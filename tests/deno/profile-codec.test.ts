/// <reference lib="deno.ns" />
// Native Deno test: the storage codec round-trips without losing the profile.
import { assertEquals, assertNotEquals } from 'jsr:@std/assert@1';
import { decodeProfileRecord, encodeProfileRecord, RECORD_MARKER } from '../../src/lib/profile-codec.ts';

Deno.test('profile record round-trips typical, Unicode and emoji JSON', () => {
  const profiles = [
    '{"version":1,"ratings":{},"watchlist":[]}',
    JSON.stringify({ name: 'Zoë — 日本語', history: [{ title: 'Amélie' }] }),
    JSON.stringify({ emoji: '🎬🍿🌙', note: 'ünïcode' }),
    JSON.stringify({ padding: 'x'.repeat(20_000) }),
  ];
  for (const json of profiles) {
    const record = encodeProfileRecord(json);
    assertEquals(typeof record, 'string');
    assertEquals(record!.startsWith(RECORD_MARKER), true);
    const decoded = decodeProfileRecord(record!);
    assertEquals(decoded, { ok: true, json });
  }
});

Deno.test('compression actually shrinks a repetitive profile', () => {
  const json = JSON.stringify({ items: Array.from({ length: 200 }, (_, i) => ({ id: i, title: 'Same title' })) });
  const record = encodeProfileRecord(json)!;
  assertNotEquals(record.length, json.length);
  assertEquals(record.length < json.length, true);
});

Deno.test('decode reports a specific reason instead of throwing', () => {
  assertEquals(decodeProfileRecord('{"plain":true}'), { ok: false, reason: 'not-a-record' });
  assertEquals(decodeProfileRecord('MOODPROFILE|1|lz-utf16|abc'), { ok: false, reason: 'unsupported-version' });
  assertEquals(decodeProfileRecord('MOODPROFILE|2|json|abc'), { ok: false, reason: 'unsupported-codec' });
  assertEquals(decodeProfileRecord('MOODPROFILE|2|lz-utf16|'), { ok: false, reason: 'corrupt' });
});
