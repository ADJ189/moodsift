import { expect, test } from '@playwright/test';
import { decodeProfileRecord, encodeProfileRecord } from '../src/lib/profile-codec';
import { detectImportFormat, parseCsv, parseImdbCsv } from '../src/lib/imdb';
import type { CatalogItem } from '../src/lib/types';

// ── a controllable localStorage ────────────────────────────────────────
class FakeStorage {
  map = new Map<string, string>();
  quota = Infinity; // max characters across all values
  blocked = false;
  corruptKey: string | null = null; // writes to this key are stored damaged
  get length() {
    return this.map.size;
  }
  private used() {
    let n = 0;
    for (const [k, v] of this.map) n += k.length + v.length;
    return n;
  }
  getItem(k: string) {
    if (this.blocked) throw new DOMException('blocked', 'SecurityError');
    return this.map.get(k) ?? null;
  }
  setItem(k: string, v: string) {
    if (this.blocked) throw new DOMException('blocked', 'SecurityError');
    const prev = this.map.get(k);
    this.map.delete(k);
    if (this.used() + k.length + v.length > this.quota) {
      if (prev !== undefined) this.map.set(k, prev);
      throw new DOMException('full', 'QuotaExceededError');
    }
    this.map.set(k, k === this.corruptKey ? v.slice(0, Math.floor(v.length / 2)) : v);
  }
  removeItem(k: string) {
    if (this.blocked) throw new DOMException('blocked', 'SecurityError');
    this.map.delete(k);
  }
}

const V1 = 'cinematch.profile.v1';
const V2 = 'cinematch.profile.v2';
const UNREADABLE = 'cinematch.profile.v2.unreadable';

const entry = (i: number, over: Record<string, unknown> = {}) => ({
  id: 1000 + i,
  title: `Film ${i} — ünïcödé 🎬 ${'x'.repeat(i % 7)}`,
  year: 1950 + (i % 70),
  type: 'movie',
  tmdbType: 'movie',
  posterPath: `/p${i}.jpg`,
  genres: ['drama', 'thriller'],
  vibe: ['dark', 'tense'],
  rating: ((i % 5) + 1) as number,
  stars: ((i % 5) + 1) as number,
  ratedAt: 1_700_000_000_000 + i * 1000,
  source: 'result',
  ...over,
});
const legacy = (n: number, over: Record<string, unknown> = {}) => ({
  version: 1,
  id: 'p-test',
  displayName: 'Tester',
  avatarColor: '#aaaaaa',
  createdAt: 1,
  lastVisitAt: 2,
  history: Array.from({ length: n }, (_, i) => entry(i, over)),
  watchlist: [],
});
const item = (id: number, tmdbType: 'movie' | 'tv' = 'movie') => ({ id, title: `Item ${id}`, year: 2001, type: tmdbType === 'movie' ? 'movie' : 'series', tmdbType, posterPath: null, backdropPath: null, genreIds: [], genres: ['drama'], vibe: ['dark'], language: 'en', era: '2000s', voteAverage: 7, voteCount: 10, popularity: 1, overview: '' }) as unknown as CatalogItem;

let storage: FakeStorage;
async function fresh(setup: (s: FakeStorage) => void = () => undefined) {
  storage = new FakeStorage();
  (globalThis as unknown as { localStorage: FakeStorage }).localStorage = storage;
  setup(storage);
  const mod = await import('../src/lib/profile');
  mod.__resetInMemoryStateForTests();
  return mod;
}

