import assert from 'node:assert/strict';
import { createEngine, type EngineDeps, type InMsg, type OutMsg } from '../src/lib/ai-engine';
import { buildCandidates, MODELS } from '../src/lib/ai-policy';
import { detectDevice, type DeviceNavigator } from '../src/lib/ai-worker';
import type { ManifestFileShape } from '../src/lib/ai-integrity';

// Shared brute-force matrix cases for the decision code: 3 model families ×
// 2 backends × 4 modes × 7 device profiles. Environment dependencies are
// injected, and GPU adapter detection is exercised through detectDevice() with
// mocked requestAdapter() responses. No CDN or real model weight is ever downloaded.

const HOST = 'https://moodsift.example/models/';
const MODES = ['best', 'balanced', 'fastest', 'lightweight'] as const;

export interface ProfileDefinition {
  deviceMemoryGb?: number;
  cores: number;
  mobile: boolean;
  crossOriginIsolated: boolean;
  gpu?: {
    adapter?: { features: { has(f: string): boolean } } | null;
    requestFails?: boolean;
  } | null;
}

export const profiles: Record<string, ProfileDefinition> = {
  'high-end webgpu': {
    deviceMemoryGb: 16,
    cores: 12,
    mobile: false,
    crossOriginIsolated: true,
    gpu: { adapter: { features: new Set(['shader-f16']) } },
  },
  'mid webgpu': {
    deviceMemoryGb: 8,
    cores: 8,
    mobile: false,
    crossOriginIsolated: true,
    gpu: { adapter: { features: new Set(['shader-f16']) } },
  },
  'desktop no gpu': {
    deviceMemoryGb: 8,
    cores: 8,
    mobile: false,
    crossOriginIsolated: true,
    gpu: { adapter: null },
  },
  '4 GB laptop': {
    deviceMemoryGb: 4,
    cores: 4,
    mobile: false,
    crossOriginIsolated: false,
    gpu: null,
  },
  '2 GB phone': {
    deviceMemoryGb: 2,
    cores: 2,
    mobile: true,
    crossOriginIsolated: false,
    gpu: null,
  },
  'unknown memory safari': {
    deviceMemoryGb: undefined,
    cores: 4,
    mobile: false,
    crossOriginIsolated: false,
    gpu: null,
  },
  'phone with webgpu': {
    deviceMemoryGb: 6,
    cores: 8,
    mobile: true,
    crossOriginIsolated: true,
    gpu: { adapter: { features: new Set(['shader-f16']) } },
  },
};

export function mockNavigator(profile: ProfileDefinition): DeviceNavigator {
  const nav: DeviceNavigator = {
    deviceMemory: profile.deviceMemoryGb,
    hardwareConcurrency: profile.cores,
    userAgentData: { mobile: profile.mobile },
    userAgent: profile.mobile ? 'iPhone' : 'Macintosh',
  };
  if (profile.gpu !== null && profile.gpu !== undefined) {
    nav.gpu = {
      async requestAdapter() {
        if (profile.gpu?.requestFails) {
          throw new Error('GPU requestAdapter failed');
        }
        return profile.gpu?.adapter ?? null;
      },
    };
  }
  return nav;
}

const READY = [{ generated_text: [{ role: 'assistant', content: 'Ready to help.' }] }];
const GOOD = [{ generated_text: [{ role: 'assistant', content: 'A tense, well-rated crime thriller that fits your mood.' }] }];
const bytes = new Uint8Array(512);
crypto.getRandomValues(bytes);

export interface PipelineCall {
  task: string;
  repo: string;
  options?: {
    revision?: string;
    device?: string;
    dtype?: string;
    progress_callback?: unknown;
  };
}

export interface HarnessOptions {
  /** Number of initial pipeline() calls to fail before succeeding, or a predicate */
  failPipelineAttempts?: number | ((repo: string, attemptIndex: number) => boolean);
}

