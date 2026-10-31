# Moodsift Local AI Engine Policy

**Applies to:** Moodsift v1.13.8 (originally written for the UI 1.10.2 local-AI optimizer patch; the v1.13.5 and v1.13.8 sections below extend it)  
**Cloudflare Workers AI:** intentionally deferred; the existing `/api/recommend` endpoint remains unchanged and is not called by the frontend.

## Product decision

Moodsift's primary recommendation ranking remains deterministic. Local AI is an optional explanation writer that may only rephrase the supplied quiz/search signals. It does not choose or rerank titles. If local AI is disabled, unready, too slow, unavailable, or produces invalid-format output, the original rule-based explanation remains available.

The optimization engine must not cut loading, initialization, smoke-check, or output-validation steps just to make the first answer appear sooner. Responsiveness is handled by loading in a Worker, serializing generation, updating cards in order, caching successful outputs, and giving progress/status feedback—not by claiming an unready model is ready.

## Settings modes

Settings > **AI engine** exposes four modes, stored in `cinematch-local-ai:v1` independently of appearance preferences:

| Mode | Priority policy | Candidate set |
|---|---|---|
| **Best quality** | Prefer the strongest model that passes resource guardrails. | Qwen2.5-0.5B Instruct (`q4f16`, WebGPU; `q8`, WASM on high-resource devices), then SmolLM2-360M, then SmolLM2-135M. A low-resource or unknown-memory device does not automatically attempt Qwen2.5-0.5B. |
| **Balanced** (default) | Balance writing quality with startup/download cost. | SmolLM2-360M first on eligible devices; SmolLM2-135M on constrained devices or as a verified fallback. |
| **Fastest** | Prefer the smallest tested model first. | SmolLM2-135M first. Larger candidates are tried only if the smaller model cannot load or fails the smoke/output-contract check. |
| **Lightweight / data saver** | Avoid model downloads and inference entirely. | No local model; use original rule-based reasons. This setting does not silently switch to cloud AI. |

Model sizes shown in settings are **approximate ONNX weight-file sizes only**. They do not represent peak memory or all supporting files:

- Qwen2.5-0.5B: about 483 MB (`q4f16`, WebGPU) / 512 MB (`q8`, WASM)
- SmolLM2-360M: about 272 MB (`q4f16`, WebGPU) / 363 MB (`q8`, WASM)
- SmolLM2-135M: about 117 MB (`q4f16`, WebGPU) / 136 MB (`q8`, WASM)

These values are repository artifact sizes, not measured performance claims. The worker pins each candidate to a verified Hugging Face commit so the model revision cannot silently change when the repository's default branch is updated:

| Model repository | Pinned revision |
|---|---|
| `onnx-community/Qwen2.5-0.5B-Instruct` | `516c8d04add8a80c5228f32102b57953b8d421a9` |
| `onnx-community/SmolLM2-360M-Instruct-ONNX` | `fe7c7db4c8921c9e3fa1c65cfd296fb3b1b1a8f9` |
| `onnx-community/SmolLM2-135M-Instruct-ONNX` | `b8a5c0f183b78c55955a5364f610c36668b5e681` |

Pinned revisions improve reproducibility but do not remove the need to verify the exact network requests and model artifacts during release testing.

## Required decision and execution order

