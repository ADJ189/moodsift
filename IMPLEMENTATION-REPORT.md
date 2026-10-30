# Moodsift v1.13.8 — Same-origin Cloudflare Worker model proxy

**Implementation report**
**Project:** Moodsift (`C:\Users\user\Downloads\moodsift-main\moodsift-main`)
**Date:** 2026-10-30
**Scope:** Put Hugging Face model downloads behind the Moodsift origin (`/models/`), wire Transformers.js and the integrity tracker to it, pin Wrangler to `4.151.3`, verify locally, update docs, and package the result.

---

## 1. Why this change

Transformers.js normally downloads model configs, tokenizers and weights directly from `huggingface.co`. That put the browser's CORS and redirect handling in the critical path of local-AI startup: a blocked redirect or a changed CORS policy could stop a model from loading even though the app itself was healthy.

The fix is a same-origin relay. The browser asks Moodsift for `/models/<repo>/resolve/<pinned-sha>/<file>`; the Cloudflare Worker (or the Vite dev/preview server) fetches the file from Hugging Face server-side, validates every hop, and streams the bytes back. Inference remains entirely on the user's device. This is a transport change, not a change to model selection, ranking or AI behaviour.

## 2. What was built

### 2.1 The relay — `worker/model-proxy.ts` (new)

- **Allow-list, not an open proxy.** A request is accepted only when its repository and full 40-character commit SHA match a pin in `src/lib/ai-policy.ts` (the existing source of truth). The upstream URL is rebuilt from trusted constants; no client-supplied host is used.
- **Methods:** `GET` and `HEAD` only. Anything else is `405`.
- **Path safety:** the path is decoded and checked for `..`, encoded traversal, empty/ambiguous segments and over-long paths before any upstream request. Unknown repos, mutable revisions (`main`, branches, short SHAs) and malformed paths are `404`/`400` without contacting Hugging Face.
- **Redirects:** followed manually, maximum 5, with the same host/scheme/port rules on every hop. Only HTTPS on `huggingface.co`, `*.huggingface.co` and `*.hf.co` is allowed; downgrades, embedded credentials, non-443 ports and loops are refused.
- **Streaming:** the response body is passed through with `ReadableStream`; it is never buffered.
- **Ranges:** valid `Range` requests are forwarded and `206`/`Content-Range` are preserved; invalid ranges are `416` without an upstream call; `HEAD` has no body.
- **Headers:** only representation metadata (`content-type`, `etag`, `content-range`, `last-modified`, `vary`, …) is copied. Client credentials, cookies and query strings are not forwarded. Upstream failures become generic `502`s; provider error bodies are not echoed.
- **Caching:** successful pinned responses are `Cache-Control: public, max-age=31536000, immutable`; ranges and errors are `no-store`. There is intentionally no separate Cloudflare edge-cache/R2 layer in this change (see §6).

### 2.2 Worker routing — `worker/index.ts`

`/models/` is handled before the optional `/api/recommend` route and before the `ASSETS` fallback, so a future `dist/models/` file cannot shadow the relay. Existing COOP/COEP and CSP header behaviour is unchanged.

### 2.3 Local parity — `worker/dev-proxy.ts` + `vite.config.ts`

The same handler runs as Vite middleware in both `npm run dev` and `vite preview`. Local testing therefore exercises the production validation, redirect and header rules instead of a separate mock.

### 2.4 Client wiring

- `src/lib/ai-engine.ts`: sets `env.remoteHost` to `${origin}/models/` and `env.remotePathTemplate` to the pinned `resolve/<sha>/` path, and passes the relay host to the integrity tracker.
- `src/lib/ai-worker.ts`: derives the origin from `ctx.location.origin` and builds `new URL('/models/', …).href`.
- `src/lib/ai-integrity.ts`: `parseModelUrl` recognises the same-origin base path (including `/models/`), so checksum verification runs on the relayed bytes. Mismatches still fail closed, discard the cached copy and fall through to the next candidate.

### 2.5 Manifest

