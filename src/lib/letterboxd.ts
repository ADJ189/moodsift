// src/lib/letterboxd.ts
//
// Import a Letterboxd "ratings.csv" export (Settings → Data → Export) as a
// taste-calibration shortcut, so returning users don't have to re-rate
// titles by hand. Parsing only — no network calls, no dependency.

import { parseCsv } from './imdb';

export interface LetterboxdRow {
  title: string;
  year: number;
  /** 1-5, rounded — what the 5-star UI shows. */
  rating: number;
  /** The exact 0.5-5 value from the export; half-star precision is kept
   * so a 3.5 and a 4 don't collapse into the same taste signal. */
  stars: number;
}

export function parseLetterboxdCsv(csvText: string): LetterboxdRow[] {
  const table = parseCsv(csvText);
  if (table.length < 2) return [];

  const header = table[0] ?? [];
  const nameIdx = header.indexOf('Name');
  const yearIdx = header.indexOf('Year');
  const ratingIdx = header.indexOf('Rating');
  if (nameIdx === -1 || ratingIdx === -1) return [];

  const rows: LetterboxdRow[] = [];
  for (const cols of table.slice(1)) {
    const title = cols[nameIdx]?.trim();
    const rawRating = cols[ratingIdx]?.trim();
    if (!title || !rawRating) continue;

    const stars = Number(rawRating);
    if (!Number.isFinite(stars) || stars <= 0) continue;

    rows.push({
      title,
      year: yearIdx !== -1 ? Number(cols[yearIdx]) || 0 : 0,
      rating: Math.max(1, Math.min(5, Math.round(stars))),
      stars: Math.max(0.5, Math.min(5, stars)),
    });
  }
  return rows;
}
