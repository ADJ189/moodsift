// src/lib/tmdb.ts
//
// Live TMDB connector. Replaces the old baked-in 30-title catalog: every
// query hits TMDB's /discover endpoints so results actually change with the
// user's answers instead of re-sorting the same fixed list.
//
// Auth: set VITE_TMDB_TOKEN (v4 read access token, preferred) or
// VITE_TMDB_KEY (v3 api key) in a local .env file. Neither is committed.

import type { CastMember, CatalogItem, Credits, ContentType, CrewMember, Era, Format, Genre, Language, PersonDetails, PersonSummary, Vibe } from './types';
import { getRegion } from './region';

const API_BASE = 'https://api.themoviedb.org/3';
const IMAGE_BASE = 'https://image.tmdb.org/t/p/';
const SIZES = { xs: 'w92', sm: 'w185', md: 'w342', lg: 'w500', xl: 'w780' } as const;
const REQUEST_TIMEOUT_MS = 9_000;

const TOKEN = import.meta.env.VITE_TMDB_TOKEN ?? '';
const KEY = import.meta.env.VITE_TMDB_KEY ?? '';

export const isTmdbConfigured = Boolean(TOKEN || KEY);

export function posterUrl(path: string | null, size: keyof typeof SIZES = 'lg'): string | null {
  if (!path) return null;
  return `${IMAGE_BASE}${SIZES[size]}${path}`;
}

export function backdropUrl(path: string | null): string | null {
  if (!path) return null;
  return `${IMAGE_BASE}${SIZES.xl}${path}`;
}

/** Public TMDB page for a title — used by the "check before you watch" detail view. */
export function tmdbDetailsUrl(id: number, tmdbType: 'movie' | 'tv'): string {
  return `https://www.themoviedb.org/${tmdbType}/${id}`;
}

// Session-lifetime cache, keyed by the fully-built request URL. TMDB data
// for a given id/query is effectively static for the length of one visit
// (a title's cast, ratings, and similar-titles list don't change minute
// to minute), and several flows can request the exact same URL more than
// once — reopening a detail modal, retyping a search query you already
// ran, switching back to a title you just viewed. `inflight` also
// collapses concurrent duplicate requests (e.g. two UI elements both
// asking for the same title's watch providers on the same render) into
// one network call instead of two.
const responseCache = new Map<string, unknown>();
const inflight = new Map<string, Promise<unknown>>();
const CACHE_MAX = 300; // bounds memory on a very long session; oldest entries drop first

/**
 * Fetches with a hard timeout and one retry. Mobile networks in particular
 * stall requests far more often than they hard-fail them — without a
 * timeout, a single slow request could leave the results screen hanging
 * indefinitely even though five other requests already came back fine.
 */
async function tmdbFetch<T>(path: string, params: Record<string, string> = {}, signal?: AbortSignal): Promise<T> {
  const url = new URL(`${API_BASE}${path}`);
  for (const [k, v] of Object.entries(params)) url.searchParams.set(k, v);
  if (!TOKEN && KEY) url.searchParams.set('api_key', KEY);
  const cacheKey = url.toString();

  const cached = responseCache.get(cacheKey);
  if (cached !== undefined) return cached as T;

  // A cancellable request (live search-as-you-type) must not be shared
  // with other callers — aborting it would cancel theirs too — so it
  // skips the in-flight dedupe, though its result still lands in the cache.
  let result: T;
  if (signal) {
    result = await tmdbFetchUncached<T>(cacheKey, signal);
  } else {
    const existing = inflight.get(cacheKey);
    if (existing) return existing as Promise<T>;
    const promise = tmdbFetchUncached<T>(cacheKey).finally(() => inflight.delete(cacheKey));
    inflight.set(cacheKey, promise);
    result = await promise;
  }
  if (responseCache.size >= CACHE_MAX) {
    const oldest = responseCache.keys().next().value;
    if (oldest !== undefined) responseCache.delete(oldest);
  }
  responseCache.set(cacheKey, result);
  return result;
}