`src/data/ai-manifest.json` was regenerated from the pinned upstream revisions with `deno run -A scripts/generate-ai-manifest.mjs` (the Deno equivalent of `npm run ai:manifest`). It now has **30 file records** (3 repos × 2 dtypes × 5 files) with real sizes and SHA-256 values. No hash was hand-written or invented. The note in the file now describes the generated data accurately.

### 2.6 Tooling and version

- Wrangler pinned to **`4.151.3`** in `package.json`; `package-lock.json` updated from the npm registry metadata.
- Version **`1.13.8`** in `package.json`, `package-lock.json`, `src/lib/app-version.ts` and `AGENTS.md`.
- `wrangler.jsonc` uses **`run_worker_first: true`**. This was changed from `["/models/*"]` after a real local Wrangler run showed that static assets bypassed the Worker and lost COOP/COEP/CSP headers. Reverting it would reintroduce that bug and let `dist/models/` shadow the relay.

### 2.7 Tests and docs

New tests:

- `deno-tests/model-proxy.test.ts` — 23 deterministic handler tests (allow-list, traversal, methods, redirects, ranges, streaming, cache headers, routing).
- `deno-tests/ai-integration.test.ts` — 4 tests (URL parsing, integrity through the relay, engine wiring, manifest/policy agreement).
- `tests/model-proxy.spec.ts` — 6 Playwright tests, both viewports.

Updated tests:

- `tests/local-ai-engine.spec.ts` — expects the same-origin host.
- `tests/local-ai-integrity.spec.ts` — reads the generated manifest and asserts real values.
- `tests/profile-storage.spec.ts` — uses `Object.defineProperty` for Deno's read-only `localStorage`.

Docs updated: `README.md`, `SECURITY.md`, `PRIVACY.md`, `AGENTS.md`, `docs/Moodsift-Local-AI-Engine-Policy.md` and this changelog entry.

## 3. Behaviour and privacy

- Model files are fetched from the Moodsift origin only. Hugging Face sees the Worker's server-side request, not the user's browser directly; no account, profile, ratings or taste-memory data is sent with it.
- The relay accepts only the pinned catalog. It cannot be used to fetch arbitrary URLs, and it does not forward client credentials or query strings.
- Inference, model choice, ranking and all storage behaviour are unchanged.
- `/api/recommend` remains off by default and untouched.

## 4. Verification actually performed

Environment: Windows, **Deno 2.9.8** (no Node.js in this environment). All commands below were run in the project root.

| Check | Command | Result |
|---|---|---|
| Typecheck | `deno run -A npm:typescript@7.0.2/tsc --noEmit` | **Pass** (exit 0) |
| Lint | `deno run -A npm:oxlint@1.89.0` | **Pass** (exit 0) |
| Production build | `deno run -A npm:vite@8.3.5 build` | **Pass** (exit 0) |
| Deno tests | `deno test -A --no-check --unstable-sloppy-imports deno-tests/model-proxy.test.ts deno-tests/ai-integration.test.ts` | **27 passed, 0 failed** |
| Playwright (proxy, AI engine, integrity, profile storage) | `deno run -A npm:@playwright/test@1.64.1 test tests/model-proxy.spec.ts tests/local-ai-engine.spec.ts tests/local-ai-integrity.spec.ts tests/profile-storage.spec.ts` | **138 passed, 0 failed** |
| Playwright (appearance) | same runner, `tests/appearance.spec.ts`, 300 s timeout | **22 passed** (20 at the default 120 s, plus the two 80-keystroke focus tests run separately at 300 s) |
| Wrangler version | `deno run -A npm:wrangler@4.151.3 --version` | **4.151.3** |

### Live local checks

- **Vite dev and preview** (`/models/`): real pinned `config.json` → `200`; `HEAD` → `200`; `Range: bytes=0-15` → `206`; mutable `main` revision → `404`.
- **Real local Worker** (`wrangler dev`): pinned `config.json` → `200`; `HEAD` → `200`; `main` → `404`; `POST` → `405`; unknown route → `404`. Root responses carried COOP/COEP/CSP after `run_worker_first: true`.

