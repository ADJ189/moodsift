// worker/model-proxy.ts
//
// Same-origin model-file relay for the on-device AI.
//
// Transformers.js normally downloads model artifacts straight from
// huggingface.co. That makes the browser's CORS and redirect handling part of
// the model-loading path. This module moves those requests behind the Moodsift
// origin: the browser asks for `/models/<repo>/resolve/<pinned-revision>/<file>`
// on Moodsift, and this handler fetches the corresponding Hugging Face file
// server-side, follows permitted redirects itself, and streams the bytes back.
//
// This is deliberately NOT an open proxy:
//   - only repositories and revisions in src/lib/ai-policy.ts are accepted;
//   - only GET and HEAD are accepted;
//   - the upstream URL is rebuilt from trusted constants, never from a
//     client-supplied host;
//   - redirects are followed manually and every hop must be an HTTPS
//     Hugging Face / HF model-storage host;
//   - the response body is streamed, never buffered.
//
// The same handler is used by worker/index.ts in production and by the Vite
// development/preview middleware in vite.config.ts, so local testing exercises
// the same validation and redirect rules as the deployed Worker.

import { MODELS } from '../src/lib/ai-policy';

/** Every model request the Worker owns lives under this prefix. */
export const MODEL_PREFIX = '/models/';

/** The only initial upstream origin. Redirects are checked separately. */
export const UPSTREAM_ORIGIN = 'https://huggingface.co';

/** Enough for Hugging Face's repository -> CDN redirect chain, but bounded. */
const MAX_REDIRECTS = 5;

/** Pinned revisions in ai-policy.ts are full 40-character commit SHAs. */
const PINNED_REVISION = /^[0-9a-f]{40}$/;

const MAX_FILE_PATH_CHARS = 1024;
const MAX_RANGE_CHARS = 200;

/**
 * A redirect may only land on Hugging Face itself or one of its model-storage
 * subdomains. `.hf.co` covers cdn-lfs*.hf.co, cas-bridge.xethub.hf.co, etc.
 */
const UPSTREAM_HOST = 'huggingface.co';
const UPSTREAM_SUFFIXES = ['.huggingface.co', '.hf.co'];

/** Representation/metadata headers worth preserving for model consumers. */
const COPY_RESPONSE_HEADERS = [
  'accept-ranges',
  'content-disposition',
  'content-encoding',
  'content-language',
  'content-range',
  'content-type',
  'etag',
  'last-modified',
  'vary',
] as const;

/** Conditional request headers that are safe and useful to relay. */
const FORWARD_REQUEST_HEADERS = ['if-match', 'if-modified-since', 'if-none-match', 'if-range', 'if-unmodified-since'] as const;

const REDIRECT_STATUSES = new Set([301, 302, 303, 307, 308]);

export type FetchLike = (input: string | URL | Request, init?: RequestInit) => Promise<Response>;

export interface ModelRoute {
  repo: string;
  revision: string;
  file: string;
}

export type ModelPathResult =
  | { ok: true; route: ModelRoute }
  | { ok: false; status: 400 | 404; message: string };

export type ModelProxyFailure = 'blocked-upstream' | 'blocked-redirect' | 'bad-redirect' | 'redirect-loop' | 'too-many-redirects';

export class ModelProxyError extends Error {
  constructor(readonly code: ModelProxyFailure) {
    super(code);
    this.name = 'ModelProxyError';
  }
}

/** Repository -> pinned revision, derived from the single source of truth. */
export function allowedModels(): ReadonlyMap<string, string> {
  return new Map(Object.values(MODELS).map((model) => [model.repo, model.revision] as const));
}

/** True for HTTPS Hugging Face / HF storage hosts only, with no credentials or
 * non-default port. This is applied to the initial URL and every redirect. */
export function isAllowedUpstreamUrl(url: URL): boolean {
  if (url.protocol !== 'https:') return false;
  if (url.username !== '' || url.password !== '') return false;
  if (url.port !== '' && url.port !== '443') return false;
  const host = url.hostname.toLowerCase();
  return host === UPSTREAM_HOST || UPSTREAM_SUFFIXES.some((suffix) => host.endsWith(suffix));
}

/** One decoded path segment or null when the escape sequence is malformed. */
function decodeSegment(raw: string): string | null {
  try {
    return decodeURIComponent(raw);
  } catch {
    return null;
  }
}

/** Rejects traversal, embedded separators, empty segments and control bytes. */
function safeSegment(value: string): boolean {
  return (
    value.length > 0 &&
    value !== '.' &&
    value !== '..' &&
    !value.includes('/') &&
    !value.includes('\\') &&
    !value.includes('?') &&
    !value.includes('#') &&
    // eslint-disable-next-line no-control-regex
    !/[\u0000-\u001f\u007f]/.test(value)
  );
}

