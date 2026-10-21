// src/lib/profile.ts
//
// A local profile: an identity plus a history of everything the user has
// rated or saved, persisted to localStorage so it survives closing the
// tab. This is intentionally NOT an account system — there's no server,
// no password, nothing that syncs across devices. It's the honest version
// of "remembers you": a private, on-this-browser identity, framed as
// exactly that in the UI (see header.ts's profile popover).
//
// Two things this unlocks:
//   1. "Closing the tab doesn't forget everything" — ratings and a
//      watchlist persist across sessions.
//   2. The recommendation engine gets more to work with over time: every
//      title ever rated (not just this session's) is fed back into
//      engine.processResultRating() on every run, so a returning user's
//      very first batch is already informed by everything they've told
//      the app before, not a cold start every time.

import type { CatalogItem, Era, Genre, RatingValue, Vibe } from './types';
import { safeGet, safeRemove, safeSet, storageAccessible } from './storage';
import { decodeProfileRecord, encodeProfileRecord } from './profile-codec';
import { keyOf, type TmdbMediaType } from './media-key';

/** Anything with a TMDB id + media type identifies a title. */
type TitleRef = { id: number; tmdbType: TmdbMediaType };

// Storage keys. v2 holds the LZ-String-compressed record (profile-codec.ts);
// v1 is the legacy plain-JSON profile, read once for migration and removed
// only after the v2 copy has been written, read back and verified.
const KEY_V1 = 'cinematch.profile.v1';
const KEY_V2 = 'cinematch.profile.v2';
/** An unreadable v2 record is copied here before anything overwrites it. */
const KEY_UNREADABLE = 'cinematch.profile.v2.unreadable';
const KEY_MEMORY = 'cinematch.taste-memory:v1';
const MAX_HISTORY = 1000; // oldest entries drop off past this — plenty for scoring, bounded for storage

/** Where an imported rating came from. Imports without this field predate it and are Letterboxd. */
export type ImportProvider = 'letterboxd-csv' | 'imdb-csv';
const PROVIDERS: readonly ImportProvider[] = ['letterboxd-csv', 'imdb-csv'];

export interface HistoryEntry {
  id: number;
  tmdbType: 'movie' | 'tv';
  title: string;
  year: number;
  posterPath: string | null;
  genres: Genre[];
  vibe: Vibe[];
  language: string;
  era: Era;
  voteAverage: number;
  popularity: number;
  rating: RatingValue;
  /** Exact 0.5-5 rating when it came from an import (rating is its rounded 1-5 form). */
  stars?: number;
  ratedAt: number;
  source: 'calibration' | 'result' | 'import';
  /** Imports only: which file format produced this rating. */
  provider?: ImportProvider;
  /** Imports only: the rating exactly as the source stated it (e.g. 7 on a 10 scale)… */
  rawRating?: number;
  /** …and that source's scale maximum, so an export or audit never has to guess. */
  ratingScaleMax?: 5 | 10;
}

export interface WatchlistEntry {
  id: number;
  tmdbType: 'movie' | 'tv';
  title: string;
  year: number;
  posterPath: string | null;
  addedAt: number;
}

export interface LocalProfile {
  version: 1;
  id: string;
  displayName: string;
  avatarColor: string;
  /** Optional — when unset, the header falls back to the display name's
   * first letter (the original, simplest avatar). Picking one of
   * AVATAR_EMOJIS is entirely optional polish, never required. */
  avatarEmoji?: string;
  createdAt: number;
  lastVisitAt: number;
  history: HistoryEntry[];
  watchlist: WatchlistEntry[];
}

const AVATAR_COLORS = [
  '#a78bfa', '#22d3ee', '#f472b6', '#fbbf24', '#4ade80', '#f87171', '#60a5fa',
  '#c084fc', '#2dd4bf', '#fb923c', '#a3e635',
];
// A small, deliberately film-themed set rather than generic smileys —
// keeps the picker feeling like part of this app rather than a bolted-on
// generic avatar system.
export const AVATAR_EMOJIS = ['🎬', '🍿', '🎭', '👾', '🐉', '🚀', '🔮', '🕵️', '👻', '🦇', '🧙', '📼'];
const NAME_ADJECTIVES = ['Curious', 'Late-night', 'Weekend', 'Rainy-day', 'Popcorn', 'Marathon', 'Couch'];
const NAME_NOUNS = ['Viewer', 'Watcher', 'Cinephile', 'Binger', 'Critic'];

