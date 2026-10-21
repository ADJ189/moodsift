// src/lib/imdb.ts
//
// Import a personal IMDb ratings CSV (IMDb → Your Ratings → Export). Parsing
// only — no network calls, no dependency, no scraping. This is the user's OWN
// ratings file, which is a different thing from OMDb's public aggregate IMDb
// rating (omdb.ts).
//
// The original 1–10 value is preserved (`rawRating`); the engine's normalised
// 0.5–5 signal (`stars`) is derived from it at the import boundary, never
// written over it.

export interface ImdbRow {
  /** The `tt…` identifier from the export's "Const" column — preferred for matching. */
  imdbId: string;
  title: string;
  year: number;
  /** Whether TMDB should be asked for a TV show (true) or a movie (false). */
  tv: boolean;
  /** Exactly as exported: an integer 1–10. */
  rawRating: number;
  /** 0.5–5, half-star precision: rawRating / 2. */
  stars: number;
  /** 1–5 rounded form, matching the app's star UI. */
  rating: number;
}

export type ImportFormat = 'imdb' | 'letterboxd';

const IMDB_ID = /^tt\d{6,10}$/;

/** IMDb "Title Type" values we can match to a TMDB movie or TV show. Episodes,
 * video games and podcasts are deliberately skipped (no TMDB title to match). */
const MOVIE_TYPES = new Set(['movie', 'tv movie', 'tvmovie', 'tv special', 'tvspecial', 'short', 'video']);
const TV_TYPES = new Set(['tv series', 'tvseries', 'tv mini series', 'tv mini-series', 'tvminiseries']);

/** RFC 4180 parser: quoted fields may contain commas, doubled quotes and newlines. */
export function parseCsv(text: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let cur = '';
  let inQuotes = false;
  const src = text.replace(/^\uFEFF/, '');
  for (let i = 0; i < src.length; i++) {
    const ch = src[i]!;
    if (inQuotes) {
      if (ch === '"') {
        if (src[i + 1] === '"') {
          cur += '"';
          i++;
        } else inQuotes = false;
      } else cur += ch;
    } else if (ch === '"') inQuotes = true;
    else if (ch === ',') {
      row.push(cur);
      cur = '';
    } else if (ch === '\n' || ch === '\r') {
      if (ch === '\r' && src[i + 1] === '\n') i++;
      row.push(cur);
      cur = '';
      if (row.some((c) => c.trim() !== '')) rows.push(row);
      row = [];
    } else cur += ch;
  }
  row.push(cur);
  if (row.some((c) => c.trim() !== '')) rows.push(row);
  return rows;
}

/** Which service's export this is, judged by its header row, or null. */
export function detectImportFormat(text: string): ImportFormat | null {
  const header = parseCsv(text.slice(0, 4000))[0]?.map((h) => h.trim());
  if (!header) return null;
  if (header.includes('Const') && header.includes('Your Rating')) return 'imdb';
  if (header.includes('Name') && header.includes('Rating') && !header.includes('Const')) return 'letterboxd';
  return null;
}

export interface ImdbParseResult {
  rows: ImdbRow[];
  /** Rows that could not be used, by reason — shown to the person, never hidden. */
  skipped: { unsupportedType: number; invalidRating: number; invalidId: number };
}

export function parseImdbCsv(text: string): ImdbParseResult {
  const skipped = { unsupportedType: 0, invalidRating: 0, invalidId: 0 };
  const table = parseCsv(text);
  const header = table[0]?.map((h) => h.trim()) ?? [];
  const col = (name: string) => header.indexOf(name);
  const idIdx = col('Const');
  const ratingIdx = col('Your Rating');
  if (idIdx === -1 || ratingIdx === -1) return { rows: [], skipped };
  const titleIdx = col('Title');
  const yearIdx = col('Year');
  const typeIdx = col('Title Type');

  // One row per title: if a file lists a title twice, the later row wins, which
  // makes importing the same file twice (or an overlapping one) idempotent.
  const byId = new Map<string, ImdbRow>();
  for (const cols of table.slice(1)) {
    const imdbId = (cols[idIdx] ?? '').trim();
    if (!IMDB_ID.test(imdbId)) {
      skipped.invalidId++;
      continue;
    }
    const rawRating = Number((cols[ratingIdx] ?? '').trim());
    if (!Number.isInteger(rawRating) || rawRating < 1 || rawRating > 10) {
      skipped.invalidRating++;
      continue;
    }
    const type = (typeIdx === -1 ? 'movie' : (cols[typeIdx] ?? '').trim().toLowerCase()) || 'movie';
    const tv = TV_TYPES.has(type);
    if (!tv && !MOVIE_TYPES.has(type)) {
      skipped.unsupportedType++;
      continue;
    }
    const stars = Math.max(0.5, Math.min(5, rawRating / 2));
    byId.set(imdbId, {
      imdbId,
      title: ((titleIdx === -1 ? '' : cols[titleIdx]) ?? '').trim() || imdbId,
      year: yearIdx === -1 ? 0 : Number((cols[yearIdx] ?? '').trim()) || 0,
      tv,
      rawRating,
      stars,
      rating: Math.max(1, Math.min(5, Math.round(stars))),
    });
  }
  return { rows: [...byId.values()], skipped };
}
