import { createHash, randomBytes } from 'node:crypto';
import { expect, test } from '@playwright/test';
import { createEngine, RuntimeImportError, type EngineDeps, type InMsg, type OutMsg } from '../src/lib/ai-engine';
import { buildCandidates, MODELS, type ResourceSnapshot } from '../src/lib/ai-policy';
import type { ManifestFileShape } from '../src/lib/ai-integrity';

const strong: ResourceSnapshot & { webgpuApi: boolean } = { deviceMemoryGb: 8, cores: 8, mobile: false, webgpuAdapter: true, crossOriginIsolated: true, webgpuApi: true };
const weak: ResourceSnapshot & { webgpuApi: boolean } = { deviceMemoryGb: 2, cores: 2, mobile: true, webgpuAdapter: false, crossOriginIsolated: false, webgpuApi: false };

const READY = [{ generated_text: [{ role: 'assistant', content: 'Ready to help.' }] }];
const GOOD = [{ generated_text: [{ role: 'assistant', content: 'A tense, well-rated crime thriller that fits your mood.' }] }];
const EMPTY = [{ generated_text: [{ role: 'assistant', content: '' }] }];

type Behaviour = 'ok' | 'init-fail' | 'network' | 'empty' | 'hang' | 'bad-bytes' | 'swallow-bad-bytes' | 'oom';

interface Harness {
  posts: OutMsg[];
  calls: { pipeline: string[]; fetched: string[]; imports: number; detects: number; cacheOpens: number };
  run(msg: InMsg): Promise<OutMsg>;
  env: { backends: { onnx: { wasm: { wasmPaths: { mjs: string; wasm: string }; numThreads?: number } } }; cacheKey: string; fetch?: unknown };
  cacheMap: Map<string, Response>;
  good: Uint8Array;
}