async function tmdbFetchUncached<T>(url: string, signal?: AbortSignal): Promise<T> {
  let lastErr: unknown;
  for (let attempt = 0; attempt < 2; attempt++) {
    if (signal?.aborted) throw new DOMException('Aborted', 'AbortError');
    const controller = new AbortController();
    const onOuterAbort = () => controller.abort();
    signal?.addEventListener('abort', onOuterAbort, { once: true });
    const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
    try {
      const res = await fetch(url, {
        headers: TOKEN ? { Authorization: `Bearer ${TOKEN}` } : {},
        signal: controller.signal,
      });
      clearTimeout(timer);
      signal?.removeEventListener('abort', onOuterAbort);
      if (!res.ok) throw new Error(`TMDB ${res.status}: ${url}`);
      return (await res.json()) as T;
    } catch (err) {
      clearTimeout(timer);
      signal?.removeEventListener('abort', onOuterAbort);
      if (signal?.aborted) throw new DOMException('Aborted', 'AbortError'); // never retry a cancelled request
      lastErr = err;
    }
  }
  throw lastErr instanceof Error ? lastErr : new Error(`TMDB request failed: ${url}`);
}

// ── Genre mapping ────────────────────────────────────────────────────────
// TMDB genre ids differ slightly between movie and tv. We map both onto our
// small internal vocabulary so quiz answers can filter either. Genre 16
// (Animation, same id on both movie and tv) is handled separately below
// since which internal tag it becomes — anime vs. cartoon — depends on
// original language, not the id alone.
const MOVIE_GENRE_MAP: Record<number, Genre> = {
  53: 'thriller', 9648: 'thriller',
  35: 'comedy',
  18: 'drama',
  878: 'scifi', 14: 'scifi',
  27: 'horror',
  12: 'adventure', 28: 'adventure', 10752: 'adventure',
};

const TV_GENRE_MAP: Record<number, Genre> = {
  9648: 'thriller', 80: 'thriller',
  35: 'comedy',
  18: 'drama',
  10765: 'scifi',
  27: 'horror',
  10759: 'adventure',
};

const ANIMATION_GENRE_ID = 16;
const TV_COMEDY_GENRE_ID = 35;

// Reverse lookup for building TMDB `with_genres` discover filters.
const GENRE_TO_TMDB_MOVIE: Record<Genre, number> = {
  thriller: 53, comedy: 35, drama: 18, scifi: 878, horror: 27, adventure: 12,
  anime: ANIMATION_GENRE_ID, cartoon: ANIMATION_GENRE_ID, sitcom: TV_COMEDY_GENRE_ID,
};
const GENRE_TO_TMDB_TV: Record<Genre, number> = {
  thriller: 9648, comedy: 35, drama: 18, scifi: 10765, horror: 27, adventure: 10759,
  anime: ANIMATION_GENRE_ID, cartoon: ANIMATION_GENRE_ID, sitcom: TV_COMEDY_GENRE_ID,
};

function mapGenres(ids: number[], type: 'movie' | 'tv', originalLanguage: string): Genre[] {
  const map = type === 'movie' ? MOVIE_GENRE_MAP : TV_GENRE_MAP;
  const out = new Set<Genre>();
  for (const id of ids) {
    if (id === ANIMATION_GENRE_ID) {
      out.add(originalLanguage === 'ja' ? 'anime' : 'cartoon');
      continue;
    }
    if (type === 'tv' && id === TV_COMEDY_GENRE_ID) {
      out.add('comedy');
      out.add('sitcom');
      continue;
    }
    const g = map[id];
    if (g) out.add(g);
  }
  return [...out];
}

// Vibe is inferred (TMDB has no direct equivalent) from genre combinations
// and vote average, so every item still gets a usable vibe signal.
function inferVibe(genres: Genre[], voteAverage: number, popularity: number): Vibe[] {
  const out = new Set<Vibe>();
  if (genres.includes('horror') || genres.includes('thriller')) out.add('dark');
  if (genres.includes('comedy') || genres.includes('sitcom')) out.add('light');
  if (genres.includes('drama') && voteAverage >= 7.5) out.add('intellectual');
  if (genres.includes('comedy') || genres.includes('sitcom') || (genres.includes('drama') && voteAverage >= 7)) {
    out.add('feelgood');
  }
  if (genres.includes('adventure') || genres.includes('scifi') || genres.includes('anime')) out.add('epic');
  if (genres.includes('cartoon')) out.add('light');
  if (out.size === 0) out.add(voteAverage >= 7.5 ? 'intellectual' : 'light');
  void popularity;
  return [...out];
}

