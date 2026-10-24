# AGENTS.md — Moodsift

Instructions for AI coding agents (Claude, Copilot, Cursor, Codex, Gemini, etc.) working in this repo. Humans: see `README.md` and `CONTRIBUTING.md`.

## What this is

Moodsift (v1.13.5) is a framework-free movie/TV recommendation web app. A 7-question quiz plus a few ratings feeds a **deterministic client-side scoring engine** over live TMDB data. Optional on-device AI rewords the explanation text only. No accounts, no analytics, no server-side user data.

- **Live:** https://moodsift.adj189.workers.dev/
- **Stack:** TypeScript (`strict`) + Vite 8, no UI framework. Cloudflare Worker (Workers Static Assets). Tests: Playwright + axe. Lint: oxlint.
- **Deploy target:** a real Cloudflare **Worker** (`wrangler.jsonc`, `main: worker/index.ts`), *not* Pages.

## Commands

```bash
npm install
cp .env.example .env     # VITE_TMDB_TOKEN (or VITE_TMDB_KEY) required for live data; VITE_OMDB_KEY optional
npm run dev              # Vite dev server (port 5173)
npm run typecheck        # tsc --noEmit — covers src/, worker/, tests/, configs
npm run lint             # oxlint
npm run build            # tsc --noEmit && vite build
npm test                 # Playwright, chromium-desktop + chromium-mobile (mocked TMDB)
npm run test:visual      # opt-in screenshot specs (baselines are NOT committed)
npm run ai:manifest      # regenerate src/data/ai-manifest.json (needs huggingface.co access)
npm run ai:manifest:check  # release gate: committed manifest must match upstream
npm run worker:dev       # run the real Worker locally against dist/
```

**Definition of done for any change:** `npm run typecheck`, `npm run lint` and `npm run build` pass clean. Run `npm test` when you touch UI, storage, AI, or the Worker. CI also runs `npm audit --audit-level=high` and Lighthouse. If you could not run something, say so explicitly — never claim it passed.

## Hard constraints (do not violate)

