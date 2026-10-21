# Moodsift taste memory — storage and controls (v1.13.5)

Ratings and the watchlist live **only in this browser**. Nothing is uploaded, and no AI model (local or cloud) receives the stored profile.

## Storage format

| Key | Contents |
|---|---|
| `cinematch.profile.v2` | `MOODPROFILE\|2\|lz-utf16\|<LZ-String UTF-16 payload of the profile JSON>` |
| `cinematch.profile.v1` | Legacy plain JSON. Read once for migration; removed only after v2 is written, read back, decoded, sanitised and identical. |
| `cinematch.profile.v2.unreadable` | Copy of a v2 record that could not be read, kept (not deleted) before a good profile is written. |
| `cinematch.taste-memory:v1` | `{ "version": 1, "paused": boolean }` |

The record format version (`2`) is independent of the profile schema version inside the JSON. Compression is a **storage optimisation, not encryption** — same-origin script can read the profile. Every load runs the same field-by-field sanitiser on the decompressed JSON; the rest of the app only ever sees a plain `LocalProfile`.

## One write path

`writeProfile()` in `src/lib/profile.ts` serialises, compresses and stores, and its result drives the status line: **Saved on this device** (last write succeeded), **Session only** (storage reachable, last write failed — e.g. full) or **Not saved — storage unavailable** (blocked). If compression ever fails the write is reported as failed; the legacy key is never rewritten (the loader prefers v2, so that would leave a stale copy on top).

## Controls (Settings → Taste memory)

- **Pause personalization** keeps ratings but stops them influencing new picks. Titles you already rated stay excluded from suggestions; ratings given during the current quiz still count for that quiz.
- **Export backup** → `{"format":"moodsift-taste-memory","formatVersion":1,"profile":{…}}`, readable JSON, never the compressed record.
- **Import backup** validates and **previews** (rated / imported / watchlist counts, rows skipped) before anything changes. *Merge*: an in-app rating beats an imported one, otherwise the newer rating wins; the same title is never duplicated. *Replace* swaps the whole profile.
- **Erase** deletes every key above, resets in-memory state and starts a fresh profile. It cannot touch files you exported or browser-level backups.

## Imports

Letterboxd `ratings.csv` and IMDb "Your Ratings" CSV are auto-detected from the header row. IMDb rows match TMDB by exact IMDb id (`/find`), 1–10 maps to 0.5–5 stars, and the original rating, scale (5 or 10) and provider are stored with the row. Re-importing a file replaces only that provider's earlier import; in-app ratings are never overwritten. A title has **one** canonical row, so if two providers rate the same title the later import wins (separate per-provider copies are not implemented).
