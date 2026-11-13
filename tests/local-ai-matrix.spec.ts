import { randomBytes } from 'node:crypto';
import { expect, test } from '@playwright/test';
import { createEngine, type EngineDeps, type InMsg, type OutMsg } from '../src/lib/ai-engine';
import { buildCandidates, MODELS, type ResourceSnapshot } from '../src/lib/ai-policy';
import type { ManifestFileShape } from '../src/lib/ai-integrity';

// Brute-force matrix for the decision code: 3 model families × 2 backends ×
// 4 modes × 7 device profiles. Every environment dependency is injected, so no
// CDN, WASM binary or model weight is ever downloaded.

const HOST = 'https://moodsift.example/models/';
const MODES = ['best', 'balanced', 'fastest', 'lightweight'] as const;

type Profile = ResourceSnapshot & { webgpuApi: boolean };
const profiles: Record<string, Profile> = {
  'high-end webgpu': { deviceMemoryGb: 16, cores: 12, mobile: false, webgpuAdapter: true, crossOriginIsolated: true, webgpuApi: true },
  'mid webgpu': { deviceMemoryGb: 8, cores: 8, mobile: false, webgpuAdapter: true, crossOriginIsolated: true, webgpuApi: true },
  'desktop no gpu': { deviceMemoryGb: 8, cores: 8, mobile: false, webgpuAdapter: false, crossOriginIsolated: true, webgpuApi: true },
  '4 GB laptop': { deviceMemoryGb: 4, cores: 4, mobile: false, webgpuAdapter: false, crossOriginIsolated: false, webgpuApi: false },
  '2 GB phone': { deviceMemoryGb: 2, cores: 2, mobile: true, webgpuAdapter: false, crossOriginIsolated: false, webgpuApi: false },
  'unknown memory safari': { deviceMemoryGb: undefined, cores: 4, mobile: false, webgpuAdapter: false, crossOriginIsolated: false, webgpuApi: false },
  'phone with webgpu': { deviceMemoryGb: 6, cores: 8, mobile: true, webgpuAdapter: true, crossOriginIsolated: true, webgpuApi: true },
};

const READY = [{ generated_text: [{ role: 'assistant', content: 'Ready to help.' }] }];
const GOOD = [{ generated_text: [{ role: 'assistant', content: 'A tense, well-rated crime thriller that fits your mood.' }] }];
const bytes = randomBytes(512);

function harness(resources: Profile) {
  const posts: OutMsg[] = [];
  const pipeline: string[] = [];
  const fetched: string[] = [];
  const allRequests: string[] = [];
  const env = {
    backends: { onnx: { wasm: { wasmPaths: { mjs: 'https://cdn.jsdelivr.net/npm/onnxruntime-web@1.26.0-dev.1/dist/ort-wasm-simd-threaded.asyncify.mjs', wasm: 'https://cdn.jsdelivr.net/npm/onnxruntime-web@1.26.0-dev.1/dist/ort-wasm-simd-threaded.asyncify.wasm' } } } },
    cacheKey: 'transformers-cache',
  } as unknown as Record<string, unknown>;

  const baseFetch: EngineDeps['baseFetch'] = async (input) => {
    const url = String(input);
    allRequests.push(url);
    if (url.includes('/resolve/')) {
      fetched.push(url);
      return new Response(new ReadableStream({ start(c) { c.enqueue(bytes); c.close(); } }), { status: 200, headers: { 'content-length': String(bytes.length) } });
    }
    return new Response('', { status: 200 });
  };

  const pipelineFn = async (_task: string, repo: string) => {
    pipeline.push(repo);
    const fam = (Object.values(MODELS) as { repo: string; revision: string }[]).find((m) => m.repo === repo)!;
    const res = await (env as { fetch?: (u: string) => Promise<Response> }).fetch?.(`${HOST}${repo}/resolve/${fam.revision}/onnx/model.onnx`);
    await res?.arrayBuffer();
    const gen = async (messages: { role: string; content: string }[]) =>
      messages.length === 2 && messages[0]!.content === 'Reply with one short sentence.' ? READY : GOOD;
    (gen as unknown as { dispose: () => void }).dispose = () => undefined;
    return gen;
  };

  const deps: EngineDeps = {
    post: (m) => void posts.push(m),
    detect: async () => resources,
    importRuntime: async () => ({ pipeline: pipelineFn, env }),
    baseFetch,
    cacheStorage: { open: async () => ({ match: async () => undefined, put: async () => undefined, delete: async () => false }) },
    manifest: { schema: 1, generatedAt: null, models: {} } as ManifestFileShape,
    modelHost: HOST,
    now: () => Date.now(),
    isOffline: () => false,
    smokeTimeoutMs: 60,
  };
  const engine = createEngine(deps);
  return {
    pipeline,
    fetched,
    allRequests,
    async run(msg: InMsg): Promise<OutMsg> {
      posts.length = 0;
      await engine.handle(msg);
      return posts.filter((p) => p.type === 'ready' || p.type === 'error' || p.type === 'result').at(-1)!;
    },
  };
}