function randomId(): string {
  try {
    return crypto.randomUUID();
  } catch {
    return `local-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
  }
}

function randomName(): string {
  const adj = NAME_ADJECTIVES[Math.floor(Math.random() * NAME_ADJECTIVES.length)];
  const noun = NAME_NOUNS[Math.floor(Math.random() * NAME_NOUNS.length)];
  return `${adj} ${noun}`;
}

function freshProfile(): LocalProfile {
  const now = Date.now();
  return {
    version: 1,
    id: randomId(),
    displayName: randomName(),
    avatarColor: AVATAR_COLORS[Math.floor(Math.random() * AVATAR_COLORS.length)],
    createdAt: now,
    lastVisitAt: now,
    history: [],
    watchlist: [],
  };
}

const GENRE_VALUES = new Set(['thriller', 'comedy', 'drama', 'scifi', 'horror', 'adventure', 'anime', 'cartoon', 'sitcom']);
const ERA_VALUES = new Set(['classic', 'mid', 'recent', 'any']);

const isObj = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);
const num = (v: unknown, fallback = 0): number => (typeof v === 'number' && Number.isFinite(v) ? v : fallback);
const str = (v: unknown, fallback = ''): string => (typeof v === 'string' ? v : fallback);

/** Rebuilds a stored rating with bounded/defaulted fields and recognized import
 * metadata; returns null for an invalid id, media type or integer 1–5 rating. */
function sanitizeHistoryEntry(raw: unknown): HistoryEntry | null {
  if (!isObj(raw)) return null;
  const id = num(raw.id, -1);
  const rating = num(raw.rating, 0);
  const tmdbType = raw.tmdbType === 'tv' ? 'tv' : raw.tmdbType === 'movie' ? 'movie' : null;
  if (id < 0 || !tmdbType || !Number.isInteger(rating) || rating < 1 || rating > 5) return null;
  const list = (v: unknown, allowed: Set<string>) =>
    Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string' && allowed.has(x)) : [];
  return {
    id,
    tmdbType,
    title: str(raw.title, 'Untitled').slice(0, 200),
    year: num(raw.year),
    posterPath: typeof raw.posterPath === 'string' ? raw.posterPath : null,
    genres: list(raw.genres, GENRE_VALUES) as Genre[],
    vibe: list(raw.vibe, VIBE_VALUES) as Vibe[],
    language: str(raw.language, 'en').slice(0, 8),
    era: (ERA_VALUES.has(str(raw.era)) ? raw.era : 'any') as Era,
    voteAverage: num(raw.voteAverage),
    popularity: num(raw.popularity),
    rating: rating as RatingValue,
    stars: typeof raw.stars === 'number' && raw.stars >= 0.5 && raw.stars <= 5 ? raw.stars : undefined,
    ratedAt: num(raw.ratedAt, Date.now()),
    source: raw.source === 'calibration' ? 'calibration' : raw.source === 'import' ? 'import' : 'result',
    provider: PROVIDERS.includes(raw.provider as ImportProvider) ? (raw.provider as ImportProvider) : undefined,
    rawRating: typeof raw.rawRating === 'number' && raw.rawRating > 0 && raw.rawRating <= 10 ? raw.rawRating : undefined,
    ratingScaleMax: raw.ratingScaleMax === 5 || raw.ratingScaleMax === 10 ? raw.ratingScaleMax : undefined,
  };
}

function sanitizeWatchlistEntry(raw: unknown): WatchlistEntry | null {
  if (!isObj(raw)) return null;
  const id = num(raw.id, -1);
  const tmdbType = raw.tmdbType === 'tv' ? 'tv' : raw.tmdbType === 'movie' ? 'movie' : null;
  if (id < 0 || !tmdbType) return null;
  return {
    id,
    tmdbType,
    title: str(raw.title, 'Untitled').slice(0, 200),
    year: num(raw.year),
    posterPath: typeof raw.posterPath === 'string' ? raw.posterPath : null,
    addedAt: num(raw.addedAt, Date.now()),
  };
}

/** Version-checking alone trusts whatever JSON happens to be in storage.
 * This rebuilds the profile field by field so a corrupted or hand-edited
 * entry degrades to safe defaults (and drops only the bad rows) instead
 * of crashing a screen that assumed the shape was right. */
function sanitizeProfile(raw: unknown): LocalProfile | null {
  if (!isObj(raw) || raw.version !== 1) return null;
  const base = freshProfile();
  const history = Array.isArray(raw.history)
    ? raw.history.map(sanitizeHistoryEntry).filter((h): h is HistoryEntry => h !== null)
    : [];
  const watchlist = Array.isArray(raw.watchlist)
    ? raw.watchlist.map(sanitizeWatchlistEntry).filter((w): w is WatchlistEntry => w !== null)
    : [];
  const emoji = typeof raw.avatarEmoji === 'string' && AVATAR_EMOJIS.includes(raw.avatarEmoji) ? raw.avatarEmoji : undefined;
  // Collapse exact duplicates (same media type + id), keeping the newest.
  const dedupe = <T extends { id: number; tmdbType: TmdbMediaType }>(rows: T[]): T[] => {
    const m = new Map<string, T>();
    for (const r of rows) m.set(keyOf(r), r);
    return [...m.values()];
  };
  return {
    version: 1,
    id: str(raw.id) || base.id,
    displayName: str(raw.displayName).trim().slice(0, 40) || base.displayName,
    avatarColor: /^#[0-9a-fA-F]{6}$/.test(str(raw.avatarColor)) ? str(raw.avatarColor) : base.avatarColor,
    avatarEmoji: emoji,
    createdAt: num(raw.createdAt, base.createdAt),
    lastVisitAt: num(raw.lastVisitAt, base.lastVisitAt),
    history: dedupe(history).slice(-MAX_HISTORY),
    watchlist: dedupe(watchlist),
  };
}

// ── persistence ─────────────────────────────────────────────────────────
//
// ONE write path (writeProfile) serialises → compresses → stores, and its
// result is what the UI reports. Storage can be blocked entirely (private
// browsing) or full; both degrade to session-only behaviour without crashing,
// and the status says so honestly instead of assuming the last change saved.

interface Loaded {
  profile: LocalProfile | null;
  source: 'v2' | 'v1' | 'none';
  issue: string | null;
}

/** Parses and sanitizes profile JSON, returning null on parsing or sanitization failure. */
function parseProfileText(json: string): LocalProfile | null {
  try {
    return sanitizeProfile(JSON.parse(json));
  } catch {
    return null;
  }
}

/** Prefers readable v2 storage, then legacy v1, returning its source and any
 * load issue. Saves unreadable v2 data aside unless an identical copy exists;
 * if copying fails, blocks v2 writes for the session to protect the original.
 * Storage read failures are treated as missing data. */
function loadStored(): Loaded {
  let issue: string | null = null;
  const raw2 = safeGet(KEY_V2);
  if (raw2) {
    const decoded = decodeProfileRecord(raw2);
    const profile = decoded.ok ? parseProfileText(decoded.json) : null;
    if (profile) return { profile, source: 'v2', issue: null };
    // Never overwrite the only copy unless this exact record is kept aside.
    const preserved = safeGet(KEY_UNREADABLE) === raw2 || safeSet(KEY_UNREADABLE, raw2);
    v2WriteBlocked = !preserved;
    issue = preserved
      ? 'Saved taste memory could not be read. The unreadable data was kept aside and not deleted.'
      : 'Saved taste memory could not be read or copied aside. The original data was left untouched; changes are session only.';
  }
  const raw1 = safeGet(KEY_V1);
  if (raw1) {
    const profile = parseProfileText(raw1);
    if (profile) return { profile, source: 'v1', issue };
    issue = issue ?? 'Your earlier saved profile could not be read. It was left untouched.';
  }
  return { profile: null, source: 'none', issue };
}

let cached: LocalProfile | null = null;
/** Outcome of the MOST RECENT write attempt (not just the first one). */
let lastWriteOk = false;
let lastSizes: { raw: number; stored: number } | null = null;
let loadIssue: string | null = null;
/** Protect the unreadable v2 record for this session if no aside could be saved. */
let v2WriteBlocked = false;
const memoryListeners = new Set<() => void>();

/** Notifies taste-memory subscribers, ignoring individual subscriber errors. */
function notifyMemory(): void {
  for (const fn of memoryListeners) {
    try {
      fn();
    } catch {
      // A broken subscriber must not break persistence.
    }
  }
}

/** Compresses and stores the profile, updates the last-write status and notifies
 * subscribers. Returns false on serialization, compression or storage failure,
 * or while writes are blocked to protect an unreadable stored record.
 * Compression is a storage optimization, not encryption: same-origin script
 * can still read the profile. */
function writeProfile(profile: LocalProfile): boolean {
  if (v2WriteBlocked) {
    lastWriteOk = false;
    notifyMemory();
    return false;
  }
  let ok = false;
  try {
    const json = JSON.stringify(profile);
    const record = encodeProfileRecord(json);
    // If compression ever fails we do NOT fall back to rewriting the legacy v1
    // key: the loader prefers v2, so that would leave a stale copy on top.
    if (record && safeSet(KEY_V2, record)) {
      ok = true;
      lastSizes = { raw: json.length, stored: record.length };
    }
  } catch {
    ok = false;
  }
  lastWriteOk = ok;
  notifyMemory();
  return ok;
}

/** v1 → v2. The legacy key is removed ONLY after the compressed copy has been
 * written, read back, decoded, sanitised and found identical. Any failure
 * leaves v1 exactly as it was and the app keeps working from memory. */
function migrateFromV1(profile: LocalProfile): void {
  if (!writeProfile(profile)) return;
  const raw = safeGet(KEY_V2);
  const decoded = raw ? decodeProfileRecord(raw) : null;
  const back = decoded?.ok ? parseProfileText(decoded.json) : null;
  const normalise = (p: LocalProfile | null) => (p ? JSON.stringify(sanitizeProfile(JSON.parse(JSON.stringify(p)))) : '');
  if (back && normalise(back) === normalise(profile)) safeRemove(KEY_V1);
}

/** Test seam: forgets all in-memory state so a test can start from a chosen storage state. */
export function __resetInMemoryStateForTests(): void {
  cached = null;
  v2WriteBlocked = false;
  lastWriteOk = false;
  lastSizes = null;
  loadIssue = null;
  paused = null;
}

/** Returns the shared mutable profile, loading or creating it on first access.
 * That first access updates the visit time and attempts to save/migrate storage;
 * failed storage writes leave the profile usable for this session. */
export function getProfile(): LocalProfile {
  if (cached) return cached;
  const loaded = loadStored();
  loadIssue = loaded.issue;
  if (loaded.profile) {
    cached = loaded.profile;
    cached.lastVisitAt = Date.now();
    if (loaded.source === 'v1') migrateFromV1(cached);
    else writeProfile(cached);
  } else {
    cached = freshProfile();
    writeProfile(cached);
  }
  return cached;
}

/** True when the most recent write was actually stored on this device. */
export function isPersistenceAvailable(): boolean {
  getProfile();
  return lastWriteOk;
}

export type PersistenceStatus = 'saved' | 'session' | 'unavailable';

/** `saved` = the last write succeeded; `session` = storage is reachable but
 * the last write failed (e.g. full); `unavailable` = storage is blocked. */
export function getPersistenceStatus(): PersistenceStatus {
  getProfile();
  if (lastWriteOk) return 'saved';
  return storageAccessible() ? 'session' : 'unavailable';
}

/** Trims the name to 40 characters, keeps the current name if empty, and attempts to save. */
export function setDisplayName(name: string): void {
  const p = getProfile();
  p.displayName = name.trim().slice(0, 40) || p.displayName;
  writeProfile(p);
}

/** Updates the avatar and attempts to save it; undefined removes the emoji selection. */
export function setAvatar(color: string, emoji: string | undefined): void {
  const p = getProfile();
  p.avatarColor = color;
  p.avatarEmoji = emoji;
  writeProfile(p);
}

/** Replaces this title's rating, appends it as the newest history row and attempts
 * to save. Drops leading history rows beyond the 1,000-entry cap. */
export function recordRating(item: CatalogItem, rating: RatingValue, source: 'calibration' | 'result'): void {
  const p = getProfile();
  const entry: HistoryEntry = {
    id: item.id,
    tmdbType: item.tmdbType,
    title: item.title,
    year: item.year,
    posterPath: item.posterPath,
    genres: item.genres,
    vibe: item.vibe,
    language: item.language,
    era: item.era,
    voteAverage: item.voteAverage,
    popularity: item.popularity,
    rating,
    ratedAt: Date.now(),
    source,
  };
  // Replace any earlier verdict on the same title rather than duplicating it.
  p.history = p.history.filter((h) => keyOf(h) !== keyOf(item));
  p.history.push(entry);
  if (p.history.length > MAX_HISTORY) p.history = p.history.slice(p.history.length - MAX_HISTORY);
  writeProfile(p);
}

/** True when the person rated this title themselves in the app (calibration
 * or result screen), as opposed to it arriving via a library import. */
export function hasDeliberateRating(ref: TitleRef): boolean {
  const k = keyOf(ref);
  const existing = getProfile().history.find((h) => keyOf(h) === k);
  return !!existing && existing.source !== 'import';
}

/** Records a batch of imported ratings and attempts to save once.
 *
 * With `replace`, removes earlier imports from `provider` before adding entries;
 * imports without a provider are treated as Letterboxd. Otherwise merges them.
 * Callers can choose merge when lookups were incomplete. There is one row per
 * media type + TMDB id: incoming entries may overwrite another provider's
 * rating for the same title, but in-app ratings take precedence.
 *
 * `stars` is the normalized 0.5–5 value; `raw` preserves the source's rating
 * and scale, defaulting to stars on a five-point scale when omitted.
 * History is capped at 1,000 entries, removing imported rows first.
 *
 * Returns the media keys that were skipped because the person had already
 * rated them in the app, so callers can keep other stores consistent.
 * A failed save leaves the updated history in memory. */
export function recordImportedRatings(
  entries: { item: CatalogItem; stars: number; raw?: { rating: number; scaleMax: 5 | 10 } }[],
  replace = true,
  provider: ImportProvider = 'letterboxd-csv'
): Set<string> {
  const p = getProfile();
  const kept = new Set<string>();
  // Replace: drop only THIS provider's earlier import (imports that predate the
  // provider field are Letterboxd). In-app ratings and other providers' imports
  // are never touched. Merge: keep every prior import too.
  const byId = new Map(
    p.history.filter((h) => !replace || h.source !== 'import' || (h.provider ?? 'letterboxd-csv') !== provider).map((h) => [keyOf(h), h])
  );
  for (const { item, stars, raw } of entries) {
    // A rating the person gave deliberately in the app beats an imported one.
    const k = keyOf(item);
    const existing = byId.get(k);
    if (existing && existing.source !== 'import') {
      kept.add(k);
      continue;
    }
    byId.set(k, {
      id: item.id,
      tmdbType: item.tmdbType,
      title: item.title,
      year: item.year,
      posterPath: item.posterPath,
      genres: item.genres,
      vibe: item.vibe,
      language: item.language,
      era: item.era,
      voteAverage: item.voteAverage,
      popularity: item.popularity,
      rating: Math.max(1, Math.min(5, Math.round(stars))) as RatingValue,
      stars,
      ratedAt: Date.now(),
      source: 'import',
      provider,
      rawRating: raw?.rating ?? stars,
      ratingScaleMax: raw?.scaleMax ?? 5,
    });
  }
  // Persist once for the whole batch, de-duplicated by TMDB id. If the cap is
  // exceeded, drop the oldest *imported* entries first so a large library can
  // never evict a rating the person gave deliberately in the app.
  p.history = capHistory([...byId.values()]);
  writeProfile(p);
  return kept;
}

/** Keeps at most MAX_HISTORY rows, removing imported rows in array order first,
 * then leading rows if the remaining in-app ratings still exceed the cap. */
function capHistory(rows: HistoryEntry[]): HistoryEntry[] {
  let merged = rows;
  let overflow = merged.length - MAX_HISTORY;
  if (overflow > 0) {
    merged = merged.filter((h) => {
      if (overflow > 0 && h.source === 'import') {
        overflow--;
        return false;
      }
      return true;
    });
    if (merged.length > MAX_HISTORY) merged = merged.slice(-MAX_HISTORY);
  }
  return merged;
}

const VIBE_VALUES = new Set(['dark', 'light', 'intellectual', 'feelgood', 'epic']);

/** The calibration screen's seed list only carries id/title/year/poster —
 * genre/vibe tags live separately in `signalsBySeedId` (see
 * rating-pool.ts). Builds the same shape of history entry from that
 * thinner data so calibration ratings persist too, just with less TMDB
 * metadata (voteAverage/popularity default to 0, era/language unknown)
 * than a result-screen rating gets for free. */
export function recordSeedRating(
  seed: { id: number; title: string; year: number; tmdbType: 'movie' | 'tv'; posterPath: string | null },
  signals: string[],
  rating: RatingValue
): void {
  const p = getProfile();
  const entry: HistoryEntry = {
    id: seed.id,
    tmdbType: seed.tmdbType,
    title: seed.title,
    year: seed.year,
    posterPath: seed.posterPath,
    genres: signals.filter((s) => !VIBE_VALUES.has(s)) as Genre[],
    vibe: signals.filter((s) => VIBE_VALUES.has(s)) as Vibe[],
    language: 'en',
    era: 'any',
    voteAverage: 0,
    popularity: 0,
    rating,
    ratedAt: Date.now(),
    source: 'calibration',
  };
  p.history = p.history.filter((h) => keyOf(h) !== keyOf(seed));
  p.history.push(entry);
  if (p.history.length > MAX_HISTORY) p.history = p.history.slice(p.history.length - MAX_HISTORY);
  writeProfile(p);
}

export function historyRatingFor(ref: TitleRef): RatingValue | undefined {
  const k = keyOf(ref);
  return getProfile().history.find((h) => keyOf(h) === k)?.rating;
}

/** Reconstructs a minimal CatalogItem from a history entry — just enough
 * for engine.processResultRating(), which only reads genres/vibe/
 * language/voteAverage/popularity/id off it. */
export function historyAsCatalogItems(): { item: CatalogItem; rating: number; imported: boolean }[] {
  return getProfile().history.map((h) => ({
    rating: h.stars ?? h.rating,
    imported: h.source === 'import',
    item: {
      id: h.id,
      title: h.title,
      year: h.year,
      type: h.tmdbType === 'tv' ? 'series' : 'movie',
      tmdbType: h.tmdbType,
      posterPath: h.posterPath,
      backdropPath: null,
      genreIds: [],
      genres: h.genres,
      vibe: h.vibe,
      language: h.language,
      era: h.era,
      voteAverage: h.voteAverage,
      voteCount: 0,
      popularity: h.popularity,
      overview: '',
    },
  }));
}

export function isInWatchlist(ref: TitleRef): boolean {
  const k = keyOf(ref);
  return getProfile().watchlist.some((w) => keyOf(w) === k);
}

/** Adds/removes a title and attempts to save. Returns its new watchlist membership,
 * even if the change could only be kept in memory. */
export function toggleWatchlist(item: CatalogItem): boolean {
  const p = getProfile();
  const k = keyOf(item);
  const already = p.watchlist.some((w) => keyOf(w) === k);
  if (already) {
    p.watchlist = p.watchlist.filter((w) => keyOf(w) !== k);
  } else {
    p.watchlist.unshift({
      id: item.id,
      tmdbType: item.tmdbType,
      title: item.title,
      year: item.year,
      posterPath: item.posterPath,
      addedAt: Date.now(),
    });
  }
  writeProfile(p);
  return !already;
}

/** Removes this media type + TMDB id from the watchlist and attempts to save. */
export function removeFromWatchlist(ref: TitleRef): void {
  const p = getProfile();
  const k = keyOf(ref);
  p.watchlist = p.watchlist.filter((w) => keyOf(w) !== k);
  writeProfile(p);
}

export function getStats(): { ratedCount: number; watchlistCount: number; sinceDays: number } {
  const p = getProfile();
  return {
    ratedCount: p.history.length,
    watchlistCount: p.watchlist.length,
    sinceDays: Math.max(0, Math.floor((Date.now() - p.createdAt) / 86_400_000)),
  };
}

// ── Local Taste Memory: status, export/import, pause, erase ─────────────
//
// Everything here is local to this browser. Nothing is uploaded, and no AI
// model receives the stored profile (see Moodsift-Local-AI-Engine-Policy.md).

export interface TasteMemoryInfo {
  status: PersistenceStatus;
  ratedCount: number;
  /** Rated in the app (calibration or results), as opposed to imported. */
  deliberateCount: number;
  importedCount: number;
  watchlistCount: number;
  /** Time of the most recent rating on record (ms since epoch), if any. */
  mostRecentRatingAt: number | null;
  /** Size of the profile JSON and of what is stored, both in UTF-16 characters
   * (what localStorage counts), or null if nothing has been written yet. */
  rawChars: number | null;
  storedChars: number | null;
  paused: boolean;
  /** Set when saved data had to be set aside on load. */
  loadIssue: string | null;
}

/** Subscribes to profile write attempts and pause changes without an initial call.
 * Returns an unsubscribe function; callback errors are ignored during notification. */
export function subscribeTasteMemory(fn: () => void): () => void {
  memoryListeners.add(fn);
  return () => {
    memoryListeners.delete(fn);
  };
}

let paused: boolean | null = null;

/** Reads the cached pause setting, defaulting to false for missing, unreadable
 * or unsupported stored settings. */
function readPaused(): boolean {
  if (paused !== null) return paused;
  const raw = safeGet(KEY_MEMORY);
  try {
    const v: unknown = raw ? JSON.parse(raw) : null;
    paused = isObj(v) && v.version === 1 && v.paused === true;
  } catch {
    paused = false;
  }
  return paused;
}

/** True while stored ratings are kept but not applied to ranking. */
export function isPersonalizationPaused(): boolean {
  return readPaused();
}

/** Pausing keeps every saved rating and stops them influencing ranking;
 * resuming restores the influence. Returns whether the choice was saved. */
export function setPersonalizationPaused(value: boolean): boolean {
  paused = value;
  const ok = safeSet(KEY_MEMORY, JSON.stringify({ version: 1, paused: value }));
  notifyMemory();
  return ok;
}

/** Returns current counts, pause/load status and the latest write outcome.
 * Size measurements are UTF-16 code units from the last successful profile write;
 * they can be stale after a failed write. Rating timestamps are epoch milliseconds. */
export function getTasteMemoryInfo(): TasteMemoryInfo {
  const p = getProfile();
  const imported = p.history.filter((h) => h.source === 'import').length;
  return {
    status: getPersistenceStatus(),
    ratedCount: p.history.length,
    deliberateCount: p.history.length - imported,
    importedCount: imported,
    watchlistCount: p.watchlist.length,
    mostRecentRatingAt: p.history.reduce<number | null>((m, h) => (m === null || h.ratedAt > m ? h.ratedAt : m), null),
    rawChars: lastSizes?.raw ?? null,
    storedChars: lastSizes?.stored ?? null,
    paused: readPaused(),
    loadIssue,
  };
}

export const EXPORT_FORMAT = 'moodsift-taste-memory';
export const MAX_IMPORT_CHARS = 5_000_000;

/** A readable, versioned JSON backup of the canonical profile — never the
 * internal compressed storage record. It contains no tokens or credentials. */
export function exportTasteMemory(): string {
  const p = getProfile();
  return JSON.stringify({ format: EXPORT_FORMAT, formatVersion: 1, exportedAt: new Date().toISOString(), profile: p }, null, 2);
}

export interface TasteMemoryPreview {
  profile: LocalProfile;
  ratedCount: number;
  importedCount: number;
  watchlistCount: number;
  /** Rows dropped as invalid, duplicate or over the cap. */
  skippedRows: number;
}

/** Validates and sanitizes a backup WITHOUT touching the active profile.
 * Returns a preview with counts (skippedRows counts discarded history rows),
 * or an error for invalid JSON, unsupported formats or more than 5,000,000
 * UTF-16 code units. */
export function parseTasteMemoryImport(text: string): { ok: true; preview: TasteMemoryPreview } | { ok: false; error: string } {
  if (text.length > MAX_IMPORT_CHARS) return { ok: false, error: 'That file is too large to be a Moodsift backup.' };
  let data: unknown;
  try {
    data = JSON.parse(text);
  } catch {
    return { ok: false, error: 'That file is not valid JSON.' };
  }
  if (!isObj(data) || data.format !== EXPORT_FORMAT) return { ok: false, error: 'That file is not a Moodsift taste-memory backup.' };
  if (data.formatVersion !== 1) return { ok: false, error: 'That backup was made by a newer version of Moodsift and cannot be read here.' };
  if (!isObj(data.profile)) return { ok: false, error: 'The backup has no profile in it.' };
  const rawRows = Array.isArray(data.profile.history) ? data.profile.history.length : 0;
  const profile = sanitizeProfile(data.profile);
  if (!profile) return { ok: false, error: 'The profile in that backup is not in a supported format.' };
  return {
    ok: true,
    preview: {
      profile,
      ratedCount: profile.history.length,
      importedCount: profile.history.filter((h) => h.source === 'import').length,
      watchlistCount: profile.watchlist.length,
      skippedRows: Math.max(0, rawRows - profile.history.length),
    },
  };
}

/** Applies a previewed backup. `replace` swaps the whole profile; `merge` adds
 * to it (an in-app rating beats an imported one, otherwise the newer rating
 * wins, and the same title is never counted twice). Merge keeps the current
 * identity and adds watchlist titles not already present. Expects a sanitized
 * profile from parseTasteMemoryImport. Returns whether the final write succeeded;
 * a failed write still applies the change in memory. */
export function applyTasteMemoryImport(incoming: LocalProfile, mode: 'replace' | 'merge'): boolean {
  const cur = getProfile();
  if (mode === 'replace') {
    cached = { ...incoming, lastVisitAt: Date.now() };
  } else {
    const byKey = new Map(cur.history.map((h) => [keyOf(h), h]));
    for (const h of incoming.history) {
      const k = keyOf(h);
      const ex = byKey.get(k);
      if (!ex) byKey.set(k, h);
      else if (ex.source !== 'import' && h.source === 'import') continue;
      else if (ex.source === 'import' && h.source !== 'import') byKey.set(k, h);
      else if (h.ratedAt > ex.ratedAt) byKey.set(k, h);
    }
    const have = new Set(cur.watchlist.map((w) => keyOf(w)));
    cur.history = capHistory([...byKey.values()]);
    cur.watchlist = [...cur.watchlist, ...incoming.watchlist.filter((w) => !have.has(keyOf(w)))];
  }
  return writeProfile(cached!);
}

/** Explicit, user-initiated only — the one destructive action in this module.
 * Attempts to delete the profile in every storage format, the unreadable-data
 * copy and the pause flag, then returns a fresh in-memory profile and attempts
 * to save it. Storage failures are ignored, so old records may remain. It does
 * not (and cannot) touch browser backups, sync copies or exported files. */
export function eraseTasteMemory(): LocalProfile {
  for (const k of [KEY_V1, KEY_V2, KEY_UNREADABLE, KEY_MEMORY]) safeRemove(k);
  v2WriteBlocked = false;
  paused = false;
  loadIssue = null;
  lastSizes = null;
  cached = freshProfile();
  writeProfile(cached);
  return cached;
}

/** Kept for the existing "Reset my data" button. */
export function resetProfile(): LocalProfile {
  return eraseTasteMemory();
}
