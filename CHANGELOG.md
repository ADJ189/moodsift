# Changelog

All notable changes to this project are documented here.

## [1.12.0] — Landing gallery

### Added
- **Popular-titles gallery on the landing page.** With a TMDB credential, the hero's static sample card is replaced by a centre-focused poster deck of eight currently popular movies and series (four of each, interleaved, ordered by TMDB popularity). It is clearly labelled *Popular picks · Not personalised* — nothing is scored against your taste, and no match percentage is shown.
  - **Gestures:** drag or swipe the deck (a card tracks the pointer directly, then settles with a small spring); a drag past ~22% of the gallery width — or a quick flick — moves exactly one title. Vertical movement stays a normal page scroll. Tap a side poster to bring it forward; tap the centre poster or *Explore title* to open it in the existing title-search flow.
  - **Controls:** previous/next buttons, a dot pager (a labelled button per title), `←` `→` `Home` `End` while focus is inside, and a polite screen-reader announcement ("3 of 8: Title, year, movie"). Inactive posters are hidden from assistive technology and are never tab stops.
  - **Ambient backdrop:** a blurred, theme-masked backdrop cross-fades behind the deck (poster art as the fallback; plain gradient if neither loads) and never blocks the poster change.
  - **Idle auto-advance** every ~7 s, with a visible Pause/Resume button. It stops for hover, keyboard focus, drag, a hidden tab, an off-screen gallery, Pause, and reduced motion, and waits ≥ 8 s after any manual interaction.
  - **Motion:** follows Appearance → Motion *and* `prefers-reduced-motion`, live. Full = tilt, parallax and spring; Subtle = shorter and gentler; Off = no tilt, parallax, rebound or autoplay, with instant changes.
  - **Cost:** one `/discover` request per media type (two in total, through the existing cached/retrying TMDB client), cancelled if you leave the page; a skeleton with the final footprint reserves the space so nothing shifts.
  - **Fallbacks:** no TMDB key → no request and the static sample card, exactly as before; request failure or nothing usable → the sample card; a single title → a static card with no dead controls; a missing poster → an initial-letter tile.
- `getLandingShowcase()` in `src/lib/tmdb.ts`; `chevronRight`, `play` and `pause` icons.
- `tests/landing-carousel.spec.ts` (data/loading, fallbacks, navigation, keyboard, gestures, touch, motion preferences, autoplay with a paused fake clock, cleanup/cancellation, and a layout matrix from 1440 px to 320 px). `playwright.config.ts` now also serves a second, key-less build so the "no credential → no request" case is tested for real.

### Fixed
- A mostly-vertical mouse drag that ended over the same poster could still count as a click; any drag, in any direction, now suppresses the click (a plain tap still works).

### Known, unchanged
- At a 320 px viewport the page header's action buttons extend ~23 px past the viewport edge (pre-existing; not caused by the gallery).

## [1.11.0] — Moodsift: redesign + rebranding

CineMatch is now **Moodsift** (the old name was too common to be findable). Live at <https://moodsift.adj189.workers.dev/>.

### Changed — rebranding
- **New name everywhere:** app header, page title and meta description, Open Graph/Twitter tags, appearance-export error text, the "Moodsift Default" font pairing, Worker prompt, `package.json` (`moodsift`, version `1.11.0`, lockfile), `wrangler.jsonc` (`name: "moodsift"`, which is also the `workers.dev` subdomain), and every doc (README, CONTRIBUTING, PRIVACY, CREDITS, the local-AI policy).
- **Docs file renamed:** `docs/CineMatch-Local-AI-Engine-Policy.md` → `docs/Moodsift-Local-AI-Engine-Policy.md` (links updated; a stray upload-link line at the top of the file removed).
- **Storage keys deliberately unchanged** (`cinematch-appearance:v1`, `cinematch-local-ai:v1`, `cinematch.profile.v1`, `cinematch-region`, `cinematch-looks:v1`, `cinematch-vibe:v1`, and the `cinematch-appearance` export tag). They are internal identifiers; renaming them would silently wipe existing ratings, watchlists, looks and settings. Existing profiles and appearance exports carry over untouched.

### Added — new visual identity
- **New logo:** an iridescent liquid-chrome four-point star, replacing the film-sprocket badge. Shipped as a background-removed transparent PNG (`public/logo-transparent.png`, plus a 96 px header mark `logo-96.png`) and a normal dark-background PNG (`public/logo.png`). Full-resolution masters of both live in `assets/brand/` (not served).
- **Favicon and app icons:** `favicon-32.png`, `apple-touch-icon.png` (opaque tile, since iOS fills transparency with black); the old `logo.svg` / `favicon.svg` are removed.
- **Social preview:** `og-image.png` (1200×630) with Open Graph and Twitter card tags pointing at the new site.
- **Boot loader** now pulses the logo instead of showing a generic spinner (still pre-paint, still themed from the stored palette).

### Changed — docs
- **README restructured into categories:** Overview, Features (Discover · Explore a title · Personalize · Refine results · Appearance · On-device AI · Privacy), Tech stack, Getting started, Configuration, Architecture, Deployment, Testing, Roadmap and Project info. Content is preserved; the "why it used to fail" history now sits under Architecture.

