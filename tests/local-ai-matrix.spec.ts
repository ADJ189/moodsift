import { test } from '@playwright/test';
import {
  testConstrainedProfiles,
  testEligibleCandidatesPolicyOrder,
  testLightweightInert,
  testSingleDownloadOnGeneration,
  testUnknownMemoryAndMobile,
  testWebGpuAdapterSelection,
} from './local-ai-matrix-cases';

// Brute-force matrix for the decision code: 3 model families × 2 backends ×
// 4 modes × 7 device profiles. Every environment dependency is injected, so no
// CDN, WASM binary or model weight is ever downloaded.
test.describe('AI engine brute-force matrix', () => {
  test('lightweight is inert on every device profile', testLightweightInert);
  test('every mode × profile attempts only policy-eligible candidates, in policy order', testEligibleCandidatesPolicyOrder);
  test('WebGPU is used first exactly when an adapter exists; otherwise WASM starts', testWebGpuAdapterSelection);
  test('constrained profiles never touch the larger model families', testConstrainedProfiles);
  test('unknown memory and mobile profiles still resolve to a working candidate', testUnknownMemoryAndMobile);
  test('a successful load followed by generation never downloads a second model', testSingleDownloadOnGeneration);
});
