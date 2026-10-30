// src/lib/ai-engine.ts
//
// The on-device AI engine, with every environment dependency injected so the
// SAME code runs in the Web Worker (ai-worker.ts wires the real thing) and in
// Node unit tests (tests/local-ai-engine.spec.ts wires fakes). Normal
// recommendations and "Test on this device" both go through `load()`:
// diagnostics are not a separate path that could pass while the real feature
// fails.
//
// Decision order (Moodsift-Local-AI-Engine-Policy.md):
//   1. Lightweight / data saver returns without importing the runtime, opening
//      a cache, hashing, fetching or loading anything.
//   2. Detect device signals (heuristics, not exact RAM/GPU memory).
//   3. Build the eligible candidate list (ai-policy.ts). Ineligible models are
//      never attempted to "prove" they fail.
//   4. Load the runtime (first working CDN), then make sure the ONNX WASM
//      assets are reachable on at least one host.
//   5. Load ONE candidate at a time with integrity tracking (ai-integrity.ts),
//      staged progress, and a per-attempt failure record.
//   6. A resolved pipeline is not "ready": run a deterministic smoke
//      generation, validate it, and check integrity. Any failure disposes the
//      candidate and moves to the next ELIGIBLE one.
//   7. Only then post `ready`. Generation is serialised by a queue.

import {
  buildCandidates,
  buildMessages,
  SMOKE_MESSAGES,
  validateExplanation,
  validateSmoke,
  type Candidate,
  type ChatMessage,
  type ExplainInput,
  type ResourceSnapshot,
} from './ai-policy';
import type { AiMode } from './ai-settings';
import {
  classifyFailure,
  cleanMessage,
  eligibleLabels,
  hostOf,
  outcomeOf,
  recommendMode,
  summarizeFailures,
  type AttemptRecord,
  type DiagnosticResult,
  type FailureStage,
} from './ai-diagnostics';
import { cacheStore, createIntegrityTracker, manifestFor, sanitizeUrl, type FetchFn, type IntegrityReport, type ManifestFileShape } from './ai-integrity';

export type Stage = 'detecting' | 'runtime' | 'downloading' | 'integrity' | 'initializing' | 'verifying' | 'quality';

export interface LoadMsg {
  type: 'load';
  mode: AiMode;
  /** Main-thread hint: primary pointer is coarse (phones/tablets). */
  coarsePointer?: boolean;
  /** "Test on this device": re-download unrecorded cached files so they are
   * verified, and optionally run the small format-check set. */
  diagnose?: { quality: boolean };
}
export interface GenerateMsg {
  type: 'generate';
  id: number;
  item: ExplainInput;
  quizSummary: string;
}
export type InMsg = LoadMsg | GenerateMsg;

export type OutMsg =
  | { type: 'stage'; stage: Stage; model?: string; approxMb?: number }
  | { type: 'progress'; pct: number; model?: string }
  | { type: 'activity' }
  | { type: 'ready'; model: string; backend: 'webgpu' | 'wasm'; dtype: string; approxMb: number; result: DiagnosticResult }
  | { type: 'error'; message: string; result: DiagnosticResult }
  | { type: 'started'; id: number }
  | { type: 'result'; id: number; text: string | null };

export type Pipeline = ((input: ChatMessage[], options?: Record<string, unknown>) => Promise<unknown>) & {
  dispose?: () => Promise<void> | void;
};

/* eslint-disable @typescript-eslint/no-explicit-any */
export interface RuntimeModule {
  pipeline: any;
  env: any;
}
/* eslint-enable @typescript-eslint/no-explicit-any */

export interface CacheLike {
  match(request: string): Promise<Response | undefined>;
  put(request: string, response: Response): Promise<void>;
  delete(request: string): Promise<boolean>;
}
export interface CacheStorageLike {
  open(name: string): Promise<CacheLike>;
}

