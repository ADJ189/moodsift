// src/lib/profile-codec.ts
//
// The persistence boundary's codec. The in-memory profile is always a plain
// `LocalProfile` object; this only turns its JSON text into a storage-safe
// compressed record and back. Nothing else in the app compresses or
// decompresses anything, and no engine ever sees a compressed string.
//
// Record format (storage-format version is independent of the profile schema
// version inside the JSON):
//
//     MOODPROFILE|2|lz-utf16|<LZ-String UTF-16 payload of the profile JSON>
//
// A plain-text marker rather than a JSON envelope: a JSON wrapper would
// re-escape the UTF-16 payload and give back some of the saving. Compression
// is a storage optimisation only — it is NOT encryption or tamper protection,
// and same-origin JavaScript can read the profile exactly as before.
//
// Lossless by construction; the unit tests round-trip empty, typical,
// maximum-size, Unicode and emoji profiles. The codec never validates the
// profile itself — profile.ts runs the field-by-field sanitizer on the result.

import LZString from 'lz-string';

export const RECORD_MARKER = 'MOODPROFILE|';
const CURRENT_PREFIX = 'MOODPROFILE|2|lz-utf16|';

export type DecodeResult =
  | { ok: true; json: string }
  | { ok: false; reason: 'not-a-record' | 'unsupported-version' | 'unsupported-codec' | 'corrupt' };

/** Compresses profile JSON into a storage record, or null if compression fails. */
export function encodeProfileRecord(json: string): string | null {
  try {
    const payload = LZString.compressToUTF16(json);
    if (typeof payload !== 'string') return null;
    return CURRENT_PREFIX + payload;
  } catch {
    return null;
  }
}

/** Decodes a record written by encodeProfileRecord, returning a failure reason
 * for unsupported or unreadable records. Never throws. A successful decode
 * does not validate JSON or profile fields; callers must validate the text. */
export function decodeProfileRecord(raw: string): DecodeResult {
  if (!raw.startsWith(RECORD_MARKER)) return { ok: false, reason: 'not-a-record' };
  const parts = raw.split('|', 3);
  if (parts[1] !== '2') return { ok: false, reason: 'unsupported-version' };
  if (parts[2] !== 'lz-utf16') return { ok: false, reason: 'unsupported-codec' };
  try {
    const json = LZString.decompressFromUTF16(raw.slice(CURRENT_PREFIX.length));
    // LZ-String returns null/"" for garbage and can also return garbage text
    // for a truncated stream; the caller's JSON.parse + sanitizer is the real
    // validity check.
    return typeof json === 'string' && json.length > 0 ? { ok: true, json } : { ok: false, reason: 'corrupt' };
  } catch {
    return { ok: false, reason: 'corrupt' };
  }
}