### Fixed
- **A rated title went blank.** Rating a result re-curated the grid after the debounce, and rated titles are (correctly) excluded from the scoring pool — so the card you had just rated disappeared and left an empty slot, and with a narrow filter the whole grid could end up empty. The most recent rated titles (up to 6) now stay on screen with their stars filled, merged in match order with the fresh picks. Covers both the card star row and the detail sheet. Regression test added in `tests/regressions.spec.ts`.
- On-device AI selects WASM directly when a WebGPU adapter lacks `shader-f16`, which the configured GPU models require.
- Clarified that titles, quiz answers, and prompts stay on-device for AI processing, while runtime and model download hosts receive request metadata including the user's IP address.

### Dependencies
- `vite` 8.3.1 → 8.3.4, `@playwright/test` 1.56.0 → 1.64.1, `@axe-core/playwright` 4.10.2 → 4.14.0, `wrangler` 4.148 → 4.151.1, `oxlint` 1.87 → 1.88.0, `@types/node` 22.15 → 22.20.5 (kept on the 22 line to match the Node 22 used in CI and Cloudflare builds). `package.json` and `package-lock.json` are in sync; `npm audit` reports 0 vulnerabilities.
- Unchanged on purpose: `typescript` (7.0.2), Fontsource packages (5.3.0) and the `sharp` override are already at their latest releases; the `undici` override stays pinned at 7.30.0.

### Notes
- `wrangler.jsonc` now names the Worker `moodsift`. A Worker with that name needs its own `VITE_TMDB_TOKEN` (and optionally `VITE_OMDB_KEY`) build variables; the old `cinematch` Worker can be deleted once the new one is verified.
- The GitHub link in the header still points at `ADJ189/Cinematch`; GitHub redirects renamed repositories, so renaming the repo later is safe.

## [1.10.3] — Local AI review fixes

### Fixed
- A slow download is no longer abandoned as "stalled" while bytes are still arriving: the worker sends a throttled activity heartbeat independent of the displayed percentage (including at the 99% cap).
- An open AI engine panel now follows a mode change made in another tab, and releases that subscription when the panel closes.
- Output check: a standalone "No." is a sentence end, so `No. It is tense and dark.` is rejected; "No." before a number (`No. 1`) is still treated as an abbreviation.

## [1.10.2] — Local AI optimizer

Policy: [`docs/Moodsift-Local-AI-Engine-Policy.md`](docs/CineMatch-Local-AI-Engine-Policy.md). Ranking is unchanged and deterministic; local AI only rewords the supplied reasons. Cloudflare Workers AI is deferred — `/api/recommend` is untouched and not called by the frontend.

### Added
- **Settings → AI engine** with four modes — Best quality, Balanced (default), Fastest, Lightweight / data saver — stored under `cinematch-local-ai:v1`, independent of appearance (appearance reset, undo, looks and export never touch it). Data saver imports nothing and downloads nothing.
- Resource-first model choice (`ai-policy.ts`): Qwen2.5-0.5B, SmolLM2-360M and SmolLM2-135M at pinned Hugging Face revisions, exact backend/dtype per candidate (`q4f16` WebGPU, `q8` WASM). Low-resource and unknown-memory devices never automatically attempt Qwen.
- Staged loading status (checking device → runtime → download % → starting → quick check) and the chosen model, backend, dtype and approximate weight size once ready.
- Start-up smoke check: a model is only reported ready after a deterministic test generation returns usable text; otherwise it is disposed and the next candidate is tried.
- Strict output checks (one sentence, ≤ 20 words, no preamble/refusal/list/markdown). These verify format, not facts.
- Unit and browser tests for settings persistence, hostile stored values, data-saver (no worker, no model/CDN requests), failed load fallback, candidate order and output validation.

### Changed
- Generation is deterministic (no sampling) and serialised by a worker-side queue; cards update one at a time as each sentence completes, and a card with no usable sentence keeps its original reasons (previously a failed sentence collapsed the reason list into one joined line).
- Load timeout is now inactivity-based (120 s of silence) with a 20 min ceiling, instead of 60 s total; a generation timeout (30 s from when decoding starts) ends a wedged worker.
- Cache is bounded (150 entries), keyed by model + `movie:`/`tv:` key + summary, and cleared when the mode changes. Changing the mode resets the worker.
- Results and search buttons stay in sync with engine state, including across screens; in data saver the button opens the AI engine setting.

## [1.10.1] — Review fixes

### Fixed
- Command menu "Search titles for…" now works while the search page is already open (the screen consumes new targets itself) and no longer replays an old query later.
- `?` no longer opens shortcut help on top of the compare dialog or a detail sheet.
- Appearance drawer: applying/deleting a saved look no longer drops keyboard focus (the list is only rebuilt when looks change, and focus is handed to the equivalent control).
- Focus trap skips roving-tabindex options parked at `-1`, so Tab enters each grouped control once and arrow keys keep their purpose.
- Compare buttons are tracked in one self-pruning registry, so cards removed by "Different picks" are released immediately rather than lingering and repainting.
- "Compare with before" now also drives the hero particle canvas (and every JS-resolved effect) from the previewed preferences, not just the CSS.

## [1.10.0] — Theme Studio, compare, command menu, tests