export interface EngineDeps {
  post(message: OutMsg): void;
  detect(coarsePointer: boolean): Promise<ResourceSnapshot & { webgpuApi: boolean }>;
  /** Loads Transformers.js. On total failure rejects with an Error carrying
   * `failures: { url: string; message: string }[]`, one per source tried. */
  importRuntime(): Promise<RuntimeModule>;
  baseFetch: FetchFn;
  cacheStorage: CacheStorageLike | undefined;
  manifest: ManifestFileShape;
  /** Same-origin base for Transformers.js model files, e.g.
   * `https://moodsift.example/models/`. Every config/tokenizer/weight request
   * is built from this host and `remotePathTemplate`, and integrity tracking
   * must parse the same base path. */
  modelHost: string;
  now(): number;
  isOffline(): boolean;
  /** Per-request cap for the smoke generation. */
  smokeTimeoutMs?: number;
}

export class RuntimeImportError extends Error {
  constructor(
    message: string,
    readonly failures: { url: string; message: string }[]
  ) {
    super(message);
    this.name = 'RuntimeImportError';
  }
}

const WASM_PROBE_TIMEOUT_MS = 8_000;
const SMOKE_TIMEOUT_MS = 30_000;

/** A handful of fixed prompts for the optional format check. */
const QUALITY_PROMPTS: { item: ExplainInput; summary: string }[] = [
  { item: { title: 'Heat', year: 1995, reasons: ['Crime thriller', 'Tense', 'Well rated'] }, summary: 'a tense crime thriller' },
  { item: { title: 'Spirited Away', year: 2001, reasons: ['Animated fantasy', 'Family friendly', 'Beautiful visuals'] }, summary: 'something magical and visual' },
  { item: { title: 'Superbad', year: 2007, reasons: ['Comedy', 'Light and fun', 'Short'] }, summary: 'a light comedy for a friend night' },
];

/** Returns the final assistant message from the first pipeline result, or null. */
function extractReply(out: unknown): string | null {
  const first = Array.isArray(out) ? (out[0] as { generated_text?: unknown } | undefined) : undefined;
  const text = first?.generated_text;
  if (!Array.isArray(text)) return null;
  const last = text[text.length - 1] as { role?: unknown; content?: unknown } | undefined;
  return last && last.role === 'assistant' && typeof last.content === 'string' ? last.content : null;
}

/** Rejects with a labeled Error after `ms` milliseconds, or forwards the promise's
 * result/rejection. Timing out does not cancel the underlying operation. */
function withTimeout<T>(promise: Promise<T>, ms: number, label: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error(`${label} timed out after ${Math.round(ms / 1000)} s`)), ms);
  });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}

/** Creates a local model engine whose progress and results go through deps.post.
 * Loading tries eligible candidates until one has no integrity failure and passes
 * its smoke check. Generation requests are queued and reply with null on failure.
 * Runtime, network, cache and device access use the supplied dependencies. */
