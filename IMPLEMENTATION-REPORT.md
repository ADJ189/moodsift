# Moodsift v1.13.8 — Same-origin model relay + pinned-revision fix

**Implementation report**
**Project:** Moodsift (`C:\Users\user\Downloads\moodsift-main\moodsift-main`)
**Date:** 2026-10-31
**Scope:** Put Hugging Face model downloads behind the Moodsift origin (`/models/`), diagnose and fix the `resolve/main/...` requests seen in the deployed preview, prove the fix with the real Transformers.js 4.3.1 runtime for all three required candidates, verify locally, update docs, and package the result.

---

## 1. Why the relay exists

Transformers.js normally downloads model configs, tokenizers and weights directly from `huggingface.co`. That put the browser's CORS and redirect handling in the critical path of local-AI startup: a blocked redirect or a changed CORS policy could stop a model from loading even though the app itself was healthy.

The relay is a same-origin transport change. The browser asks Moodsift for `/models/<repo>/resolve/<pinned-sha>/<file>`; the Cloudflare Worker (or the Vite dev/preview server) fetches the file from Hugging Face server-side, validates every hop, and streams the bytes back. Inference remains entirely on the user's device.

## 2. Root cause of the `resolve/main/...` requests

The preview was requesting:

```
/models/onnx-community/SmolLM2-135M-Instruct-ONNX/resolve/main/config.json
```

`src/lib/ai-engine.ts` already passed `revision: candidate.revision` to `pipeline()`. The revision was correct; **Transformers.js 4.3.1 stops using it during file discovery**.

Confirmed in the exact 4.3.1 package (`@huggingface/transformers@4.3.1`):

| Location | Code | Effect |
|---|---|---|
| `src/pipelines.js` | `get_pipeline_files(task, model, { device, dtype })` | discovery is called **without** `revision` |
| `src/utils/model_registry/get_pipeline_files.js` | `get_files(...)` / `get_config(modelId, …)` | the nested calls do not forward `revision` |
| `src/utils/model_registry/get_model_files.js` | `get_config(modelId, { config })` | `config.json` is fetched without a revision |
| `src/utils/model_registry/get_tokenizer_files.js` | `get_file_metadata(modelId, 'tokenizer_config.json', {})` | tokenizer probing is hard-coded to an empty options object |
| `src/pipelines.js` (progress totals) | `get_file_metadata(model, file)` | metadata probes omit options too |
| `src/utils/hub.js` | `const revision = options.revision ?? 'main'` | every omitted revision becomes `main` |

So even though the component-loading path later used the pinned SHA, the **discovery and progress-metadata requests happened first at `main`**. The relay is strict by design and answered those requests with `404`, so loading failed before the pinned downloads could complete. The preview therefore looked like a CORS/revision failure even though the policy and the `pipeline()` call were correct.

The failure is in the runtime's call graph, not in the model pins, the relay allow-list, or `buildCandidates()`.

## 3. The fix

### 3.1 Request normalisation at the supported hook

`src/lib/ai-integrity.ts` now exports `pinModelRequestUrl(raw, { remoteHost, repo, revision })` and calls it at the top of the integrity tracker's `trackedFetch`, which is installed as `env.fetch` by `src/lib/ai-engine.ts`.

Every same-origin request for the candidate's **exact** repository has its revision segment replaced with the candidate's full 40-character SHA before the request is sent and before integrity parsing.

The rewrite:

- only applies when the tracker's configured revision is a full lowercase 40-character SHA — never `main`, a branch, a tag or a shortened SHA;
- only applies to the configured origin and base path (e.g. `https://moodsift.example/models/`);
- only applies to the exact repository the tracker was created for;
- preserves the file path, query and fragment;
- leaves requests for another repository, another origin or a malformed URL unchanged (the relay then rejects them).

`trackedFetch` records network failures and HTTP errors under the **normalised** URL and passes that URL to `parseModelUrl`, so discovery responses are also subject to the existing manifest/SHA-256 verification. Streaming, size/digest verification, cache-discard behaviour, Range requests and redirect restrictions are unchanged.

### 3.2 The relay stays strict

