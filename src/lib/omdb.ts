// src/lib/omdb.ts
//
// Optional secondary connector. TMDB gives us the catalog; OMDb (free key at
// omdbapi.com/apikey.aspx) adds Rotten Tomatoes / Metacritic / IMDb scores
// as an extra quality signal. Entirely optional — every call fails soft.

import type { ExternalRatings } from './types';

const KEY = import.meta.env.VITE_OMDB_KEY ?? '';

export const isOmdbConfigured = Boolean(KEY);

const OMDB_TIMEOUT_MS = 3500;

const cache = new Map<string, ExternalRatings | null>();

export async function fetchExternalRatings(
  title: string,
  year: number
): Promise<ExternalRatings | null> {
  if (!KEY) return null;

  const cacheKey = `${title}:${year}`;
  if (cache.has(cacheKey)) return cache.get(cacheKey) ?? null;

  try {
    const url = new URL('https://www.omdbapi.com/');
    url.searchParams.set('apikey', KEY);
    url.searchParams.set('t', title);
    url.searchParams.set('y', String(year));

    // A hung request must never hold the results screen hostage.
    const res = await fetch(url.toString(), { signal: AbortSignal.timeout(OMDB_TIMEOUT_MS) });
    if (!res.ok) throw new Error(`OMDb ${res.status}`);
    const data = (await res.json()) as {
      Response: string;
      imdbRating?: string;
      Metascore?: string;
      Ratings?: { Source: string; Value: string }[];
    };
    if (data.Response !== 'True') {
      cache.set(cacheKey, null);
      return null;
    }

    const parseFinite = (raw: string | undefined): number | undefined => {
      if (!raw || raw === 'N/A') return undefined;
      const n = Number(raw);
      return Number.isFinite(n) ? n : undefined;
    };
    const rt = data.Ratings?.find((r) => r.Source === 'Rotten Tomatoes')?.Value;
    const result: ExternalRatings = {
      imdbRating: parseFinite(data.imdbRating),
      metacritic: parseFinite(data.Metascore),
      rottenTomatoes: parseFinite(rt?.replace('%', '')),
    };
    cache.set(cacheKey, result);
    return result;
  } catch {
    cache.set(cacheKey, null);
    return null;
  }
}