1. **Read the user's mode.** Data saver returns without initializing Transformers.js or downloading model weights.
2. **Detect resources.** Check `navigator.deviceMemory` where available, `navigator.hardwareConcurrency`, mobile hints, cross-origin isolation, and `navigator.gpu.requestAdapter()` (not merely whether the API property exists). These signals are heuristics, not exact available RAM/GPU memory.
3. **Build an eligible candidate list.** Match each candidate to a known model repository, pipeline type, backend and dtype. Apply hard guardrails before attempting a large model. An unsupported or unsafe candidate is not attempted just to prove it fails.
4. **Prepare the runtime.** Try the configured Transformers.js CDN locations in order and allow the library to resolve its own version-matched ONNX Runtime WASM assets. Request multiple WASM threads only on a cross-origin-isolated page; otherwise use one thread.
5. **Load one candidate at a time.** Show the current stage and model-download progress. Use browser caching when supported. Never load all candidates or download every model up front.
6. **Wait for full initialization.** A resolved pipeline alone does not mean the model is ready. Run one deterministic smoke generation and validate that the runtime returns a short, usable response. If initialization or smoke validation fails, dispose the candidate where supported and try the next eligible configuration.
7. **Only then report `ready`.** Display the chosen model, backend, dtype and approximate weight size in the status detail.
8. **Generate serially.** Keep the worker-side queue as the invariant even if future callers use `Promise.all`. Results and search screens update a card after its generation completes rather than flooding the backend with concurrent decodes.
9. **Use deterministic decoding and strict output checks.** Do not ask the model for chain-of-thought. Limit output to one sentence / no more than 20 words. Reject malformed, empty, excessively long or obvious preamble/refusal output. These checks verify format and usability; they are **not a semantic fact-check**.
10. **Fall back safely.** A failed generation returns the supplied rule-based reasons. A generation timeout terminates a wedged worker so later requests do not queue behind it indefinitely. Never block movie discovery, scoring, or results on local AI.

## Same-origin model relay (v1.13.8)

Transformers.js no longer sends model-file requests straight to Hugging Face from the browser. The engine sets:

```ts
env.remoteHost = `${origin}/models/`;
env.remotePathTemplate = '{model}/resolve/{revision}/';
```

so every config/tokenizer/weight request stays on the Moodsift origin. `worker/model-proxy.ts` handles it in production (`worker/index.ts`, before the `ASSETS` fallback) and in the Vite dev/preview server (`worker/dev-proxy.ts`), using the same code path.

The relay is deliberately not an open proxy:

- only repositories and revisions in `src/lib/ai-policy.ts` are accepted, and the revision must be the exact full pinned commit SHA (`main`, branches, tags and shortened SHAs are rejected);
- only `GET` and `HEAD` are accepted;
- the upstream URL is rebuilt from trusted constants, never from a client-supplied host;
- Hugging Face's storage redirects are followed server-side, with a bounded hop count; every hop must be HTTPS on `huggingface.co`, `*.huggingface.co` or `*.hf.co`, with no credentials and no non-443 port;
- client cookies, authorization headers, query strings and other credentials are not forwarded; only safe conditional headers and Range are relayed;
- decoded `.`/`..`, encoded slashes/backslashes, control bytes and malformed escapes are rejected;
- responses are streamed rather than buffered, `206 Partial Content` and `HEAD` are preserved, and upstream cookies/CORS headers are stripped.

Successful pinned responses carry `Cache-Control: public, max-age=31536000, immutable`; errors, invalid ranges and range responses are not promoted to complete-file cache entries. There is no explicit R2 mirror or Cloudflare Cache API layer in this change. The relay removes the browser CORS/redirect dependency; it does not replace the integrity manifest, and the Transformers.js runtime/ONNX WASM assets still come from their public CDNs (with the existing fallback probes).

**Pinned-revision request normalisation (Transformers.js 4.3.1).** The runtime does not thread `revision` through its file-discovery helpers (`pipeline` → `get_pipeline_files` → `get_config` / `get_tokenizer_files`) or through its progress metadata probes. Even when `pipeline(..., { revision })` receives a full SHA, those helpers request `resolve/main/...`. Because the relay correctly rejects `main`, loading failed before the pinned component downloads could run. `src/lib/ai-integrity.ts` therefore exports `pinModelRequestUrl()`, and the integrity tracker's `trackedFetch` (installed as `env.fetch`) rewrites every same-origin request for **the candidate's exact repository** to that candidate's full pinned SHA before fetching and before verification parsing. The rewrite:

- only applies when the tracker's configured revision is a full 40-character lowercase SHA;
- only applies to the same origin and the configured base path (e.g. `/models/`);
- only applies to the exact repository the tracker was created for;
- preserves the file path, query and fragment, and never rewrites to `main`, a branch or a tag.