export function harness(profile: ProfileDefinition, options?: HarnessOptions) {
  const posts: OutMsg[] = [];
  const pipeline: string[] = [];
  const pipelineCalls: PipelineCall[] = [];
  const fetched: string[] = [];
  const allRequests: string[] = [];
  let attemptCount = 0;

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

  const pipelineFn = async (
    _task: string,
    repo: string,
    opts?: { revision?: string; device?: string; dtype?: string; progress_callback?: unknown },
  ) => {
    const currentAttempt = attemptCount++;
    pipeline.push(repo);
    pipelineCalls.push({ task: _task, repo, options: opts });

    const shouldFail = typeof options?.failPipelineAttempts === 'function'
      ? options.failPipelineAttempts(repo, currentAttempt)
      : typeof options?.failPipelineAttempts === 'number'
        ? currentAttempt < options.failPipelineAttempts
        : false;

    if (shouldFail) {
      throw new Error(`Simulated pipeline construction failure for ${repo} (attempt ${currentAttempt})`);
    }

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
    detect: (coarsePointer) => detectDevice(mockNavigator(profile), profile.crossOriginIsolated, coarsePointer),
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
    pipelineCalls,
    fetched,
    allRequests,
    async run(msg: InMsg): Promise<OutMsg> {
      posts.length = 0;
      await engine.handle(msg);
      return posts.filter((p) => p.type === 'ready' || p.type === 'error' || p.type === 'result').at(-1)!;
    },
    detectSnapshot: (coarsePointer = false) => detectDevice(mockNavigator(profile), profile.crossOriginIsolated, coarsePointer),
  };
}

const load = (mode: (typeof MODES)[number]): InMsg => ({ type: 'load', mode });
const outcome = (m: OutMsg) => (m.type === 'ready' || m.type === 'error' ? m.result : null);

export async function testAdapterDetection(): Promise<void> {
  // 1. Absent navigator.gpu
  const noGpu = await detectDevice({ gpu: undefined });
  assert.equal(noGpu.webgpuApi, false);
  assert.equal(noGpu.webgpuAdapter, false);

  // 2. navigator.gpu present, requestAdapter() returns null
  const nullAdapter = await detectDevice({
    gpu: { requestAdapter: async () => null },
  });
  assert.equal(nullAdapter.webgpuApi, true);
  assert.equal(nullAdapter.webgpuAdapter, false);

  // 3. Adapter present without shader-f16
  const noF16 = await detectDevice({
    gpu: { requestAdapter: async () => ({ features: new Set(['depth-clip-control']) }) },
  });
  assert.equal(noF16.webgpuApi, true);
  assert.equal(noF16.webgpuAdapter, false);

  // 4. requestAdapter() throws error
  const throwing = await detectDevice({
    gpu: {
      requestAdapter: async () => {
        throw new Error('Adapter error');
      },
    },
  });
  assert.equal(throwing.webgpuApi, true);
  assert.equal(throwing.webgpuAdapter, false);

  // 5. Adapter present with shader-f16
  const valid = await detectDevice({
    gpu: { requestAdapter: async () => ({ features: new Set(['shader-f16']) }) },
  });
  assert.equal(valid.webgpuApi, true);
  assert.equal(valid.webgpuAdapter, true);
}

export async function testLightweightInert(): Promise<void> {
  for (const [name, prof] of Object.entries(profiles)) {
    const h = harness(prof);
    const out = await h.run(load('lightweight'));
    const r = outcome(out);
    assert.equal(r?.outcome, 'disabled', name);
    assert.deepEqual(h.pipeline, [], name);
    assert.deepEqual(h.fetched, [], name);
  }
}

