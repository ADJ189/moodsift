/// <reference lib="deno.ns" />
// Native Deno test: the full AI candidate policy matrix (3 models Ã— 2 backends Ã—
// 4 modes Ã— device profiles), plus output validation. No model is downloaded.
import { assertEquals } from 'jsr:@std/assert@1';
import {
  buildCandidates,
  isConstrained,
  isEligible,
  MAX_CHARS,
  MAX_WORDS,
  MODELS,
  validateExplanation,
  validateSmoke,
  type ResourceSnapshot,
} from '../../src/lib/ai-policy.ts';
import type { AiMode } from '../../src/lib/ai-settings.ts';

const MODES: AiMode[] = ['best', 'balanced', 'fastest', 'lightweight'];
const FAMILIES = Object.keys(MODELS) as (keyof typeof MODELS)[];
const BACKENDS = ['webgpu', 'wasm'] as const;

const profiles: Record<string, ResourceSnapshot> = {
  'high-end webgpu': { deviceMemoryGb: 16, cores: 12, mobile: false, webgpuAdapter: true, crossOriginIsolated: true },
  'mid webgpu': { deviceMemoryGb: 8, cores: 8, mobile: false, webgpuAdapter: true, crossOriginIsolated: true },
  'desktop no gpu': { deviceMemoryGb: 8, cores: 8, mobile: false, webgpuAdapter: false, crossOriginIsolated: true },
  '4 GB laptop': { deviceMemoryGb: 4, cores: 4, mobile: false, webgpuAdapter: false, crossOriginIsolated: false },
  '2 GB phone': { deviceMemoryGb: 2, cores: 2, mobile: true, webgpuAdapter: false, crossOriginIsolated: false },
  'unknown memory': { deviceMemoryGb: undefined, cores: 4, mobile: false, webgpuAdapter: false, crossOriginIsolated: false },
  'phone with webgpu': { deviceMemoryGb: 6, cores: 8, mobile: true, webgpuAdapter: true, crossOriginIsolated: true },
};

Deno.test('lightweight never yields a candidate on any device', () => {
  for (const [name, r] of Object.entries(profiles)) {
    assertEquals(buildCandidates('lightweight', r), [], name);
  }
});

Deno.test('every mode Ã— device produces a deterministic, eligible candidate list', () => {
  for (const mode of MODES.filter((m) => m !== 'lightweight')) {
    for (const [name, r] of Object.entries(profiles)) {
      const a = buildCandidates(mode, r);
      const b = buildCandidates(mode, r);
      assertEquals(a, b, `${mode}/${name} must be deterministic`);
      for (const c of a) {
        assertEquals(c.family in MODELS, true, `${c.family} is catalogued`);
        assertEquals(isEligible(c.family, c.backend, r), true, `${mode}/${name}: ${c.family}:${c.backend} must be eligible`);
        const spec = MODELS[c.family];
        assertEquals(c.dtype, spec[c.backend].dtype, 'dtype follows the catalogue');
      }
      assertEquals(new Set(a.map((c) => `${c.family}:${c.backend}`)).size, a.length, 'no duplicate attempts');
    }
  }
});

Deno.test('constrained devices are limited to the smallest model', () => {
  for (const name of ['2 GB phone', '4 GB laptop']) {
    const r = profiles[name]!;
    assertEquals(isConstrained(r), true, name);
    for (const mode of MODES.filter((m) => m !== 'lightweight')) {
      for (const c of buildCandidates(mode, r)) assertEquals(c.family, 'smollm2-135m', `${name}/${mode}`);
    }
  }
});

Deno.test('WebGPU is never offered without an adapter; WASM is the fallback', () => {
  for (const [name, r] of Object.entries(profiles)) {
    const list = buildCandidates('best', r);
    for (const c of list) {
      if (c.backend === 'webgpu') assertEquals(r.webgpuAdapter, true, `${name}: WebGPU requires a real adapter`);
    }
    if (!r.webgpuAdapter) {
      assertEquals(list.every((c) => c.backend === 'wasm'), true, `${name}: no WebGPU attempts`);
    }
  }
});

Deno.test('eligibility matrix covers every family Ã— backend', () => {
  const strong: ResourceSnapshot = profiles['high-end webgpu']!;
  const weak: ResourceSnapshot = profiles['2 GB phone']!;
  for (const family of FAMILIES) {
    for (const backend of BACKENDS) {
      if (!(backend in MODELS[family])) continue;
      const ok = isEligible(family, backend, strong);
      assertEquals(typeof ok, 'boolean');
      if (family !== 'smollm2-135m') assertEquals(isEligible(family, backend, weak), false, `${family}:${backend} on 2 GB`);
    }
  }
});

Deno.test('explanation validation rejects empty, short, long and off-contract text', () => {
  assertEquals(validateExplanation('A tense, well-rated crime thriller that fits your mood.'), 'A tense, well-rated crime thriller that fits your mood.');
  assertEquals(validateExplanation(''), null);
  assertEquals(validateExplanation('Too short.'), null);
  assertEquals(validateExplanation('word '.repeat(MAX_WORDS + 1)), null);
  assertEquals(validateExplanation('x'.repeat(MAX_CHARS + 1)), null);
  assertEquals(validateExplanation({ text: 'nope' }), null);
  assertEquals(validateExplanation(null), null);
});

Deno.test('smoke validation needs only short usable text', () => {
  assertEquals(validateSmoke('Ready to help.'), true);
  assertEquals(validateSmoke(''), false);
  assertEquals(validateSmoke('12345'), false);
  assertEquals(validateSmoke('x'.repeat(MAX_CHARS + 1)), false);
  assertEquals(validateSmoke(null), false);
});