Requests for another repository or origin are passed through unchanged, so the relay still rejects them. The relay's own rules are unchanged: `main`, branches, tags and shortened SHAs remain invalid. `deno-tests/transformers-revision.test.ts` runs the real vendored 4.3.1 bundle for SmolLM2-360M/WebGPU, SmolLM2-135M/WebGPU and SmolLM2-135M/WASM and fails if any request uses `resolve/main/`.

`run_worker_first: true` in `wrangler.jsonc` keeps the Worker ahead of static-asset serving: a future `dist/models/` file cannot shadow the relay, and the Worker's COOP/COEP/CSP headers are applied to HTML and asset responses.

## Diagnostics, integrity and recommendations (v1.13.5)

**Settings → AI engine → Test on this device** runs the *same* load path as normal use (`src/lib/ai-engine.ts`): the same worker, the same mode, the same candidate policy and the same start-up checks. A diagnostic that could pass while the real feature fails is not allowed to exist.

### Diagnostic order

1. **Device signals** — WebGPU adapter + `shader-f16`, `navigator.deviceMemory` (when present), logical cores, mobile/touch hints, `crossOriginIsolated`. Estimates only.
2. **Runtime** — the pinned Transformers.js build from the first working CDN (esm.sh → jsDelivr → unpkg). Every source that fails is recorded with its host.
3. **ONNX WASM assets** — the library's own version-correct `.mjs`/`.wasm` URLs are probed with `HEAD`. If the default host is unreachable, the same version's files are tried on `fastly.jsdelivr.net` and `unpkg.com`; every failure names the exact resource.
4. **Eligible candidates** — shown in policy order. Ineligible models are never downloaded "to test".
5. **Integrity** — see below.
6. **Real start-up** in the Web Worker (progress, cancellation, existing timeouts).
7. **Smoke inference** — a fixed short prompt with a 30 s deadline, validated with the same output checks as production.
8. **Optional format check** — three fixed Moodsift prompts; reports how many pass the *format* checks. Not a factuality test.
9. **Result** — *Passed*, *Passed with fallback* (an earlier eligible candidate failed) or *Failed*, with model, backend, dtype, approximate weights size, start-up time and a readable reason. *Lightweight / data saver* reports that local inference is intentionally disabled and makes **zero** runtime, model, cache or worker requests.

### Per-attempt failure records

Each attempt keeps: model / backend / dtype / pinned revision; stage (`runtime`, `download`, `integrity`, `initialization`, `smoke inference`); failing resource as origin + path (query strings and credentials are always stripped); HTTP status; and a kind — `offline`, `timeout`, `cors`, `http`, `network`, `module`, `wasm`, `integrity`, `memory`, `empty-output`. Settings shows a concise summary of *all* attempts; **Copy diagnostic report** copies the detail. The report contains technical facts only (browser family + major version, stage, model revision, backend, host, error category, timings) — never quiz answers, ratings, searches, tokens or cookies — and is only produced when the person clicks the button.

### Model integrity

`src/data/ai-manifest.json` lists, per pinned revision and dtype, every required file with its **SHA-256 and size**. `src/lib/ai-integrity.ts` installs a verifying `env.fetch` (a supported Transformers.js hook): the response body streams through an incremental SHA-256 (`src/lib/sha256.ts`, no whole-file buffer) and is **errored at the end** on any size or digest mismatch, so the pipeline fails and the browser cache stores nothing for that file. A mismatch fails closed for that candidate (even if a library swallowed the error), removes the bad cached copy, and the next *eligible* local candidate is tried.

States shown: **Verified** (every needed file matched), **Not yet verified** (no manifest entry, a file outside the manifest, or cached files with no recorded verification) and **Verification failed**. A file is never called verified merely because it downloaded. Cached files are re-checked by metadata (size + our own recorded verification) — not re-hashed on every page load; the diagnostic purges unrecorded cached copies so they are re-downloaded and verified.

**The shipped manifest contains real generated values** for every pinned repository and dtype. It is produced from the pinned upstream revisions in a trusted environment: run `npm run ai:manifest`, review the diff, commit it; `npm run ai:manifest:check` is the release gate. If a manifest entry is missing, empty, malformed or for a different revision, the honest state is *Not yet verified*; a mismatching download is *Verification failed*. Never hand-edit hashes or treat a successful download as proof of integrity.