No allow-list was widened and no revision check was relaxed. `worker/model-proxy.ts` still rejects `main`, branches, tags and shortened SHAs before any upstream request. The client now asks for the revision the policy already approved; it does not gain the ability to ask for a different one.

### 3.3 Why the fix belongs in `env.fetch`

The omitted revisions are spread across several internal library helpers, including progress callbacks that run after the pipeline options have been assembled. Patching each helper (or monkey-patching `get_config`/`get_file_metadata`) would depend on private module internals and could miss future calls. `env.fetch` is the library's documented integration point and is already the project's integrity boundary, so normalising there covers config, tokenizer, generation config, metadata probes, weights and any future helper that builds the same URL shape.

## 4. Reproduced traces with the real 4.3.1 runtime

The unmodified `dist/transformers.web.js` from npm `@huggingface/transformers@4.3.1` was vendored under `tests/vendor/` (SHA-256 `ad44c6e41ff23fd5b01fa3fe08199a0440a35711dc9f80a31132fcce08fbd432`). The fake upstream serves minimal real-shaped config/tokenizer JSON and answers the first ONNX weight request with `404`, so the trace reaches the weight without downloading or inferring anything.

For SmolLM2-135M/WASM (`b8a5c0f183b78c55955a5364f610c36668b5e681`), the **unpatched** fetch hook produced:

```
GET       .../resolve/main/config.json
GET Range .../resolve/main/tokenizer_config.json
GET Range .../resolve/main/config.json
GET Range .../resolve/main/onnx/model_quantized.onnx
GET Range .../resolve/main/generation_config.json
GET Range .../resolve/main/tokenizer.json
GET       .../resolve/b8a5c0f…/config.json
GET       .../resolve/b8a5c0f…/tokenizer.json
GET       .../resolve/b8a5c0f…/tokenizer_config.json
GET       .../resolve/b8a5c0f…/onnx/model_quantized.onnx
GET       .../resolve/b8a5c0f…/generation_config.json
```

With the production `trackedFetch`, the same run produced **only pinned requests**:

```
GET       .../resolve/b8a5c0f…/config.json
GET Range .../resolve/b8a5c0f…/tokenizer_config.json
GET Range .../resolve/b8a5c0f…/config.json
GET Range .../resolve/b8a5c0f…/onnx/model_quantized.onnx
GET Range .../resolve/b8a5c0f…/generation_config.json
GET Range .../resolve/b8a5c0f…/tokenizer.json
GET       .../resolve/b8a5c0f…/config.json
GET       .../resolve/b8a5c0f…/tokenizer.json
GET       .../resolve/b8a5c0f…/tokenizer_config.json
GET       .../resolve/b8a5c0f…/onnx/model_quantized.onnx
GET       .../resolve/b8a5c0f…/generation_config.json
```

Zero `/resolve/main/` requests. Both metadata (Range) and full-download requests are pinned.

## 5. Regression tests

`deno-tests/transformers-revision.test.ts` (6 tests) runs the real vendored 4.3.1 bundle through a per-candidate subprocess. A fresh process is used because Transformers.js memoizes discovery promises at module scope.

Coverage:

1. The required candidate list is exactly SmolLM2-360M/WebGPU, SmolLM2-135M/WebGPU and SmolLM2-135M/WASM.
2. For **each** candidate:
   - every recorded request starts with `https://moodsift.example/models/<repo>/resolve/<pinned-sha>/`;
   - **no request contains `/resolve/main/`** (the explicit regression assertion);
   - `config.json`, `tokenizer.json`, `tokenizer_config.json`, `generation_config.json` and the manifest's ONNX weight (`onnx/model_q4f16.onnx` for `q4f16`, `onnx/model_quantized.onnx` for `q8`) are requested;
   - at least one pinned Range probe and one pinned full GET for the weight are observed.
3. A control test runs the unpatched fetch hook and asserts that `resolve/main/` **is** still requested, so the test cannot silently pass if the runtime changes.
4. `pinModelRequestUrl` unit coverage: `main`, tags and short SHAs are rewritten; already-pinned URLs are unchanged; query/hash are preserved; another repository, another origin and a non-SHA tracker revision are not rewritten.

