/// <reference lib="deno.ns" />
// Native Deno test (npm run test:deno). Pure module, no browser required.
import { assertEquals } from 'jsr:@std/assert@1';
import { keyOf, keySelector, mediaKey, parseMediaKey } from '../../src/lib/media-key.ts';

Deno.test('media keys separate colliding movie and TV ids', () => {
  assertEquals(mediaKey('movie', 1399), 'movie:1399');
  assertEquals(mediaKey('tv', 1399), 'tv:1399');
  assertEquals(keyOf({ id: 1399, tmdbType: 'tv' }), 'tv:1399');
});

Deno.test('parseMediaKey round-trips and rejects malformed keys', () => {
  assertEquals(parseMediaKey('tv:42'), { tmdbType: 'tv', id: 42 });
  assertEquals(parseMediaKey('42'), null);
  assertEquals(parseMediaKey('person:42'), null);
  assertEquals(parseMediaKey('movie:-1'), null);
  assertEquals(parseMediaKey('movie:1.5'), null);
});

Deno.test('keySelector quotes and strips quotes from the key', () => {
  assertEquals(keySelector('movie:1'), '[data-item="movie:1"]');
  assertEquals(keySelector('movie:1"'), '[data-item="movie:1"]');
});
