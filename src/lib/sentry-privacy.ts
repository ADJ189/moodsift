// src/lib/sentry-privacy.ts
//
// Pure privacy-sanitization helpers for browser-side Sentry telemetry.
// Kept dependency-free so native Deno tests can verify them without loading
// the browser SDK.

const THIRD_PARTY_API_URL_RE = /https?:\/\/(?:api\.themoviedb\.org|www\.omdbapi\.com|omdbapi\.com)\/[^\s"'`<>)]+/gi;

const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);

/** Strips query strings and fragments from TMDB/OMDb URLs inside arbitrary text. */
export function scrubThirdPartyQueryUrls(text: string): string {
  return text.replace(THIRD_PARTY_API_URL_RE, (raw) => {
    try {
      const u = new URL(raw);
      if (!u.search && !u.hash) return raw;
      u.search = '';
      u.hash = '';
      return u.toString();
    } catch {
      return raw.replace(/[?#].*$/, '');
    }
  });
}

export interface SanitizeBreadcrumbInput {
  category?: string;
  data?: Record<string, unknown>;
}

/** Drops DOM/HTTP breadcrumbs that could carry rated titles or search queries,
 * and strips query strings from navigation breadcrumbs. */
export function sanitizeBreadcrumb<T extends SanitizeBreadcrumbInput>(breadcrumb: T): T | null {
  const cat = breadcrumb.category ?? '';
  if (cat.startsWith('ui.') || cat === 'fetch' || cat === 'xhr') return null;
  if (cat === 'navigation' && breadcrumb.data) {
    const nextData: Record<string, unknown> = { ...breadcrumb.data };
    for (const key of ['from', 'to'] as const) {
      const val = nextData[key];
      if (typeof val === 'string') nextData[key] = val.replace(/[?#].*$/, '');
    }
    return { ...breadcrumb, data: nextData };
  }
  return breadcrumb;
}

export interface SanitizeReplayEventInput {
  data?: {
    tag?: string;
    payload?: unknown;
  };
}

/** Drops UI interaction breadcrumbs inside Session Replay and strips query
 * strings from network span descriptions. */
export function sanitizeReplayEvent<T extends SanitizeReplayEventInput>(event: T): T | null {
  const tag = event.data?.tag;
  const payload = event.data?.payload;
  if (tag === 'breadcrumb' && isRecord(payload) && typeof payload.category === 'string' && payload.category.startsWith('ui.')) {
    return null;
  }
  if (
    tag === 'performanceSpan' &&
    isRecord(payload) &&
    (payload.op === 'resource.fetch' || payload.op === 'resource.xhr') &&
    typeof payload.description === 'string'
  ) {
    const scrubbed = payload.description.replace(/[?#].*$/, '');
    if (scrubbed !== payload.description) {
      return {
        ...event,
        data: {
          ...event.data,
          payload: {
            ...payload,
            description: scrubbed,
          },
        },
      };
    }
  }
  return event;
}

export interface SanitizeErrorEventInput {
  message?: string;
  exception?: {
    values?: Array<{ value?: string }>;
  };
}

/** Strips query strings from third-party catalog URLs in captured error messages. */
export function sanitizeErrorEvent<T extends SanitizeErrorEventInput>(event: T): T {
  const message = typeof event.message === 'string' ? scrubThirdPartyQueryUrls(event.message) : event.message;
  const values = event.exception?.values?.map((ex) =>
    typeof ex.value === 'string' ? { ...ex, value: scrubThirdPartyQueryUrls(ex.value) } : ex
  );
  return {
    ...event,
    ...(message !== undefined ? { message } : {}),
    ...(values !== undefined ? { exception: { ...event.exception, values } } : {}),
  };
}
