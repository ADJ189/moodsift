<div align="center">

<img src="public/logo.png" width="120" alt="Moodsift logo" />

# Moodsift

**Find what to watch, in 60 seconds.**
Seven quick questions, a few titles you already know, and a live pull from thousands of real TMDB titles — matched to your taste, not re-sorted from a fixed list.

**[Open the live app → moodsift.adj189.workers.dev](https://moodsift.adj189.workers.dev/)**

[![Build](https://img.shields.io/badge/build-Vite%208-7c5cf0?style=flat-square)](https://vitejs.dev)
[![TypeScript](https://img.shields.io/badge/TypeScript-strict-3178c6?style=flat-square)](https://www.typescriptlang.org)
[![License: Apache 2.0](https://img.shields.io/badge/license-Apache%202.0-blue?style=flat-square)](./LICENSE)
[![No framework](https://img.shields.io/badge/framework-none-22d3ee?style=flat-square)](#tech-stack)
[![Deploy](https://img.shields.io/badge/deploy-Cloudflare%20Workers-f38020?style=flat-square)](#deployment)

</div>

## Contents

| | |
|---|---|
| **Product** | [Features](#features) · [Screenshots](#screenshots) |
| **Build & run** | [Tech stack](#tech-stack) · [Getting started](#getting-started) · [Configuration](#configuration) · [Testing](#testing) · [Deployment](#deployment) |
| **Under the hood** | [Architecture](#architecture) · [How recommendations work](#how-recommendations-stay-fresh) · [On-device AI](#on-device-ai) · [Performance](#performance) |
| **Project** | [Roadmap](#roadmap) · [Contributing](#contributing) · [Privacy](#privacy) · [Security](#security) · [Credits](#credits) · [License](#license) |

---

## Features

### Discover — the quiz and live catalog

- **Live catalog, not a fixed list.** Every query hits TMDB's `/discover` endpoints directly — hundreds of candidates per query, filtered by genre, era, format, and language, so results actually change with your answers.
- **Adaptive quiz.** Seven quick questions, including a dedicated anime / Western cartoon / sitcom style pick. Later questions narrow their own options based on what you've already answered — picking "horror" won't then offer "light & fun" as a tone.
- **Genre-weighted taste calibration.** Picking a mood pulls ~75% of the titles you rate live from TMDB in that genre, with the rest kept as broadly-known anchors — rating "horror" actually calibrates against horror, not a fixed generic list.
- **An era pick that's actually enforced.** Era (classic/mid/recent) is a hard filter on the candidate pool, not just a scoring nudge.
- **Precise / Grouped toggle.** Grouped is a wide, forgiving pool (default). Precise holds results to a 68%+ match floor and returns fewer, tighter picks.
- **Letterboxd import.** Drop in a `ratings.csv` export to skip manual re-rating; the latest import replaces the previous imported library, and ratings you gave in the app are never touched.

### First impression — the landing gallery

- **A real look at what's popular, honestly labelled.** With a TMDB key, the landing page shows a swipeable poster gallery of eight popular movies and series — *popular, not personalised*, and it says so. Drag, swipe, tap, use the arrow buttons or the keyboard; *Explore title* opens the title in the search flow. It auto-advances gently (with a Pause button), respects Reduced Motion, costs two TMDB requests, and falls back to the static sample card with no key or if TMDB is unreachable.

### Explore — search, cast and where to watch

- **Search a title, see what's actually similar** — or search an actor, director, or other crew and see their best-known work. Results come from TMDB's own recommendation/credit data rather than being re-scored against your quiz answers, since taste isn't the same every session and a title's own data doesn't depend on who's asking.
- **Cast & crew, click-through.** Every title's detail view shows its top-billed cast and director(s)/creator(s); click anyone to open their page — photo, bio, and best-known work ranked by rating.
- **Streaming availability with a manual region picker.** See where a title can be streamed, rented, or bought (JustWatch data via TMDB) on both the search screen and the results detail sheet. Defaults to a guess from your browser's locale, but a dropdown lets you pick any of ~50 supported countries and re-checks instantly; your pick is remembered on this device.
- **Hover for the quick take, click for the full picture.** Hovering a result shows a synopsis and ratings preview; clicking opens the detail sheet with TMDB / Rotten Tomatoes / Metacritic / IMDb scores, streaming availability, a trailer link, and the watchlist toggle.

### Personalize — a profile with no account

- **Local profile.** Created automatically on first visit: your rating history and watchlist persist across sessions, and every past rating feeds back into the engine, so a returning session starts informed instead of cold. No signup, no sync, nothing sent anywhere — reachable any time from the profile icon in the header, with a one-click reset. Choose from 11 colors and a curated set of film-themed icons for your avatar.
- **Watchlist.** Bookmark any result from its card or the detail sheet; manage the list from the header on any screen.
- **Compare shortlist.** Pick 2–3 results and compare them side by side (type, year, genres, TMDB rating, match reasons; unavailable fields say so rather than guessing).

### Refine — keep going after the first results

- **Rate right on the card.** Every recommendation has an inline star row, and the grid re-curates using every signal collected so far (this session's ratings plus everything your local profile remembers). Rating updates instantly; re-curation debounces ~1.6 s so a quick streak of taps doesn't re-render on every click. Titles you've just rated stay on screen with their stars filled while the rest of the grid adjusts around them.
- **"Give me another."** One click pulls a fresh, unseen set from TMDB.
- **Never a dead end.** If a narrow filter combination runs low, the app escalates through fallbacks — a later TMDB page, a loosened Precise floor, then a labeled repeat — instead of leaving a blank screen.

### Appearance — make it yours

- **Settings workspace / Theme Studio** (Overview · Cards & layout · Search · Theme · Readability · Motion & performance · AI engine · Advanced). Pick a **card type** (Interactive, Poster gallery, Editorial, Compact), a **design style** (Cinematic, Minimal, Film journal, Glass, Neon noir) and a **search type** (Grouped, Compact, Expanded, Full page) independently, or start from a preset. These change presentation only. The theme tools: System/Dark/Light, 8 hand-tuned palettes (each with separate, contrast-checked dark and light maps), custom accent, 8 self-hosted font pairings, text size, line spacing, content width, density, poster size, card corners, results layout, motion profile, and particle level. Live preview, undo/redo, up to three saved looks, versioned export/import, and reset (appearance only — never ratings or watchlist).
- **Command menu** (<kbd>Ctrl</kbd>/<kbd>⌘</kbd>+<kbd>K</kbd> or <kbd>/</kbd>) and shortcut help (<kbd>?</kbd>).
- **Accessible by default.** Keyboard- and screen-reader-operable, axe-tested, WCAG AA text contrast across every palette, and Motion: Off always wins.

### On-device AI — optional

- Turns each result's rule-based reasons into one natural sentence, running entirely in a Web Worker. Picks a model and quantization tier from your device's memory, core count and WebGPU support, and falls through several CDN options and a short, resource-checked list of pinned models until one fully loads and passes a start-up check.
- No API key; titles, quiz answers, and prompts are not sent for AI processing. Runtime and model downloads still send request metadata, including your IP address, to the download hosts.
- Choose the priority under Settings → AI engine (Best quality / Balanced / Fastest / Lightweight data saver). It only rewords the rule-based reasons — ranking stays deterministic. Opt-in, never a dependency.

### Privacy

- **No tracking, no server account.** Nothing is sent anywhere except the TMDB/OMDb API calls needed to fetch and score titles. The local profile lives entirely in your browser's `localStorage`. Details in [PRIVACY.md](./PRIVACY.md).

## Screenshots

| Landing | Results |
|---|---|
| _Add a screenshot of the landing screen here_ | _Add a screenshot of the results grid here_ |

---

## Tech stack

Vanilla TypeScript + Vite. No framework. The UI is a handful of screens and a small pub-sub store (`src/lib/store.ts`) — not enough surface area to justify a compiler-driven framework, and it keeps the bundle small (the on-device AI worker and the hero particle canvas are separate, lazily-loaded chunks that most page loads never touch).

| | |
|---|---|
| **Language** | TypeScript, `strict: true` |
| **Build** | Vite 8 |
| **Lint** | oxlint |
| **Data** | [TMDB](https://www.themoviedb.org/documentation/api) (required), [OMDb](https://www.omdbapi.com/) (optional) |
| **On-device AI** | [`@huggingface/transformers`](https://huggingface.co/docs/transformers.js) v4, loaded from CDN, Web Worker, WebGPU with a WASM fallback |
| **Tests** | Playwright + axe (desktop and mobile Chromium) |
| **Deploy target** | Cloudflare Workers (static assets + a small API Worker) |

## Getting started

The live deployment already has `VITE_TMDB_TOKEN` set as a Cloudflare **project variable**, so production builds need nothing from you — this section is for running the app locally.

```bash
npm install
cp .env.example .env
npm run dev        # local Vite dev server
```

| Command | What it does |
|---|---|
| `npm run dev` | Local Vite dev server |
| `npm run typecheck` | Strict TypeScript, zero errors (covers `src/` and `worker/`) |
| `npm run lint` | oxlint |
| `npm run build` | Typecheck, then production build to `dist/` |
| `npm run worker:dev` | Run the actual Cloudflare Worker locally via wrangler, serving `dist/` |
| `npm test` | Playwright suite |

## Configuration

Fill in `.env`:

| Variable | Required | Where to get it |
|---|---|---|
| `VITE_TMDB_TOKEN` | Yes for local dev — the app runs in a "TMDB not configured" demo state without it | [themoviedb.org/settings/api](https://www.themoviedb.org/settings/api) → API Read Access Token (v4) |
| `VITE_OMDB_KEY` | No — adds Rotten Tomatoes / Metacritic / IMDb as a secondary signal | [omdbapi.com/apikey.aspx](https://www.omdbapi.com/apikey.aspx) (free tier) |

`VITE_`-prefixed vars are build-time only — Vite bakes them into the client bundle, the Worker doesn't read them at request time. That's why they're set as Cloudflare **project variables** (used at build time), not Worker secrets.

### Connectors

| Connector | Status | Purpose |
|---|---|---|
| **TMDB** | Required | Live catalog, search, similarity, streaming availability |
| **OMDb** | Optional | Rotten Tomatoes / Metacritic / IMDb as a scoring signal |
| **Letterboxd** | Optional | Import a `ratings.csv` export for taste calibration |
| **Local profile** | Always on | localStorage identity, rating history, watchlist — this browser only |
| **On-device AI** | Optional, opt-in | Loads a small quantized model from CDN at runtime (never part of `npm install` — see the comment at the top of `src/lib/ai-worker.ts`) |

## Testing

```bash
npm run test:install   # once: downloads Chromium for Playwright
npm test               # builds with a dummy TMDB key, mocks TMDB, runs desktop + mobile
npm run test:visual    # opt-in screenshot comparisons
```

The suite covers appearance persistence/validation, the quiz → rating → results flow, rating a result, movie/TV id collisions, library re-import semantics, compare, the command menu, keyboard/focus rules, and axe accessibility scans. Visual baselines are intentionally **not committed** (rendering differs between machines): generate them where they'll be compared with `npm run test:visual -- --update-snapshots`. CI also runs typecheck, lint, build, and Lighthouse.

## Deployment

```bash
npm run deploy   # builds, then runs `wrangler deploy`
```

Moodsift is a genuine Cloudflare Worker (`wrangler.jsonc` declares `main: worker/index.ts`), not a Pages project — it serves the built `dist/` folder via Workers Static Assets and handles `/api/recommend` itself. Live at **https://moodsift.adj189.workers.dev/**.

Set `VITE_TMDB_TOKEN` (and optionally `VITE_OMDB_KEY`) as **project variables** in the Cloudflare dashboard so they're present when `npm run build` runs; `.env` is gitignored and never committed.

The Worker's `name` in `wrangler.jsonc` (`moodsift`) is also the `workers.dev` subdomain, and `wrangler deploy` matches on it — renaming it later creates a brand-new, unconfigured Worker instead of updating the one that already has your variables.

---

## Architecture

```
src/
  lib/
    tmdb.ts          live catalog — /discover/movie + /discover/tv, genre-mapped, era-classified,
                      paginated on demand; also search/multi, /recommendations + /similar, and
                      /watch/providers. Cached by request URL with in-flight de-duping
    engine.ts        scoring model — quiz + calibration ratings + in-session result ratings
                      → matchPct + reasons; era is a hard filter here
    rating-pool.ts   builds the calibration list — ~75% genre-weighted to the quiz's mood
    omdb.ts          optional secondary rating signal
    letterboxd.ts    parses a Letterboxd ratings.csv export
    profile.ts       local profile — identity, avatar, rating history, watchlist (localStorage)
    media-key.ts     `movie:123` / `tv:123` identity used for ratings, watchlist, caches
    store.ts         small pub-sub store — the entire "framework"
    dom.ts           tiny element-builder helper
    rating-ui.ts     shared watchlist-button and star-row builders
    providers-ui.ts  shared watch-providers section (region select + provider row)
    credits-ui.ts    shared cast/crew row builder
    region.ts        streaming-availability region (manual override → locale guess)
    appearance.ts    mode, palette, font, motion & layout preferences (validated, versioned, local)
    settings-panel.ts the Settings workspace / Theme Studio (previews in settings-previews.ts)
    card-ui.ts       shared pieces of a title card (type line, rating, quick actions)
    fonts.ts         self-hosted font presets, loaded on demand
    theme.ts, header.ts, icons.ts, toast.ts, command-palette.ts, compare.ts, ambient.ts, artwork.ts
    llm.ts           main-thread wrapper for the on-device AI: timeouts, caching, status
    ai-worker.ts     the on-device model — candidate list, staged load, smoke check, serial queue
    ai-policy.ts     pure policy: model catalogue, eligibility, prompt and output checks
    ai-settings.ts   the AI engine mode (own storage key, independent of appearance)
  screens/           landing, quiz, rating, results, search — one module each, lazily loaded except landing
  components/        landing-carousel.ts — the landing page's popular-titles gallery (Pointer Events + CSS transforms)
  data/              quiz questions, taste-calibration seed titles
worker/
  index.ts           Cloudflare Worker entry — serves dist/ via the ASSETS binding, handles
                      POST /api/recommend (optional Workers AI re-ranking), and sets the COOP/COEP
                      (`credentialless`) headers the on-device AI's multi-threaded WASM path needs
public/              logo, favicons, app icons, social image
assets/brand/        full-resolution logo masters (not served)
docs/                Moodsift-Local-AI-Engine-Policy.md
tests/               Playwright specs
```

**The client-side engine is fully self-sufficient.** `worker/index.ts`'s `/api/recommend` route is an enhancement layer, not a dependency — nothing in `src/` calls it. It is same-origin only, size/shape-validated, redacts provider errors, and supports an optional per-IP rate limit (see the commented `ratelimits` example in `wrangler.jsonc`). To use it, turn the AI binding on in the Cloudflare dashboard (Settings → Bindings), not just in `wrangler.jsonc`.

### Search vs. the quiz engine

`search.ts` is deliberately not "results.ts with a search box." The quiz flow scores candidates against *this user's* stated preferences — right for "recommend me something", wrong for "what's actually similar to this title" or "what's this person's best work", since neither depends on who's asking. So similarity comes from TMDB's own data: `getSimilarTitles()` merges `/recommendations` with `/similar`, and `getPersonBestWork()` ranks a person's combined filmography by rating with a vote-count floor. None of this runs through `engine.ts`. Cast & crew (`getCredits()`) ties the two together; from the results modal, clicking a person closes the modal and opens the search screen already loaded on them (`store.openInSearch()`).

### How recommendations stay fresh

1. The quiz and calibration ratings seed an initial TMDB query (up to 3 pages × 2 media types), hard-filtered by era if one was picked.
2. `engine.ts` scores every candidate and returns the top batch, excluding anything already shown.
3. Rating a result card feeds that title's own genre/vibe tags straight back into the engine, and the grid re-scores after a short debounce. Rated titles leave the scoring pool (they already got a verdict) but the most recent few stay on screen with their stars filled.
4. If a re-score comes back empty, `ensureBatch()` in `results.ts` escalates: retry ignoring the "already shown" set, pull a later TMDB page window, drop Precise mode's match floor, and only as a last resort show the pool's best titles again — with a small note whenever it had to compromise.

### On-device AI

The full policy is in [`docs/Moodsift-Local-AI-Engine-Policy.md`](docs/Moodsift-Local-AI-Engine-Policy.md). In short: ranking is deterministic and never changes; local AI only rewords the supplied reasons; a model is reported ready only after it fully initialises and passes a smoke generation; generation is serial and deterministic; and any failure keeps the original reasons. Cloudflare Workers AI is deferred and not called by the frontend. Model sizes are approximate weight-file sizes, not memory use or measured performance.

<details>
<summary>History: why on-device AI used to fail</summary>

`ai-worker.ts` used to manually pin `wasmPaths` (where the WASM binary that runs the model is fetched from) at `@huggingface/transformers`'s own CDN folder — but that folder only contains a JS glue file, not the `.wasm` binary. The real binary ships in the separate `onnxruntime-web` package. Every WASM-tier load therefore 404'd on the binary fetch, which is most devices — WebGPU is the minority path. Fixed by not overriding `wasmPaths` at all; the library's own default is correct by construction.

Two related hardening fixes went in alongside it: a real `navigator.gpu.requestAdapter()` check before attempting the WebGPU tier, and multi-threaded WASM only when the page is actually cross-origin isolated (`self.crossOriginIsolated`). `worker/index.ts` sets the COOP/COEP headers on every response so the fast path is available; without them the worker still runs, single-threaded.

</details>

### Performance

- **Lazy-loaded screens.** Landing is the only screen in the initial bundle; quiz/rating/results/search are separate chunks fetched on first navigation.
- **Request caching + de-dupe.** `tmdbFetch()` caches by request URL for the session (capped at 300 entries) and collapses concurrent identical requests into one.

---

## Roadmap

- **Letterboxd reviews.** `letterboxd.ts` currently only parses a `ratings.csv` export (star ratings, for taste calibration). Pulling in actual review *text* is planned but not started — Letterboxd has no public review API, so this needs more design work on where the data comes from.

## Contributing

Issues and PRs are welcome. Before opening a PR:

```bash
npm run typecheck   # must be clean — strict mode, covers src/ and worker/
npm run build       # must succeed
```

Keep the "no framework" constraint in mind — new UI goes through `src/lib/dom.ts`'s `el()` helper, not a new dependency. See [CONTRIBUTING.md](./CONTRIBUTING.md) for the full workflow and scope, and the [Code of Conduct](./CODE_OF_CONDUCT.md).

## Privacy

No accounts, no analytics, no tracking — everything Moodsift remembers about you lives in your browser's localStorage, and the only network calls are the direct TMDB/OMDb requests needed to fetch and score titles. See [PRIVACY.md](./PRIVACY.md) for the full breakdown.

## Security

See [SECURITY.md](./SECURITY.md) for the reporting policy. Dependabot is configured for weekly npm checks.

## Credits

TMDB, JustWatch (via TMDB), OMDb, and a handful of open-source libraries and design references make this project possible — see [CREDITS.md](./CREDITS.md) for full attribution.

## License

Apache 2.0 — see [LICENSE](./LICENSE).
