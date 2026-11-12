/// <reference lib="deno.ns" />
// Native Deno test: FIPS-vector SHA-256 used by the model-integrity tracker.
import { assertEquals } from 'jsr:@std/assert@1';
import { Sha256, sha256Hex } from '../../src/lib/sha256.ts';

const bytes = (s: string) => new TextEncoder().encode(s);

Deno.test('sha256Hex matches published vectors', () => {
  assertEquals(sha256Hex(bytes('')), 'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855');
  assertEquals(sha256Hex(bytes('abc')), 'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad');
});

Deno.test('streaming Sha256 matches the one-shot digest across chunk boundaries', () => {
  const input = bytes('The quick brown fox jumps over the lazy dog');
  const oneShot = sha256Hex(input);
  for (const cut of [1, 7, 31, input.length - 1]) {
    const h = new Sha256();
    h.update(input.slice(0, cut));
    h.update(input.slice(cut));
    assertEquals(h.digestHex(), oneShot, `cut at ${cut}`);
  }
});

Deno.test('digest is stable for a UTF-8 payload with emoji', () => {
  const h = new Sha256();
  h.update(bytes('Moodsift ðŸŽ¬'));
  assertEquals(h.digestHex(), sha256Hex(bytes('Moodsift ðŸŽ¬')));
});
