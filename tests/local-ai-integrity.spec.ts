import { createHash, randomBytes } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { expect, test } from '@playwright/test';
import { Sha256 } from '../src/lib/sha256';
import {
  cacheStore,
  createIntegrityTracker,
  manifestFor,
  memoryStore,
  parseModelUrl,
  sanitizeUrl,
  type ManifestFileShape,
} from '../src/lib/ai-integrity';

const REPO = 'onnx-community/SmolLM2-135M-Instruct-ONNX';
const REV = 'b8a5c0f183b78c55955a5364f610c36668b5e681';
const url = (p: string) => `https://huggingface.co/${REPO}/resolve/${REV}/${p}`;
const MODEL_ORIGIN = 'https://moodsift.example';
const MODEL_HOST = `${MODEL_ORIGIN}/models/`;
const modelUrl = (p: string) => `${MODEL_HOST}${REPO}/resolve/${REV}/${p}`;
const hex = (b: Uint8Array) => createHash('sha256').update(b).digest('hex');

function streamOf(bytes: Uint8Array, chunk = 1000): ReadableStream<Uint8Array> {
  let i = 0;
  return new ReadableStream({
    pull(c) {
      if (i >= bytes.length) return c.close();
      c.enqueue(bytes.subarray(i, i + chunk));
      i += chunk;
    },
  });
}
const respond = (bytes: Uint8Array, headers: Record<string, string> = {}) => new Response(streamOf(bytes), { status: 200, headers: { 'content-length': String(bytes.length), ...headers } });
async function drain(res: Response): Promise<number> {
  const reader = res.body!.getReader();
  let n = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) return n;
    n += value.length;
  }
}

test.describe('incremental SHA-256', () => {
  test('matches node:crypto for edge-case lengths and chunkings', () => {
    for (const n of [0, 1, 3, 55, 56, 57, 63, 64, 65, 119, 120, 127, 128, 1000, 65537, 300_000]) {
      const b = randomBytes(n);
      for (const step of [1, 5, 64, 97, 4096]) {
        const h = new Sha256();
        for (let i = 0; i < n; i += step) h.update(b.subarray(i, Math.min(n, i + step)));
        expect(h.digestHex(), `n=${n} step=${step}`).toBe(hex(b));
      }
    }
  });
  test('known vector and single-use guards', () => {
    expect(new Sha256().update(new TextEncoder().encode('abc')).digestHex()).toBe('ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad');
    const h = new Sha256();
    h.digestHex();
    expect(() => h.update(new Uint8Array(1))).toThrow();
    expect(() => h.digestHex()).toThrow();
  });
});

test.describe('manifest handling', () => {
  const good = randomBytes(5000);
  const manifest = (over: Partial<{ revision: string; sha: string; size: number; files: unknown[] }> = {}): ManifestFileShape =>
    ({
      schema: 1,
      generatedAt: 'x',
      models: {
        'smollm2-135m': {
          repo: REPO,
          revision: over.revision ?? REV,
          dtypes: { q8: { files: (over.files as never) ?? [{ path: 'onnx/model_quantized.onnx', size: over.size ?? good.length, sha256: over.sha ?? hex(good) }] } },
        },
      },
    }) as ManifestFileShape;
  const cand = { family: 'smollm2-135m', dtype: 'q8', repo: REPO, revision: REV };

  test('valid entry resolves; empty / wrong revision / malformed are rejected (never "verified")', () => {
    expect(manifestFor(cand, manifest())?.files).toHaveLength(1);
    expect(manifestFor(cand, manifest({ files: [] }))).toBeNull();
    expect(manifestFor(cand, manifest({ revision: 'deadbeef' }))).toBeNull();
    expect(manifestFor(cand, manifest({ sha: 'NOT-A-HASH' }))).toBeNull();
    expect(manifestFor(cand, manifest({ size: 0 }))).toBeNull();
    expect(manifestFor({ ...cand, dtype: 'q4f16' }, manifest())).toBeNull();
    expect(manifestFor({ ...cand, family: 'nope' }, manifest())).toBeNull();
  });

  test('shipped manifest never claims hashes it does not have, and matches the pinned policy', async () => {
    // Read the committed JSON directly. Playwright's transform does not support
    // import attributes (`with { type: 'json' }`) in every runner, and this test
    // must also work under a plain Node/Deno test runner.
    const shipped = JSON.parse(readFileSync(new URL('../src/data/ai-manifest.json', import.meta.url), 'utf8')) as ManifestFileShape;
    const { MODELS } = await import('../src/lib/ai-policy');
    expect(shipped.generatedAt).toEqual(expect.any(String));
    for (const [family, m] of Object.entries(shipped.models)) {
      const policy = MODELS[family as keyof typeof MODELS] as unknown as { revision: string };
      expect(m.revision, family).toBe(policy.revision);
      for (const d of Object.values(m.dtypes)) {
        expect(d.files.length, `${family} files`).toBeGreaterThan(0);
        for (const f of d.files) {
          expect(f.sha256).toMatch(/^[0-9a-f]{64}$/);
          expect(f.size).toBeGreaterThan(0);
        }
      }
    }
  });

  test('URL helpers strip credentials/query and parse resolve URLs', () => {
    expect(sanitizeUrl('https://user:pw@example.com/a/b.wasm?token=SECRET#frag')).toBe('https://example.com/a/b.wasm');
    expect(parseModelUrl(url('onnx/model_quantized.onnx'))).toEqual({ repo: REPO, revision: REV, path: 'onnx/model_quantized.onnx' });
    expect(parseModelUrl('https://evil.example/' + REPO + '/resolve/' + REV + '/x')).toBeNull();
    expect(parseModelUrl('not a url')).toBeNull();
    // Same-origin proxy host with a base path (the production /models/ route).
    expect(parseModelUrl(modelUrl('onnx/model_quantized.onnx'), MODEL_HOST)).toEqual({ repo: REPO, revision: REV, path: 'onnx/model_quantized.onnx' });
    expect(parseModelUrl(url('onnx/model_quantized.onnx'), MODEL_HOST)).toBeNull();
    expect(parseModelUrl(modelUrl('onnx/model_quantized.onnx'), `${MODEL_ORIGIN}/other/`)).toBeNull();
  });
});