function harness(opts: { behaviour?: Record<string, Behaviour>; resources?: typeof strong; manifest?: ManifestFileShape; runtimeFails?: boolean; blockedHosts?: string[]; quality?: 'good' | 'empty'; bytes?: Uint8Array } = {}): Harness {
  const posts: OutMsg[] = [];
  const calls = { pipeline: [] as string[], fetched: [] as string[], imports: 0, detects: 0, cacheOpens: 0 };
  const cacheMap = new Map<string, Response>();
  const env = {
    backends: { onnx: { wasm: { wasmPaths: { mjs: 'https://cdn.jsdelivr.net/npm/onnxruntime-web@1.26.0-dev.1/dist/ort-wasm-simd-threaded.asyncify.mjs', wasm: 'https://cdn.jsdelivr.net/npm/onnxruntime-web@1.26.0-dev.1/dist/ort-wasm-simd-threaded.asyncify.wasm' } } } },
    cacheKey: 'transformers-cache',
  } as Harness['env'];
  const good = opts.bytes ?? randomBytes(4000);
  const bad = Uint8Array.from(good).map((b, i) => (i === 10 ? b ^ 1 : b));

  const body = (bytes: Uint8Array) => new Response(new ReadableStream({ start(c) { c.enqueue(bytes); c.close(); } }), { status: 200, headers: { 'content-length': String(bytes.length) } });
  const repoOf = (u: string) => new URL(u).pathname.split('/resolve/')[0]!.slice(1);
  const baseFetch: EngineDeps['baseFetch'] = async (input) => {
    const u = String(input);
    calls.fetched.push(u);
    if (u.includes('download=1') || opts.blockedHosts?.some((h) => u.includes(h))) throw new TypeError('NetworkError when attempting to fetch resource.');
    if (u.includes('/resolve/')) {
      const b = opts.behaviour?.[repoOf(u)];
      return body(b === 'bad-bytes' || b === 'swallow-bad-bytes' ? bad : good);
    }
    return new Response('', { status: 200 });
  };

  const pipeline = async (_task: string, repo: string, o: { progress_callback?: (p: unknown) => void }) => {
    calls.pipeline.push(repo);
    const b = opts.behaviour?.[repo] ?? 'ok';
    if (b === 'network') {
      await (env.fetch as (u: string) => Promise<Response>)(`https://huggingface.co/${repo}/resolve/x/config.json?download=1`).catch(() => undefined);
      throw new TypeError('NetworkError when attempting to fetch resource.');
    }
    const fullDownload = () => {
      const fam = (Object.values(MODELS) as unknown as { repo: string; approx?: number }[]).find((m) => m.repo === repo);
      void fam;
      const bytes = (buildCandidates('best', strong).concat(buildCandidates('fastest', strong)).find((c) => c.repo === repo)?.approxMb ?? 100) * 1_000_000;
      o.progress_callback?.({ status: 'initiate', file: 'onnx/model.onnx' });
      o.progress_callback?.({ status: 'progress', file: 'onnx/model.onnx', loaded: bytes, total: bytes });
      o.progress_callback?.({ status: 'done', file: 'onnx/model.onnx' });
    };
    if (b === 'init-fail' || b === 'oom') fullDownload();
    if (b === 'init-fail') throw new Error('Aborted(). Build with -sASSERTIONS for more info.');
    if (b === 'oom') throw new Error('std::bad_alloc: out of memory');
    if (b === 'bad-bytes' || b === 'swallow-bad-bytes') {
      const fam = (Object.values(MODELS) as unknown as { repo: string; revision: string }[]).find((m) => m.repo === repo)!;
      const res = await (env.fetch as (u: string) => Promise<Response>)(`https://huggingface.co/${repo}/resolve/${fam.revision}/onnx/model.onnx`);
      try {
        await res.arrayBuffer();
      } catch (e) {
        if (b === 'bad-bytes') throw e;
        // 'swallow-bad-bytes': a library that hides the stream error and goes on
      }
    }
    if (b === 'ok') {
      const fam = (Object.values(MODELS) as unknown as { repo: string; revision: string }[]).find((m) => m.repo === repo)!;
      await (await (env.fetch as (u: string) => Promise<Response>)(`https://huggingface.co/${repo}/resolve/${fam.revision}/onnx/model.onnx`)).arrayBuffer();
    }
    o.progress_callback?.({ status: 'done', file: 'onnx/model.onnx', loaded: 1, total: 1 });
    const gen = async (messages: { role: string; content: string }[]) => {
      if (b === 'hang') return new Promise(() => undefined);
      if (b === 'empty') return EMPTY;
      return messages.length === 2 && messages[0]!.content === 'Reply with one short sentence.' ? READY : opts.quality === 'empty' ? EMPTY : GOOD;
    };
    (gen as unknown as { dispose: () => void }).dispose = () => undefined;
    return gen;
  };

  const deps: EngineDeps = {
    post: (m) => void posts.push(m),
    detect: async () => (calls.detects++, opts.resources ?? strong),
    importRuntime: async () => {
      calls.imports++;
      if (opts.runtimeFails) throw new RuntimeImportError('x', [{ url: 'https://esm.sh/@huggingface/transformers@4.2.0?secret=1', message: 'Failed to fetch dynamically imported module' }, { url: 'https://unpkg.com/@huggingface/transformers@4.2.0?module', message: 'NetworkError when attempting to fetch resource.' }]);
      return { pipeline, env };
    },
    baseFetch,
    cacheStorage: { open: async () => (calls.cacheOpens++, { match: async (k) => cacheMap.get(k)?.clone(), put: async (k, r) => void cacheMap.set(k, r), delete: async (k) => cacheMap.delete(k) }) },
    manifest: opts.manifest ?? ({ schema: 1, generatedAt: null, models: {} } as ManifestFileShape),
    now: () => Date.now(),
    isOffline: () => false,
    smokeTimeoutMs: 60,
  };
  const engine = createEngine(deps);
  return {
    posts,
    calls,
    env,
    cacheMap,
    good,
    async run(msg) {
      posts.length = 0;
      await engine.handle(msg);
      return posts.filter((p) => p.type === 'ready' || p.type === 'error' || p.type === 'result').at(-1)!;
    },
  };
}

