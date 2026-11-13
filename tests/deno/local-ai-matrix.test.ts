/// <reference lib="deno.ns" />
// Native Deno test: brute-force matrix for the decision code (3 models ×
// 2 backends × 4 modes × 7 device profiles). Dependencies are injected,
// and GPU adapter detection is exercised through detectDevice() with mocked requestAdapter().
// No model or WASM binary is downloaded.
import {
  testAdapterDetection,
  testConstrainedProfiles,
  testEligibleCandidatesPolicyOrder,
  testLightweightInert,
  testSingleDownloadOnGeneration,
  testUnknownMemoryAndMobile,
  testWebGpuAdapterSelection,
} from '../local-ai-matrix-cases.ts';

Deno.test('adapter detection: absent, null, unflagged, error, and shader-f16 adapters', testAdapterDetection);
Deno.test('lightweight is inert on every device profile', testLightweightInert);
Deno.test('every mode × profile attempts only policy-eligible candidates in policy order, verifying fallbacks and runtime options', testEligibleCandidatesPolicyOrder);
Deno.test('WebGPU is used first exactly when an adapter exists; otherwise WASM starts, with matching runtime options', testWebGpuAdapterSelection);
Deno.test('constrained profiles never touch the larger model families', testConstrainedProfiles);
Deno.test('unknown memory and mobile profiles still resolve to a working candidate', testUnknownMemoryAndMobile);
Deno.test('a successful load followed by generation never downloads a second model', testSingleDownloadOnGeneration);
