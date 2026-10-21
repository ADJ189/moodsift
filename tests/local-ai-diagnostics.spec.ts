import { expect, test } from '@playwright/test';
import { buildCandidates, type ResourceSnapshot } from '../src/lib/ai-policy';
import {
  browserFamily,
  buildReport,
  classifyFailure,
  cleanMessage,
  describeAttempt,
  eligibleLabels,
  outcomeOf,
  recommendMode,
  summarizeFailures,
  type AttemptRecord,
  type DiagnosticResult,
} from '../src/lib/ai-diagnostics';

const strong: ResourceSnapshot = { deviceMemoryGb: 8, cores: 8, mobile: false, webgpuAdapter: true, crossOriginIsolated: true };
const fail = (over: Partial<AttemptRecord>): AttemptRecord => ({ key: 'smollm2-360m:webgpu', label: 'SmolLM2-360M', ok: false, stage: 'initialization', kind: 'unknown', ...over });

test.describe('failure classification', () => {
  test('distinguishes offline, timeout, CORS, HTTP, network, module, WASM, memory, integrity', () => {
    const k = (stage: Parameters<typeof classifyFailure>[0]['stage'], message: string, extra: object = {}) => classifyFailure({ stage, message, ...extra });
    expect(k('download', 'x', { offline: true })).toBe('offline');
    expect(k('download', 'The request timed out after 30 s')).toBe('timeout');
    expect(k('download', 'x', { timedOut: true })).toBe('timeout');
    expect(k('download', 'x', { status: 503 })).toBe('http');
    expect(k('download', 'blocked by CORS policy: No Access-Control-Allow-Origin')).toBe('cors');
    expect(k('download', 'NetworkError when attempting to fetch resource.')).toBe('network');
    expect(k('download', 'TypeError: Failed to fetch')).toBe('network');
    expect(k('runtime', 'Failed to fetch dynamically imported module: https://esm.sh/x')).toBe('module');
    expect(k('initialization', 'failed to load ort-wasm-simd-threaded.asyncify.wasm')).toBe('wasm');
    expect(k('initialization', 'std::bad_alloc: out of memory')).toBe('memory');
    expect(k('integrity', 'whatever')).toBe('integrity');
    expect(k('smoke inference', 'The start-up check returned no usable text.')).toBe('empty-output');
    expect(k('generation', 'something odd')).toBe('unknown');
  });

  test('messages are single-line, bounded, and never carry query strings or credentials', () => {
    const m = cleanMessage(new Error('failed\nat https://host.example/a/b.onnx?token=SECRET&x=1#frag and more'), 80);
    expect(m).not.toMatch(/SECRET|\n|token=/);
    expect(m.length).toBeLessThanOrEqual(80);
  });

  test('summaries name every failed attempt, not just the last', () => {
    const text = summarizeFailures([
      fail({ label: 'Qwen2.5-0.5B', backend: 'webgpu', stage: 'download', kind: 'network', host: 'huggingface.co' }),
      fail({ label: 'SmolLM2-360M', backend: 'wasm', stage: 'initialization', kind: 'memory' }),
    ]);
    expect(text).toContain('Qwen2.5-0.5B (WebGPU): download');
    expect(text).toContain('at huggingface.co');
    expect(text).toContain('SmolLM2-360M (WASM): initialization');
    expect(describeAttempt(fail({ stage: 'integrity', kind: 'integrity' }))).toMatch(/checksum/);
  });
});