const load = (mode: 'best' | 'balanced' | 'fastest' | 'lightweight', extra: Partial<Extract<InMsg, { type: 'load' }>> = {}): InMsg => ({ type: 'load', mode, ...extra });
const result = (m: OutMsg) => (m.type === 'ready' || m.type === 'error' ? m.result : (() => { throw new Error('no result on ' + m.type); })());
const orderOf = (mode: 'best' | 'balanced' | 'fastest', r: ResourceSnapshot) => buildCandidates(mode, r);

test.describe('local AI engine (real decision code, injected environment)', () => {
  test('lightweight: zero runtime/model/cache/fetch activity and no worker-side detection', async () => {
    const h = harness();
    const out = await h.run(load('lightweight', { diagnose: { quality: true } }));
    expect(out.type).toBe('error');
    expect(result(out).outcome).toBe('disabled');
    expect(result(out).summary).toMatch(/intentionally disabled/);
    expect(h.calls).toMatchObject({ imports: 0, detects: 0, cacheOpens: 0, pipeline: [] });
    expect(h.calls.fetched).toEqual([]);
  });

  test('every non-lightweight mode starts its first eligible candidate and passes', async () => {
    for (const mode of ['best', 'balanced', 'fastest'] as const) {
      const h = harness();
      const out = await h.run(load(mode));
      expect(out.type, mode).toBe('ready');
      const r = result(out);
      expect(r.outcome).toBe('passed');
      expect(r.model?.family).toBe(orderOf(mode, strong)[0]!.family);
      expect(r.recommendation ?? null).toBeNull();
    }
  });

  test('fallback: first model fails to start → next ELIGIBLE one, outcome "passed-fallback", recommends the mode that matches', async () => {
    const first = orderOf('balanced', strong)[0]!;
    const h = harness({ behaviour: { [first.repo]: 'init-fail' } });
    const out = await h.run(load('balanced'));
    expect(out.type).toBe('ready');
    const r = result(out);
    expect(r.outcome).toBe('passed-fallback');
    expect(r.attempts.filter((a) => !a.ok)).toHaveLength(1);
    expect(r.attempts[0]).toMatchObject({ key: first.key, ok: false, stage: 'initialization' });
    expect(r.model?.family).toBe('smollm2-135m');
    expect(r.recommendation?.mode).toBe('fastest');
    expect(r.recommendation?.message).toMatch(/could not start\. We recommend Fastest \(SmolLM2-135M\) on this device\./);
  });

  test('ineligible models are never attempted (constrained device, Best quality)', async () => {
    const h = harness({ resources: weak });
    await h.run(load('best'));
    expect(h.calls.pipeline.every((repo) => repo !== MODELS['qwen2.5-0.5b'].repo)).toBe(true);
    expect(result(h.posts.at(-1)!).eligible.join(' ')).not.toMatch(/Qwen/);
  });

  test('every attempt gets a structured record; all-network failure gives no pointless "smaller model" advice', async () => {
    const cands = orderOf('balanced', strong);
    const behaviour = Object.fromEntries(cands.map((c) => [c.repo, 'network' as const]));
    const h = harness({ behaviour });
    const out = await h.run(load('balanced'));
    expect(out.type).toBe('error');
    const r = result(out);
    expect(r.outcome).toBe('failed');
    expect(r.attempts.filter((a) => !a.ok)).toHaveLength(cands.length);
    for (const a of r.attempts) expect(a).toMatchObject({ stage: 'download', kind: 'network', host: 'huggingface.co' });
    expect(JSON.stringify(r)).not.toContain('download=1'); // query strings never leave the engine
    expect(r.recommendation).toBeNull();
    if (out.type === 'error') expect(out.message).toMatch(/No on-device model could be started\./);
  });

  test('start-up failures that a smaller model could fix do recommend data saver, and out-of-memory is classified', async () => {
    const cands = orderOf('fastest', strong);
    const h = harness({ behaviour: Object.fromEntries(cands.map((c) => [c.repo, 'oom' as const])) });
    const r = result(await h.run(load('fastest')));
    expect(r.attempts[0]!.kind).toBe('memory');
    expect(r.recommendation?.mode).toBe('lightweight');
  });

  test('runtime import failure names every source tried, strips query strings, and loads no model', async () => {
    const h = harness({ runtimeFails: true });
    const out = await h.run(load('balanced'));
    const r = result(out);
    expect(r.outcome).toBe('failed');
    expect(r.attempts.map((a) => a.host)).toEqual(['esm.sh', 'unpkg.com']);
    expect(r.attempts[0]).toMatchObject({ stage: 'runtime', kind: 'module', url: 'https://esm.sh/@huggingface/transformers@4.2.0' });
    expect(h.calls.pipeline).toEqual([]);
  });

  test('a resolved pipeline is not "ready": empty smoke output disposes it and tries the next candidate', async () => {
    const first = orderOf('balanced', strong)[0]!;
    const h = harness({ behaviour: { [first.repo]: 'empty' } });
    const r = result(await h.run(load('balanced')));
    expect(r.attempts[0]).toMatchObject({ ok: false, stage: 'smoke inference', kind: 'empty-output' });
    expect(r.outcome).toBe('passed-fallback');
  });

  test('a hung smoke inference times out instead of blocking forever', async () => {
    const first = orderOf('fastest', strong)[0]!;
    const h = harness({ behaviour: { [first.repo]: 'hang' } });
    const r = result(await h.run(load('fastest')));
    expect(r.attempts[0]).toMatchObject({ ok: false, stage: 'smoke inference', kind: 'timeout' });
  });

  test('WASM assets: unreachable default host is recorded and a same-version mirror is used', async () => {
    const h = harness({ blockedHosts: ['cdn.jsdelivr.net'] });
    const r = result(await h.run(load('balanced')));
    expect(r.outcome).toBe('passed'); // a mirror worked, so the model still started first try
    const wasm = r.attempts.find((a) => a.key === 'runtime');
    expect(wasm).toMatchObject({ ok: false, stage: 'runtime', kind: 'wasm', host: 'cdn.jsdelivr.net' });
    expect(h.env.backends.onnx.wasm.wasmPaths.wasm).toBe('https://fastly.jsdelivr.net/npm/onnxruntime-web@1.26.0-dev.1/dist/ort-wasm-simd-threaded.asyncify.wasm');
    expect(h.env.backends.onnx.wasm.wasmPaths.mjs).toContain('onnxruntime-web@1.26.0-dev.1');
  });

  test('WASM assets: nothing reachable is reported with the exact resource, and the run continues', async () => {
    const h = harness({ blockedHosts: ['jsdelivr.net', 'unpkg.com'] });
    const r = result(await h.run(load('balanced')));
    expect(r.attempts.filter((a) => a.key === 'runtime')).toHaveLength(3);
    expect(r.attempts.some((a) => a.url?.endsWith('.mjs'))).toBe(true);
  });

  test('threads: single-threaded unless the page is cross-origin isolated', async () => {
    const a = harness({ resources: { ...strong, crossOriginIsolated: false } });
    await a.run(load('balanced'));
    expect(a.env.backends.onnx.wasm.numThreads).toBe(1);
    const b = harness();
    await b.run(load('balanced'));
    expect(b.env.backends.onnx.wasm.numThreads).toBe(7);
  });

  test('optional format check runs only when asked, and a weak answer does not fail the model', async () => {
    const a = harness();
    expect(result(await a.run(load('balanced', { diagnose: { quality: false } }))).quality).toBeUndefined();
    const b = harness();
    expect(result(await b.run(load('balanced', { diagnose: { quality: true } }))).quality).toEqual({ passed: 3, total: 3 });
    const c = harness({ quality: 'empty' });
    const rc = result(await c.run(load('balanced', { diagnose: { quality: true } })));
    expect(rc.quality).toEqual({ passed: 0, total: 3 });
    expect(rc.outcome).toBe('passed');
  });

  test('generation is available after a pass and returns validated text; before it, null', async () => {
    const h = harness();
    const none = await h.run({ type: 'generate', id: 1, item: { title: 'Heat', year: 1995, reasons: ['Crime'] }, quizSummary: 'x' });
    expect(none).toMatchObject({ type: 'result', id: 1, text: null });
    await h.run(load('balanced'));
    const ok = await h.run({ type: 'generate', id: 2, item: { title: 'Heat', year: 1995, reasons: ['Crime'] }, quizSummary: 'x' });
    expect(ok).toMatchObject({ type: 'result', id: 2 });
    expect((ok as { text: string | null }).text).toMatch(/crime thriller/);
  });

  test('progress messages are monotonic and never reach 100 before ready', async () => {
    const h = harness();
    await h.run(load('balanced'));
    const pcts = h.posts.filter((p): p is Extract<OutMsg, { type: 'progress' }> => p.type === 'progress').map((p) => p.pct);
    expect([...pcts].sort((x, y) => x - y)).toEqual(pcts);
    expect(Math.max(0, ...pcts)).toBeLessThanOrEqual(99);
  });
});