/**
 * Parses `/models/{owner}/{repo}/resolve/{revision}/{file...}`.
 *
 * URL parsing has already collapsed literal `.`/`..` segments, so those become
 * a missing/unknown route rather than a traversal. Percent-encoded traversal
 * (`%2e%2e`), encoded slashes/backslashes and malformed escapes are rejected
 * explicitly here. Every segment is decoded once and never re-decoded.
 */
export function parseModelPath(pathname: string, allowed: ReadonlyMap<string, string> = allowedModels()): ModelPathResult {
  if (!pathname.startsWith(MODEL_PREFIX)) return { ok: false, status: 404, message: 'Not found.' };

  const raw = pathname.slice(MODEL_PREFIX.length).split('/');
  if (raw.length < 5) return { ok: false, status: 404, message: 'Not found.' };

  const owner = decodeSegment(raw[0] ?? '');
  const name = decodeSegment(raw[1] ?? '');
  if (owner === null || name === null) return { ok: false, status: 400, message: 'Invalid model path.' };
  if (!safeSegment(owner) || !safeSegment(name)) return { ok: false, status: 400, message: 'Invalid model path.' };

  const repo = `${owner}/${name}`;
  const revisionRaw = raw[3] ?? '';
  const revision = decodeSegment(revisionRaw);
  if (revision === null) return { ok: false, status: 400, message: 'Invalid model path.' };

  // `resolve` is part of the public URL contract. A different keyword is not a
  // model file, even if the rest of the path happens to look valid.
  if (raw[2] !== 'resolve') return { ok: false, status: 404, message: 'Not found.' };

  const pinned = allowed.get(repo);
  if (!pinned) return { ok: false, status: 404, message: 'Model not available.' };
  // Reject `main`, branches, tags and any other mutable/unknown revision.
  if (!PINNED_REVISION.test(revision) || revision !== pinned) {
    return { ok: false, status: 404, message: 'Model revision not available.' };
  }

  const fileParts: string[] = [];
  for (const part of raw.slice(4)) {
    const decoded = decodeSegment(part);
    if (decoded === null) return { ok: false, status: 400, message: 'Invalid model path.' };
    if (!safeSegment(decoded)) return { ok: false, status: 400, message: 'Invalid model path.' };
    fileParts.push(decoded);
  }
  if (fileParts.length === 0) return { ok: false, status: 404, message: 'Not found.' };

  const file = fileParts.join('/');
  if (file.length > MAX_FILE_PATH_CHARS) return { ok: false, status: 400, message: 'Invalid model path.' };

  return { ok: true, route: { repo, revision, file } };
}

/** Accepts a single well-formed byte range. Multiple ranges are refused rather
 * than turned into an unbounded multipart response. */
export function isValidRange(value: string): boolean {
  if (value.length === 0 || value.length > MAX_RANGE_CHARS) return false;
  const match = /^bytes=(\d*)-(\d*)$/.exec(value);
  if (!match) return false;
  const [, start = '', end = ''] = match;
  if (start === '' && end === '') return false;
  if (start !== '' && end !== '' && Number(start) > Number(end)) return false;
  return true;
}

/** Encodes a validated file path segment-by-segment, preserving `/`. */
export function encodeFilePath(file: string): string {
  return file.split('/').map((part) => encodeURIComponent(part)).join('/');
}

/** Builds the trusted Hugging Face URL for an approved route. */
export function upstreamUrlFor(route: ModelRoute): URL {
  return new URL(`${UPSTREAM_ORIGIN}/${route.repo}/resolve/${route.revision}/${encodeFilePath(route.file)}`);
}

/** Fetches with manual redirect handling so each hop can be validated. */
async function fetchWithRedirects(initial: URL, init: RequestInit, fetchImpl: FetchLike): Promise<Response> {
  let current = initial;
  const seen = new Set<string>();

  for (let hop = 0; hop <= MAX_REDIRECTS; hop++) {
    if (!isAllowedUpstreamUrl(current)) throw new ModelProxyError('blocked-upstream');
    if (seen.has(current.href)) throw new ModelProxyError('redirect-loop');
    seen.add(current.href);

    const response = await fetchImpl(current, { ...init, redirect: 'manual' });
    if (!REDIRECT_STATUSES.has(response.status)) return response;

    const location = response.headers.get('location');
    if (!location) return response;

    // Nobody needs a redirect body; cancel it before the next hop.
    try {
      await response.body?.cancel();
    } catch {
      // Best effort.
    }

    let next: URL;
    try {
      next = new URL(location, current);
    } catch {
      throw new ModelProxyError('bad-redirect');
    }
    if (!isAllowedUpstreamUrl(next)) throw new ModelProxyError('blocked-redirect');
    current = next;
  }

  throw new ModelProxyError('too-many-redirects');
}