test.describe('profile codec', () => {
  test('round-trips empty, typical, maximum-size, Unicode and emoji profiles losslessly', () => {
    const cases = [
      JSON.stringify(legacy(0)),
      JSON.stringify(legacy(25)),
      JSON.stringify(legacy(2000)),
      JSON.stringify({ displayName: 'Zoë 😀 日本語 \u202e \u202e \u0000 tab\there', n: [1.5, -0, 1e21], s: '"quotes" \\ back' }),
      JSON.stringify({ big: 'ab'.repeat(500_000) }),
    ];
    for (const json of cases) {
      const rec = encodeProfileRecord(json)!;
      expect(rec.startsWith('MOODPROFILE|2|lz-utf16|')).toBe(true);
      expect(decodeProfileRecord(rec)).toEqual({ ok: true, json });
    }
  });

  test('a realistic profile stores in well under its plain size', () => {
    const json = JSON.stringify(legacy(1500));
    const rec = encodeProfileRecord(json)!;
    expect(rec.length).toBeLessThan(json.length * 0.6);
  });

  test('bad input is rejected, never thrown', () => {
    expect(decodeProfileRecord('{"plain":"json"}')).toEqual({ ok: false, reason: 'not-a-record' });
    expect(decodeProfileRecord('MOODPROFILE|9|lz-utf16|abc')).toEqual({ ok: false, reason: 'unsupported-version' });
    expect(decodeProfileRecord('MOODPROFILE|2|gzip|abc')).toEqual({ ok: false, reason: 'unsupported-codec' });
    const rec = encodeProfileRecord(JSON.stringify(legacy(50)))!;
    const truncated = decodeProfileRecord(rec.slice(0, rec.length - 40));
    if (truncated.ok) expect(() => JSON.parse(truncated.json)).toThrow(); // never mistaken for a valid profile
    expect(decodeProfileRecord('MOODPROFILE|2|lz-utf16|\u0001\u0002\u0003').ok).toBe(false);
  });
});

