#!/usr/bin/env node
// scripts/generate-ai-manifest.mjs
//
// Fills src/data/ai-manifest.json with the real SHA-256 and size of every file
// the on-device models need, taken from the EXACT pinned upstream revisions.
//
//   npm run ai:manifest            # (re)generate the manifest in place
//   npm run ai:manifest -- --check # verify the committed manifest still matches upstream (CI / release gate)
//
// Needs network access to huggingface.co, so run it in a trusted release/CI
// environment and REVIEW the diff before committing. Hashes are never invented:
//   - Large (Git LFS) files: Hugging Face publishes the SHA-256 as `lfs.oid`.
//   - Small non-LFS files (config/tokenizer): downloaded and hashed here.
// An HTTP ETag is never used as a checksum.
//
// Repo + revision + dtype keys are read from the existing manifest (a test
// asserts they match src/lib/ai-policy.ts, the source of truth for pins).

import { createHash } from 'node:crypto';
import { readFile, writeFile } from 'node:fs/promises';
import { fileURLToPath, pathToFileURL } from 'node:url';

const MANIFEST_PATH = fileURLToPath(new URL('../src/data/ai-manifest.json', import.meta.url));
const HOST = 'https://huggingface.co';

/** dtype → the weights file Transformers.js requests for it. */
export const WEIGHTS_FILE = { q4f16: 'onnx/model_q4f16.onnx', q8: 'onnx/model_quantized.onnx' };
const SMALL_FILES = ['config.json', 'generation_config.json', 'tokenizer.json', 'tokenizer_config.json'];

/** Pure: which tree entries a dtype needs (weights, optional external-data shards, small files). */
export function requiredPaths(tree, dtype) {
  const weights = WEIGHTS_FILE[dtype];
  if (!weights) throw new Error(`Unknown dtype: ${dtype}`);
  const present = new Set(tree.filter((e) => e.type === 'file').map((e) => e.path));
  if (!present.has(weights)) throw new Error(`Weights file ${weights} is not in the pinned revision.`);
  const paths = SMALL_FILES.filter((p) => present.has(p));
  for (const p of ['config.json', 'tokenizer.json', 'tokenizer_config.json']) if (!present.has(p)) throw new Error(`Required file ${p} is missing from the pinned revision.`);
  paths.push(weights);
  for (const p of present) if (p.startsWith(`${weights}_data`)) paths.push(p);
  return paths;
}

async function sha256OfUrl(fetchImpl, url) {
  const res = await fetchImpl(url);
  if (!res.ok || !res.body) throw new Error(`Download failed (${res.status}) for ${url}`);
  const hash = createHash('sha256');
  let size = 0;
  for await (const chunk of res.body) {
    hash.update(chunk);
    size += chunk.length;
  }
  return { sha256: hash.digest('hex'), size };
}

export async function generate(manifest, { fetchImpl = fetch, now = () => new Date().toISOString() } = {}) {
  const out = structuredClone(manifest);
  const treeCache = new Map();
  const fileCache = new Map();
  for (const model of Object.values(out.models)) {
    const treeUrl = `${HOST}/api/models/${model.repo}/tree/${model.revision}?recursive=true`;
    if (!treeCache.has(treeUrl)) {
      const res = await fetchImpl(treeUrl);
      if (!res.ok) throw new Error(`Could not list ${model.repo}@${model.revision} (${res.status}).`);
      treeCache.set(treeUrl, await res.json());
    }
    const tree = treeCache.get(treeUrl);
    for (const dtype of Object.keys(model.dtypes)) {
      const files = [];
      for (const path of requiredPaths(tree, dtype)) {
        const entry = tree.find((e) => e.path === path);
        const cacheKey = `${model.repo}@${model.revision}/${path}`;
        let info;
        if (entry.lfs?.oid && /^[0-9a-f]{64}$/.test(entry.lfs.oid)) {
          info = { sha256: entry.lfs.oid, size: entry.lfs.size ?? entry.size };
        } else {
          if (!fileCache.has(cacheKey)) fileCache.set(cacheKey, await sha256OfUrl(fetchImpl, `${HOST}/${model.repo}/resolve/${model.revision}/${path}`));
          info = fileCache.get(cacheKey);
          if (entry.size !== undefined && entry.size !== info.size) throw new Error(`Size mismatch for ${path}: tree says ${entry.size}, downloaded ${info.size}.`);
        }
        files.push({ path, size: info.size, sha256: info.sha256 });
      }
      model.dtypes[dtype] = { files };
    }
  }
  out.generatedAt = now();
  return out;
}

const strip = (m) => JSON.stringify({ ...m, generatedAt: null });

async function main() {
  const check = process.argv.includes('--check');
  const current = JSON.parse(await readFile(MANIFEST_PATH, 'utf8'));
  const next = await generate(current);
  if (check) {
    if (strip(current) !== strip(next)) {
      console.error('ai-manifest.json does not match the pinned upstream revisions. Run `npm run ai:manifest` and review the diff.');
      process.exit(1);
    }
    console.log('ai-manifest.json matches upstream.');
    return;
  }
  await writeFile(MANIFEST_PATH, JSON.stringify(next, null, 2) + '\n');
  const n = Object.values(next.models).reduce((a, m) => a + Object.values(m.dtypes).reduce((b, d) => b + d.files.length, 0), 0);
  console.log(`Wrote ${n} file entries to src/data/ai-manifest.json. Review the diff before committing.`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((err) => {
    console.error(err.message);
    process.exit(1);
  });
}