### Full Playwright suite

The complete two-viewport suite was run after the final edits; the outcome is recorded in §5. Several tests are slow under Deno's Node compatibility layer, so the run used a 300 s per-test timeout. The two known-slow focus tests pass at that timeout (they also pass individually; at the original 60 s they time out while still making progress).

## 5. Final full-suite result

The complete two-viewport suite (**429 tests**) was started after the final edits with a 300 s per-test timeout. It did not finish: under Deno's Node compatibility layer, browser actions are extremely slow (roughly 50 s per UI test; the appearance focus test alone needs ~1.8 minutes for 80 keystrokes). The run reached **25 passing, 0 failing** before being stopped, so no full-suite pass is claimed.

The targeted suites cover the changed surface and passed cleanly:

- 138/138 — `/models/` proxy, AI engine wiring, integrity tracker, profile storage.
- 22/22 — appearance (including both slow focus tests at a 300 s timeout).
- 27/27 — Deno handler/integration tests.


## 6. Limitations and things not done

- **No explicit edge cache.** `/models/` relies on immutable `Cache-Control` on successful pinned responses; ranges and errors are not cached. A dedicated R2 or Cache API layer is a separate change if repeat-download cost matters.
- **No full model download / real-device inference.** The relay was tested with real pinned metadata and byte ranges, not by loading a complete ONNX weight file on a device. Real-device diagnostics for every advertised model/backend remain the release gate.
- **No production deployment or production-browser test.** Nothing was deployed, no Cloudflare account was changed, and no GitHub operation was performed.
- **Wrangler local workerd** emitted crash/restart warnings after config reloads during the local run, although requests continued to succeed. It was not reproduced against a deployed Worker.
- **`deno test` without `--no-check`** fails on a pre-existing DOM typing issue in `src/lib/ai-settings.ts` (`Property 'key' does not exist on type 'Event'`). Typechecking is done with `tsc`, which passes.
- **Node scripts**: because Node is unavailable here, npm scripts were run through their Deno equivalents. The committed npm scripts themselves are unchanged and conventional.

## 7. Files added / modified / deleted

### Added

- `worker/model-proxy.ts`
- `worker/dev-proxy.ts`
- `deno-tests/model-proxy.test.ts`
- `deno-tests/ai-integration.test.ts`
- `tests/model-proxy.spec.ts`
- `IMPLEMENTATION-REPORT.md` (this file)

### Modified

- `worker/index.ts`
- `vite.config.ts`
- `wrangler.jsonc`
- `package.json`
- `package-lock.json`
- `src/lib/app-version.ts`
- `src/lib/ai-engine.ts`
- `src/lib/ai-worker.ts`
- `src/lib/ai-integrity.ts`
- `src/data/ai-manifest.json`
- `tests/local-ai-engine.spec.ts`
- `tests/local-ai-integrity.spec.ts`
- `tests/profile-storage.spec.ts`
- `README.md`
- `SECURITY.md`
- `PRIVACY.md`
- `AGENTS.md`
- `docs/Moodsift-Local-AI-Engine-Policy.md`
- `CHANGELOG.md`

### Deleted

- None.

## 8. Delivered archive

- Archive: `moodsift-cloudflare-worker-fixed.zip`
- Contents: the complete modified project, excluding `node_modules`, `dist`, `dist-e2e*`, `.wrangler`, `deno.lock`, `test-results`, `.env`, credentials, caches and temporary test files.
- The archive's SHA-256 is reported alongside the delivery (the external copy of this report and the final message). It cannot be embedded in this file and also match the archive it is inside, by construction.

### Upload summary for the maintainer

Upload the added and modified files listed in §7. Remove nothing. If the repository already has `deno-tests/`, merge the two new files; otherwise add the directory. Do not upload `node_modules`, `dist`, `dist-e2e*`, `.wrangler`, `deno.lock`, `test-results`, `.env` or the temporary `*-test.json` / `trace-inspect.mjs` files.