function classifyEra(year: number): Era {
  if (year < 2000) return 'classic';
  if (year < 2016) return 'mid';
  return 'recent';
}

interface TmdbRawResult {
  id: number;
  title?: string;
  name?: string;
  release_date?: string;
  first_air_date?: string;
  poster_path: string | null;
  backdrop_path: string | null;
  genre_ids: number[];
  original_language: string;
  vote_average: number;
  vote_count: number;
  popularity: number;
  overview: string;
}

function toCatalogItem(raw: TmdbRawResult, tmdbType: 'movie' | 'tv'): CatalogItem | null {
  const title = raw.title ?? raw.name;
  const dateStr = raw.release_date ?? raw.first_air_date;
  if (!title || !dateStr) return null;
  const year = Number(dateStr.slice(0, 4));
  if (!year) return null;

  const genres = mapGenres(raw.genre_ids ?? [], tmdbType, raw.original_language);
  return {
    id: raw.id,
    title,
    year,
    type: tmdbType === 'movie' ? 'movie' : 'series',
    tmdbType,
    posterPath: raw.poster_path,
    backdropPath: raw.backdrop_path,
    genreIds: raw.genre_ids ?? [],
    genres,
    vibe: inferVibe(genres, raw.vote_average, raw.popularity),
    language: raw.original_language,
    era: classifyEra(year),
    voteAverage: raw.vote_average,
    voteCount: raw.vote_count,
    popularity: raw.popularity,
    overview: raw.overview,
  };
}

export interface DiscoverFilters {
  mood?: Genre;
  vibe?: Vibe;
  era?: Era;
  format?: Format;
  language?: Language;
  contentType?: ContentType;
}

/** Genre ids implied by contentType, on top of whatever `mood` already set.
 * Combined with mood's id via AND (TMDB's comma-joined `with_genres`) — e.g.
 * mood=comedy + contentType=cartoon asks for animated comedies specifically,
 * not just "anything animated OR anything funny". */
function contentTypeGenreId(contentType: ContentType | undefined): number | null {
  if (contentType === 'anime' || contentType === 'cartoon') return ANIMATION_GENRE_ID;
  if (contentType === 'sitcom') return TV_COMEDY_GENRE_ID;
  return null;
}

/**
 * Pulls a live candidate pool from TMDB across up to 3 pages per media type,
 * filtered server-side by genre/era/language where TMDB supports it. This is
 * the fix for "same recommendations every time" — the pool is now hundreds
 * of titles wide and actually shifts with the quiz answers, instead of a
 * fixed 30-item array re-sorted in place.
 *
 * `pageOffset` shifts the page window forward (e.g. offset 3 pulls pages
 * 4-6 instead of 1-3) so "show me different picks" can pull a genuinely
 * new batch from TMDB instead of re-sorting the same candidates.
 */