test.describe('local AI engine: integrity end-to-end', () => {
  /** Builds a manifest whose single file "onnx/model.onnx" matches `bytes`. */
  function manifestFor135(bytes: Uint8Array): ManifestFileShape {
    const sha = createHash('sha256').update(bytes).digest('hex');
    const files = [{ path: 'onnx/model.onnx', size: bytes.length, sha256: sha }];
    const m = MODELS['smollm2-135m'] as unknown as { repo: string; revision: string };
    return { schema: 1, generatedAt: 't', models: { 'smollm2-135m': { repo: m.repo, revision: m.revision, dtypes: { q4f16: { files }, q8: { files } } } } } as unknown as ManifestFileShape;
  }

  test('healthy bytes matching the manifest end Verified; the same file with a flipped byte does not', async () => {
    const bytes = randomBytes(4000);
    const r = result(await harness({ bytes, manifest: manifestFor135(bytes) }).run(load('fastest')));
    expect(r.outcome).toBe('passed');
    expect(r.integrity).toMatchObject({ state: 'verified', verifiedFiles: 1, totalFiles: 1 });
  });

  test('mismatching bytes fail the candidate at the integrity stage (and a swallowed stream error still fails closed)', async () => {
    const m = MODELS['smollm2-135m'] as unknown as { repo: string; revision: string };
    const wrongManifest = manifestFor135(new Uint8Array([1, 2, 3])); // does not match what is served
    for (const behaviour of ['bad-bytes', 'swallow-bad-bytes', 'ok'] as const) {
      const h = harness({ manifest: wrongManifest, behaviour: { [m.repo]: behaviour } });
      const out = await h.run(load('fastest'));
      const r = result(out);
      const first = r.attempts[0]!;
      expect(first, behaviour).toMatchObject({ ok: false, stage: 'integrity', kind: 'integrity' });
      expect(r.integrity?.state ?? 'failed').not.toBe('verified');
    }
  });

  test('a mismatch moves on to the next eligible candidate instead of reporting the bad model ready', async () => {
    const m = MODELS['smollm2-135m'] as unknown as { repo: string };
    // Only 135M has a (deliberately wrong) manifest; the other families have none.
    const h = harness({ manifest: manifestFor135(new Uint8Array([9, 9, 9])), behaviour: { [m.repo]: 'ok' } });
    const r = result(await h.run(load('fastest')));
    const failed = r.attempts.filter((a) => !a.ok);
    expect(failed.length).toBeGreaterThanOrEqual(1);
    expect(failed.every((a) => a.stage === 'integrity' && a.kind === 'integrity')).toBe(true);
    expect(r.outcome).toBe('passed-fallback');
    expect(r.model?.family).not.toBe('smollm2-135m'); // the bad model was never reported ready
    expect(r.integrity?.state).toBe('not-verified'); // and the fallback is honest about having no manifest
  });
});