### Added
- **Theme Studio:** up to three named *looks*, versioned appearance export/import (strict schema — unknown keys or out-of-list values reject the whole file; no ratings or profile data ever included), "Compare with before" preview, "Restore previous", undo/redo across all of it.
- **More layout & effect controls:** results layout (poster grid / spotlight / compact list), poster labels, shadows, grain; advanced effects (particle density, connection lines, pointer response, click pulse, poster tilt, hover glow, transition intensity). Everything is bounded, adapts *down* on touch/low-power, and Off always wins.
- **Artwork ambience:** a confined halo around your top pick tinted from its poster, with a safe fallback when the image can't be read. Decoration only.
- **Compare shortlist:** pick 2–3 results, compare side by side (type, year, genres, TMDB rating, match reasons; unavailable fields say so rather than guessing). Keyboard- and screen-reader-operable; swipeable on phones.
- **Command menu** (Ctrl/Cmd+K or "/") and shortcut help ("?") with documented conflict rules (never while typing, never on top of another dialog).
- Shared-element poster → detail transition and a one-time top-pick light sweep (both progressive, off with Motion: Off / Minimal).
- **Playwright + axe test suite** (desktop & mobile Chromium) and a CI job; opt-in visual-regression specs.
- Worker: best-effort in-memory rate limit when the Cloudflare binding isn't configured, `Retry-After`, and a timeout on the AI call.

### Fixed
- **Muted/accent text below WCAG AA** in several light palettes (found by axe): all palettes now keep secondary/muted text ≥ 4.5:1 and accent text ≥ 4.6:1 on page, surface and tinted surfaces.
- **Rating-card stars overflowed and overlapped** at 125% text; the results page could scroll sideways at large text + wide width.
- **A choice made just before reloading or closing the tab could be lost** to the save debounce; saves now flush on page hide.
- Focus trap now moves explicitly across dialog + toast; failed Letterboxd lookups no longer erase an earlier import.
- Custom-accent warning also covers accents too close to the page colour.

## [1.9.0] — Appearance system, hero redesign, correctness fixes

### Added
- **Appearance drawer** (header → sliders icon): System/Dark/Light, 8 hand-tuned palettes (each with separate dark and light maps, contrast-checked), custom accent with a contrast warning, 8 self-hosted font pairings, text size, line spacing, content width, density, poster size, card corners, soft-glass surfaces, high contrast, reduced transparency, motion profile and hero-particle level. Live preview, auto-save, undo/redo, per-section and global reset (appearance only — never ratings or watchlist), "Surprise me", a one-time skippable "Choose your vibe".
- **Landing hero redesign:** product-as-artwork sample match card (CSS only), calmer layout, phone-first CTA, honest copy.
- **One ambient canvas** (`ambient.ts`) replacing the CPU fluid solver: pauses when hidden/off-screen, capped DPR and particle count, pointer response only in Interactive mode on a hover pointer, fully torn down on leave.
- **Toasts** with Undo for watchlist/appearance actions; View-Transition screen changes (plain swap where unsupported or motion Off); scroll-to-top and heading focus on navigation.
- Fonts are bundled (Fontsource) — **no Google Fonts requests**; only the default pairing loads on first paint.

### Fixed
- **Movie/TV identity collisions.** TMDB reuses numeric ids across movies and shows, so a rating, watchlist entry or "already seen" filter for one could hit the other. Everything now keys on `movie:123` / `tv:123` (ratings, history, watchlist, engine, caches, DOM selectors).
- **"Who's watching" did nothing.** The quiz collected it but nothing used it; it now tilts genre/vibe weights (family away from horror/dark thrillers, friends toward comedy/adventure, date toward drama/warm).
- **Re-importing a smaller Letterboxd export left stale ratings steering results.** The latest import now replaces the previous imported library; ratings you gave in the app are never touched.
- **Landing could stay dimmed** after leaving a lazy screen mid-load; **ambient loop could start after you had already left** the landing screen.
- Search: a title chosen elsewhere in the app (pending title target) was ignored.
- Open detail sheet is closed when its screen unmounts; stale async re-curation can no longer overwrite a newer one.
- Misleading "offline demo mode" warning replaced with an accurate missing-TMDB-key message.
- Profile popover: Escape, `aria-expanded`, focus handling; logo no longer reloads the page; light-mode primary-button text contrast.
- CI: duplicate `permissions` key removed; Node 22.

## [1.8.0] — Audit fixes, security hardening, cinematic redesign

### Security
- **undici → 7.30.0** (npm `overrides`, lockfile regenerated). Clears all six reported advisories (the BalancedPool TLS bypass is fixed from 7.29.1; 7.30.0 is the newest 7.x). `npm audit` reports 0 vulnerabilities. undici is a dev-only transitive dependency of `wrangler`, so nothing ships to browsers.
- **`/api/recommend` hardened:** same-origin only (wildcard CORS removed), 16 KB body cap, strict allow-list input schema, de-duplicated/validated model output (every candidate returned exactly once), generic client errors (provider text and raw model output now stay in server logs), optional per-IP rate-limit binding.
- **COEP `require-corp` → `credentialless`.** Keeps the page cross-origin isolated for the on-device AI without blocking third-party TMDB images; also adds `nosniff` and a referrer policy to asset responses.