The fixture runner is `deno-tests/fixtures/transformers-revision-runner.ts`; the ONNX bare imports are mapped to minimal stubs in `deno.json` because the test stops at the first weight request and never creates an inference session. The vendored bundle, its license and provenance are in `tests/vendor/README.md`.

## 6. What else was built

### 6.1 The relay — `worker/model-proxy.ts`

- **Allow-list, not an open proxy.** A request is accepted only when its repository and full 40-character commit SHA match a pin in `src/lib/ai-policy.ts`. The upstream URL is rebuilt from trusted constants; no client-supplied host is used.
- **Methods:** `GET` and `HEAD` only. Anything else is `405`.
- **Path safety:** decoded `..`, encoded traversal, empty/ambiguous segments and over-long paths are rejected before any upstream request. Unknown repos, mutable revisions (`main`, branches, short SHAs) and malformed paths are `404`/`400` without contacting Hugging Face.
- **Redirects:** followed manually, maximum 5, with the same host/scheme/port rules on every hop. Only HTTPS on `huggingface.co`, `*.huggingface.co` and `*.hf.co` is allowed; downgrades, embedded credentials, non-443 ports and loops are refused.
- **Streaming:** the response body is passed through with `ReadableStream`; it is never buffered.
- **Ranges:** valid `Range` requests are forwarded and `206`/`Content-Range` are preserved; invalid ranges are `416` without an upstream call; `HEAD` has no body.
- **Headers:** only representation metadata (`content-type`, `etag`, `content-range`, `last-modified`, `vary`, …) is copied. Client credentials, cookies and query strings are not forwarded. Upstream failures become generic `502`s; provider error bodies are not echoed.
- **Caching:** successful pinned responses are `Cache-Control: public, max-age=31536000, immutable`; ranges and errors are `no-store`.

### 6.2 Routing and local parity

- `worker/index.ts` handles `/models/` before `/api/recommend` and before the `ASSETS` fallback.
- `worker/dev-proxy.ts` runs the same handler as Vite middleware in `npm run dev` and `vite preview`.
- `wrangler.jsonc` uses `run_worker_first: true` so the Worker applies COOP/COEP/CSP to assets and a future `dist/models/` file cannot shadow the relay.

### 6.3 Client wiring

- `src/lib/ai-engine.ts`: sets `env.remoteHost` to `${origin}/models/`, `env.remotePathTemplate` to `'{model}/resolve/{revision}/'`, installs `tracker.fetch` as `env.fetch`, and passes `revision: candidate.revision`.
- `src/lib/ai-worker.ts`: derives the origin from `ctx.location.origin`.
- `src/lib/ai-integrity.ts`: same-origin URL parsing, streaming verification, `pinModelRequestUrl()` and normalising `trackedFetch`.

### 6.4 Manifest and tooling

- `src/data/ai-manifest.json` contains **30 file records** (3 repos × 2 dtypes × 5 files) generated from the pinned upstream revisions. No hash was hand-written.
- Wrangler is pinned to `4.151.3`.
- Version remains `1.13.8` in `package.json`, `package-lock.json`, `src/lib/app-version.ts` and `AGENTS.md`.

## 7. Verification actually performed

Environment: Windows, **Deno 2.9.8** (no Node.js in this environment). All commands were run in the project root.

| Check | Command | Result |
|---|---|---|
| Typecheck | `deno run -A npm:typescript@7.0.2/tsc --noEmit` | **Pass** (exit 0) |
| Lint | `deno run -A npm:oxlint@1.89.0` | **Pass** (exit 0; `tests/vendor/**` excluded as an unmodified third-party bundle) |
| Production build | `deno run -A npm:vite@8.3.5 build` | **Pass** (exit 0) |
| Deno tests | `deno test -A --no-check --unstable-sloppy-imports deno-tests/model-proxy.test.ts deno-tests/ai-integration.test.ts deno-tests/transformers-revision.test.ts` | **33 passed, 0 failed** (27 existing + 6 new real-runtime tests) |
| Playwright (proxy, AI engine, integrity, profile storage) | `deno run -A npm:@playwright/test@1.64.1 test tests/model-proxy.spec.ts tests/local-ai-engine.spec.ts tests/local-ai-integrity.spec.ts tests/profile-storage.spec.ts` | **138 passed, 0 failed** |

