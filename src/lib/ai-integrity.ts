// src/lib/ai-integrity.ts
//
// Model integrity: verifies the BYTES of every manifested model file against
// an expected SHA-256 + size before a model may be reported ready.
//
// A pinned Hugging Face revision makes a download reproducible; it does not
// prove the bytes that arrived are the bytes that revision contains. This
// module closes that gap WITHOUT buffering a model: Transformers.js is told to
// use `tracker.fetch` (its supported `env.fetch` hook), the response body is
// streamed through an incremental SHA-256 (sha256.ts) and the stream is
// ERRORED at its very end if the digest or size differs. The consumer
// therefore never sees a clean end-of-file for bad bytes, the pipeline
// construction fails, and nothing is stored in the browser cache for that
// file (a failed `cache.put` stores nothing).
//
// Revision pinning: Transformers.js 4.3.1 does not thread `revision` through
// its file-discovery helpers (`get_pipeline_files` -> `get_config` /
// `get_tokenizer_files`, and the progress metadata calls). Those requests fall
// back to `resolve/main/...` even when `pipeline(..., { revision })` was given.
// Because the same-origin relay correctly refuses `main`, the pipeline failed
// before the pinned component downloads could run. `trackedFetch` therefore
// rewrites every same-origin request for THIS candidate's repository to the
// pinned revision before it reaches the network. The relay stays strict: it
// still rejects `main`, branches and tags, and only the exact allow-listed
// repository/SHA pair is reachable. This also makes the discovery responses
// verifiable, because `parseModelUrl` only matches the pinned revision.
//
// Honesty rules (see docs/Moodsift-Local-AI-Engine-Policy.md):
//   - "verified" means every file the model needs was hashed and matched.
//   - No manifest entry / empty manifest / a file outside the manifest /
//     a cached file with no recorded verification → "not-verified", never
//     "verified". A mismatch → "failed".
//   - Hashes come from a reviewed manifest generated from the exact pinned
//     revision (scripts/generate-ai-manifest.mjs). HTTP ETags are not used.
//
// Pure: no DOM or worker globals — fetch/caches are injected, so the whole
// thing is unit-tested in Node.


import { Sha256 } from './sha256';

export interface ManifestFile {
  /** Path inside the repository, e.g. `onnx/model_quantized.onnx`. */
  path: string;
  size: number;
  sha256: string;
}

export interface ManifestEntry {
  repo: string;
  revision: string;
  files: ManifestFile[];
}

export interface ManifestFileShape {
  schema: number;
  generatedAt: string | null;
  models: Record<string, { repo: string; revision: string; dtypes: Record<string, { files: ManifestFile[] }> }>;
}

export type IntegrityState = 'verified' | 'not-verified' | 'failed';

export interface IntegrityReport {
  state: IntegrityState;
  /** Short, user-readable explanation. */
  detail: string;
  /** Machine-readable reason for `not-verified` / `failed`. */
  reason?: 'no-manifest' | 'unmanifested-file' | 'cache-unrecorded' | 'sha256-mismatch' | 'size-mismatch' | 'cache-corrupt' | 'unsupported-response';
  verifiedFiles: number;
  totalFiles: number;
}

const HEX64 = /^[0-9a-f]{64}$/;

/** Returns the manifest entry for a candidate, or null when there is nothing
 * trustworthy to verify against (missing, empty, wrong repo/revision, or a
 * malformed hash/size). Never throws. */
export function manifestFor(
  c: { family: string; dtype: string; repo: string; revision: string },
  manifest: ManifestFileShape
): ManifestEntry | null {
  const model = manifest?.models?.[c.family];
  if (!model || model.repo !== c.repo || model.revision !== c.revision) return null;
  const files = model.dtypes?.[c.dtype]?.files;
  if (!Array.isArray(files) || files.length === 0) return null;
  const clean: ManifestFile[] = [];
  for (const f of files) {
    if (!f || typeof f.path !== 'string' || !HEX64.test(f.sha256) || !Number.isSafeInteger(f.size) || f.size <= 0) return null;
    clean.push({ path: f.path, size: f.size, sha256: f.sha256 });
  }
  return { repo: c.repo, revision: c.revision, files: clean };
}

/** Removes credentials, query and fragment from a valid URL. For invalid URLs,
 * returns up to 200 characters before the first query or fragment delimiter. */