### Fixed
- **movie + sitcom returned zero candidates** (both media types disabled). Sitcom now forces series.
- **TMDB outages looked like "No matches."** Discovery and similar-title lookups now distinguish "every request failed" (retryable outage state) from a genuinely empty result, which offers a one-click "Broaden my matches".
- **Lazy-screen import failure left the app stuck loading.** Now shows a retry/reload state, with one guarded automatic reload for stale-chunk-after-deploy.
- **Theme storage could crash startup** in storage-blocked browsers; all storage goes through `src/lib/storage.ts`.
- **Profile JSON is now schema-validated** field by field; corrupt rows are dropped instead of trusted.
- **Match % is absolute.** It used to be min/max-scaled per batch ("92%" meant "top of this batch"). Now a fixed calibration curve, so the same title/taste gives the same % across searches. A separate relative `rankPct` is kept for ordering.
- **External (OMDb) ratings now influence ranking.** The top candidates are enriched (bounded concurrency, cached) before the scoring pass instead of after selection.
- **Letterboxd import rewritten:** the whole export (most recent 400 rows) is resolved on TMDB by title + year, half-star precision is kept, results are de-duplicated by TMDB id and persisted to the profile, all of it calibrates the engine, and a summary reports imported / matched / unidentified.
- **People/cast feature is wired end to end:** cast & director row in the detail sheet, person results in search, person pages, and the pending-search handoff.
- Search requests are cancellable (`AbortController`); landing avatar honors the chosen emoji; landing copy says seven questions and no longer overclaims privacy; demo mode makes no TMDB poster lookups; streaming availability says when it fell back from your region; fluid canvas pauses when off-screen; search no longer autofocuses on touch devices.
- **Accessibility:** detail view is a real dialog (focus moves in, Tab is trapped, Escape closes, focus returns, `aria-labelledby`); poster/title controls are real buttons with visible focus; reduced-motion removes movement instead of shrinking durations to 1ms.

### Changed (design)
- Landing: new headline/CTA, staged entrance, trust line, spotlight + grain backdrop.
- Quiz: slide transitions (reverse on Back), option stagger, selection pulse, dot progress with stage labels.
- Results: real-progress loading steps, featured #1 pick, themed shelves (Strong matches / Hidden gems / Worth a stretch), match meter with confidence label, "why it matched" chips, poster hover choreography, "Give me another".
- Detail view: "Why this recommendation?", cast row, bottom sheet on mobile.
- New design tokens: shadows, glows, focus ring, spacing scale, motion levels.

### Review follow-ups (also in 1.8.0)
- Letterboxd matching no longer sends TMDB's `year` filter (it hid films dated one year off); the ±1-year check now runs on unfiltered results, exact year preferred.
- A rating is counted once: titles that are both a seed/result rating and in the saved history are no longer applied twice.
- Taste affinities are saturated and large imported libraries are down-weighted, so heavy imports can't push every title to the top of the match curve (curve re-fitted).
- Search: an older person/title response can no longer overwrite a newer selection.
- Quiz: Back during the post-answer pause cancels the pending submit; the timer is cleared on leaving the screen.
- Results: OMDb lookups have a 3.5s timeout and a 6s overall budget, so a hung request can't block the first batch.
- Stale-chunk reload guard is reset only after a lazy screen actually loads, so a persistent failure shows the retry screen instead of reloading repeatedly.
- `/api/recommend` enforces the 16 KB cap while streaming the body (stops reading at the limit) rather than after buffering it.

- Import down-weighting now applies only to *imported* entries; ratings the person gave in the app in earlier sessions keep full weight regardless of library size. An import also no longer overwrites a rating the person gave themselves for the same film.
- Letterboxd matching considers the whole TMDB result page and searches in stages (stated year → unfiltered → adjacent years), so a title with many namesakes still resolves to the right film.

### Not changed (still open from the audit)
Watched/Not-for-me feedback, Tonight mode, Group Match, provider-aware filtering, browse collections, IMDb import, unit/E2E tests, and the shared-element poster transition are larger features and are not in this release.

## [1.7.1] — Lint and Lighthouse CI

### Added
- **oxlint.** Config in `.oxlintrc.json`, scripts `npm run lint` / `npm run lint:fix`. Chosen over ESLint/`typescript-eslint` because `typescript-eslint` hard-fails against TS 7's native compiler (no programmatic API yet — confirmed via live testing, known unresolved upstream gap pending TS 7.1); oxlint has no dependency on the `typescript` package so it's unaffected and needed no workarounds. Runs clean (0 findings) against the current codebase.
- **Lighthouse CI.** `lighthouserc.json` runs three headless-Chrome passes (desktop preset) against the built `dist/` and asserts on the four category scores only — accessibility is a hard `error` gate at 0.9, performance/best-practices/SEO are `warn` at 0.85–0.9. (Deliberately not the `lighthouse:recommended` preset, which also hard-asserts individual diagnostic-only audits.)
- **Two CI workflows:** `.github/workflows/ci.yml` (typecheck → lint → build, Node 22) and `.github/workflows/lighthouse.yml` (`treosh/lighthouse-ci-action` against the build).

## [1.7.0] — Manual streaming region, contributor docs

### Added
- **Region picker for streaming availability.** `getWatchProviders()` used to silently guess your country from the browser's locale and never let you change it — wrong for a browser locale that doesn't match where you actually subscribe, checking availability somewhere you're traveling to, or a household with multiple regional accounts. A new `region.ts` persists an explicit override (or falls back to the old locale guess) across ~50 JustWatch-covered countries; a dropdown next to the provider logos (search hero + results detail modal) lets you switch instantly and re-fetches for the new region. `providers-ui.ts` now exports `mountProviders()`, which owns the whole fetch → render → refetch-on-change lifecycle, replacing the old pattern of each call site fetching providers itself and calling a pure row-builder.
- **CONTRIBUTING.md, CODE_OF_CONDUCT.md, CREDITS.md, PRIVACY.md.** The README already had a short "Contributing" section and SECURITY.md already covered vulnerability reporting; these fill the remaining gaps a public repo's community-health checklist expects — a fuller PR/dev workflow doc, a Contributor Covenant code of conduct, attribution for the data sources and libraries this project depends on, and a plain-language explainer of what is and isn't collected (short version: nothing leaves the browser except the direct TMDB/OMDb API calls needed to fetch and score titles).

