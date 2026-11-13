/// <reference lib="deno.ns" />
// Native Deno test: brute-force matrix for the decision code (3 models ×
// 2 backends × 4 modes × 7 device profiles). Dependencies are injected,
// so no model or WASM binary is downloaded.
import {
  testConstrainedProfiles,
  testEligibleCandidatesPolicyOrder,
  testLightweightInert,
  testSingleDownloadOnGeneration,
  testUnknownMemoryAndMobile,
  testWebGpuAdapterSelection,
} from '../local-ai-matrix-cases.ts';

Deno.test('lightweight is inert on every device profile', testLightweightInert);
Deno.test('every mode × profile attempts only policy-eligible candidates, in policy order', testEligibleCandidatesPolicyOrder);
Deno.test('WebGPU is used first exactly when an adapter exists; otherwise WASM starts', testWebGpuAdapterSelection);
Deno.test('constrained profiles never touch the larger model families', testConstrainedProfiles);
Deno.test('unknown memory and mobile profiles still resolve to a working candidate', testUnknownMemoryAndMobile);
Deno.test('a successful load followed by generation never downloads a second model', testSingleDownloadOnGeneration);