1. **No framework, no new UI dependency.** New UI is built with `el()` from `src/lib/dom.ts`. No React/Svelte/Vue/Lit/templating compilers, no state libraries. State is the pub-sub store in `src/lib/store.ts`.
2. **Strict TypeScript, no `any`** (two isolated worker-boundary casts already exist; don't add a third). `noUnusedLocals` / `noUnusedParameters` are on.
3. **Shared markup goes in a shared module.** If more than one screen uses it, put it in `src/lib/*-ui.ts` (see `providers-ui.ts`, `credits-ui.ts`, `rating-ui.ts`, `card-ui.ts`, `taste-memory-ui.ts`).
4. **Privacy: nothing leaves the browser except TMDB/OMDb calls** (plus optional model/runtime downloads for on-device AI). No analytics, telemetry, or new third-party requests. If a change genuinely needs one, flag it prominently and update `PRIVACY.md`.
5. **Ranking is deterministic and client-side** (`engine.ts`). AI must never choose or reorder titles.
6. **Honest UX copy.** Describe limitations accurately (e.g. compression is "storage optimisation, not encryption"; model sizes are "approximate weight-file sizes"). Don't overclaim.
7. **Presentation options stay presentation-only.** Card type, design style and search type must never change what is searched, scored or stored, and must never override Reduced Motion, Reduced transparency, High contrast, text size, or user layout settings. "Motion: Off always wins."
8. **Accessibility is a requirement**, not polish: keyboard operable, screen-reader labelled, WCAG AA contrast in every palette (light and dark), axe scans pass.

## Architecture map

```
src/
  main.ts               entry
  screens/              landing (eager) · quiz · rating · results · search (lazy chunks)
  components/           landing-carousel.ts (Pointer Events + CSS transforms)
  data/                 quiz-questions.ts, rating-seeds.ts, ai-manifest.json
  styles/               tokens, primitives, per-screen CSS, palettes, effects
  lib/
    tmdb.ts             live catalog (/discover, search/multi, /recommendations, /similar, /watch/providers); cached + in-flight de-dupe
    engine.ts           scoring: quiz + ratings → matchPct + reasons; era is a HARD filter
    rating-pool.ts      calibration list (~75% genre-weighted to chosen mood)
    omdb.ts             optional RT/Metacritic/IMDb signal
    letterboxd.ts, imdb.ts   ratings CSV importers (provider auto-detected from header)
    profile.ts, profile-codec.ts, storage.ts   local profile + compressed storage
    media-key.ts        `movie:123` / `tv:123` identity (ids collide across types!)
    store.ts            pub-sub store — the whole "framework"
    appearance.ts, settings-panel.ts, settings-previews.ts, theme.ts, fonts.ts   Settings / Theme Studio
    llm.ts              main-thread wrapper for on-device AI (timeouts, cache, status)
    ai-worker.ts        thin wiring for the Web Worker
    ai-engine.ts        unit-tested decisions: candidates, staging, failures
    ai-policy.ts        SOURCE OF TRUTH for model catalogue, pins, eligibility, output checks
    ai-integrity.ts, sha256.ts   streaming SHA-256 + size verification
    ai-diagnostics.ts, ai-diagnostics-ui.ts   "Test on this device"
    ai-settings.ts      AI mode (own storage key)
worker/index.ts         serves dist/ via ASSETS; COOP/COEP; CSP; optional POST /api/recommend
scripts/generate-ai-manifest.mjs
tests/                  Playwright specs + fixtures.ts (mocked TMDB)
docs/                   Local-AI policy, Taste Memory, visual redesign spec
```

When you add, move, or change the purpose of a file listed in the README's Architecture section, update that section in the same change.

## Domain rules that are easy to break

- **Movie/TV id collisions.** TMDB movie and TV ids overlap. Always key ratings, watchlist, caches and imports by `media-key.ts` (`movie:123` / `tv:123`), never by bare id. Test fixtures deliberately reuse ids to catch this.
- **Search is not the quiz engine.** `search.ts` uses TMDB's own similarity/credits data (`getSimilarTitles`, `getPersonBestWork`), not `engine.ts`. Don't route search through the scorer.
- **Never a dead end.** `ensureBatch()` in `results.ts` escalates (retry ignoring "shown" → later TMDB page → drop Precise floor → labeled repeat). Preserve that fallback chain.
- **Rating debounce** on result cards is ~1.6 s; rated titles leave the scoring pool but recent ones stay visible with stars filled.
- **TMDB rating shows only when TMDB has votes.** Unavailable fields say so rather than guess.
- **Imports:** Letterboxd/IMDb re-import replaces only that provider's earlier import; in-app ratings are never touched. IMDb 1–10 → 0.5–5 stars, original rating/scale/provider preserved; episodes/games/invalid rows skipped and counted.
- **Env vars** `VITE_*` are build-time only, baked into the client bundle. They are Cloudflare **project/build variables**, not Worker secrets. Never commit `.env`.
- **Do not rename the Worker** (`name: "moodsift"` in `wrangler.jsonc`). It is the workers.dev subdomain; renaming creates a new, unconfigured Worker.

## Local storage (don't change keys casually)

| Key | Purpose |
|---|---|
| `cinematch.profile.v2` | `MOODPROFILE\|2\|lz-utf16\|<LZ-String payload>` — ratings, watchlist, avatar |
| `cinematch.profile.v1` | Legacy plain JSON; removed only after v2 is written, read back, decoded, sanitised and identical |
| `cinematch.profile.v2.unreadable` | Unreadable v2 data set aside, never deleted |
| `cinematch.taste-memory:v1` | `{version, paused}` |
| `cinematch-appearance:v1`, `cinematch-looks:v1`, `cinematch-vibe:v1` | Appearance prefs, saved looks, vibe |
| `cinematch-local-ai:v1` | AI mode (independent of appearance) |
| `cinematch-region` | Streaming region override |

(The `cinematch` prefix is historical from the project's earlier name — keep it for compatibility.)

Rules: all profile writes go through `writeProfile()` (one write path; its result drives the "Saved on this device / Session only / Not saved" status). Every load runs the field-by-field sanitiser. Unreadable data is set aside, never overwritten or deleted. Appearance reset must never touch ratings or watchlist. Always access storage via the safe wrappers in `src/lib/storage.ts` (storage can be blocked or full).

## On-device AI rules

Full policy: `docs/Moodsift-Local-AI-Engine-Policy.md`. Key invariants:

- AI **only rewords** supplied rule-based reasons. Any failure, timeout or invalid output keeps the original reasons.
- A model is "ready" only after full init **and** a passing smoke generation. Never shorten loading, init, smoke-check or output-validation steps to appear faster.
- Generation is serial and deterministic. Model downloads happen at runtime from CDN and are **never** part of `npm install`.
- Pinned HF revisions live in `ai-policy.ts` (source of truth); `ai-manifest.json` must match (a test asserts this). Checksum mismatches **fail closed**, discard the cache, and fall through to the next candidate.
- Don't override `wasmPaths` in the worker (a past bug: wrong CDN folder → every WASM load 404'd).
- Multi-threaded WASM only when `self.crossOriginIsolated`; WebGPU only after a real `navigator.gpu.requestAdapter()`.
- Modes never silently switch to cloud AI, and the saved mode is never changed without user action. No AI path receives stored ratings or the profile.
- "Lightweight / data saver" means no model download and no inference at all.

## Worker / security

- `/api/recommend` is **off by default**: the `ai` binding is commented out in `wrangler.jsonc`, the frontend never calls it, and the route returns 503 without `env.AI` and fails closed without the shared `RECOMMEND_LIMITER`. Don't wire the frontend to it. Requests with >40 candidates are rejected, not truncated.
- `Content-Security-Policy: frame-ancestors 'self'` is enforced; the full CSP ships as **Report-Only** until validated in a real browser. Don't promote or tighten it without checking the live console.
- COOP/COEP (`credentialless`) headers are set on all asset responses for the AI worker's fast path. Don't remove them.
- Keep provider errors redacted in Worker responses.

## Testing conventions

- Tests build with a dummy TMDB key and **mock every TMDB response** (`tests/fixtures.ts`: `mockTmdb`, `mockSearchResults`, `openSettings`). Never hit the live API from tests.
- A second build with **no** key covers the "no key → no request, static sample visual" case (port 4322).
- New UI needs: a flow/regression test where behaviour changes, and an axe scan for new Settings sections / card types / design styles / search types.
- `APP_VERSION` in `src/lib/app-version.ts` must equal `package.json` `version` (a test fails on drift). Bump both together.
- Visual snapshots are intentionally not committed (`tests/**/*-snapshots/` is gitignored).

## Style

- Match existing patterns before inventing new ones. Small, scoped changes; don't mix a refactor with a feature.
- Comments explain *why* (this codebase has long, useful header comments on files — keep them accurate when behaviour changes).
- User-visible change → add a `CHANGELOG.md` entry (Added / Changed / Fixed, with a short "why"). Keep the "Not in this release" and "Verification" honesty: state what was and wasn't actually run.
- Don't invent data: no fabricated checksums, ratings, or performance claims.

## Known issues / watch-outs (verify before relying on these)

- **`package.json` has duplicate keys** in `devDependencies` (`@types/node` and `oxlint` each appear twice with different versions). Clean this up (keep one of each) and regenerate `package-lock.json`.
- **`src/data/ai-manifest.json` has empty `files` arrays** (`generatedAt: null`), so every model currently reports *Not yet verified*. `npm run ai:manifest` must be run in a network-enabled environment, the diff reviewed, and the result committed; then `ai:manifest:check` becomes a meaningful release gate.
- **`CONTRIBUTING.md` says "no automated test suite yet"** — that is stale; a Playwright suite exists.
- Full CSP is still Report-Only (see above).
- The Playwright suites and real model downloads/inference have not been verified in every environment this was developed in; confirm in CI.

## Working in this repo without a local clone

The maintainer often edits through the GitHub web UI, so at the end of every task provide:

1. **Files added / modified / deleted** — an explicit list of exactly what to upload to or remove from git.
2. Full file contents (or a diff / updated ZIP) for each changed file — no "rest unchanged" elisions.
3. What you ran (`typecheck`, `lint`, `build`, `test`) and the result, plus anything you could not run.
4. Any adjacent bugs you noticed (flag them; fix only if in scope or trivially safe).