test.describe('profile persistence (v1 → v2)', () => {
  test('first run writes only the compressed v2 record and reports Saved', async () => {
    const m = await fresh();
    m.getProfile();
    expect(storage.map.has(V2)).toBe(true);
    expect(storage.map.has(V1)).toBe(false);
    expect(m.getPersistenceStatus()).toBe('saved');
  });

  test('legacy v1 is migrated losslessly, verified by read-back, then removed', async () => {
    const m = await fresh((s) => s.setItem(V1, JSON.stringify(legacy(120))));
    const p = m.getProfile();
    expect(p.history).toHaveLength(120);
    expect(storage.map.has(V1)).toBe(false);
    const decoded = decodeProfileRecord(storage.map.get(V2)!);
    expect(decoded.ok).toBe(true);
    expect(JSON.parse((decoded as { json: string }).json).history).toHaveLength(120);
    // survives a "reload"
    m.__resetInMemoryStateForTests();
    expect(m.getProfile().history.map((h) => h.title)).toEqual(p.history.map((h) => h.title));
    const info = m.getTasteMemoryInfo();
    expect(info.storedChars!).toBeLessThan(info.rawChars!);
  });

  test('if the v2 write fails (full), v1 is kept, the app keeps working, and status says session-only', async () => {
    const legacyJson = JSON.stringify(legacy(60));
    const m = await fresh((s) => {
      s.setItem(V1, legacyJson);
      s.quota = legacyJson.length + V1.length + 20; // room for v1 only
    });
    const p = m.getProfile();
    expect(p.history).toHaveLength(60);
    expect(storage.map.get(V1)).toBe(legacyJson);
    expect(storage.map.has(V2)).toBe(false);
    expect(m.getPersistenceStatus()).toBe('session');
  });

  test('if the stored v2 copy does not read back identically, v1 is NOT deleted', async () => {
    const m = await fresh((s) => {
      s.setItem(V1, JSON.stringify(legacy(60)));
      s.corruptKey = V2;
    });
    expect(m.getProfile().history).toHaveLength(60);
    expect(storage.map.has(V1)).toBe(true);
  });

  test('unreadable v2 + intact v1: uses v1, sets the bad record aside, and says so', async () => {
    const m = await fresh((s) => {
      s.setItem(V1, JSON.stringify(legacy(10)));
      s.setItem(V2, 'MOODPROFILE|2|lz-utf16|\u0001garbage');
    });
    expect(m.getProfile().history).toHaveLength(10);
    expect(storage.map.get(UNREADABLE)).toBe('MOODPROFILE|2|lz-utf16|\u0001garbage');
    expect(m.getTasteMemoryInfo().loadIssue).toMatch(/kept aside/);
  });

  test('unreadable v2 and nothing else: fresh profile, but the bad copy is preserved, not erased', async () => {
    const m = await fresh((s) => s.setItem(V2, 'MOODPROFILE|2|lz-utf16|\u0001garbage'));
    expect(m.getProfile().history).toHaveLength(0);
    expect(storage.map.get(UNREADABLE)).toContain('garbage');
  });

  test('every write updates the status: failure then recovery', async () => {
    const m = await fresh();
    m.getProfile();
    expect(m.getPersistenceStatus()).toBe('saved');
    storage.quota = 10;
    m.recordRating(item(1), 4, 'result');
    expect(m.getPersistenceStatus()).toBe('session');
    expect(m.getProfile().history).toHaveLength(1); // still usable in memory
    storage.quota = Infinity;
    m.recordRating(item(2), 5, 'result');
    expect(m.getPersistenceStatus()).toBe('saved');
  });

  for (const aside of [null, 'a different unreadable record']) {
    test(`failed aside copy protects v2 and legacy data (${aside === null ? 'no aside' : 'different aside'})`, async () => {
      const raw2 = 'unreadable'.repeat(2000);
      const raw1 = JSON.stringify(legacy(3));
      const m = await fresh((s) => {
        s.setItem(V2, raw2);
        s.setItem(V1, raw1);
        if (aside !== null) s.setItem(UNREADABLE, aside);
        // A new compressed profile would fit, but a second copy of raw2 cannot.
        s.quota = [...s.map].reduce((n, [k, v]) => n + k.length + v.length, 100);
      });
      expect(m.getProfile().history).toHaveLength(3);
      expect(m.getPersistenceStatus()).toBe('session');
      expect(m.getTasteMemoryInfo().loadIssue).toMatch(/original data was left untouched/);
      expect(storage.map.get(V2)).toBe(raw2);
      expect(storage.map.get(V1)).toBe(raw1);
      expect(storage.map.get(UNREADABLE) ?? null).toBe(aside);

      storage.quota = Infinity;
      m.recordRating(item(1), 4, 'result');
      expect(m.getProfile().history).toHaveLength(4);
      expect(m.getPersistenceStatus()).toBe('session');
      expect(storage.map.get(V2)).toBe(raw2);

      m.__resetInMemoryStateForTests();
      expect(m.getProfile().history).toHaveLength(3);
      expect(storage.map.get(UNREADABLE)).toBe(raw2);
      expect(m.getPersistenceStatus()).toBe('saved');
    });
  }

  test('an existing aside must match the current unreadable record before v2 is replaced', async () => {
    const raw2 = 'current unreadable data';
    const m = await fresh((s) => {
      s.setItem(V2, raw2);
      s.setItem(UNREADABLE, 'older unreadable data');
    });
    m.getProfile();
    expect(storage.map.get(UNREADABLE)).toBe(raw2);
    expect(m.getPersistenceStatus()).toBe('saved');
  });

  test('a matching aside allows writes even when copying it again would fail', async () => {
    const raw2 = 'unreadable'.repeat(2000);
    const m = await fresh((s) => {
      s.setItem(V2, raw2);
      s.setItem(UNREADABLE, raw2);
      s.quota = raw2.length + 1000; // existing values exceed quota; replacing v2 with a small profile fits
    });
    m.getProfile();
    expect(storage.map.get(UNREADABLE)).toBe(raw2);
    expect(m.getPersistenceStatus()).toBe('saved');
  });

  test('explicit erase clears the write block and starts a saved empty profile', async () => {
    const m = await fresh((s) => {
      s.setItem(V2, 'unreadable'.repeat(2000));
      s.quota = 20_000;
    });
    expect(m.getPersistenceStatus()).toBe('session');
    m.eraseTasteMemory();
    expect(m.getPersistenceStatus()).toBe('saved');
    expect(m.getProfile().history).toHaveLength(0);
    expect(m.getTasteMemoryInfo().loadIssue).toBeNull();
    expect(storage.map.has(UNREADABLE)).toBe(false);
    expect(decodeProfileRecord(storage.map.get(V2)!).ok).toBe(true);
  });

  test('blocked storage: no crash, status "unavailable", data still usable this session', async () => {
    const m = await fresh((s) => (s.blocked = true));
    expect(m.getProfile().history).toHaveLength(0);
    m.recordRating(item(1), 3, 'calibration');
    expect(m.getProfile().history).toHaveLength(1);
    expect(m.getPersistenceStatus()).toBe('unavailable');
  });

  test('unsanitary stored fields are still cleaned after decompression', async () => {
    const dirty = legacy(0);
    (dirty as { displayName: string }).displayName = '<img src=x onerror=alert(1)>'.repeat(20);
    (dirty.history as unknown[]).push({ id: -5, title: '', rating: 99 }, entry(1));
    const m = await fresh((s) => s.setItem(V2, encodeProfileRecord(JSON.stringify(dirty))!));
    const p = m.getProfile();
    expect(p.history).toHaveLength(1);
    expect(p.displayName.length).toBeLessThanOrEqual(40);
  });
});

