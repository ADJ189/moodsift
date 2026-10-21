// src/lib/storage.ts
//
// Every localStorage touch in the app goes through here. Storage throws in
// private-browsing / storage-disabled contexts (and even *reading* the
// `localStorage` property can throw a SecurityError), so each call is
// guarded and degrades to "session only" instead of crashing startup.

export function safeGet(key: string): string | null {
  try {
    return localStorage.getItem(key);
  } catch {
    return null;
  }
}

export function safeSet(key: string, value: string): boolean {
  try {
    localStorage.setItem(key, value);
    return true;
  } catch {
    return false;
  }
}

/** Removes a localStorage key; returns true even if absent, or false if access/removal throws. */
export function safeRemove(key: string): boolean {
  try {
    localStorage.removeItem(key);
    return true;
  } catch {
    return false;
  }
}

/** True when localStorage can be touched at all. Distinguishes "storage is
 * blocked" (private mode / disabled) from "the last write failed" (quota). */
export function storageAccessible(): boolean {
  try {
    localStorage.getItem('__moodsift_probe__');
    return true;
  } catch {
    return false;
  }
}
