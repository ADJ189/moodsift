# Device and browser-engine test matrix

This document records what is actually exercised, on which engine and form
factor, and what remains a simulation. It is intentionally concrete: if a
row says "skipped", the reason is stated and the test is not counted as a
pass.

## Projects

Playwright is pinned by `@playwright/test` 1.65.0, which ships Chromium 158,
Firefox 159 and WebKit 27.2. Every project runs against a production build
with a dummy TMDB key and mocked TMDB responses; no live API is called.

| Project | Engine | Emulation | Typical use |
|---|---|---|---|
| `chromium-desktop` | Chromium 158 | Desktop Chrome, 1280 × 800 | Fast gate (`npm test`) |
| `chromium-mobile` | Chromium 158 | Pixel 7, touch, `isMobile` | Fast gate (`npm test`) |
| `chromium-tablet` | Chromium 158 | iPad Mini, touch | `test:devices` |
| `chromium-small` | Chromium 158 | 320 × 640, touch | `test:devices` |
| `chromium-landscape` | Chromium 158 | Pixel 7 landscape | `test:devices` |
| `webkit-desktop` | WebKit 27.2 | Desktop Safari, 1280 × 800 | `test:engines` / `test:matrix` |
| `webkit-mobile` | WebKit 27.2 | iPhone 15 | `test:engines` / `test:devices` |
| `firefox-desktop` | Firefox 159 | Desktop Firefox, 1440 × 900 | `test:engines` |
| `firefox-mobile` | Firefox 159 | 390 × 844, touch, **no `isMobile`** | `test:engines` / `test:devices` |

All runs use `workers: 3`. The config and the npm/Deno scripts both pin it;
raising it makes the shared preview server and host CPU the measured thing.

## Commands

```bash
npm test               # chromium-desktop + chromium-mobile, every spec
npm run test:devices   # tablet, 320 px, landscape, webkit-mobile, firefox-mobile
npm run test:engines   # webkit-desktop/mobile, firefox-desktop/mobile
npm run test:matrix    # all nine projects (slow; release check)
npm run test:deno      # 39 native Deno tests, no browser
deno task test:e2e     # Playwright through Deno
npm run test:visual    # opt-in screenshots; baselines are not committed
```

Browser binaries are version-bound. After a Playwright bump run
`npx playwright install chromium firefox webkit`; otherwise every project
fails at launch, not at an assertion.

## What the environment spec checks

`tests/matrix.spec.ts` runs in every project above:

- landing, quiz and results have no horizontal overflow;
- result cards start and end inside the viewport;
- visible interactive controls meet the 24 × 24 px WCAG 2.2 minimum;
- 200 % text zoom does not create horizontal overflow;
- forced-colors mode keeps the CTA visible, focusable and unclipped;
- `prefers-reduced-motion: reduce` resolves to `data-motion="off"`;
- a light `prefers-color-scheme` resolves the stored `system` mode to
  `data-theme="light"`;
- a throwing `localStorage` never blanks the app;
- an unreadable compressed profile is set aside, not deleted;
- a `de-DE` / `Europe/Berlin` context boots and stays inside the viewport.

The locale/plumbing test is Chromium-only by design (one engine is enough for
locale data); it is skipped elsewhere with that reason.

## What is simulated, not real

| Area | How it is covered | What is not proven |
|---|---|---|
| TMDB | Every request mocked in `tests/fixtures.ts` | Live API shape/rate limits |
| IMDb / Letterboxd | CSV fixtures in browser + Deno importers | A user's real export |
| AI models | Injected runtime, fetch and cache; policy/engine tests | Real weight download, WASM/WebGPU inference, device memory pressure |
| WebGPU | `navigator.gpu.requestAdapter()` is mocked per device profile | Actual GPU adapters and drivers |
| Storage failure | A throwing `localStorage` and a corrupt record | Browser-specific quota edge cases |
| Text zoom | `html { font-size: 200% }` | Browser UI zoom and OS text scaling (similar, not identical) |
| Network failures | Route handlers return 500/empty | Offline transitions and captive portals |

Real model downloads and real-device inference are never part of CI. The
policy is still verified: a model is only "ready" after init **and** a smoke
generation, and ineligible candidates are never attempted.

## Results from this checkout (v1.14.0)

Environment: Windows, Node 26.13.0 (canonical for CI and Cloudflare Worker deploy), npm 12.2.2, Deno 2.9.8 (optional task & pure-logic test runner), Playwright 1.65.0.

| Run | Command | Result |
|---|---|---|
| Typecheck | `npm run typecheck` | 0 errors |
| Lint | `npm run lint` | 0 findings |
| Build | `npm run build` | Pass; 33.01 kB gzip initial JS, 26.76 kB gzip CSS |
| Deno check/lint/build | `deno task check`, `lint`, `build` | 0 errors |
| Deno tests | `deno task test` | **45 passed, 0 failed** |
| Chromium fast gate | `npm test` | **451 passed, 10 skipped, 0 failed** |
| Engine matrix | `npm run test:engines` | **892 passed, 20 skipped, 0 failed** |
| Device matrix targets | `chromium-small` & `chromium-landscape` | **81 passed, 3 skipped, 0 failed** |
| Local AI suite | `tests/local-ai-*.spec.ts` | **40 passed, 0 failed** |
| WebKit flows + matrix | `npx playwright test tests/flows.spec.ts tests/matrix.spec.ts --project=webkit-desktop --project=webkit-mobile --workers=3` | **48 passed, 2 skipped, 0 failed** |
| Worker smoke | `npx wrangler dev --port 8787 --local` | Root 200 with COOP/COEP + CSP; `/models/…/resolve/main/…` 404; `POST /models/` 405; pinned `HEAD` 200; pinned `Range` 206 + immutable cache; `/api/recommend` 503 |
| Manifest check | `npm run ai:manifest:check` | `ai-manifest.json` matches upstream |
| Audit | `npm audit --audit-level=high` | 0 vulnerabilities |

Full engine, device and all-project counts are recorded in `CHANGELOG.md`
after the release run. If a row is absent there, that run was not completed
and is not claimed.

## Engine-specific notes and skips

- **CDP touch synthesis** (`Input.dispatchTouchEvent`) exists only in
  Chromium. The carousel gesture tests skip on WebKit/Firefox with an explicit
  reason; those engines still cover tap/pointer/keyboard carousel behaviour
  in the other tests.
- **Firefox does not support `isMobile` contexts.** The Firefox mobile project
  uses a 390 × 844 viewport with `hasTouch`, and the one test that needs a
  real mobile context skips on Firefox.
- **WebKit 27.2 crash (fixed in 1.14.0).** Repeated
  `document.startViewTransition` calls and a `translateY` animation on the
  full-height `.screen` crashed the WebKit renderer on Windows. Screen swaps
  are now plain and the screen fade is opacity-only. The WebKit run above is
  the regression evidence.
- **Closed popovers are not "visible controls".** The 24 × 24 check ignores
  elements inside a closed popover (`pointer-events: none`) or outside the
  viewport. Colour swatches that are only reachable after opening the profile
  dialog are still 20 × 20 when the dialog is open; they sit inside a larger
  labelled control region and are not part of the default surface.

## Reproducing a failure

Use one project, one worker and a line reporter to separate an engine/app
failure from resource pressure:

```bash
npx playwright test tests/flows.spec.ts:20 --project=webkit-desktop --workers=1 --reporter=line
```

Failure artefacts (`error-context.md`, `trace.zip`, screenshots) are written
to `test-results/` and are intentionally not committed.