const load = (mode: (typeof MODES)[number]): InMsg => ({ type: 'load', mode });
const outcome = (m: OutMsg) => (m.type === 'ready' || m.type === 'error' ? m.result : null);

test.describe('AI engine brute-force matrix', () => {
  test('lightweight is inert on every device profile', async () => {
    for (const [name, resources] of Object.entries(profiles)) {
      const h = harness(resources);
      const out = await h.run(load('lightweight'));
      const r = outcome(out);
      expect(r?.outcome, name).toBe('disabled');
      expect(h.pipeline, name).toEqual([]);
      expect(h.fetched, name).toEqual([]);
    }
  });

  test('every mode × profile attempts only policy-eligible candidates, in policy order', async () => {
    for (const [name, resources] of Object.entries(profiles)) {
      for (const mode of MODES) {
        if (mode === 'lightweight') continue;
        const policy = buildCandidates(mode, resources);
        const h = harness(resources);
        const out = await h.run(load(mode));
        const r = outcome(out);
        expect(r, `${name}/${mode}`).not.toBeNull();
        // The first model attempt must be the first eligible candidate.
        const modelAttempts = r!.attempts.filter((a) => !['runtime'].includes(a.key));
        if (policy.length > 0) {
          const firstRepo = policy[0]!.repo;
          expect(h.pipeline[0], `${name}/${mode}: first pipeline`).toBe(firstRepo);
        }
        const eligibleRepos = new Set(policy.map((c) => c.repo));
        for (const repo of h.pipeline) expect(eligibleRepos.has(repo), `${name}/${mode}: attempted ineligible ${repo}`).toBe(true);
        // No more attempts than eligible candidates (+runtime probes).
        expect(modelAttempts.length, `${name}/${mode}: attempt count`).toBeLessThanOrEqual(policy.length);
        expect(r!.outcome, `${name}/${mode}`).toBe('passed');
      }
    }
  });

  test('WebGPU is used first exactly when an adapter exists; otherwise WASM starts', async () => {
    for (const [name, resources] of Object.entries(profiles)) {
      const h = harness(resources);
      await h.run(load('best'));
      const policy = buildCandidates('best', resources);
      const first = policy[0]!;
      expect(first.backend, name).toBe(resources.webgpuAdapter ? 'webgpu' : 'wasm');
      expect(h.pipeline[0], name).toBe(first.repo);
    }
  });

  test('constrained profiles never touch the larger model families', async () => {
    for (const name of ['4 GB laptop', '2 GB phone']) {
      for (const mode of ['best', 'balanced', 'fastest'] as const) {
        const h = harness(profiles[name]!);
        await h.run(load(mode));
        expect(h.pipeline, `${name}/${mode}`).toEqual(expect.arrayContaining([]));
        expect(h.pipeline.every((repo) => repo === MODELS['smollm2-135m'].repo), `${name}/${mode}`).toBe(true);
      }
    }
  });

  test('unknown memory and mobile profiles still resolve to a working candidate', async () => {
    for (const name of ['unknown memory safari', 'phone with webgpu', 'desktop no gpu']) {
      const h = harness(profiles[name]!);
      const r = outcome(await h.run(load('balanced')));
      expect(r?.outcome, name).toBe('passed');
      expect(r?.model, name).not.toBeNull();
    }
  });

  test('a successful load followed by generation never downloads a second model', async () => {
    const h = harness(profiles['mid webgpu']!);
    await h.run(load('balanced'));
    const pipelines = h.pipeline.length;
    const requestCount = h.allRequests.length;
    const out = await h.run({ type: 'generate', id: 7, item: { title: 'Heat', year: 1995, reasons: ['Crime thriller'] }, quizSummary: 'tense' });
    expect(out).toMatchObject({ type: 'result', id: 7 });
    expect(h.pipeline.length).toBe(pipelines);
    expect(h.allRequests.length).toBe(requestCount);
  });
});