export async function discoverCandidates(
  filters: DiscoverFilters,
  pageOffset = 0
): Promise<CatalogItem[]> {
  // Sitcom is inherently a TV concept — force series-only regardless of the
  // quiz's format answer rather than wasting a request on "sitcom movies".
  // This also resolves the contradictory "movie + sitcom" combination: the
  // content type wins over the format, so it becomes series-only instead of
  // producing an empty job list (and a bogus "No matches").
  const sitcomOnly = filters.contentType === 'sitcom';
  const wantMovies = filters.format !== 'series' && !sitcomOnly;
  const wantSeries = sitcomOnly || filters.format !== 'movie';

  const eraRange: Record<Era, [string, string] | null> = {
    classic: ['1900-01-01', '1999-12-31'],
    mid: ['2000-01-01', '2015-12-31'],
    recent: ['2016-01-01', new Date().toISOString().slice(0, 10)],
    any: null,
  };

  const extraGenreId = contentTypeGenreId(filters.contentType);

  const jobs: Promise<DiscoverPagesResult>[] = [];

  if (wantMovies) {
    const params: Record<string, string> = {
      sort_by: 'popularity.desc',
      'vote_count.gte': '150',
      include_adult: 'false',
    };
    const genreIds = new Set<number>();
    if (filters.mood) genreIds.add(GENRE_TO_TMDB_MOVIE[filters.mood]);
    if (extraGenreId) genreIds.add(extraGenreId);
    if (genreIds.size) params.with_genres = [...genreIds].join(',');

    const range = filters.era ? eraRange[filters.era] : null;
    if (range) {
      params['primary_release_date.gte'] = range[0];
      params['primary_release_date.lte'] = range[1];
    }
    if (filters.contentType === 'anime') params.with_original_language = 'ja';
    else if (filters.language === 'english') params.with_original_language = 'en';

    jobs.push(fetchDiscoverPages('/discover/movie', params, 'movie', pageOffset));
  }

  if (wantSeries) {
    const params: Record<string, string> = {
      sort_by: 'popularity.desc',
      'vote_count.gte': '100',
      include_adult: 'false',
    };
    const genreIds = new Set<number>();
    if (filters.mood) genreIds.add(GENRE_TO_TMDB_TV[filters.mood]);
    if (extraGenreId) genreIds.add(extraGenreId);
    if (genreIds.size) params.with_genres = [...genreIds].join(',');

    const range = filters.era ? eraRange[filters.era] : null;
    if (range) {
      params['first_air_date.gte'] = range[0];
      params['first_air_date.lte'] = range[1];
    }
    if (filters.contentType === 'anime') params.with_original_language = 'ja';
    else if (filters.language === 'english') params.with_original_language = 'en';

    jobs.push(fetchDiscoverPages('/discover/tv', params, 'tv', pageOffset));
  }

  const results = await Promise.all(jobs);
  const failed = results.reduce((n, r) => n + r.failedPages, 0);
  const total = results.reduce((n, r) => n + r.totalPages, 0);
  // Every page failing is an outage (network/auth/rate limit), not "no
  // matches" — surface it so the UI can offer a retry instead of lying.
  if (total > 0 && failed === total) throw new TmdbUnavailableError();
  return results.flatMap((r) => r.items);
}

/** Cap for the landing gallery — a decorative showcase, not a catalog. */
const SHOWCASE_MAX = 8;

/**
 * A small, popularity-ordered set of titles for the landing-page gallery.
 *
 * Deliberately NOT `discoverCandidates()`: that pipeline pulls several pages
 * per media type to feed the scoring engine, which is far more traffic than
 * a decorative carousel needs. This makes exactly one request per media type
 * (two total), through the same `tmdbFetch` so auth, timeout, retry and the
 * session cache behave identically.
 *
 * These are *popular* titles, not recommendations — nothing here is scored
 * against anyone's taste, and callers must not present it as personalised.
 *
 * Only titles with a poster are returned (it is a visual gallery). Movies and
 * series are balanced (up to four each, topped up from the other type if one
 * runs short) and interleaved so the deck alternates; within each type the
 * order is TMDB popularity. A title with a backdrop is preferred over a
 * poster-only one when there is a choice, but poster-only is still allowed.
 *
 * Pass a signal to cancel on navigation; an abort rejects with `AbortError`.
 * Rejects with `TmdbUnavailableError` only if *both* requests fail.
 */