export function createEngine(deps: EngineDeps) {
  let generator: Pipeline | null = null;
  let active: Candidate | null = null;
  let lastReady: Extract<OutMsg, { type: 'ready' }> | null = null;
  let loading = false;
  const queue: GenerateMsg[] = [];
  let draining = false;

  const stage = (s: Stage, c?: Candidate) => deps.post({ type: 'stage', stage: s, model: c?.label, approxMb: c?.approxMb });

  /** Releases a pipeline when supported, ignoring disposal failures. */
  async function disposeGenerator(g: Pipeline | null): Promise<void> {
    try {
      await g?.dispose?.();
    } catch {
      // Best effort — the worker may be terminated right after anyway.
    }
  }

  /** Probes the ONNX Runtime WASM assets (derived from the library's own
   * version-correct default, never hard-coded) and, if the default host is
   * unreachable, switches to the first mirror that serves both files. The
   * generic "NetworkError" a blocked asset produces deep inside ONNX Runtime
   * otherwise cannot be told apart from a model-download failure. Records
   * unreachable hosts and continues loading even if every probe fails. */
  async function ensureWasmHost(env: any, attempts: AttemptRecord[]): Promise<void> {
    const paths = env?.backends?.onnx?.wasm?.wasmPaths;
    if (!paths || typeof paths !== 'object' || typeof paths.mjs !== 'string' || typeof paths.wasm !== 'string') return;
    const m = /^(https:\/\/)cdn\.jsdelivr\.net(\/npm\/onnxruntime-web@[^/]+\/dist\/)(.+)$/.exec(paths.wasm);
    const hosts: { host: string; mjs: string; wasm: string }[] = [{ host: new URL(paths.wasm).host, mjs: paths.mjs, wasm: paths.wasm }];
    if (m) {
      const file = (u: string) => u.slice(u.lastIndexOf('/') + 1);
      for (const base of ['https://fastly.jsdelivr.net/npm/', 'https://unpkg.com/']) {
        const dir = base === 'https://unpkg.com/' ? m[2]!.replace('/npm/', '/') : m[2]!;
        const prefix = base === 'https://unpkg.com/' ? `https://unpkg.com${dir}` : `${base.replace(/\/npm\/$/, '')}${dir}`;
        hosts.push({ host: new URL(prefix).host, mjs: `${prefix}${file(paths.mjs)}`, wasm: `${prefix}${file(paths.wasm)}` });
      }
    }
    for (const [i, h] of hosts.entries()) {
      const failedUrl = await firstUnreachable([h.mjs, h.wasm]);
      if (!failedUrl) {
        if (i > 0) {
          paths.mjs = h.mjs;
          paths.wasm = h.wasm;
        }
        return;
      }
      attempts.push({
        key: 'runtime',
        label: 'ONNX WASM runtime',
        ok: false,
        stage: 'runtime',
        kind: deps.isOffline() ? 'offline' : 'wasm',
        url: sanitizeUrl(failedUrl.url),
        host: hostOf(failedUrl.url),
        status: failedUrl.status,
        message: failedUrl.message,
      });
    }
    // Every host failed: carry on. The real attempt will fail with the same
    // (now recorded) resource named, instead of a bare "NetworkError".
  }

  /** Returns the first failed HEAD probe, converting request errors and the
   * eight-second timeout into details, or null if every URL responds successfully. */
  async function firstUnreachable(urls: string[]): Promise<{ url: string; status?: number; message?: string } | null> {
    for (const url of urls) {
      try {
        const res = await withTimeout(deps.baseFetch(url, { method: 'HEAD' }), WASM_PROBE_TIMEOUT_MS, 'The request');
        if (!res.ok) return { url, status: res.status };
      } catch (err) {
        return { url, message: cleanMessage(err) };
      }
    }
    return null;
  }

  /** Posts a ready/error outcome and progress while trying eligible local models.
   * Reuses a ready model unless diagnosing, and ignores loads already in progress.
   * A fresh lightweight load posts disabled without accessing the runtime or models.
   * Diagnostic loads purge unrecorded cache entries and may run extra format checks;
   * failed format checks do not fail a model. Load failures become error messages. */
  async function load(msg: LoadMsg): Promise<void> {
    if (generator && active && lastReady && !msg.diagnose) {
      deps.post(lastReady);
      return;
    }
    if (loading) return;
    loading = true;
    const started = deps.now();
    const attempts: AttemptRecord[] = [];
    let resources: DiagnosticResult['resources'];
    let eligible: string[] = [];

    const fail = (message: string): void => {
      const result: DiagnosticResult = {
        outcome: 'failed',
        mode: msg.mode,
        resources,
        eligible,
        attempts,
        startupMs: deps.now() - started,
        recommendation: resources ? recommendMode(msg.mode, attempts, null, resources) : null,
        summary: message,
      };
      deps.post({ type: 'error', message, result });
    };

    try {
      if (msg.mode === 'lightweight') {
        deps.post({
          type: 'error',
          message: 'Lightweight mode is on, so no AI model is loaded.',
          result: { outcome: 'disabled', mode: 'lightweight', eligible: [], attempts: [], summary: 'Local inference is intentionally disabled in Lightweight / data saver mode.' },
        });
        return;
      }

      stage('detecting');
      resources = await deps.detect(msg.coarsePointer === true);
      const candidates = buildCandidates(msg.mode, resources);
      eligible = eligibleLabels(msg.mode, resources);
      if (candidates.length === 0) {
        fail('No on-device model is suitable for this device.');
        return;
      }

      stage('runtime');
      let runtime: RuntimeModule;
      try {
        runtime = await deps.importRuntime();
      } catch (err) {
        const failures = err instanceof RuntimeImportError ? err.failures : [{ url: '', message: cleanMessage(err) }];
        for (const f of failures) {
          attempts.push({
            key: 'runtime',
            label: 'AI runtime',
            ok: false,
            stage: 'runtime',
            kind: classifyFailure({ stage: 'runtime', message: f.message, offline: deps.isOffline() }),
            url: f.url ? sanitizeUrl(f.url) : undefined,
            host: hostOf(f.url),
            message: cleanMessage(f.message),
          });
        }
        fail(`The AI runtime could not be loaded${failures[0]?.url ? ` (tried ${failures.map((f) => hostOf(f.url) ?? 'unknown host').join(', ')})` : ''}.`);
        return;
      }

      const { pipeline, env } = runtime;
      env.allowLocalModels = false;
      env.useBrowserCache = true;
      // Route every model artifact through the same-origin /models/ proxy.
      // The path template keeps Hugging Face's repo/revision/file layout, which
      // worker/model-proxy.ts validates. Both settings are supported
      // Transformers.js environment options (not a Moodsift-specific fork).
      env.remoteHost = deps.modelHost;
      env.remotePathTemplate = '{model}/resolve/{revision}/';
      if (env.backends?.onnx?.wasm) {
        // Multi-threaded WASM needs a SharedArrayBuffer, which the browser only
        // grants on a cross-origin-isolated page (COOP/COEP — see
        // worker/index.ts). Requesting >1 thread without that throws on most
        // onnxruntime-web builds, so only ask when the page is isolated.
        env.backends.onnx.wasm.numThreads = resources.crossOriginIsolated ? Math.max(1, resources.cores - 1) : 1;
      }
      await ensureWasmHost(env, attempts);

      const cacheName: string = typeof env.cacheKey === 'string' ? env.cacheKey : 'transformers-cache';
      const openModelCache = async (): Promise<CacheLike | undefined> => {
        try {
          return await deps.cacheStorage?.open(cacheName);
        } catch {
          return undefined;
        }
      };
      const store = cacheStore(deps.cacheStorage);

      for (const candidate of candidates) {
        const t0 = deps.now();
        let built: Pipeline | null = null;
        const ph: { v: FailureStage } = { v: 'download' };
        const tracker = createIntegrityTracker({
          repo: candidate.repo,
          revision: candidate.revision,
          entry: manifestFor(candidate, deps.manifest),
          baseFetch: deps.baseFetch,
          // The tracker must recognise the same /models/ base path that
          // Transformers.js uses, or it cannot map requests to manifest files.
          remoteHost: deps.modelHost,
          store,
          discardCached: async (url) => {
            await (await openModelCache())?.delete(url);
          },
        });
        env.fetch = tracker.fetch;
        try {
          await tracker.preflight(await openModelCache(), { purgeUnrecorded: msg.diagnose !== undefined });

          stage('downloading', candidate);
          built = (await pipeline('text-generation', candidate.repo, {
            revision: candidate.revision,
            device: candidate.backend,
            dtype: candidate.dtype,
            progress_callback: makeProgressReporter(candidate, () => {
              ph.v = 'initialization';
            }),
          })) as Pipeline;

          // Fail closed: if a checksum mismatch happened anywhere, even if the
          // library swallowed the stream error, this candidate is not usable.
          ph.v = 'integrity';
          stage('integrity', candidate);
          if (tracker.hasMismatch()) throw new Error((await tracker.finalize()).detail);

          // A resolved pipeline is not a ready model: prove it can answer.
          ph.v = 'smoke inference';
          stage('verifying', candidate);
          const smokeStart = deps.now();
          const out = await withTimeout(built(SMOKE_MESSAGES, { max_new_tokens: 12, do_sample: false }), deps.smokeTimeoutMs ?? SMOKE_TIMEOUT_MS, 'The start-up check');
          const smokeMs = deps.now() - smokeStart;
          if (!validateSmoke(extractReply(out))) throw new Error('The start-up check returned no usable text.');

          const integrity: IntegrityReport = await tracker.finalize();
          if (integrity.state === 'failed') {
            ph.v = 'integrity';
            throw new Error(integrity.detail);
          }

          let quality: DiagnosticResult['quality'];
          if (msg.diagnose?.quality) {
            stage('quality', candidate);
            let passedChecks = 0;
            for (const q of QUALITY_PROMPTS) {
              try {
                const reply = await withTimeout(built(buildMessages(q.item, q.summary), { max_new_tokens: candidate.maxNewTokens, do_sample: false }), deps.smokeTimeoutMs ?? SMOKE_TIMEOUT_MS, 'The quality check');
                if (validateExplanation(extractReply(reply)) !== null) passedChecks++;
              } catch {
                // A failed prompt is a failed check, not a failed model.
              }
            }
            quality = { passed: passedChecks, total: QUALITY_PROMPTS.length };
          }

          generator = built;
          active = candidate;
          attempts.push({ key: candidate.key, label: candidate.label, backend: candidate.backend, dtype: candidate.dtype, revision: candidate.revision, ok: true, ms: deps.now() - t0 });
          const result: DiagnosticResult = {
            outcome: outcomeOf(attempts, candidate, buildCandidates(msg.mode, resources)[0]?.key),
            mode: msg.mode,
            model: { label: candidate.label, family: candidate.family, backend: candidate.backend, dtype: candidate.dtype, revision: candidate.revision, approxMb: candidate.approxMb },
            integrity,
            resources,
            eligible,
            attempts,
            startupMs: deps.now() - started,
            smokeMs,
            quality,
            recommendation: recommendMode(msg.mode, attempts, candidate, resources),
            summary: '',
          };
          result.summary =
            result.outcome === 'passed'
              ? `${candidate.label} started and answered a test prompt on this device.`
              : `${candidate.label} started after an earlier attempt failed, and answered a test prompt.`;
          lastReady = { type: 'ready', model: candidate.label, backend: candidate.backend, dtype: candidate.dtype, approxMb: candidate.approxMb, result };
          deps.post(lastReady);
          return;
        } catch (err) {
          const net = tracker.lastFailure();
          const message = cleanMessage(err) || 'failed to start';
          const stageNow: FailureStage = tracker.hasMismatch() ? 'integrity' : ph.v;
          const timedOut = /timed out/i.test(message);
          attempts.push({
            key: candidate.key,
            label: candidate.label,
            backend: candidate.backend,
            dtype: candidate.dtype,
            revision: candidate.revision,
            ok: false,
            stage: stageNow,
            kind: classifyFailure({ stage: stageNow, message: `${message} ${net?.error ?? ''}`, status: net?.status, offline: deps.isOffline(), timedOut }),
            url: stageNow === 'download' || stageNow === 'initialization' ? net?.url : undefined,
            host: stageNow === 'download' || stageNow === 'initialization' ? hostOf(net?.url) : undefined,
            status: stageNow === 'download' || stageNow === 'initialization' ? net?.status : undefined,
            message,
            ms: deps.now() - t0,
          });
          await disposeGenerator(built);
        }
      }
      fail(summarizeFailures(attempts));
    } catch (err) {
      fail(cleanMessage(err) || 'Failed to load the on-device model.');
    } finally {
      loading = false;
    }
  }

  /** Aggregates file downloads into a monotonic percentage capped at 99.
   * Calls onInit and announces initialization once all tracked files are done
   * and at least 95% of the candidate's approximate weight bytes have arrived. */
  function makeProgressReporter(candidate: Candidate, onInit: () => void): (p: unknown) => void {
    const files = new Map<string, { loaded: number; total: number; done: boolean }>();
    const expectedBytes = candidate.approxMb * 1_000_000;
    let lastPct = -1;
    let announcedInit = false;
    let lastActivityAt = 0;

    return (raw) => {
      const p = raw as { status?: string; file?: string; name?: string; loaded?: number; total?: number } | null;
      if (!p || typeof p.status !== 'string') return;
      const name = p.file ?? p.name ?? '';
      if (!name) return;

      if (p.status === 'initiate') {
        if (!files.has(name)) files.set(name, { loaded: 0, total: 0, done: false });
      } else if (p.status === 'progress' || p.status === 'download') {
        const f = files.get(name) ?? { loaded: 0, total: 0, done: false };
        if (typeof p.loaded === 'number') f.loaded = p.loaded;
        if (typeof p.total === 'number') f.total = p.total;
        files.set(name, f);
      } else if (p.status === 'done') {
        const f = files.get(name) ?? { loaded: 0, total: 0, done: false };
        f.done = true;
        if (f.total > 0) f.loaded = f.total;
        files.set(name, f);
      }

      // Bytes are still arriving even when the displayed percentage doesn't
      // move (slow link, or parked at the 99% cap while the last bytes land).
      // Tell the main thread so its idle timer doesn't call a live download
      // stalled. Throttled; the main thread's limit is 120 s.
      const now = deps.now();
      if (p.status === 'progress' && now - lastActivityAt >= 2000) {
        lastActivityAt = now;
        deps.post({ type: 'activity' });
      }

      let loaded = 0;
      let total = 0;
      let allDone = files.size > 0;
      for (const f of files.values()) {
        loaded += f.loaded;
        total += f.total;
        if (!f.done) allDone = false;
      }
      // Weigh against the expected weight-file size so the bar doesn't jump
      // backwards when the large file starts after the small ones finish.
      const denominator = Math.max(total, expectedBytes);
      const pct = Math.min(99, Math.floor((loaded / denominator) * 100));
      if (pct > lastPct) {
        lastPct = pct;
        deps.post({ type: 'progress', pct, model: candidate.label });
      }
      // The small config/tokenizer files finish long before the weights, so
      // "every started file is done" alone is not enough: also require that
      // roughly the whole weight file has arrived.
      if (allDone && !announcedInit && loaded >= expectedBytes * 0.95) {
        announcedInit = true;
        onInit();
        stage('initializing', candidate);
      }
    };
  }

  /** Posts started, then a validated explanation or null when no model is ready,
   * generation throws or the output is unusable. */
  async function generateOne(msg: GenerateMsg): Promise<void> {
    // Lets the main thread start its per-request timeout now that this request
    // is actually being decoded (not merely waiting in the queue).
    deps.post({ type: 'started', id: msg.id });
    if (!generator || !active) {
      deps.post({ type: 'result', id: msg.id, text: null });
      return;
    }
    try {
      const out = await generator(buildMessages(msg.item, msg.quizSummary), { max_new_tokens: active.maxNewTokens, do_sample: false });
      deps.post({ type: 'result', id: msg.id, text: validateExplanation(extractReply(out)) });
    } catch {
      deps.post({ type: 'result', id: msg.id, text: null });
    }
  }

  /** Processes queued generations serially; returns immediately if already draining. */
  async function drain(): Promise<void> {
    if (draining) return;
    draining = true;
    try {
      for (let next = queue.shift(); next; next = queue.shift()) await generateOne(next);
    } finally {
      draining = false;
    }
  }

  return {
    /** Loads a model or enqueues a generation. Results arrive through deps.post;
     * a generation queued during an active drain can resolve before it is processed. */
    handle(msg: InMsg): Promise<void> {
      if (msg.type === 'load') return load(msg);
      // Worker-side serial queue: requests are decoded strictly one at a time,
      // in arrival order, no matter how many callers post at once.
      queue.push(msg);
      return drain();
    },
  };
}