export function sanitizeUrl(raw: string): string {
  try {
    const u = new URL(raw);
    return `${u.origin}${u.pathname}`;
  } catch {
    return raw.split(/[?#]/)[0]?.slice(0, 200) ?? '';
  }
}

export interface ParsedModelUrl {
  repo: string;
  revision: string;
  path: string;
}

/** Splits a model resolve URL into decoded repo, revision and path, or returns
 * null for an invalid URL, another origin or an unrecognized path.
 *
 * `remoteHost` may include a base path, e.g. `https://moodsift.example/models/`.
 * That is the same-origin proxy route used by ai-engine.ts; without stripping
 * the base path the tracker would not recognise the requests it must verify.
 * Throws TypeError for an invalid remoteHost and URIError for malformed escapes. */
export function parseModelUrl(raw: string, remoteHost = 'https://huggingface.co/'): ParsedModelUrl | null {
  let u: URL;
  try {
    u = new URL(raw);
  } catch {
    return null;
  }
  const host = new URL(remoteHost);
  if (u.origin !== host.origin) return null;

  const base = host.pathname.endsWith('/') ? host.pathname : `${host.pathname}/`;
  if (!u.pathname.startsWith(base)) return null;
  const rest = u.pathname.slice(base.length);
  const m = /^([^/]+\/[^/]+)\/resolve\/([^/]+)\/(.+)$/.exec(rest);
  if (!m) return null;
  return { repo: decodeURIComponent(m[1]!), revision: decodeURIComponent(m[2]!), path: decodeURIComponent(m[3]!) };
}

export class IntegrityError extends Error {
  constructor(
    readonly path: string,
    readonly reason: 'sha256-mismatch' | 'size-mismatch',
    readonly expected: string,
    readonly actual: string
  ) {
    super(`Integrity check failed for ${path}: ${reason === 'size-mismatch' ? 'size' : 'SHA-256'} mismatch.`);
    this.name = 'IntegrityError';
  }
}

/** Where "this exact file passed verification" is remembered between visits. */
export interface VerifiedStore {
  get(key: string): Promise<{ sha256: string; size: number } | null>;
  set(key: string, record: { sha256: string; size: number }): Promise<void>;
  delete(key: string): Promise<void>;
}

/** Creates an isolated, in-memory store of file verification records. */
export function memoryStore(): VerifiedStore {
  const map = new Map<string, { sha256: string; size: number }>();
  return {
    async get(k) {
      return map.get(k) ?? null;
    },
    async set(k, r) {
      map.set(k, r);
    },
    async delete(k) {
      map.delete(k);
    },
  };
}

interface CacheLike {
  match(request: string): Promise<Response | undefined>;
  put(request: string, response: Response): Promise<void>;
  delete(request: string): Promise<boolean>;
}
interface CacheStorageLike {
  open(name: string): Promise<CacheLike>;
}

/** A VerifiedStore backed by the Cache API (tiny JSON bodies). Any storage
 * failure degrades to "nothing recorded" — i.e. "not verified", never a false
 * "verified". */
export function cacheStore(storage: CacheStorageLike | undefined, name = 'moodsift-ai-integrity-v1'): VerifiedStore {
  const keyUrl = (k: string) => `https://integrity.moodsift.invalid/${encodeURIComponent(k)}`;
  return {
    async get(k) {
      try {
        const res = await (await storage!.open(name)).match(keyUrl(k));
        if (!res) return null;
        const v = (await res.json()) as { sha256?: unknown; size?: unknown };
        return typeof v.sha256 === 'string' && typeof v.size === 'number' ? { sha256: v.sha256, size: v.size } : null;
      } catch {
        return null;
      }
    },
    async set(k, r) {
      try {
        await (await storage!.open(name)).put(keyUrl(k), new Response(JSON.stringify(r), { headers: { 'Content-Type': 'application/json' } }));
      } catch {
        // Not recorded → next visit reports "not verified". Safe.
      }
    },
    async delete(k) {
      try {
        await (await storage!.open(name)).delete(keyUrl(k));
      } catch {
        // ignore
      }
    },
  };
}

export type FetchFn = (input: string | URL, init?: RequestInit) => Promise<Response>;

/** A pinned revision is a full 40-character commit SHA, never `main`. */
const PINNED_REVISION = /^[0-9a-f]{40}$/;

/**
 * Rewrites a same-origin model request to the pinned revision for the SAME
 * repository. This exists because Transformers.js 4.3.1's discovery helpers
 * omit `revision`, producing `resolve/main/...` requests even when the caller
 * supplied a pin. Only the revision segment is replaced; the origin, base
 * path, repo, file path, query and hash are preserved. Requests for another
 * repository, another origin, a malformed URL, or a tracker whose configured
 * revision is not a full SHA are returned unchanged (the relay then rejects
 * them). Never rewrites to a mutable revision.
 */
export function pinModelRequestUrl(raw: string, opts: { remoteHost: string; repo: string; revision: string }): string {
  if (!PINNED_REVISION.test(opts.revision)) return raw;

  let u: URL;
  let host: URL;
  try {
    u = new URL(raw);
    host = new URL(opts.remoteHost);
  } catch {
    return raw;
  }
  if (u.origin !== host.origin) return raw;

  const base = host.pathname.endsWith('/') ? host.pathname : `${host.pathname}/`;
  if (!u.pathname.startsWith(base)) return raw;

  const rest = u.pathname.slice(base.length);
  const match = /^([^/]+\/[^/]+)\/resolve\/([^/]+)\/(.+)$/.exec(rest);
  if (!match) return raw;

  let repo: string;
  let revision: string;
  try {
    repo = decodeURIComponent(match[1]!);
    revision = decodeURIComponent(match[2]!);
  } catch {
    return raw;
  }
  if (repo !== opts.repo || revision === opts.revision) return raw;

  const revisionStart = base.length + match[1]!.length + '/resolve/'.length;
  u.pathname = `${u.pathname.slice(0, revisionStart)}${encodeURIComponent(opts.revision)}${u.pathname.slice(revisionStart + match[2]!.length)}`;
  return u.toString();
}

export interface TrackerOptions {
  repo: string;
  revision: string;
  /** null → nothing to verify against ("Not yet verified"). */
  entry: ManifestEntry | null;
  baseFetch: FetchFn;
  store: VerifiedStore;
  /** Best-effort removal of a bad file from the model cache (by URL). */
  discardCached?: (url: string) => Promise<void>;
  remoteHost?: string;
}

export interface NetworkFailure {
  /** origin + path only. */
  url: string;
  /** HTTP status, or undefined for a network-level (opaque) failure. */
  status?: number;
  /** Error name/message for network-level failures, e.g. "TypeError: NetworkError…". */
  error?: string;
}

type FileStatus = 'verified' | 'failed' | 'unsupported' | 'absent';

export interface IntegrityTracker {
  /** Pass as `env.fetch`. */
  fetch: FetchFn;
  /** Before loading: inspect cached copies by metadata, never by full re-hash. */
  preflight(cache: CacheLike | undefined, opts: { purgeUnrecorded: boolean }): Promise<void>;
  /** The most recent failed request (network error or HTTP >= 400). */
  lastFailure(): NetworkFailure | null;
  /** True once any file failed verification. */
  hasMismatch(): boolean;
  /** Final state after the pipeline has been constructed. */
  finalize(): Promise<IntegrityReport>;
}

const key = (repo: string, revision: string, path: string) => `${repo}@${revision}/${path}`;

/** Tracks one model revision's downloads and recorded cache verification.
 * Only manifested files with matching size and SHA-256 count as verified;
 * missing metadata or unsupported responses remain not-verified. */
export function createIntegrityTracker(opts: TrackerOptions): IntegrityTracker {
  const { repo, revision, entry, baseFetch, store } = opts;
  const remoteHost = opts.remoteHost ?? 'https://huggingface.co/';
  const expected = new Map((entry?.files ?? []).map((f) => [f.path, f] as const));
  const status = new Map<string, FileStatus>();
  const unmanifested = new Set<string>();
  const cachedBad = new Set<string>();
  let failure: NetworkFailure | null = null;
  let mismatch: IntegrityError | null = null;

  const urlOf = (path: string) => `${remoteHost.replace(/\/?$/, '/')}${repo}/resolve/${encodeURIComponent(revision)}/${path}`;

  /** Forwards requests and records failures, verifying manifested response bodies
   * as they are consumed. Same-origin requests for this candidate's repo are
   * rewritten to the pinned revision first (Transformers.js 4.3.1 discovery
   * otherwise asks for `main`). A mismatch errors the stream with IntegrityError
   * and attempts cache removal; fetch and verification-store errors propagate.
   * HTTP failures are returned as responses rather than thrown. */
  const trackedFetch: FetchFn = async (input, init) => {
    const requested = input instanceof URL ? input.toString() : String(input);
    const raw = pinModelRequestUrl(requested, { remoteHost, repo, revision });
    let res: Response;
    try {
      res = await baseFetch(raw, init);
    } catch (err) {
      failure = { url: sanitizeUrl(raw), error: err instanceof Error ? `${err.name}: ${err.message}`.slice(0, 160) : 'network error' };
      throw err;
    }
    if (!res.ok) failure = { url: sanitizeUrl(raw), status: res.status };

    const parsed = parseModelUrl(raw, remoteHost);
    if (!parsed || parsed.repo !== repo || parsed.revision !== revision) return res;
    if (!res.ok) {
      // 404 on an optional file (e.g. generation_config.json) is normal.
      status.set(parsed.path, 'absent');
      return res;
    }

    const want = expected.get(parsed.path);
    if (!want) {
      unmanifested.add(parsed.path);
      return res;
    }
    if (!res.body || res.status !== 200) {
      status.set(parsed.path, 'unsupported');
      return res;
    }

    const hash = new Sha256();
    const path = parsed.path;
    const verifying = new TransformStream<Uint8Array, Uint8Array>({
      transform(chunk, controller) {
        hash.update(chunk);
        controller.enqueue(chunk);
      },
      async flush(controller) {
        const size = hash.length;
        const sha = hash.digestHex();
        if (size !== want.size || sha !== want.sha256) {
          const err = new IntegrityError(path, size !== want.size ? 'size-mismatch' : 'sha256-mismatch', size !== want.size ? String(want.size) : want.sha256, size !== want.size ? String(size) : sha);
          mismatch = err;
          status.set(path, 'failed');
          await store.delete(key(repo, revision, path));
          try {
            await opts.discardCached?.(urlOf(path));
          } catch {
            // best effort
          }
          controller.error(err);
          return;
        }
        status.set(path, 'verified');
        await store.set(key(repo, revision, path), { sha256: sha, size });
      },
    });
    const headers = new Headers(res.headers);
    return new Response(res.body.pipeThrough(verifying), { status: res.status, statusText: res.statusText, headers });
  };

  return {
    fetch: trackedFetch,

    /** Inspects cache size headers and verification records without hashing bodies.
     * Attempts to remove inconsistent copies and, if requested, unrecorded ones.
     * Cache lookup/deletion errors are ignored; verification-store errors propagate. */
    async preflight(cache, { purgeUnrecorded }) {
      if (!cache || !entry) return;
      for (const f of entry.files) {
        const url = urlOf(f.path);
        let cached: Response | undefined;
        try {
          cached = await cache.match(url);
        } catch {
          continue;
        }
        if (!cached) continue;
        const declared = Number(cached.headers.get('content-length') ?? Number.NaN);
        const rec = await store.get(key(repo, revision, f.path));
        const sizeBad = Number.isFinite(declared) && declared !== f.size;
        const recordBad = rec !== null && (rec.sha256 !== f.sha256 || rec.size !== f.size);
        const unrecorded = rec === null;
        if (sizeBad || recordBad || (unrecorded && purgeUnrecorded)) {
          // Discard so the next request re-downloads and is verified.
          try {
            await cache.delete(url);
          } catch {
            // best effort
          }
          await store.delete(key(repo, revision, f.path));
          if (sizeBad || recordBad) cachedBad.add(f.path);
        }
      }
    },

    lastFailure: () => failure,
    hasMismatch: () => mismatch !== null,

    /** Reports mismatches or verification coverage using completed downloads and
     * matching stored records. Does not consume outstanding response bodies.
     * Verification-store read errors propagate. */
    async finalize() {
      const total = expected.size;
      if (!entry) {
        return { state: 'not-verified', reason: 'no-manifest', detail: 'No checksum manifest is available for this model revision yet.', verifiedFiles: 0, totalFiles: 0 };
      }
      if (mismatch) {
        return { state: 'failed', reason: mismatch.reason, detail: mismatch.message, verifiedFiles: 0, totalFiles: total };
      }
      let verified = 0;
      let unsupported = false;
      let unrecorded = false;
      for (const f of entry.files) {
        const s = status.get(f.path);
        if (s === 'verified') {
          verified++;
        } else if (s === 'unsupported') {
          unsupported = true;
        } else {
          // Not downloaded this time → served from the browser cache. It only
          // counts when our own record proves THESE bytes passed before.
          const rec = await store.get(key(repo, revision, f.path));
          if (rec && rec.sha256 === f.sha256 && rec.size === f.size && !cachedBad.has(f.path)) verified++;
          else unrecorded = true;
        }
      }
      if (unmanifested.size > 0) {
        return { state: 'not-verified', reason: 'unmanifested-file', detail: `A downloaded file is not in the checksum manifest (${[...unmanifested][0]}).`, verifiedFiles: verified, totalFiles: total };
      }
      if (unsupported) {
        return { state: 'not-verified', reason: 'unsupported-response', detail: 'A model file arrived in a form that cannot be hashed while streaming.', verifiedFiles: verified, totalFiles: total };
      }
      if (unrecorded) {
        return { state: 'not-verified', reason: 'cache-unrecorded', detail: 'Model files are cached from before verification existed. Run the test again to re-download and verify them.', verifiedFiles: verified, totalFiles: total };
      }
      return { state: 'verified', detail: `${verified} of ${total} model files match their expected SHA-256.`, verifiedFiles: verified, totalFiles: total };
    },
  };
}