export async function getLandingShowcase(signal?: AbortSignal): Promise<CatalogItem[]> {
  const base = { sort_by: 'popularity.desc', include_adult: 'false', page: '1' };
  const load = (path: string, voteCount: string, type: 'movie' | 'tv'): Promise<CatalogItem[] | null> =>
    tmdbFetch<{ results?: TmdbRawResult[] }>(path, { ...base, 'vote_count.gte': voteCount }, signal).then(
      (page) => {
        const items: CatalogItem[] = [];
        for (const raw of page.results ?? []) {
          const item = toCatalogItem(raw, type);
          if (item) items.push(item);
        }
        return items;
      },
      (err: unknown) => {
        if (signal?.aborted) throw err; // a cancelled load is not a "failure" — let it propagate
        return null;
      }
    );

  const [movies, shows] = await Promise.all([load('/discover/movie', '150', 'movie'), load('/discover/tv', '100', 'tv')]);
  if (movies === null && shows === null) throw new TmdbUnavailableError();

  const seen = new Set<string>();
  const usable = (list: CatalogItem[] | null): CatalogItem[] =>
    (list ?? [])
      .filter((item) => {
        const key = `${item.tmdbType}:${item.id}`;
        if (!item.posterPath || seen.has(key)) return false;
        seen.add(key);
        return true;
      })
      .sort((a, b) => b.popularity - a.popularity);

  const pools = [usable(movies), usable(shows)];
  // Each type's pool: backdrop-having titles first (stable, so popularity
  // order survives inside each group), poster-only titles as the fallback.
  const ranked = pools.map((pool) => [...pool.filter((i) => i.backdropPath), ...pool.filter((i) => !i.backdropPath)]);

  const picked: CatalogItem[][] = [[], []];
  const quota = SHOWCASE_MAX / 2;
  for (let t = 0; t < 2; t++) picked[t] = ranked[t]!.slice(0, quota);
  // Top up from whichever type still has spare titles if the other fell short.
  for (let t = 0; t < 2; t++) {
    const other = 1 - t;
    const spare = ranked[other]!.slice(picked[other]!.length);
    picked[other] = [...picked[other]!, ...spare.slice(0, Math.max(0, quota - picked[t]!.length))];
  }

  // Interleave, leading with whichever type holds the single most popular title.
  const lead = (picked[0]![0]?.popularity ?? -1) >= (picked[1]![0]?.popularity ?? -1) ? 0 : 1;
  const a = picked[lead]!.sort((x, y) => y.popularity - x.popularity);
  const b = picked[1 - lead]!.sort((x, y) => y.popularity - x.popularity);
  const out: CatalogItem[] = [];
  for (let i = 0; i < Math.max(a.length, b.length) && out.length < SHOWCASE_MAX; i++) {
    if (a[i]) out.push(a[i]!);
    if (b[i] && out.length < SHOWCASE_MAX) out.push(b[i]!);
  }
  return out;
}

/** Thrown when every TMDB request for a discovery pass failed. */
export class TmdbUnavailableError extends Error {
  constructor() {
    super('TMDB is unreachable right now.');
    this.name = 'TmdbUnavailableError';
  }
}

interface DiscoverPagesResult {
  items: CatalogItem[];
  failedPages: number;
  totalPages: number;
}

async function fetchDiscoverPages(
  path: string,
  params: Record<string, string>,
  tmdbType: 'movie' | 'tv',
  pageOffset = 0
): Promise<DiscoverPagesResult> {
  const pageNumbers = [1, 2, 3];
  let failedPages = 0;
  const pages = await Promise.all(
    pageNumbers.map((page) =>
      tmdbFetch<{ results: TmdbRawResult[] }>(path, { ...params, page: String(page + pageOffset) }).catch(() => {
        failedPages++;
        return { results: [] as TmdbRawResult[] };
      })
    )
  );
  const items: CatalogItem[] = [];
  for (const page of pages) {
    for (const raw of page.results) {
      const item = toCatalogItem(raw, tmdbType);
      if (item) items.push(item);
    }
  }
  return { items, failedPages, totalPages: pageNumbers.length };
}

/** Used by the rating step to resolve a small, well-known seed list to live posters/ids. */
export async function searchTitle(
  title: string,
  tmdbType: 'movie' | 'tv',
  year?: number
): Promise<{ id: number; posterPath: string | null } | null> {
  const path = tmdbType === 'movie' ? '/search/movie' : '/search/tv';
  const params: Record<string, string> = { query: title };
  if (year) params[tmdbType === 'movie' ? 'year' : 'first_air_date_year'] = String(year);
  const data = await tmdbFetch<{ results: TmdbRawResult[] }>(path, params);
  // With a year supplied, prefer a result whose date actually matches so a
  // remake/namesake doesn't win just by being listed first.
  const dated = (r: TmdbRawResult) => Number((r.release_date ?? r.first_air_date ?? '').slice(0, 4));
  const first = (year ? data.results.find((r) => dated(r) === year) : undefined) ?? data.results[0];
  if (!first) return null;
  return { id: first.id, posterPath: first.poster_path };
}

/**
 * Resolves one title (+ release year) to a full CatalogItem — used by the
 * Letterboxd import, where title-only matching picks the wrong remake.
 * Tries the requested type first, and when the year is known only accepts
 * a result whose date is within a year of it (exports and TMDB sometimes
 * disagree by one year across regional release dates).
 */
