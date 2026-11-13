/// <reference lib="deno.ns" />
// Native Deno test: the rating importers stay provider-aware and lossless.
import { assertEquals } from 'jsr:@std/assert@1';
import { detectImportFormat, parseCsv, parseImdbCsv } from '../../src/lib/imdb.ts';
import { parseLetterboxdCsv } from '../../src/lib/letterboxd.ts';

Deno.test('CSV parser handles quotes, doubled quotes and embedded newlines', () => {
  const rows = parseCsv('\uFEFFA,B\n"x, y","he said ""hi"""\n"multi\nline",2\n');
  assertEquals(rows[0], ['A', 'B']);
  assertEquals(rows[1], ['x, y', 'he said "hi"']);
  assertEquals(rows[2], ['multi\nline', '2']);
});

Deno.test('format detection reads the header, not the filename', () => {
  assertEquals(detectImportFormat('Const,Title,Your Rating\ntt1234567,Heat,9'), 'imdb');
  assertEquals(detectImportFormat('Name,Year,Rating\nHeat,1995,4.5'), 'letterboxd');
  assertEquals(detectImportFormat('Title,Score\nHeat,9'), null);
});

Deno.test('IMDb: 1â€“10 becomes 0.5â€“5 stars, originals preserved, bad rows counted', () => {
  const csv = [
    'Const,Title,Year,Title Type,Your Rating',
    'tt0113277,Heat,1995,movie,9',
    'tt0944947,Game of Thrones,2011,TV Series,8',
    'tt0000001,Short Thing,1920,short,5',
    'tt0000002,Virtual Thing,2020,video game,7',
    'ttBAD,Typo,2000,movie,5',
    'tt0000003,Out of Range,2000,movie,11',
  ].join('\n');
  const { rows, skipped } = parseImdbCsv(csv);
  assertEquals(rows.length, 3);
  assertEquals(rows.find((r) => r.imdbId === 'tt0113277')?.stars, 4.5);
  assertEquals(rows.find((r) => r.imdbId === 'tt0944947')?.tv, true);
  assertEquals(skipped, { unsupportedType: 1, invalidRating: 1, invalidId: 1 });
});

Deno.test('IMDb: later duplicate row wins, so re-importing is idempotent', () => {
  const csv = 'Const,Title,Year,Title Type,Your Rating\ntt0113277,Heat,1995,movie,3\ntt0113277,Heat,1995,movie,10';
  const { rows } = parseImdbCsv(csv);
  assertEquals(rows.length, 1);
  assertEquals(rows[0]!.rawRating, 10);
  assertEquals(rows[0]!.stars, 5);
});

Deno.test('Letterboxd keeps half-star precision and skips unrated rows', () => {
  const csv = 'Name,Year,Rating\n"AmÃ©lie",2001,4.5\n"Unrated",2020,\n"Zero",1999,0\n"Too High",2021,9';
  const rows = parseLetterboxdCsv(csv);
  assertEquals(rows.length, 2);
  assertEquals(rows[0], { title: 'AmÃ©lie', year: 2001, rating: 5, stars: 4.5 });
  assertEquals(rows[1], { title: 'Too High', year: 2021, rating: 5, stars: 5 });
});

Deno.test('Letterboxd without Name/Rating headers yields no rows', () => {
  assertEquals(parseLetterboxdCsv('Title,Year,Score\nHeat,1995,4'), []);
  assertEquals(parseLetterboxdCsv('Name,Year'), []);
});
