# Security Policy

## Supported versions

Only the latest commit on `main` is supported. This is a small, actively-developed
project — there are no maintained release branches to backport fixes to.

## Reporting a vulnerability

Please **do not** open a public GitHub issue for security vulnerabilities.

Instead, use GitHub's private vulnerability reporting for this repository
(**Security** tab → **Report a vulnerability**), or open a draft security
advisory. Include:

- A description of the vulnerability and its potential impact
- Steps to reproduce, or a proof of concept
- Any suggested fix, if you have one

You should get an initial response within a few days. This project has no
paid security program or bounty, but confirmed reports will be credited in
the fix's changelog entry unless you'd prefer to stay anonymous.

## Scope notes

- Client-side app: the primary risk surface is XSS via untrusted API
  responses (TMDB/OMDb) rendered into the DOM, and any handling of
  user-supplied files (the Letterboxd and IMDb CSV importers and the
  taste-memory backup import, which rejects oversized files and
  sanitises every field on load).
- The optional on-device AI runtime is loaded from a CDN at runtime and never
  sends user data anywhere. Model files are fetched through the same-origin
  `/models/` relay (`worker/model-proxy.ts`), not directly by the browser.
  The relay is deliberately narrow: only the repositories and full pinned
  commit SHAs in `src/lib/ai-policy.ts`, only HTTPS Hugging Face / HF storage
  hosts on each redirect hop, only `GET` and `HEAD`, no client credentials,
  cookies or query strings forwarded, and path traversal/encoded separators
  rejected. It streams responses and does not buffer files. Eligible downloads
  recorded in the committed manifest are checked against its sizes and SHA-256
  checksums; a mismatch fails closed. Unmanifested files and cached files without
  a verification record may be accepted without hashing, with a not-verified
  result. The optional `worker/index.ts`
  `/api/recommend` route is off by default (no AI binding) and only ever
  forwards a pre-filtered candidate list, never raw user input, to Cloudflare
  Workers AI.
- The Worker enforces `frame-ancestors 'self'`; the full Content Security
  Policy currently ships as Report-Only until it has been validated in a
  real browser.
- CI runs `npm audit --audit-level=high` and Dependabot is configured for
  weekly npm checks.