export async function findCatalogItem(title: string, year: number, signal?: AbortSignal): Promise<CatalogItem | null> {
  const search = async (filterYear?: number): Promise<CatalogItem[]> => {
    const params: Record<string, string> = { query: title, include_adult: 'false' };
    if (filterYear) params.year = String(filterYear);
    const data = await tmdbFetch<{ results: TmdbRawResult[] }>('/search/movie', params, signal);
    // The whole page (up to 20), not just the first few: for a title with
    // many namesakes the right one can sit well down the relevance order.
    return data.results.map((raw) => toCatalogItem(raw, 'movie')).filter((item): item is CatalogItem => item !== null);
  };

  const closest = (items: CatalogItem[]): CatalogItem | null => {
    let best: CatalogItem | null = null;
    let bestDiff = Infinity;
    for (const item of items) {
      const diff = Math.abs(item.year - year);
      if (diff <= 1 && diff < bestDiff) {
        best = item;
        bestDiff = diff;
      }
    }
    return best;
  };

  if (!year) return (await search())[0] ?? null;

  // 1. Ask TMDB to narrow to the stated year — this surfaces an exact
  //    title+year match even among many namesakes.
  const exact = (await search(year)).find((i) => i.year === year);
  if (exact) return exact;

  // 2. Unfiltered, for a film TMDB dates a year off from Letterboxd.
  const loose = closest(await search());
  if (loose) return loose;

  // 3. Last resort: the adjacent years, filtered, so a namesake-heavy
  //    title that is off by one is still found. Closest year wins; ties
  //    keep the earlier-year-first order.
  //    One search failing must not discard the other's result.
  const settled = await Promise.allSettled([search(year - 1), search(year + 1)]);
  const found = settled.flatMap((r) => (r.status === 'fulfilled' ? r.value : []));
  const failure = settled.find((r): r is PromiseRejectedResult => r.status === 'rejected');
  // Both failed: surface the error. One failed: use what the other found.
  if (failure && settled.every((r) => r.status === 'rejected')) throw failure.reason;
  return closest(found);
}

interface TmdbMultiSearchRaw extends TmdbRawResult {
  media_type: 'movie' | 'tv' | 'person';
}

/**
 * Free-text search across movies and TV in one call, for the "search a
 * title" screen. Filters out `person` results (TMDB's /search/multi mixes
 * actors/directors into the same endpoint) and anything with too few
 * votes to be a meaningful search match, but keeps the threshold low
 * (unlike discoverCandidates' 100-150) since a direct name search should
 * still surface a title the user is specifically looking for even if
 * it's obscure.
 */
export async function searchMulti(query: string, signal?: AbortSignal): Promise<CatalogItem[]> {
  const trimmed = query.trim();
  if (!trimmed) return [];
  const data = await tmdbFetch<{ results: TmdbMultiSearchRaw[] }>(
    '/search/multi',
    { query: trimmed, include_adult: 'false' },
    signal
  );
  const items: CatalogItem[] = [];
  for (const raw of data.results) {
    if (raw.media_type !== 'movie' && raw.media_type !== 'tv') continue;
    const item = toCatalogItem(raw, raw.media_type);
    if (item) items.push(item);
  }
  return items;
}

/**
 * "People don't have the same taste every time" — rather than run a
 * single title through our own quiz-calibrated genre/vibe engine (which
 * is tuned for *this user's* stated preferences, not for "what's
 * actually similar to this specific title"), this defers to TMDB's own
 * similarity data: /recommendations (collaborative-filtering — what
 * users who engaged with this title also engaged with) merged with
 * /similar (genre/keyword/cast overlap) as a fallback for when
 * recommendations is thin, which it often is for less mainstream titles.
 * Deduped, with the source title itself excluded.
 */
export async function getSimilarTitles(id: number, tmdbType: 'movie' | 'tv'): Promise<CatalogItem[]> {
  let failures = 0;
  const soft = () => {
    failures++;
    return { results: [] as TmdbRawResult[] };
  };
  const [recs, similar] = await Promise.all([
    tmdbFetch<{ results: TmdbRawResult[] }>(`/${tmdbType}/${id}/recommendations`, {}).catch(soft),
    tmdbFetch<{ results: TmdbRawResult[] }>(`/${tmdbType}/${id}/similar`, {}).catch(soft),
  ]);
  // Both sources failing is an outage, not "TMDB has nothing similar" —
  // callers can tell the two apart and offer a retry for the former.
  if (failures === 2) throw new TmdbUnavailableError();

  const seen = new Set<number>([id]);
  const items: CatalogItem[] = [];
  // Recommendations first — it's the stronger signal — similar only fills gaps.
  for (const raw of [...recs.results, ...similar.results]) {
    if (seen.has(raw.id)) continue;
    seen.add(raw.id);
    const item = toCatalogItem(raw, tmdbType);
    if (item) items.push(item);
  }
  return items;
}