### Roadmap note
Letterboxd *review text* (not just star ratings, which `letterboxd.ts` already imports) is scoped for a future update — see the README's Roadmap section. Not part of this release.

## [1.6.0] — Search actors/directors, cast & crew, person pages

The Jellyfin/Plex "click a cast member to see their other work" pattern,
built on top of what 1.5.0 added. Jellyfin itself is a self-hosted media
*server* (C#/.NET, scans a local library) — a fundamentally different
architecture from this client-only, no-library TMDB app, so there's no
literal code to port. What carried over is the actual UX pattern, backed
by TMDB's own person/credits data instead of a local library scan.

### Added
- **Search people, not just titles.** The search screen now runs a title search and a person search (`/search/person`) together — search "Denis Villeneuve" or "Zendaya" as directly as a movie title.
- **Person pages.** Photo, department, birthday/place of birth, a short bio, and a "Best of {name}" grid — their combined filmography (`/person/{id}/combined_credits`) ranked by rating with a vote-count floor (same reasoning `discoverCandidates()` already applies elsewhere, so a one-review 9.8 short doesn't outrank a broadly-loved title).
- **Cast & crew on every title.** Both the search screen's title hero and the quiz-results detail modal now show the top-billed cast and director(s)/creator(s) (`getCredits()` — director comes from the crew list for movies, from TMDB's separate `created_by` field for TV, which genuinely differ, not an oversight). Click anyone to jump straight to their person page — from the results modal, that means closing the modal and switching to the search screen already loaded on that person, via a new `store.openInSearch()` navigation helper.
- **`getTitleDetails()`** in `tmdb.ts` — resolves a bare (id, type) to a full title, needed when navigation only carries an id (e.g. jumping to a title from someone's filmography).

### Changed — code quality
- **Extracted `src/lib/rating-ui.ts`.** The watchlist-toggle button and 5-star rating row were byte-for-byte duplicated between `results.ts` and `search.ts`; both now import one shared implementation.
- **Extracted `src/lib/credits-ui.ts`** for the same reason, shared between the search hero and the results modal.
- Net effect: two more real features shipped with *less* net duplication than before, not more — the shared-module pattern from 1.5.0 (`providers-ui.ts`) is now applied consistently rather than each new feature growing its own copy of card/button-building code.

## [1.5.0] — Title search + real similarity data, streaming availability, more avatars

### Added
- **Search screen (`src/screens/search.ts`).** Search for a specific movie or show and see what's actually similar to it. Deliberately *not* run through the quiz-calibrated engine — people's taste isn't the same every session, so a single title's similarity is better answered by TMDB's own data than by re-scoring it against stated quiz preferences from a different visit. `getSimilarTitles()` in `tmdb.ts` merges `/recommendations` (collaborative filtering — what people who engaged with this title also engaged with) with `/similar` (genre/keyword/cast overlap) as a fallback for titles where recommendations data is thin.
- **Streaming availability**, originally slated for a later v1.4.5 — feasible to include now, so it shipped here instead. `getWatchProviders()` pulls TMDB's JustWatch-sourced region data (guessed from the browser's locale, falling back to US) and renders stream/rent/buy provider logos with a link to full availability. Shown on the search screen's hero and, for consistency, on the quiz-results detail modal too — loaded asynchronously so it never blocks the rest of the detail view from rendering. Always paired with a "full availability" link, never presented as a standalone play action, since JustWatch/TMDB data isn't guaranteed complete or current.
- **On-device AI now also summarizes search-similar picks.** The same local model used to rewrite quiz-result reasons into one sentence (`explainPick()`) is reused here with a similarity-specific prompt instead of a quiz summary — "use AI to summarize/precise the recommends" is the same underlying feature applied to a second context, not a second AI integration.
- **More avatar options.** The color palette grew from 7 to 11, and a small picker for a curated, film-themed emoji set (🎬🍿🎭👾🐉🚀🔮🕵️👻🦇🧙📼) was added to the profile popover — pick a color, an icon, or both. The plain initial-letter avatar is still there as the default/fallback, never required to change.

### Changed — performance
- **Screens are now lazily loaded.** Landing is the only screen bundled into the initial script; quiz/rating/results/search each became a separate chunk, fetched on first navigation to that screen. Initial JS dropped from ~17.4 kB gzip to ~9.5 kB gzip — meaningful for the (common) case of someone previewing the landing page and leaving, who now never downloads the search screen's TMDB-similarity/watch-provider code at all.
- **`tmdbFetch()` now caches by request URL and de-dupes in-flight requests.** Reopening a detail modal, retyping a search you already ran, or two UI elements requesting the same title's watch providers in the same render all used to mean duplicate network calls; they now resolve from a session-lifetime cache (bounded to 300 entries) or collapse into the one request already in flight.
- **Extracted `src/lib/providers-ui.ts`.** The watch-providers row was on track to become two near-identical implementations (search screen + results modal); it's a single shared module instead.

### Scope note
File count is up (`search.ts`, `providers-ui.ts`, `search.css` are new — see the README's file list for the full upload manifest). The per-option emoji on the quiz screen are still untouched, same reasoning as 1.4.1.

## [1.4.1] — Custom icon set, warmer light theme

A continuation of 1.4.0's "closer to seriesgraph.com" pass — this part is
the visual craft layer on top of last version's functional one (local
profile, watchlist, hover preview).

### Added
- **`src/lib/icons.ts`** — a small custom inline-SVG icon set replacing the emoji chrome that was scattered through buttons and badges (🔀🌙☀️🍅Ⓜ️⭐✕ℹ️). Emoji render inconsistently across OS/browser (different weight, color, sometimes a completely different silhouette); a custom set inherits `currentColor` so it themes for free and reads as considered rather than default. Wired into the theme toggle, shuffle/back/close buttons, rating badges, the results note banner, and the empty-state actions.
- Rating rows (hover preview + detail modal) now use a middle-dot separator between icon+label pairs (`⭐ 8.4 · 🍅 91% · IMDb 8.2` → the same idea, rendered with the new icons) — a small nod to the "eps · rating · votes" chip style used on seriesgraph.com's show pages.

### Changed
- **Light theme is warmer.** The neutral canvas (backgrounds, surfaces, borders) shifted from a cool violet-tinted white to a warm cream/paper base — closer to the editorial, poster-forward feel of sites like seriesgraph.com, whose own `theme-color` is a warm `#f4eff0`. The violet/cyan/amber accent colors are unchanged; only the neutral canvas underneath them moved warm, since that's what was reading as "generic dark-app light-mode" rather than a considered light theme.
- `theme-color` meta (static in `index.html` and the JS-driven update in `src/lib/theme.ts`) both updated to match.

### Scope note
The per-option emoji on the quiz screen (mood/era/company/etc.) were left as-is — replacing dozens of option icons is a much larger, separate pass, and unlike the button/badge chrome, playful per-choice emoji in a quiz UI is a reasonably normal pattern rather than a polish problem.

## [1.4.0] — Local profile, watchlist, richer result previews

Moves the app from "everything resets when you close the tab" toward the
seriesgraph.com-style feel of a site that remembers you — without adding a
backend, a password, or anything that leaves the browser.

### Added
- **Local profile (`src/lib/profile.ts`).** A localStorage-backed identity — display name, avatar, and a full rating history — created automatically on first visit, no signup. Framed honestly in the UI as exactly what it is: on-this-device only, nothing synced, nothing sent anywhere. Falls back to session-only behavior (rather than crashing) if the browser is blocking storage (private mode etc.), and says so.
- **Ratings persist across sessions**, both from the calibration screen and the results screen. Closing the tab no longer resets your taste profile.
- **The engine now uses that whole history, every run.** Every previously-rated title (not just this session's) is fed into `engine.processResultRating()` before scoring, and excluded from ever being re-recommended — so a returning user's very first batch is already informed instead of a cold start every time. This is the concrete version of "let the AI use more data."
- **Watchlist.** A bookmark toggle on every result card and in the detail modal, a persistent watchlist panel in the header's profile popover (reachable from every screen), stored in the same local profile.
- **Hover/click info preview.** Hovering a result poster now reveals a quick-glance panel — synopsis snippet + TMDB/RT/IMDb ratings — using data already on the card (no extra fetch). Clicking still opens the full detail modal (cast-level synopsis, full ratings breakdown, trailer link, watchlist toggle, rate). Touch devices skip straight to the tap-through modal since there's no hover state to reveal the panel in.
- A landing-screen "Welcome back" banner for returning profiles, showing how many titles have been rated on this device and swapping the CTA to "Get fresh picks."

### Changed
- Landing page eyebrow copy updated from "no account" to "no server account / nothing leaves your device untracked" — still accurate (there's genuinely no backend or sync), now precise about what the local profile is.

### Scope note
This is the functional core of the "make it feel like seriesgraph.com" ask — persistence, a watchlist, richer previews. A full visual pass (new type scale, poster-wall layouts, a broader custom icon set matching that specific editorial look) is a separate, larger design pass and wasn't attempted wholesale here to avoid a half-finished reskin sitting on top of a half-tested one.

## [1.3.0] — Worker migration, three real bug fixes, resilience pass

### Fixed
- **On-device AI failed with "unavailable/error" on most devices.** Root cause: `ai-worker.ts` manually pointed `wasmPaths` at `@huggingface/transformers`'s own CDN dist folder to "pin" the WASM source — but that folder only ships a JS glue file, not the actual `.wasm` binaries (those live in the separate `onnxruntime-web` package, at a specific version transformers.js resolves internally). Every WASM-tier load 404'd on the binary fetch, which is most devices — WebGPU is the minority path. Fixed by not overriding `wasmPaths` at all; the library's own default is version-correct by construction. Also added a real `navigator.gpu.requestAdapter()` check instead of trusting `'gpu' in navigator` (true even with no usable adapter behind it), and gated multi-threaded WASM behind `self.crossOriginIsolated` (it needs `SharedArrayBuffer`, which throws without COOP/COEP headers — see "Changed" below for where those now come from).
- **Selecting an era (e.g. "Classic — pre-2000") could still surface newer titles.** `engine.ts` only applied era as a soft +12/-4 score nudge; TMDB's server-side date filter isn't airtight (re-release dates, missing region, occasional bad data), and a strong genre/vibe match could outscore the penalty regardless. Era is now hard-filtered in `engine.getResults()` before scoring — the era you pick is the era you get.
- **Recommendations "ran out" after rating just a few results.** Every rating triggered a debounced `rescore()` that excluded everything already in `shownIds` — which, for a narrower filter combination, could already cover the entire fetched pool after only 2-3 ratings. The next rescore silently returned an empty array and got rendered as-is: no fallback, no message, just a blank grid. Replaced with `ensureBatch()`, which escalates through fallbacks — retry ignoring the shown-set, pull a later TMDB page window, drop Precise mode's match floor, and only as a last resort show the pool's best titles again — surfacing an honest note (`.results-note`) whenever it had to compromise, and a real inline empty-state card (with "Different picks" / "Adjust answers" actions) in the true last-resort case instead of ever leaving the grid blank.

### Changed — architecture
- **Migrated from Cloudflare Pages to a genuine Cloudflare Worker.** `functions/api/recommend.ts` (a Pages Functions convention) is now `worker/index.ts`, a real `fetch` handler: it serves `dist/` via the `ASSETS` binding for everything except `/api/recommend`, and stamps `Cross-Origin-Opener-Policy: same-origin` + `Cross-Origin-Embedder-Policy: require-corp` onto every response. Those two headers are what actually make `self.crossOriginIsolated` true, which is what unlocks the multi-threaded WASM fast path referenced above. `wrangler.jsonc` now declares `main` (previously assets-only) and keeps the same Worker name so redeploying doesn't orphan the existing project's Cloudflare variables. `wrangler` was also missing from `devDependencies` despite `wrangler.jsonc` existing — added, along with `worker:dev` and `deploy` scripts.
- `tsconfig.json` now typechecks `worker/` — the old `functions/` directory was never actually covered by `tsc --noEmit`, so a break there could ship silently.
- `package.json` version corrected to track this changelog (it had drifted to `3.2.0` against a `1.2.0` changelog top).

### Added
- Small, targeted motion in the two places users actually watch: the match% badge on each result card now pops in on render, and a star pops on fill — both via the existing `--dur-fast`/`--ease-spring` tokens, so `prefers-reduced-motion` still disables them for free.

## [1.2.0] — Adaptive quiz, genre-weighted calibration, resource-aware AI, perf pass

### Fixed
- **On-device AI still failed on some devices/networks.** A single hardcoded CDN and a single model repo meant any one of: that CDN being blocked by a network/proxy, a transient CDN outage, or that specific Hugging Face repo being briefly rate-limited, took the whole feature down. `ai-worker.ts` now tries a short list of CDNs for the library itself and a short list of model repos per resource tier, in order, until one combination actually finishes loading. WASM execution is now explicitly multi-threaded (sized to leave one core free for the UI) instead of single-threaded.
- **Posters appearing not to load.** Cards used to sit as blank/empty boxes with no feedback while a poster image was still in flight. `dom.ts`'s new `buildPosterImage()` keeps a visible skeleton shimmer until the image actually finishes decoding, then crossfades it in; a failed image falls back to a letter placeholder instead of staying blank. Off-screen posters use native lazy-loading so they don't compete with the first results batch for bandwidth.
- Recommendations no longer stall on a cold connection: TMDB requests now carry a 9s timeout + one retry (`tmdbFetch`), instead of an in-flight request hanging indefinitely on a flaky mobile network.

### Added
- **Resource-aware model selection.** `ai-worker.ts` picks a tier (model + quantization + device) from `navigator.deviceMemory`, `hardwareConcurrency`, WebGPU availability, and mobile detection — a 16-core desktop with a GPU and a budget phone no longer get the identical request.
- **Genre-weighted taste calibration** (`src/lib/rating-pool.ts`). Picking a mood in the quiz now pulls ~75% of the rating step's titles live from TMDB in that genre (diversified by vibe, capped by vote count), instead of always showing the same fixed 15 regardless of answer.
- **Adaptive quiz.** The vibe question filters out options that would directly contradict the mood just picked (e.g. "horror" removes "light & fun" / "feel-good"); previously-selected options are highlighted when navigating back.
- **Anime / cartoon / sitcom as their own dimension** — a new `contentType` quiz question, separate from mood/tone, mapped to TMDB's Animation genre (split into anime vs. cartoon by original language) and TV Comedy for sitcom (which also forces series-only, since "sitcom movie" isn't a meaningful TMDB query).
- **Precise / Grouped results toggle** — Grouped is the original wide, forgiving pool; Precise holds results to a 68%+ match floor and returns fewer, tighter picks.
- **Debounced in-place rating.** Rating a result card updates its stars immediately but waits ~1.6s (resetting on each new tap) before re-curating the grid, with a "Curating your picks…" indicator — avoids a full re-render on every single click during a quick rating streak.
- Boot-time loading spinner (inlined critical CSS in `index.html`, dismissed by `main.ts` once the first screen mounts) for the gap between first paint and the JS bundle finishing parse/exec on slower connections/devices.
- `preconnect` hints for the TMDB API and image CDN.

### Changed
- The landing page's fluid background sim now runs at a lower grid resolution on mobile or ≤4-core devices — it's CPU-bound Canvas2D, not GPU work, so full resolution was a real jank/battery cost on phones.
- Results toolbar restructured: the mode toggle is now a visually distinct segmented control instead of competing with action buttons in one row; buttons stack full-width on screens under 640px instead of squeezing.
- `engine.processRatings` signal source and `rating.ts`'s seed list are now read from the store (`ratingSeeds`/`ratingSignals`), populated by whichever pool (static or genre-weighted) actually got shown and rated.

## [1.1.0] — Reliability, refinement loop, and a design pass

### Fixed
- **On-device AI failed intermittently.** It loaded on the main thread with no explicit quantization or device selection, so it silently pulled the largest available build (often full `fp32`) regardless of connection speed or device memory — the most likely reason loads stalled out or ran out of memory on ordinary laptops and most phones. A WebGPU-only path also had no fallback, so it failed outright on browsers/systems without WebGPU. Rewritten as `src/lib/ai-worker.ts` + `src/lib/llm.ts`: runs off the main thread in a Web Worker, requests the smallest quantization each backend supports (`q4` WebGPU → `q8` WASM → `q4` WASM), points the WASM loader at a reliable CDN path, uses proper chat-formatted prompts instead of string-splitting a raw completion, and enforces load/generate timeouts so a stalled connection degrades to the rule-based reasons instead of hanging forever.

### Added
- **Keep rating after you get results.** Every result card has an inline star row; rating a title feeds its own genre/vibe signal straight back into the engine (`RecommendationEngine.processResultRating`) and the whole grid re-curates immediately — no restart needed.
- **"Show me different picks."** Pulls a genuinely new batch: first from the unseen remainder of the already-fetched pool, then by paging further into TMDB, falling back to allowing repeats only once a filter combination is truly exhausted.
- **Movie detail modal.** Click any poster or title to check a synopsis, genre/vibe tags, TMDB/RT/Metacritic/IMDb scores, and a link to the title's TMDB page before deciding to watch — with the same rating control built in.
- **Dark mode / light mode**, persisted in `localStorage`, defaulting to system preference, applied pre-paint to avoid a flash of the wrong theme (`src/lib/theme.ts`).
- **Persistent header** with the CineMatch logo, a GitHub link, and the theme toggle (`src/lib/header.ts`), present across all four screens.
- `tmdb.ts`'s `discoverCandidates` now accepts a page offset so callers can pull a later results window instead of only ever seeing pages 1-3.

### Changed
- Display font swapped from Bricolage Grotesque to **Sora** — a cleaner geometric grotesque that reads as product-grade rather than editorial.
- More motion throughout: staggered card entrance on the results grid, a subtle animated gradient on primary buttons, hover glow on quiz options, smoother cross-theme transitions.
- `engine.processRatings` now accumulates across repeated calls instead of overwriting, since the results screen re-runs it on every re-score.
- README and SECURITY.md rewritten.

## [0.1 - 0.9.] — Full rebuild

### Fixed
- **Recommendations no longer repeat regardless of quiz answers.** Root cause was two-fold: the AI recommendation call silently failed (Workers AI binding not active) and fell back to a client-side scorer running against a **hardcoded 30-title catalog**, whose flat quality bonus (`(rating - 7) * 5`, up to ±12.5) outweighed the actual quiz signal (max ±30 across 6 questions). Fixed by rewriting the scoring model and replacing the fixed catalog with a live TMDB pool.
- `package.json` had duplicate `svelte`/`typescript`/`vite` keys from a bad merge — removed entirely along with Svelte.

### Changed — architecture
- **Framework removed.** Svelte 5 + SvelteKit → vanilla TypeScript + Vite. Initial JS payload dropped to ~5 kB gzipped.
- **Catalog is now live, not static.** `src/lib/tmdb.ts` queries TMDB's `/discover/movie` and `/discover/tv` directly, filtered by genre/era/language — hundreds of candidates per query instead of 30 fixed ones.
- **Scoring rebalanced.** Quality bonus capped to ±3 (tiebreaker, not driver); rating-derived taste signal weighted above one-off quiz picks; match% now normalized against the actual score spread of each query instead of a fixed clamp, so results meaningfully separate instead of clustering near 99%.

### Added
- OMDb connector for Rotten Tomatoes / Metacritic / IMDb as a secondary signal (`src/lib/omdb.ts`)
- Letterboxd `ratings.csv` import for taste calibration (`src/lib/letterboxd.ts`)
- Optional on-device AI reason-writer, CDN-loaded and opt-in only (`src/lib/llm.ts`)
- New landing screen, quiz flow with progress bar and back navigation, taste-calibration screen with live poster resolution
- Custom logo (`public/logo.svg`, `public/favicon.svg`)
- This changelog

### Removed
- All `.svelte` components and `svelte.config.js`
- The hardcoded 30-item catalog (`src/lib/data.ts`)
- `src/stores/appState.svelte.ts` (replaced by `src/lib/store.ts`, framework-free)

### Security
- `npm audit`: 0 vulnerabilities. The on-device AI dependency (`@huggingface/transformers`) was deliberately kept out of `package.json` — its Node backend pulls in `onnxruntime-node` and `sharp` as hard dependencies (native postinstall, irrelevant for a browser-only feature) and previously carried transitive `protobufjs` vulnerabilities via the older `@xenova/transformers`. It's loaded from CDN at runtime only if a user opts in.
