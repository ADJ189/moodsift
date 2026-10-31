// src/lib/ai-worker.ts
//
// Runs the on-device explanation writer in a dedicated Worker so a slow
// download or decode never freezes the UI. This file only WIRES the real
// environment (CDN import, navigator, Cache API, fetch) into the engine in
// ai-engine.ts, which holds the decision logic and is unit-tested with fakes.
//
// This file intentionally uses `any` casts around postMessage/onmessage and
// the CDN module: the project's tsconfig only loads the "DOM" lib (not
// "webworker"), and the library is loaded from a CDN at runtime rather than
// being an npm dependency (see llm.ts for why).
//
// Note on `wasmPaths`: transformers.js sets it (to the version-correct
// onnxruntime-web build on jsDelivr). The engine never invents a path; it only
// probes the library's own default and, when that host is unreachable, swaps
// in the same version's files from a mirror (see ensureWasmHost).

import { createEngine, RuntimeImportError, type InMsg, type RuntimeModule } from './ai-engine';
import manifest from '../data/ai-manifest.json';
import type { ManifestFileShape } from './ai-integrity';
import type { ResourceSnapshot } from './ai-policy';

/** Runtime source order. Exact pins only; never a range or `latest`. */
export const TRANSFORMERS_VERSION = '4.3.1';
const JS_CDN_SOURCES = [
  `https://esm.sh/@huggingface/transformers@${TRANSFORMERS_VERSION}`,
  `https://cdn.jsdelivr.net/npm/@huggingface/transformers@${TRANSFORMERS_VERSION}/+esm`,
  `https://unpkg.com/@huggingface/transformers@${TRANSFORMERS_VERSION}?module`,
];

const ctx = self as unknown as {
  postMessage: (message: unknown) => void;
  onmessage: ((ev: { data: InMsg }) => void) | null;
  navigator: Navigator & {
    deviceMemory?: number;
    userAgentData?: { mobile?: boolean };
    gpu?: { requestAdapter(): Promise<{ features: ReadonlySet<string> } | null> };
  };
  crossOriginIsolated?: boolean;
  caches?: CacheStorage;
  /** The page/worker origin used to build the same-origin /models/ URL. */
  location: { origin: string };
};

/** Collects device estimates, treating coarsePointer as a mobile hint and
 * requiring shader-f16 for a usable GPU. Adapter errors yield webgpuAdapter=false;
 * unknown memory stays undefined and unavailable core counts default to four. */
async function detect(coarsePointer: boolean): Promise<ResourceSnapshot & { webgpuApi: boolean }> {
  const nav = ctx.navigator;
  const mem = typeof nav.deviceMemory === 'number' && nav.deviceMemory > 0 ? nav.deviceMemory : undefined;
  const cores = typeof nav.hardwareConcurrency === 'number' && nav.hardwareConcurrency > 0 ? Math.floor(nav.hardwareConcurrency) : 4;
  const mobile = nav.userAgentData?.mobile === true || coarsePointer || /Android|iPhone|iPad|iPod|Mobi/i.test(nav.userAgent || '');

  // The q4f16 models require a real adapter with half-precision shader support.
  // `'gpu' in navigator` alone is true on devices with no usable adapter.
  let webgpuAdapter = false;
  if (nav.gpu) {
    try {
      const adapter = await nav.gpu.requestAdapter();
      webgpuAdapter = adapter?.features.has('shader-f16') === true;
    } catch {
      webgpuAdapter = false;
    }
  }
  return { deviceMemoryGb: mem, cores, mobile, webgpuAdapter, crossOriginIsolated: ctx.crossOriginIsolated === true, webgpuApi: Boolean(nav.gpu) };
}

/** Returns the first pinned CDN module with a pipeline export. If all sources
 * fail, rejects with RuntimeImportError containing each source's failure. */
async function importRuntime(): Promise<RuntimeModule> {
  const failures: { url: string; message: string }[] = [];
  for (const src of JS_CDN_SOURCES) {
    try {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const mod: any = await import(/* @vite-ignore */ src);
      if (mod?.pipeline) return mod;
      failures.push({ url: src, message: 'loaded but had no pipeline export' });
    } catch (err) {
      failures.push({ url: src, message: err instanceof Error ? err.message : String(err) });
    }
  }
  throw new RuntimeImportError('The AI runtime could not be loaded from any source.', failures);
}

const engine = createEngine({
  post: (m) => ctx.postMessage(m),
  detect,
  importRuntime,
  baseFetch: (input, init) => fetch(input, init),
  cacheStorage: ctx.caches,
  manifest: manifest as ManifestFileShape,
  // Same-origin model downloads: worker/index.ts (and the Vite dev/preview
  // middleware) serve /models/ by validating the pinned repository/revision
  // and relaying Hugging Face server-side. Inference stays in this worker.
  modelHost: new URL('/models/', ctx.location.origin).href,
  now: () => Date.now(),
  isOffline: () => ctx.navigator.onLine === false,
});

ctx.onmessage = (e) => {
  void engine.handle(e.data);
};