test.describe('integrity tracker (streaming verification)', () => {
  const file = randomBytes(20_000);
  const entry = { repo: REPO, revision: REV, files: [{ path: 'onnx/model_quantized.onnx', size: file.length, sha256: hex(file) }] };
  const make = (over: { bytes?: Uint8Array; entry?: typeof entry | null; store?: ReturnType<typeof memoryStore>; discarded?: string[] } = {}) => {
    const store = over.store ?? memoryStore();
    const discarded = over.discarded ?? [];
    const tracker = createIntegrityTracker({
      repo: REPO,
      revision: REV,
      entry: over.entry === undefined ? entry : over.entry,
      baseFetch: async (u) => {
        const s = String(u);
        if (s.includes('missing')) return new Response('nope', { status: 404 });
        if (s.includes('boom')) throw new TypeError('NetworkError when attempting to fetch resource.');
        return respond(over.bytes ?? file);
      },
      store,
      discardCached: async (u) => void discarded.push(u),
    });
    return { tracker, store, discarded };
  };

  test('matching bytes pass through unchanged, then report Verified and are remembered', async () => {
    const { tracker, store } = make();
    const res = await tracker.fetch(url('onnx/model_quantized.onnx'));
    expect(await drain(res)).toBe(file.length);
    const report = await tracker.finalize();
    expect(report.state).toBe('verified');
    expect(report.verifiedFiles).toBe(1);
    expect(await store.get(`${REPO}@${REV}/onnx/model_quantized.onnx`)).toEqual({ sha256: hex(file), size: file.length });
  });

  test('one flipped byte errors the stream at the end, fails closed, and discards the cached copy', async () => {
    const bad = Uint8Array.from(file);
    bad[777] ^= 0xff;
    const { tracker, store, discarded } = make({ bytes: bad });
    const res = await tracker.fetch(url('onnx/model_quantized.onnx'));
    await expect(drain(res)).rejects.toThrow(/SHA-256 mismatch/);
    expect(tracker.hasMismatch()).toBe(true);
    const report = await tracker.finalize();
    expect(report.state).toBe('failed');
    expect(report.reason).toBe('sha256-mismatch');
    expect(discarded).toEqual([url('onnx/model_quantized.onnx')]);
    expect(await store.get(`${REPO}@${REV}/onnx/model_quantized.onnx`)).toBeNull();
  });

  test('a truncated download (right prefix, wrong size) fails as a size mismatch', async () => {
    const { tracker } = make({ bytes: file.subarray(0, 19_000) });
    await expect(drain(await tracker.fetch(url('onnx/model_quantized.onnx')))).rejects.toThrow(/size mismatch/);
    expect((await tracker.finalize()).reason).toBe('size-mismatch');
  });

  test('no manifest entry → Not yet verified (never Verified)', async () => {
    const { tracker } = make({ entry: null });
    await drain(await tracker.fetch(url('onnx/model_quantized.onnx')));
    const r = await tracker.finalize();
    expect(r.state).toBe('not-verified');
    expect(r.reason).toBe('no-manifest');
  });

  test('a downloaded file outside the manifest keeps the model at Not yet verified', async () => {
    const { tracker } = make();
    await drain(await tracker.fetch(url('onnx/model_quantized.onnx')));
    await drain(await tracker.fetch(url('tokenizer.json')));
    const r = await tracker.finalize();
    expect(r.state).toBe('not-verified');
    expect(r.reason).toBe('unmanifested-file');
  });

  test('cached files count only when a recorded verification matches the manifest', async () => {
    const store = memoryStore();
    const a = make({ store });
    expect((await a.tracker.finalize()).reason).toBe('cache-unrecorded');
    await store.set(`${REPO}@${REV}/onnx/model_quantized.onnx`, { sha256: hex(file), size: file.length });
    const b = make({ store });
    expect((await b.tracker.finalize()).state).toBe('verified');
    await store.set(`${REPO}@${REV}/onnx/model_quantized.onnx`, { sha256: 'a'.repeat(64), size: file.length });
    expect((await make({ store }).tracker.finalize()).state).toBe('not-verified');
  });

  test('preflight: wrong-size cached copy is discarded; unrecorded copies are purged only when asked', async () => {
    const cacheMap = new Map<string, Response>();
    const cache = {
      match: async (k: string) => cacheMap.get(k)?.clone(),
      put: async (k: string, r: Response) => void cacheMap.set(k, r),
      delete: async (k: string) => cacheMap.delete(k),
    };
    const key = url('onnx/model_quantized.onnx');

    cacheMap.set(key, new Response('x', { headers: { 'content-length': '123' } }));
    await make().tracker.preflight(cache, { purgeUnrecorded: false });
    expect(cacheMap.has(key), 'corrupt/partial copy removed').toBe(false);

    cacheMap.set(key, new Response('x', { headers: { 'content-length': String(file.length) } }));
    await make().tracker.preflight(cache, { purgeUnrecorded: false });
    expect(cacheMap.has(key), 'normal load leaves unrecorded copy alone').toBe(true);
    await make().tracker.preflight(cache, { purgeUnrecorded: true });
    expect(cacheMap.has(key), 'diagnostic re-downloads so it can be verified').toBe(false);
  });

  test('records the failing resource (query stripped), HTTP status and network errors; 404 on optional files is fine', async () => {
    const { tracker } = make();
    await expect(tracker.fetch('https://cdn.example.com/boom/ort-wasm.wasm?sig=SECRET')).rejects.toThrow();
    expect(tracker.lastFailure()).toMatchObject({ url: 'https://cdn.example.com/boom/ort-wasm.wasm' });
    expect(JSON.stringify(tracker.lastFailure())).not.toContain('SECRET');
    const res = await tracker.fetch(url('missing.json'));
    expect(res.status).toBe(404);
    expect(tracker.lastFailure()).toMatchObject({ status: 404 });
    expect(tracker.hasMismatch()).toBe(false);
  });

  test('verifies files fetched through the same-origin /models/ proxy', async () => {
    const tracker = createIntegrityTracker({
      repo: REPO,
      revision: REV,
      entry,
      baseFetch: async () => respond(file),
      store: memoryStore(),
      remoteHost: MODEL_HOST,
    });
    expect(await drain(await tracker.fetch(modelUrl('onnx/model_quantized.onnx')))).toBe(file.length);
    expect(await tracker.finalize()).toMatchObject({ state: 'verified', verifiedFiles: 1, totalFiles: 1 });
  });

  test('cache-backed verified store round-trips and degrades to "nothing recorded"', async () => {
    const m = new Map<string, Response>();
    const storage = { open: async () => ({ match: async (k: string) => m.get(k)?.clone(), put: async (k: string, r: Response) => void m.set(k, r), delete: async (k: string) => m.delete(k) }) };
    const s = cacheStore(storage);
    await s.set('k', { sha256: 'a'.repeat(64), size: 5 });
    expect(await s.get('k')).toEqual({ sha256: 'a'.repeat(64), size: 5 });
    await s.delete('k');
    expect(await s.get('k')).toBeNull();
    const broken = cacheStore(undefined);
    await broken.set('k', { sha256: 'b', size: 1 });
    expect(await broken.get('k')).toBeNull();
  });
});