test.describe('taste memory controls', () => {
  test('imports: replace drops only the SAME provider, never in-app ratings; raw rating/scale/provider kept', async () => {
    const m = await fresh();
    m.recordRating(item(1), 5, 'result');
    m.recordImportedRatings([{ item: item(2), stars: 3.5, raw: { rating: 7, scaleMax: 10 } }], true, 'imdb-csv');
    m.recordImportedRatings([{ item: item(3), stars: 4 }], true, 'letterboxd-csv');
    // re-importing IMDb replaces IMDb rows only
    m.recordImportedRatings([{ item: item(4), stars: 2, raw: { rating: 4, scaleMax: 10 } }], true, 'imdb-csv');
    const ids = m.getProfile().history.map((h) => h.id).sort((a, b) => a - b);
    expect(ids).toEqual([1, 3, 4]);
    const four = m.getProfile().history.find((h) => h.id === 4)!;
    expect(four).toMatchObject({ provider: 'imdb-csv', rawRating: 4, ratingScaleMax: 10, stars: 2, source: 'import' });
    // idempotent: same file twice → same result
    m.recordImportedRatings([{ item: item(4), stars: 2, raw: { rating: 4, scaleMax: 10 } }], true, 'imdb-csv');
    expect(m.getProfile().history.filter((h) => h.id === 4)).toHaveLength(1);
    // an imported row never overwrites a rating given in the app
    m.recordImportedRatings([{ item: item(1), stars: 1 }], false, 'imdb-csv');
    expect(m.getProfile().history.find((h) => h.id === 1)).toMatchObject({ rating: 5, source: 'result' });
  });

  test('status counts and sizes reflect the real profile', async () => {
    const m = await fresh();
    m.recordRating(item(1), 5, 'result');
    m.recordImportedRatings([{ item: item(2), stars: 3 }, { item: item(3), stars: 2 }]);
    m.toggleWatchlist(item(9));
    const info = m.getTasteMemoryInfo();
    expect(info).toMatchObject({ status: 'saved', ratedCount: 3, deliberateCount: 1, importedCount: 2, watchlistCount: 1, paused: false });
    expect(info.mostRecentRatingAt).not.toBeNull();
    expect(info.rawChars).toBeGreaterThan(0);
  });

  test('pause persists across reloads and resume restores', async () => {
    const m = await fresh();
    expect(m.isPersonalizationPaused()).toBe(false);
    expect(m.setPersonalizationPaused(true)).toBe(true);
    m.__resetInMemoryStateForTests();
    expect(m.isPersonalizationPaused()).toBe(true);
    m.setPersonalizationPaused(false);
    m.__resetInMemoryStateForTests();
    expect(m.isPersonalizationPaused()).toBe(false);
  });

  test('export → import round-trips (replace) and the export is canonical JSON, not the compressed record', async () => {
    const a = await fresh();
    a.recordRating(item(1), 5, 'result');
    a.recordImportedRatings([{ item: item(2), stars: 3.5, raw: { rating: 7, scaleMax: 10 } }], true, 'imdb-csv');
    a.toggleWatchlist(item(9));
    const text = a.exportTasteMemory();
    expect(text).not.toContain('MOODPROFILE|');
    expect(JSON.parse(text)).toMatchObject({ format: 'moodsift-taste-memory', formatVersion: 1 });

    const b = await fresh();
    const parsed = b.parseTasteMemoryImport(text);
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    expect(parsed.preview).toMatchObject({ ratedCount: 2, importedCount: 1, watchlistCount: 1, skippedRows: 0 });
    expect(b.getProfile().history).toHaveLength(0); // previewing changed nothing
    expect(b.applyTasteMemoryImport(parsed.preview.profile, 'replace')).toBe(true);
    expect(b.getProfile().history.map((h) => h.id).sort()).toEqual([1, 2]);
    b.__resetInMemoryStateForTests();
    expect(b.getProfile().history).toHaveLength(2); // and it was persisted
  });

  test('import validation: not JSON, wrong format, newer version, oversize, junk rows counted as skipped', async () => {
    const m = await fresh();
    expect(m.parseTasteMemoryImport('{nope')).toMatchObject({ ok: false });
    expect(m.parseTasteMemoryImport('{"a":1}')).toMatchObject({ ok: false, error: expect.stringMatching(/not a Moodsift/) });
    expect(m.parseTasteMemoryImport(JSON.stringify({ format: 'moodsift-taste-memory', formatVersion: 7, profile: {} }))).toMatchObject({ ok: false, error: expect.stringMatching(/newer version/) });
    expect(m.parseTasteMemoryImport('x'.repeat(5_000_001))).toMatchObject({ ok: false, error: expect.stringMatching(/too large/) });
    const withJunk = { format: 'moodsift-taste-memory', formatVersion: 1, profile: { ...legacy(2), history: [entry(1), { nope: true }, entry(1), entry(2)] } };
    const r = m.parseTasteMemoryImport(JSON.stringify(withJunk));
    expect(r.ok && r.preview.skippedRows).toBe(2); // one invalid + one duplicate
  });

  test('merge: in-app rating beats an imported one, newer wins otherwise, watchlist unions, nothing duplicates', async () => {
    const m = await fresh();
    m.recordRating(item(1), 5, 'result');
    m.recordImportedRatings([{ item: item(2), stars: 2 }]);
    const incoming = m.parseTasteMemoryImport(
      JSON.stringify({
        format: 'moodsift-taste-memory',
        formatVersion: 1,
        profile: { ...legacy(0), history: [entry(0, { id: 1, rating: 1, stars: 1, source: 'import', ratedAt: 9e12 }), entry(0, { id: 2, rating: 4, stars: 4, source: 'result', ratedAt: 1 }), entry(0, { id: 3, rating: 3, stars: 3, ratedAt: 5 })], watchlist: [{ id: 50, tmdbType: 'movie', title: 'W', year: 2000, posterPath: null, addedAt: 1 }] },
      })
    );
    expect(incoming.ok).toBe(true);
    if (!incoming.ok) return;
    m.applyTasteMemoryImport(incoming.preview.profile, 'merge');
    const h = new Map(m.getProfile().history.map((x) => [x.id, x]));
    expect(h.get(1)).toMatchObject({ rating: 5, source: 'result' }); // deliberate beats import even though the import is "newer"
    expect(h.get(2)).toMatchObject({ rating: 4, source: 'result' }); // deliberate replaces import
    expect(h.has(3)).toBe(true);
    expect(m.getProfile().history).toHaveLength(3);
    expect(m.getProfile().watchlist.map((w) => w.id)).toContain(50);
  });

  test('erase removes every storage key, resets in-memory state, and starts fresh', async () => {
    const m = await fresh((s) => {
      s.setItem(V1, JSON.stringify(legacy(5)));
      s.setItem(UNREADABLE, 'x');
    });
    m.recordRating(item(1), 5, 'result');
    m.setPersonalizationPaused(true);
    const before = m.getProfile().id;
    m.eraseTasteMemory();
    expect([...storage.map.keys()].sort()).toEqual([V2]); // only the brand-new empty profile remains
    expect(m.getProfile().history).toHaveLength(0);
    expect(m.getProfile().id).not.toBe(before);
    expect(m.isPersonalizationPaused()).toBe(false);
    expect(m.getTasteMemoryInfo().loadIssue).toBeNull();
  });
});

