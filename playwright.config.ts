import { defineConfig, devices } from '@playwright/test';

// Tests run against a production build with a dummy TMDB key and *mocked*
// TMDB responses (see tests/fixtures.ts) — no live API, deterministic data.
const PORT = 4321;
const NOKEY_PORT = 4322;

export default defineConfig({
  testDir: './tests',
  fullyParallel: true,
  // Each test drives a real browser through a multi-screen flow; give them
  // room, and keep parallelism modest so the shared preview server and CPU
  // aren't the thing being tested.
  timeout: 60_000,
  expect: { timeout: 8_000 },
  workers: process.env.CI ? 2 : 3,
  forbidOnly: !!process.env.CI,
  retries: process.env.CI ? 1 : 0,
  reporter: process.env.CI ? [['github'], ['html', { open: 'never' }]] : 'list',
  use: {
    baseURL: `http://localhost:${PORT}`,
    trace: 'retain-on-failure',
  },
  projects: [
    { name: 'chromium-desktop', use: { ...devices['Desktop Chrome'], viewport: { width: 1280, height: 800 } } },
    { name: 'chromium-mobile', use: { ...devices['Pixel 7'] }, testIgnore: /visual\.spec\.ts/ },
  ],
  webServer: [
    {
      command: `VITE_TMDB_KEY=test-fixture-key npm run build -- --outDir dist-e2e --emptyOutDir && npx vite preview --outDir dist-e2e --port ${PORT} --strictPort`,
      url: `http://localhost:${PORT}`,
      reuseExistingServer: !process.env.CI,
      timeout: 120_000,
    },
    {
      // A second build with *no* TMDB credential, for the "no key → no request,
      // static sample visual" case. The empty vars win over any local .env.
      command: `VITE_TMDB_KEY= VITE_TMDB_TOKEN= npm run build -- --outDir dist-e2e-nokey --emptyOutDir && npx vite preview --outDir dist-e2e-nokey --port ${NOKEY_PORT} --strictPort`,
      url: `http://localhost:${NOKEY_PORT}`,
      reuseExistingServer: !process.env.CI,
      timeout: 120_000,
    },
  ],
});