export interface WatchProvider {
  name: string;
  logoPath: string | null;
}

export interface WatchProviders {
  region: string;
  /** Set when the requested region had no data and `region` is a fallback. */
  fallbackFrom?: string;
  link: string | null;
  stream: WatchProvider[];
  rent: WatchProvider[];
  buy: WatchProvider[];
}

interface TmdbWatchProviderRaw {
  provider_name: string;
  logo_path: string | null;
}

interface TmdbWatchProvidersRaw {
  link: string;
  flatrate?: TmdbWatchProviderRaw[];
  rent?: TmdbWatchProviderRaw[];
  buy?: TmdbWatchProviderRaw[];
}

/**
 * TMDB's /watch/providers is powered by JustWatch and is region-locked —
 * results genuinely differ by country because of licensing. The region
 * used is whatever `region.ts`'s getRegion() currently resolves to: a
 * manual pick from the region selector if the user has made one, else a
 * guess from the browser's locale (e.g. "en-US" → "US"), falling back to
 * US, the largest single dataset. Availability data is provided by
 * JustWatch via TMDB, not guaranteed complete or current — always paired
 * with a "check {provider}" link, never presented as a standalone
 * purchase/play action.
 */
export async function getWatchProviders(id: number, tmdbType: 'movie' | 'tv'): Promise<WatchProviders | null> {
  const region = getRegion();
  try {
    const data = await tmdbFetch<{ results: Record<string, TmdbWatchProvidersRaw> }>(
      `/${tmdbType}/${id}/watch/providers`,
      {}
    );
    const entry = data.results[region] ?? data.results.US;
    if (!entry) return null;
    const toList = (arr?: TmdbWatchProviderRaw[]): WatchProvider[] =>
      (arr ?? []).map((p) => ({ name: p.provider_name, logoPath: p.logo_path }));
    return {
      region: data.results[region] ? region : 'US',
      // Set when the chosen region had no entry and we fell back to US, so
      // the UI can say so instead of silently showing another market.
      fallbackFrom: data.results[region] ? undefined : region,
      link: entry.link ?? null,
      stream: toList(entry.flatrate),
      rent: toList(entry.rent),
      buy: toList(entry.buy),
    };
  } catch {
    return null;
  }
}

export function providerLogoUrl(logoPath: string | null): string | null {
  if (!logoPath) return null;
  return `${IMAGE_BASE}w92${logoPath}`;
}

export function personImageUrl(profilePath: string | null): string | null {
  if (!profilePath) return null;
  return `${IMAGE_BASE}w185${profilePath}`;
}

interface TmdbPersonSearchRaw {
  id: number;
  name: string;
  profile_path: string | null;
  known_for_department: string;
  known_for?: { title?: string; name?: string }[];
}

/** Search for a person (actor, director, etc.) by name. Kept separate
 * from searchMulti() rather than folded in — a title search and a
 * person search want different follow-up actions (similar titles vs. a
 * filmography), so the search screen treats them as parallel result
 * lists rather than one merged, type-ambiguous list. */
export async function searchPeople(query: string, signal?: AbortSignal): Promise<PersonSummary[]> {
  const trimmed = query.trim();
  if (!trimmed) return [];
  const data = await tmdbFetch<{ results: TmdbPersonSearchRaw[] }>(
    '/search/person',
    { query: trimmed, include_adult: 'false' },
    signal
  );
  return data.results
    .filter((p) => p.known_for_department) // filters out near-empty/junk entries
    .map((p) => {
      const knownFor = (Array.isArray(p.known_for) ? p.known_for : [])
        .map((k) => (typeof k.title === 'string' ? k.title : typeof k.name === 'string' ? k.name : ''))
        .filter(Boolean)
        .slice(0, 3);
      return { id: p.id, name: p.name, profilePath: p.profile_path, knownForDepartment: p.known_for_department, ...(knownFor.length ? { knownFor } : {}) };
    });
}