The Playwright web servers had to be started manually (`deno run -A npm:vite@8.3.5 preview --outDir dist-e2e --port 4321` and the `dist-e2e-nokey` build on 4322) because the configured `npm`/`npx` commands are unavailable without Node.js; `reuseExistingServer` then used them.

### 7.1 Live-build check (read-only)

`https://moodsift.adj189.workers.dev/` was inspected without deploying or modifying anything:

- Root returned `200`, but **no** COOP, COEP or CSP headers.
- The HTML referenced `assets/index-B-RKoh9r.js`, `assets/rolldown-runtime-XKyaHtl9.js`, `assets/ambient-B0cm8rH8.js` and `assets/llm-BBEHxMnJ.js` — different hashes from the local build.
- The live main JS was 114,602 bytes and did **not** contain `4.3.1`, `/models/`, `remotePathTemplate`, `modelHost` or `candidate.revision`.
- Both `/models/<repo>/resolve/main/config.json` and `/models/<repo>/resolve/b8a5c0f…/config.json` returned **404**.

Conclusion: the public URL is an **older build** without the relay. It is not the build under investigation and cannot validate this fix. The preview must be rebuilt and redeployed to exercise the corrected path; that deployment is out of scope here.

## 8. Limitations and things not done

- **No full model download and no inference.** The real-runtime tests stop at the first ONNX weight request (answered `404`); no weight bytes, ONNX session, smoke generation or output validation were exercised. No model/backend is claimed "tested" in the product sense.
- **No production deployment or production-browser test.** Nothing was deployed, no Cloudflare account was changed, and no GitHub operation was performed.
- **The deployed preview could not be validated.** The accessible live build is older and has no `/models/` route; see §7.1.
- **No explicit edge cache.** `/models/` relies on immutable `Cache-Control`; ranges and errors are not cached. A dedicated R2 or Cache API layer is a separate change.
- **Full Playwright suite not run.** It is impractical under Deno here (roughly 50 s per UI test); the targeted suites above cover the changed surface.
- **`deno test` without `--no-check`** still fails on a pre-existing DOM typing issue in `src/lib/ai-settings.ts` (`Property 'key' does not exist on type 'Event'`). Typechecking is done with `tsc`, which passes.
- **Node scripts** are run through Deno equivalents because Node.js is unavailable; the committed npm scripts themselves are unchanged.

## 9. Files added / modified / deleted

### Added

- `worker/model-proxy.ts`
- `worker/dev-proxy.ts`
- `deno-tests/model-proxy.test.ts`
- `deno-tests/ai-integration.test.ts`
- `deno-tests/transformers-revision.test.ts`
- `deno-tests/fixtures/transformers-revision-runner.ts`
- `deno.json`
- `tests/vendor/transformers-4.3.1.web.js`
- `tests/vendor/transformers-4.3.1.web.d.ts`
- `tests/vendor/onnxruntime-common-stub.mjs`
- `tests/vendor/onnxruntime-web-stub.mjs`
- `tests/vendor/LICENSE.transformers.js`
- `tests/vendor/README.md`
- `tests/model-proxy.spec.ts`

### Modified

- `worker/index.ts`
- `vite.config.ts`
- `wrangler.jsonc`
- `package.json`
- `package-lock.json`
- `.oxlintrc.json`
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
- `IMPLEMENTATION-REPORT.md` (this file)

### Deleted

- None.

## 10. Delivered archive

- Archive: `moodsift-cloudflare-worker-fixed.zip`
- Contents: the complete modified project, excluding `node_modules`, `dist`, `dist-e2e*`, `.wrangler`, `deno.lock`, `test-results`, `.env`, credentials, caches and temporary test files.
- The archive's SHA-256 is reported alongside the delivery. It cannot be embedded in this file and also match the archive it is inside, by construction.

### Upload summary for the maintainer

Upload the added and modified files listed in §9. Remove nothing. Do not upload `node_modules`, `dist`, `dist-e2e*`, `.wrangler`, `deno.lock`, `test-results`, `.env` or the temporary `*-test.json` / `trace-inspect.mjs` files. After deploying, re-check `/models/<repo>/resolve/<sha>/config.json` on the preview and confirm the browser requests only the pinned SHA.