### Recommendations

After a fallback succeeds the card says, for example, *"SmolLM2-360M could not start. We recommend Fastest (SmolLM2-135M) on this device."* with **Use recommended mode** / **Keep current setting**. The saved mode changes **only** when the person clicks the first button. If every failure was a network problem no mode change is suggested (a smaller model would hit the same blocked host). A recommendation is always a local mode or data saver — never cloud AI.

## Why small models are appropriate

Moodsift's local task is intentionally narrow: turn a title, quiz/search summary, and already-computed reasons into one concise explanation. It does not need a general chatbot, long-context summarizer, or a model that ranks the catalogue. Model choice should be based on Moodsift-specific groundedness, relevance, instruction compliance, load size, warmed latency and stability—not parameter count or general-purpose leaderboard rankings alone.

## Cloud AI is future last resort—not active now

The intended future cascade is:

1. Check whether local AI was enabled and the chosen mode allows it.
2. Try eligible local candidates in priority order, fully loading and verifying each one.
3. If a ready local model returns invalid output, retry only where the failure policy permits, otherwise use deterministic reasons.
4. Only in a later, explicitly enabled integration phase, consider Cloudflare Workers AI if no compatible local model can become ready or local generation fails. Do not call cloud first just because it may be more capable.
5. Never use cloud fallback in **Lightweight / data saver** unless the product adds a separate, explicit cloud-permission setting. Do not silently transmit quiz or title data to a remote model.

This repository change does not implement step 4. The existing Cloudflare endpoint is left untouched until its model, quota, timeout, privacy and failure policy are finalized.

## Source areas changed

v1.13.8 adds: `worker/model-proxy.ts` (same-origin relay), `worker/dev-proxy.ts` (Vite dev/preview wiring), the `/models/` route in `worker/index.ts`, the `modelHost` / `env.remoteHost` / integrity `remoteHost` wiring in `src/lib/ai-engine.ts` and `src/lib/ai-worker.ts`, real generated values in `src/data/ai-manifest.json`, and `pinModelRequestUrl()` plus revision-normalising `trackedFetch` in `src/lib/ai-integrity.ts` (with `deno-tests/transformers-revision.test.ts` and the vendored runtime under `tests/vendor/`).

v1.13.5 adds: `src/lib/ai-engine.ts` (decision logic with injected environment), `src/lib/ai-diagnostics.ts`, `src/lib/ai-diagnostics-ui.ts`, `src/lib/ai-integrity.ts`, `src/lib/sha256.ts`, `src/data/ai-manifest.json`, `scripts/generate-ai-manifest.mjs`; `src/lib/ai-worker.ts` is now only the wiring. Earlier areas:

- `src/lib/ai-settings.ts`: saved priority options and user-facing mode descriptions.
- `src/lib/settings-panel.ts`: the AI engine settings tab.
- `src/lib/ai-worker.ts`: resource-first candidate order, exact model IDs/dtypes, loading stages, smoke check, deterministic generation, output checks, and serial worker queue.
- `src/lib/llm.ts`: staged loading status, longer hard timeout for downloads, timeout recovery, cache bounds, and worker reset on mode changes.
- `src/screens/results.ts` and `src/screens/search.ts`: progress text, data-saver behavior, button status synchronization, and sequential card updates.
- `src/styles/settings.css`: mode-selector layout.
- `tests/local-ai-settings.spec.ts`: persistence and no-download data-saver checks.

## Verification status

See the v1.13.8 entry in `CHANGELOG.md` for exactly what was run and what was not. In short: the relay is covered by deterministic Deno and Playwright tests, a real local Wrangler Worker returned a real pinned `config.json` through `/models/`, live model bytes were streamed through both Vite dev and Vite preview, and the unmodified Transformers.js 4.3.1 runtime was traced for all three required candidates with zero `resolve/main/` requests. No full model download, real-device inference or production deployment was performed. Do not publish any model/backend as "tested" from those results alone — the release gates in `nextupdate.md` §6 (real-device diagnostics for every advertised model/backend) still apply.