test.describe('IMDb ratings CSV', () => {
  const HEADER = 'Const,Your Rating,Date Rated,Title,Original Title,URL,Title Type,IMDb Rating,Runtime (mins),Year,Genres,Num Votes,Release Date,Directors';
  const row = (id: string, r: string, title: string, type: string, year = 1999) => `${id},${r},2024-01-02,${title},${title},https://x,${type},8.1,120,${year},"Drama, Crime",1000,${year}-01-01,Someone`;

  test('detects the format by header and rejects unrelated files', () => {
    expect(detectImportFormat(HEADER + '\n')).toBe('imdb');
    expect(detectImportFormat('Date,Name,Year,Letterboxd URI,Rating\n')).toBe('letterboxd');
    expect(detectImportFormat('a,b,c\n1,2,3')).toBeNull();
    expect(detectImportFormat('')).toBeNull();
  });

  test('1–10 maps to 0.5–5 stars with the raw value preserved; movies and TV are told apart', () => {
    const csv = [HEADER, row('tt0000001', '1', 'Low', 'Movie'), row('tt0000002', '7', 'Mid', 'Movie'), row('tt0000003', '10', 'Top', 'TV Series'), row('tt0000004', '5', 'Mini', 'TV Mini Series')].join('\r\n');
    const { rows } = parseImdbCsv(csv);
    expect(rows.map((r) => [r.imdbId, r.rawRating, r.stars, r.rating, r.tv])).toEqual([
      ['tt0000001', 1, 0.5, 1, false],
      ['tt0000002', 7, 3.5, 4, false],
      ['tt0000003', 10, 5, 5, true],
      ['tt0000004', 5, 2.5, 3, true],
    ]);
  });

  test('handles BOM, quoted commas/quotes/newlines, and skips (and counts) unusable rows', () => {
    const csv =
      '\uFEFF' +
      [
        HEADER,
        `tt0000010,8,2024-01-02,"Hello, ""World""",x,https://x,Movie,8,1,2001,"A, B",1,2001-01-01,D`,
        `tt0000011,8,2024-01-02,"Line one\nLine two",x,https://x,Movie,8,1,2002,A,1,2002-01-01,D`,
        row('tt0000012', '9', 'Ep', 'TV Episode'),
        row('tt0000013', '9', 'Game', 'Video Game'),
        row('tt0000014', '0', 'Zero', 'Movie'),
        row('tt0000015', '11', 'Eleven', 'Movie'),
        row('tt0000016', 'abc', 'Nan', 'Movie'),
        row('nope', '5', 'BadId', 'Movie'),
      ].join('\n');
    const r = parseImdbCsv(csv);
    expect(r.rows.map((x) => x.title)).toEqual(['Hello, "World"', 'Line one\nLine two']);
    expect(r.skipped).toEqual({ unsupportedType: 2, invalidRating: 3, invalidId: 1 });
  });

  test('duplicate ids collapse (later row wins) so re-importing is idempotent', () => {
    const csv = [HEADER, row('tt0000020', '3', 'Same', 'Movie'), row('tt0000020', '9', 'Same', 'Movie')].join('\n');
    const { rows } = parseImdbCsv(csv);
    expect(rows).toHaveLength(1);
    expect(rows[0]!.rawRating).toBe(9);
  });

  test('missing required columns yields nothing; generic CSV parser is RFC-4180 safe', () => {
    expect(parseImdbCsv('a,b\n1,2').rows).toEqual([]);
    expect(parseCsv('a,"b,c",d\r\n1,"x""y",3\n')).toEqual([['a', 'b,c', 'd'], ['1', 'x"y', '3']]);
  });
});
