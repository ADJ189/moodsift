import { createHash } from 'node:crypto';
import { expect, test } from '@playwright/test';
// @ts-expect-error — plain .mjs script, no type declarations
import { generate, requiredPaths } from '../scripts/generate-ai-manifest.mjs';

const sha = (s: string) => createHash('sha256').update(s).digest('hex');
const LFS = 'f'.repeat(64);

const manifest = (files = {}) => ({
  schema: 1,
  generatedAt: null,
  models: { 'smollm2-135m': { repo: 'org/Model', revision: 'abc123', dtypes: { q8: { files: [] }, q4f16: { files: [] } }, ...files } },
});
const tree = [
  { type: 'file', path: 'config.json', size: 5 },
  { type: 'file', path: 'tokenizer.json', size: 6 },
  { type: 'file', path: 'tokenizer_config.json', size: 3 },
  { type: 'file', path: 'onnx/model_quantized.onnx', size: 999, lfs: { oid: LFS, size: 999 } },
  { type: 'file', path: 'onnx/model_q4f16.onnx', size: 500, lfs: { oid: 'e'.repeat(64), size: 500 } },
  { type: 'file', path: 'README.md', size: 1 },
];
const bodies: Record<string, string> = { 'config.json': 'hello', 'tokenizer.json': 'tokens', 'tokenizer_config.json': 'cfg' };

function fakeFetch(requested: string[]) {
  return async (url: string) => {
    requested.push(url);
    if (url.includes('/api/models/')) return new Response(JSON.stringify(tree), { status: 200 });
    const path = url.split('/resolve/abc123/')[1]!;
    const body = bodies[path];
    return body === undefined ? new Response('', { status: 404 }) : new Response(body);
  };
}

test.describe('manifest generator (fake Hugging Face)', () => {
  test('required files per dtype; missing weights or tokenizer is an error', () => {
    expect(requiredPaths(tree, 'q8')).toEqual(['config.json', 'tokenizer.json', 'tokenizer_config.json', 'onnx/model_quantized.onnx']);
    expect(() => requiredPaths(tree.filter((e) => e.path !== 'onnx/model_q4f16.onnx'), 'q4f16')).toThrow(/not in the pinned revision/);
    expect(() => requiredPaths(tree.filter((e) => e.path !== 'tokenizer.json'), 'q8')).toThrow(/tokenizer\.json/);
    expect(() => requiredPaths(tree, 'fp32')).toThrow(/Unknown dtype/);
  });

  test('LFS hashes come from upstream metadata; small files are downloaded and hashed; no download for weights', async () => {
    const requested: string[] = [];
    const out = await generate(manifest(), { fetchImpl: fakeFetch(requested), now: () => 'T' });
    const q8 = out.models['smollm2-135m'].dtypes.q8.files;
    expect(q8.find((f: { path: string }) => f.path === 'onnx/model_quantized.onnx')).toEqual({ path: 'onnx/model_quantized.onnx', size: 999, sha256: LFS });
    expect(q8.find((f: { path: string }) => f.path === 'config.json')).toEqual({ path: 'config.json', size: 5, sha256: sha('hello') });
    expect(requested.some((u) => u.includes('.onnx') && u.includes('/resolve/'))).toBe(false);
    expect(requested.filter((u) => u.endsWith('/config.json'))).toHaveLength(1); // cached across dtypes
    expect(out.generatedAt).toBe('T');
  });

  test('size disagreement between the tree and the download is refused', async () => {
    const bad: Record<string, string> = { ...bodies, 'config.json': 'hello world' };
    const fetchImpl = async (url: string) => (url.includes('/api/models/') ? new Response(JSON.stringify(tree)) : new Response(bad[url.split('/resolve/abc123/')[1]!] ?? '', { status: 200 }));
    await expect(generate(manifest(), { fetchImpl })).rejects.toThrow(/Size mismatch/);
  });

  test('upstream listing failure is an error, not an empty manifest', async () => {
    await expect(generate(manifest(), { fetchImpl: async () => new Response('', { status: 404 }) })).rejects.toThrow(/Could not list/);
  });
});
