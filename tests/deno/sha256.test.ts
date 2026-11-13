/// <reference lib="deno.ns" />
// Native Deno test: FIPS-vector SHA-256 used by the model-integrity tracker.
import { assertEquals } from 'jsr:@std/assert@1';
import { Sha256, sha256Hex } from '../../src/lib/sha256.ts';

const bytes = (s: string) => new TextEncoder().encode(s);

Deno.test('sha256Hex matches published vectors', () => {
  assertEquals(sha256Hex(bytes('')), 'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855');
  assertEquals(sha256Hex(bytes('abc')), 'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad');
  // 55 bytes: single-block padding boundary
  const s55 = 'abcdbcdecdefdefgefghfghighijhijkijkljklmklmnlmnomnopnop';
  assertEquals(sha256Hex(bytes(s55)), 'aa353e009edbaebfc6e494c8d847696896cb8b398e0173a4b5c1b636292d87c7');
  // 56 bytes: NIST FIPS 180-2 multi-block padding boundary
  const s56 = 'abcdbcdecdefdefgefghfghighijhijkijkljklmklmnlmnomnopnopq';
  assertEquals(sha256Hex(bytes(s56)), '248d6a61d20638b8e5c026930c3e6039a33ce45964ff2167f6ecedd419db06c1');
  // 112 bytes: multi-block vector
  const s112 = s56 + s56;
  assertEquals(sha256Hex(bytes(s112)), '59f109d9533b2b70e7c3b814a2bd218f78ea5d3714455bc67987cf0d664399cf');
});

Deno.test('streaming Sha256 matches the one-shot digest across chunk boundaries', () => {
  const multi = bytes('abcdbcdecdefdefgefghfghighijhijkijkljklmklmnlmnomnopnopqabcdbcdecdefdefgefghfghighijhijkijkljklmklmnlmnomnopnopq');
  const oneShot = sha256Hex(multi);
  for (const cut of [1, 7, 31, 55, 56, 63, 64, 65, multi.length - 1]) {
    const h = new Sha256();
    h.update(multi.slice(0, cut));
    h.update(multi.slice(cut));
    assertEquals(h.digestHex(), oneShot, `cut at ${cut}`);
  }
});

Deno.test('digest is stable for a UTF-8 payload with emoji', () => {
  const h = new Sha256();
  h.update(bytes('Moodsift \u{1F3AC}'));
  assertEquals(h.digestHex(), sha256Hex(bytes('Moodsift \u{1F3AC}')));
});