/** Builds the browser-facing headers. Upstream cookies, CORS headers and other
 * hop-by-hop/credential-bearing headers are intentionally not copied. */
function responseHeaders(upstream: Response, hasRange: boolean): Headers {
  const headers = new Headers();

  for (const name of COPY_RESPONSE_HEADERS) {
    const value = upstream.headers.get(name);
    if (value) headers.set(name, value);
  }

  // Cloudflare may transparently decode a compressed upstream body. Sending
  // the compressed byte length with a decoded body would corrupt the response.
  const encoded = headers.has('content-encoding');
  if (!encoded) {
    const length = upstream.headers.get('content-length');
    if (length) headers.set('Content-Length', length);
  } else {
    headers.delete('Content-Length');
  }

  headers.set('Accept-Ranges', upstream.headers.get('accept-ranges') ?? 'bytes');
  headers.set('X-Content-Type-Options', 'nosniff');
  headers.set('Referrer-Policy', 'no-referrer');
  headers.set('Cross-Origin-Resource-Policy', 'same-origin');

  const cacheable = (upstream.status >= 200 && upstream.status < 300) || upstream.status === 304;
  if (cacheable) {
    // Pinned revisions are immutable, so this URL's bytes never change.
    // Range responses stay 206 and are not promoted to a complete-object
    // cache entry by this handler (it performs no explicit edge caching).
    headers.set('Cache-Control', 'public, max-age=31536000, immutable');
  } else {
    headers.set('Cache-Control', 'no-store');
  }

  // `hasRange` is accepted for readability at the call site; 206 semantics
  // are preserved from upstream and are never rewritten to 200.
  void hasRange;
  return headers;
}

function errorResponse(request: Request, status: number, message: string, extra: Record<string, string> = {}): Response {
  const headers = new Headers({
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store',
    'X-Content-Type-Options': 'nosniff',
    ...extra,
  });
  // HEAD must never carry a body, including for error responses.
  if (request.method === 'HEAD') return new Response(null, { status, headers });
  return new Response(JSON.stringify({ error: message }), { status, headers });
}

export interface ModelProxyOptions {
  /** Injectable for tests; production uses the Worker runtime's global fetch. */
  fetchImpl?: FetchLike;
}

/**
 * Handles one `/models/...` request. The caller is responsible for routing
 * only that prefix here; this function still re-checks it so a direct call
 * cannot proxy something else.
 */
export async function handleModelProxy(request: Request, url: URL = new URL(request.url), options: ModelProxyOptions = {}): Promise<Response> {
  if (request.method !== 'GET' && request.method !== 'HEAD') {
    return errorResponse(request, 405, 'Method not allowed.', { Allow: 'GET, HEAD' });
  }
  if (!url.pathname.startsWith(MODEL_PREFIX)) return errorResponse(request, 404, 'Not found.');

  const parsed = parseModelPath(url.pathname);
  if (!parsed.ok) return errorResponse(request, parsed.status, parsed.message);

  const range = request.headers.get('range');
  if (range !== null && !isValidRange(range)) {
    return errorResponse(request, 416, 'Range not satisfiable.', { 'Accept-Ranges': 'bytes' });
  }

  const upstreamHeaders = new Headers();
  // Keep the relay byte-transparent; the Worker runtime should not hand us a
  // decoded body whose length no longer matches the upstream headers.
  upstreamHeaders.set('Accept-Encoding', 'identity');
  upstreamHeaders.set('Accept', '*/*');
  if (range !== null) upstreamHeaders.set('Range', range);

  for (const name of FORWARD_REQUEST_HEADERS) {
    const value = request.headers.get(name);
    if (value) upstreamHeaders.set(name, value);
  }

  const fetchImpl: FetchLike = options.fetchImpl ?? ((input, init) => fetch(input, init));

  let upstream: Response;
  try {
    upstream = await fetchWithRedirects(
      upstreamUrlFor(parsed.route),
      { method: request.method, headers: upstreamHeaders, signal: request.signal },
      fetchImpl
    );
  } catch (err) {
    // Provider detail (including redirect targets) stays in Worker logs. The
    // browser receives a generic, non-cacheable error.
    const code = err instanceof ModelProxyError ? err.code : err instanceof Error ? err.name : 'unknown';
    console.error('Model proxy upstream failure:', code);
    return errorResponse(request, 502, 'The model file could not be fetched.');
  }

  const headers = responseHeaders(upstream, range !== null);
  const body = request.method === 'HEAD' ? null : upstream.body;
  return new Response(body, { status: upstream.status, statusText: upstream.statusText, headers });
}