test.describe('recommendation policy', () => {
  const cands = buildCandidates('balanced', strong);
  const f135 = buildCandidates('fastest', strong)[0]!;

  test('recommends only after a fallback worked, only a different mode, and only if that mode would start with the working model', () => {
    const r = recommendMode('balanced', [fail({}), { key: f135.key, label: f135.label, ok: true }], f135, strong);
    expect(r).toEqual({ mode: 'fastest', message: 'SmolLM2-360M could not start. We recommend Fastest (SmolLM2-135M) on this device.' });
    expect(recommendMode('fastest', [fail({}), { key: f135.key, label: f135.label, ok: true }], f135, strong)).toBeNull(); // already there
    expect(recommendMode('balanced', [{ key: cands[0]!.key, label: cands[0]!.label, ok: true }], cands[0]!, strong)).toBeNull(); // no failure
  });

  test('never recommends from lightweight, and a network-only failure gets no "smaller model" advice', () => {
    expect(recommendMode('lightweight', [fail({})], null, strong)).toBeNull();
    expect(recommendMode('balanced', [fail({ kind: 'network' }), fail({ kind: 'timeout' })], null, strong)).toBeNull();
    expect(recommendMode('balanced', [fail({ kind: 'memory' })], null, strong)?.mode).toBe('lightweight');
  });

  test('a recommendation is only ever a local mode (never a cloud service)', () => {
    for (const kind of ['memory', 'unknown', 'empty-output'] as const) {
      const r = recommendMode('best', [fail({ kind })], null, strong);
      if (r) expect(['best', 'balanced', 'fastest', 'lightweight']).toContain(r.mode);
    }
  });

  test('outcome: first-try pass vs fallback vs failure; runtime-host notes do not downgrade a pass', () => {
    const c = cands[0]!;
    expect(outcomeOf([{ key: c.key, label: c.label, ok: true }], c, c.key)).toBe('passed');
    expect(outcomeOf([{ key: 'runtime', label: 'ONNX WASM runtime', ok: false, kind: 'wasm' }, { key: c.key, label: c.label, ok: true }], c, c.key)).toBe('passed');
    expect(outcomeOf([fail({}), { key: c.key, label: c.label, ok: true }], c, 'other')).toBe('passed-fallback');
    expect(outcomeOf([fail({})], null, c.key)).toBe('failed');
  });

  test('eligible list mirrors policy for the device', () => {
    expect(eligibleLabels('lightweight', strong)).toEqual([]);
    expect(eligibleLabels('fastest', strong)[0]).toMatch(/^SmolLM2-135M \(WebGPU, about \d+ MB\)$/);
  });
});

test.describe('diagnostic report (privacy)', () => {
  const result: DiagnosticResult = {
    outcome: 'passed-fallback',
    mode: 'balanced',
    model: { label: 'SmolLM2-135M', family: 'smollm2-135m', backend: 'wasm', dtype: 'q8', revision: 'b8a5c0f183b78c55955a5364f610c36668b5e681', approxMb: 136 },
    integrity: { state: 'not-verified', reason: 'no-manifest', detail: 'No checksum manifest is available for this model revision yet.', verifiedFiles: 0, totalFiles: 0 },
    resources: { deviceMemoryGb: 4, cores: 4, mobile: true, webgpuAdapter: false, crossOriginIsolated: false, webgpuApi: true },
    eligible: ['SmolLM2-135M (WASM, about 136 MB)'],
    attempts: [fail({ stage: 'download', kind: 'network', url: 'https://huggingface.co/x/resolve/abc/config.json', host: 'huggingface.co', message: 'NetworkError', backend: 'wasm', dtype: 'q8', revision: 'b8a5c0f183b78c55955a5364f610c36668b5e681' })],
    startupMs: 4200,
    recommendation: { mode: 'fastest', message: 'x' },
    summary: 's',
  };
  const text = buildReport(result, { browser: 'Chrome 126', appVersion: '1.13.5' });

  test('contains technical facts only', () => {
    for (const expected of ['Moodsift 1.13.5', 'Result: Passed with fallback', 'Browser: Chrome 126', 'WebGPU adapter unavailable', 'Integrity: not-verified (no-manifest)', 'resource=https://huggingface.co/x/resolve/abc/config.json', 'kind=network', 'failed at download']) {
      expect(text).toContain(expected);
    }
    expect(text).not.toMatch(/\?|token|cookie|rating|quiz|search term|@[a-z0-9.-]+\.[a-z]{2,}/i);
  });

  test('browser family never includes the full user-agent', () => {
    expect(browserFamily('Mozilla/5.0 (Windows NT 10.0) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36')).toBe('Chrome 126');
    expect(browserFamily('Mozilla/5.0 (Macintosh) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.5 Safari/605.1.15')).toBe('Safari 17');
    expect(browserFamily('Mozilla/5.0 (X11; Linux x86_64; rv:128.0) Gecko/20100101 Firefox/128.0')).toBe('Firefox 128');
    expect(browserFamily('???')).toBe('Unknown browser');
  });
});

test('app version constant matches package.json', async () => {
  const { readFileSync } = await import('node:fs');
  const { APP_VERSION } = await import('../src/lib/app-version');
  expect(APP_VERSION).toBe(JSON.parse(readFileSync('package.json', 'utf8')).version);
});
