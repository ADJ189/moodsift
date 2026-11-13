import { test } from '@playwright/test';
import * as cases from './local-ai-matrix-cases';

// Brute-force matrix for the decision code: 3 model families × 2 backends ×
// 4 modes × 7 device profiles. Environment dependencies are injected, and GPU
// adapter detection is exercised through detectDevice() with mocked requestAdapter().
// No CDN, WASM binary or model weight is ever downloaded.
test.describe('AI engine brute-force matrix', () => {
  test('adapter detection: absent, null, unflagged, error, and shader-f16 adapters', cases.testAdapterDetection);
  test('lightweight is inert on every device profile', cases.testLightweightInert);
  test('every mode × profile attempts only policy-eligible candidates in policy order, verifying fallbacks and runtime options', cases.testEligibleCandidatesPolicyOrder);
  test('WebGPU is used first exactly when an adapter exists; otherwise WASM starts, with matching runtime options', cases.testWebGpuAdapterSelection);
  test('constrained profiles never touch the larger model families', cases.testConstrainedProfiles);
  test('unknown memory and mobile profiles still resolve to a working candidate', cases.testUnknownMemoryAndMobile);
  test('a successful load followed by generation never downloads a second model', cases.testSingleDownloadOnGeneration);
});
