import { defineConfig, devices } from '@playwright/test';

// Tests run against a production build with a dummy TMDB key and *mocked*
// TMDB responses (see tests/fixtures.ts) — no live API, deterministic data.
const PORT = 4321;
const NOKEY_PORT = 4322;

export default defineConfig({
  testDir: './tests',
  // Playwright's default matches `*.test.ts` too, which would pull in the
  // native Deno suite in tests/deno/ (those use `jsr:` specifiers that Node's
  // ESM loader cannot resolve). Every browser spec here is `*.spec.ts`.
  testMatch: '**/*.spec.ts',
  testIgnore: [/deno/],
  fullyParallel: true,
  // Each test drives a real browser through a multi-screen flow; give them
  // room, and keep parallelism modest so the shared preview server and CPU
  // aren't the thing being tested.
  timeout: 60_000,
  expect: { timeout: 8_000 },
  // At most three browser workers everywhere: each test drives a real
  // multi-screen flow, and more workers make the shared preview server and
  // host CPU the thing being measured instead of the app.
  workers: 3,
  forbidOnly: !!process.env.CI,
  retries: process.env.CI ? 1 : 0,
  reporter: process.env.CI ? [['github'], ['html', { open: 'never' }]] : 'list',
  use: {
    baseURL: `http://localhost:${PORT}`,
    trace: 'retain-on-failure',
  },
  projects: [
    // Fast gate (npm test): the two original Chromium projects.
    { name: 'chromium-desktop', use: { ...devices['Desktop Chrome'], viewport: { width: 1280, height: 800 } } },
    { name: 'chromium-mobile', use: { ...devices['Pixel 7'] }, testIgnore: /visual\.spec\.ts/ },
    // Device matrix (npm run test:devices): layout extremes, tablets, landscape.
    { name: 'chromium-tablet', use: { ...devices['iPad Mini'] }, testIgnore: /visual\.spec\.ts/ },
    { name: 'chromium-small', use: { ...devices['Desktop Chrome'], viewport: { width: 320, height: 640 }, hasTouch: true }, testIgnore: /visual\.spec\.ts/ },
    { name: 'chromium-landscape', use: { ...devices['Pixel 7 landscape'] }, testIgnore: /visual\.spec\.ts/ },
    // Engine matrix (npm run test:engines): the renderers users actually have.
    { name: 'webkit-desktop', use: { ...devices['Desktop Safari'], viewport: { width: 1280, height: 800 } }, testIgnore: /visual\.spec\.ts/ },
    { name: 'webkit-mobile', use: { ...devices['iPhone 15'] }, testIgnore: /visual\.spec\.ts/ },
    { name: 'firefox-desktop', use: { ...devices['Desktop Firefox'], viewport: { width: 1440, height: 900 } }, testIgnore: /visual\.spec\.ts/ },
    // Firefox does not support `isMobile`; emulate the small screen without it.
    { name: 'firefox-mobile', use: { ...devices['Desktop Firefox'], viewport: { width: 390, height: 844 }, hasTouch: true }, testIgnore: /visual\.spec\.ts/ },
  ],
  webServer: [
    {
      command: `npx vite build --outDir dist-e2e --emptyOutDir && npx vite preview --outDir dist-e2e --port ${PORT} --strictPort`,
      url: `http://localhost:${PORT}`,
      // Cross-platform: Playwright's env field works on Windows cmd,
      // PowerShell, macOS and Linux; `VAR=value cmd` does not.
      env: { VITE_TMDB_KEY: 'test-fixture-key' },
      reuseExistingServer: !process.env.CI,
      timeout: 120_000,
    },
    {
      // A second build with *no* TMDB credential, for the "no key → no request,
      // static sample visual" case. The empty vars win over any local .env.
      command: `npx vite build --outDir dist-e2e-nokey --emptyOutDir && npx vite preview --outDir dist-e2e-nokey --port ${NOKEY_PORT} --strictPort`,
      url: `http://localhost:${NOKEY_PORT}`,
      env: { VITE_TMDB_KEY: '', VITE_TMDB_TOKEN: '' },
      reuseExistingServer: !process.env.CI,
      timeout: 120_000,
    },
  ],
});