export async function testEligibleCandidatesPolicyOrder(): Promise<void> {
  for (const [name, prof] of Object.entries(profiles)) {
    const resources = await harness(prof).detectSnapshot();
    for (const mode of MODES) {
      if (mode === 'lightweight') continue;
      const policy = buildCandidates(mode, resources);

      // Part A: first candidate succeeds; verify attempt order and options
      {
        const h = harness(prof);
        const out = await h.run(load(mode));
        const r = outcome(out);
        assert.ok(r !== null, `${name}/${mode}`);
        const modelAttempts = r!.attempts.filter((a) => a.key !== 'runtime');
        if (policy.length > 0) {
          const first = policy[0]!;
          assert.equal(h.pipeline[0], first.repo, `${name}/${mode}: first pipeline`);
          const call = h.pipelineCalls[0];
          assert.ok(call, `${name}/${mode}: pipeline call must exist`);
          assert.equal(call.options?.device, first.backend, `${name}/${mode}: backend mismatch`);
          assert.equal(call.options?.dtype, first.dtype, `${name}/${mode}: dtype mismatch`);
          assert.equal(call.options?.revision, first.revision, `${name}/${mode}: revision mismatch`);
        }
        const eligibleRepos = new Set(policy.map((c) => c.repo));
        for (const repo of h.pipeline) {
          assert.ok(eligibleRepos.has(repo), `${name}/${mode}: attempted ineligible ${repo}`);
        }
        assert.ok(modelAttempts.length <= policy.length, `${name}/${mode}: attempt count`);
        assert.equal(r!.outcome, 'passed', `${name}/${mode}`);
      }

      // Part B: Fallback candidate attempt order under candidate failure
      if (policy.length > 1) {
        const fallbacksToFail = policy.length - 1;
        const hFallback = harness(prof, { failPipelineAttempts: fallbacksToFail });
        const outFallback = await hFallback.run(load(mode));
        const rFallback = outcome(outFallback);
        assert.ok(rFallback !== null, `${name}/${mode} fallback`);
        assert.equal(rFallback!.outcome, 'passed-fallback', `${name}/${mode} fallback outcome`);

        const attemptedKeys = rFallback!.attempts
          .filter((a) => a.key !== 'runtime')
          .map((a) => a.key);
        const expectedKeys = policy.map((c) => c.key);
        assert.deepEqual(attemptedKeys, expectedKeys, `${name}/${mode}: fallback attempt sequence mismatch`);

        assert.deepEqual(
          hFallback.pipeline,
          policy.map((c) => c.repo),
          `${name}/${mode}: pipeline call sequence mismatch`,
        );

        for (let i = 0; i < policy.length; i++) {
          const call = hFallback.pipelineCalls[i]!;
          const cand = policy[i]!;
          assert.equal(call.options?.device, cand.backend, `${name}/${mode}[${i}]: fallback backend mismatch`);
          assert.equal(call.options?.dtype, cand.dtype, `${name}/${mode}[${i}]: fallback dtype mismatch`);
          assert.equal(call.options?.revision, cand.revision, `${name}/${mode}[${i}]: fallback revision mismatch`);
        }

        const lastCand = policy[policy.length - 1]!;
        assert.equal(rFallback!.model?.family, lastCand.family);
        assert.equal(rFallback!.model?.backend, lastCand.backend);
        assert.equal(rFallback!.model?.dtype, lastCand.dtype);
        assert.equal(rFallback!.model?.revision, lastCand.revision);
      }
    }
  }
}

export async function testWebGpuAdapterSelection(): Promise<void> {
  for (const [name, prof] of Object.entries(profiles)) {
    const h = harness(prof);
    const resources = await h.detectSnapshot();
    await h.run(load('best'));
    const policy = buildCandidates('best', resources);
    const first = policy[0]!;
    assert.equal(first.backend, resources.webgpuAdapter ? 'webgpu' : 'wasm', name);
    assert.equal(h.pipeline[0], first.repo, name);

    // Verify 3rd pipeline() argument matches expected policy candidate
    const call = h.pipelineCalls[0];
    assert.ok(call, `${name}: pipeline must be called`);
    assert.equal(call.options?.device, first.backend, `${name}: runtime device backend mismatch`);
    assert.equal(call.options?.dtype, first.dtype, `${name}: runtime dtype mismatch`);
    assert.equal(call.options?.revision, first.revision, `${name}: runtime revision mismatch`);
  }
}

export async function testConstrainedProfiles(): Promise<void> {
  for (const name of ['4 GB laptop', '2 GB phone']) {
    for (const mode of ['best', 'balanced', 'fastest'] as const) {
      const h = harness(profiles[name]!);
      await h.run(load(mode));
      assert.ok(h.pipeline.every((repo) => repo === MODELS['smollm2-135m'].repo), `${name}/${mode}`);
    }
  }
}

export async function testUnknownMemoryAndMobile(): Promise<void> {
  for (const name of ['unknown memory safari', 'phone with webgpu', 'desktop no gpu']) {
    const h = harness(profiles[name]!);
    const r = outcome(await h.run(load('balanced')));
    assert.equal(r?.outcome, 'passed', name);
    assert.ok(r?.model !== null, name);
  }
}

export async function testSingleDownloadOnGeneration(): Promise<void> {
  const h = harness(profiles['mid webgpu']!);
  await h.run(load('balanced'));
  const pipelines = h.pipeline.length;
  const requestCount = h.allRequests.length;
  const out = await h.run({ type: 'generate', id: 7, item: { title: 'Heat', year: 1995, reasons: ['Crime thriller'] }, quizSummary: 'tense' });
  assert.equal(out.type, 'result');
  assert.equal((out as { id: number }).id, 7);
  assert.equal(h.pipeline.length, pipelines);
  assert.equal(h.allRequests.length, requestCount);
}