interface TmdbCastRaw {
  id: number;
  name: string;
  character: string;
  profile_path: string | null;
  order: number;
}
interface TmdbCrewRaw {
  id: number;
  name: string;
  job: string;
  profile_path: string | null;
}
interface TmdbCreatedByRaw {
  id: number;
  name: string;
  profile_path: string | null;
}

/**
 * Cast + director(s)/creator(s) for one title. Movies carry directors in
 * the crew list (job === 'Director'); TV shows put creators in a
 * separate top-level `created_by` field instead — TMDB's schema
 * genuinely differs here, not an oversight, so both are checked.
 */
export async function getCredits(id: number, tmdbType: 'movie' | 'tv'): Promise<Credits> {
  const data = await tmdbFetch<{
    cast: TmdbCastRaw[];
    crew: TmdbCrewRaw[];
    created_by?: TmdbCreatedByRaw[];
  }>(`/${tmdbType}/${id}/credits`, {});

  const cast: CastMember[] = [...data.cast]
    .sort((a, b) => a.order - b.order)
    .slice(0, 12)
    .map((c) => ({ id: c.id, name: c.name, character: c.character, profilePath: c.profile_path }));

  const directors: CrewMember[] =
    tmdbType === 'movie'
      ? data.crew
          .filter((c) => c.job === 'Director')
          .map((c) => ({ id: c.id, name: c.name, job: 'Director', profilePath: c.profile_path }))
      : (data.created_by ?? []).map((c) => ({ id: c.id, name: c.name, job: 'Creator', profilePath: c.profile_path }));

  return { cast, directors };
}

interface TmdbPersonDetailsRaw {
  id: number;
  name: string;
  profile_path: string | null;
  known_for_department: string;
  biography: string;
  birthday: string | null;
  place_of_birth: string | null;
}

interface TmdbCombinedCreditRaw extends TmdbRawResult {
  media_type: 'movie' | 'tv';
}

export async function getPersonDetails(id: number): Promise<PersonDetails> {
  const p = await tmdbFetch<TmdbPersonDetailsRaw>(`/person/${id}`, {});
  return {
    id: p.id,
    name: p.name,
    profilePath: p.profile_path,
    knownForDepartment: p.known_for_department,
    biography: p.biography,
    birthday: p.birthday,
    placeOfBirth: p.place_of_birth,
  };
}

interface TmdbDetailsRaw extends Omit<TmdbRawResult, 'genre_ids'> {
  genres: { id: number; name: string }[];
}

/** Resolves a bare (id, tmdbType) to a full CatalogItem — needed when
 * navigation only carries an id, e.g. jumping to a title from a person's
 * filmography or a "pending search target" set by another screen.
 * /movie/{id} and /tv/{id} return `genres` as {id,name} objects rather
 * than the bare id array /discover and /search return, so this adapts
 * that shape before reusing the same toCatalogItem() mapper. */
export async function getTitleDetails(id: number, tmdbType: 'movie' | 'tv'): Promise<CatalogItem | null> {
  const raw = await tmdbFetch<TmdbDetailsRaw>(`/${tmdbType}/${id}`, {});
  return toCatalogItem({ ...raw, genre_ids: raw.genres.map((g) => g.id) }, tmdbType);
}

/**
 * A person's best-known work, for the "best movies & shows" section of
 * their page — ranked by vote average with a vote-count floor (so a
 * one-review 9.8 short film doesn't outrank a broadly-loved title), the
 * same reasoning discoverCandidates() already applies elsewhere.
 */
export async function getPersonBestWork(id: number, limit = 12): Promise<CatalogItem[]> {
  const data = await tmdbFetch<{ cast: TmdbCombinedCreditRaw[]; crew: TmdbCombinedCreditRaw[] }>(
    `/person/${id}/combined_credits`,
    {}
  );
  const seen = new Set<number>();
  const items: CatalogItem[] = [];
  for (const raw of [...data.cast, ...data.crew]) {
    if (seen.has(raw.id) || raw.vote_count < 50) continue;
    seen.add(raw.id);
    const item = toCatalogItem(raw, raw.media_type);
    if (item) items.push(item);
  }
  return items.sort((a, b) => b.voteAverage - a.voteAverage).slice(0, limit);
}
