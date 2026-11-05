import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { digsHash, fromHex, hashChain, layoutSeed, rollSeed, sha256, streamRng, toHex } from './random';

const ascii = (text: string) => new TextEncoder().encode(text);
const nodeSha = (data: Uint8Array) => toHex(new Uint8Array(createHash('sha256').update(data).digest()));

describe('sha256', () => {
  it('matches the published test vectors', () => {
    expect(toHex(sha256(ascii('')))).toBe('e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855');
    expect(toHex(sha256(ascii('abc')))).toBe('ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad');
    expect(toHex(sha256(ascii('abcdbcdecdefdefgefghfghighijhijkijkljklmklmnlmnomnopnopq'))))
      .toBe('248d6a61d20638b8e5c026930c3e6039a33ce45964ff2167f6ecedd419db06c1');
    expect(toHex(sha256(ascii('a'.repeat(1_000_000))))).toBe('cdc76e5c9914fb9281a1c7e284d73e67f1809a48a497200e046d39ccc7112cd0');
  });

  it('agrees with node:crypto at every length around the padding boundaries', () => {
    const data = Uint8Array.from({ length: 300 }, (_, i) => (i * 37 + 11) % 256);
    for (let length = 0; length <= 300; length++) {
      const part = data.subarray(0, length);
      expect(toHex(sha256(part)), `length ${length}`).toBe(nodeSha(part));
    }
  });

  it('reads only the view it was given', () => {
    const data = Uint8Array.from({ length: 80 }, (_, i) => i);
    const part = data.subarray(10, 20);
    expect(toHex(sha256(part))).toBe(nodeSha(Uint8Array.from(part)));
  });
});

describe('streamRng', () => {
  const seed = sha256(ascii('stream'));

  function blockWords(k: number): number[] {
    const input = new Uint8Array(36);
    input.set(seed);
    new DataView(input.buffer).setUint32(32, k, true);
    const hash = new Uint8Array(createHash('sha256').update(input).digest());
    return Array.from({ length: 8 }, (_, i) => new DataView(hash.buffer, hash.byteOffset).getUint32(i * 4, true));
  }

  it('reads block after block as little-endian words', () => {
    const rng = streamRng(seed);
    const max = 0xffffffff;
    const words = [...blockWords(0), ...blockWords(1)];
    for (const word of words) {
      if (word === max) continue;
      expect(rng(max)).toBe(word);
    }
  });

  it('uses up one word for a roll below 1', () => {
    const rng = streamRng(seed);
    expect(rng(1)).toBe(0);
    expect(rng(1000)).toBe(blockWords(0)[1] % 1000);
  });

  it('throws away words above the largest multiple of n', () => {
    // With n just over 2^31, the limit is n itself, so about half of all words are thrown away.
    const n = 2 ** 31 + 1;
    const rng = streamRng(seed);
    const expected = [...blockWords(0), ...blockWords(1)].filter((w) => w < n).map((w) => w % n);
    for (const value of expected) expect(rng(n)).toBe(value);
    expect(expected.length).toBeLessThan(16);
  });

  it('gives every value about equally often', () => {
    const rng = streamRng(seed);
    const counts = new Array(7).fill(0);
    for (let i = 0; i < 7000; i++) counts[rng(7)]++;
    for (const count of counts) expect(Math.abs(count - 1000)).toBeLessThan(150);
  });

  it('refuses a range it cannot roll', () => {
    const rng = streamRng(seed);
    for (const n of [0, -1, 1.5, 2 ** 32]) expect(() => rng(n)).toThrow();
  });
});

describe('seeds and hashes', () => {
  const bytes = (fill: number) => new Uint8Array(32).fill(fill);

  it('builds the hash chain in reveal order, ending at the secret', () => {
    const secret = bytes(7);
    const { tip, links } = hashChain(secret);
    expect(links).toHaveLength(4);
    expect(toHex(links[3])).toBe(toHex(secret));
    expect(toHex(sha256(links[0]))).toBe(toHex(tip));
    for (let i = 1; i < 4; i++) expect(toHex(sha256(links[i]))).toBe(toHex(links[i - 1]));
  });

  it('lays out the roll seed as the spec says', () => {
    const expected = new Uint8Array([
      ...ascii('dig-here-v1'), 2, 1, 0, 0, 0, 0, 0, 0, 3, ...bytes(1), ...bytes(2), ...bytes(3),
    ]);
    expect(toHex(rollSeed(258, 3, bytes(1), bytes(2), bytes(3)))).toBe(nodeSha(expected));
  });

  it('lays out the layout seed as the spec says', () => {
    const expected = new Uint8Array([...ascii('dig-here-layout-v1'), 2, 1, 0, 0, 0, 0, 0, 0, ...bytes(1), ...bytes(2)]);
    expect(toHex(layoutSeed(258, bytes(1), bytes(2)))).toBe(nodeSha(expected));
  });

  it('lays out the digs hash as the spec says', () => {
    expect(toHex(digsHash([]))).toBe(nodeSha(new Uint8Array(0)));
    const expected = new Uint8Array([
      ...ascii('a.near'), 0, 0x34, 0x01, 0xdf, 0x00, 2, 0x08, 0x07, 0x06, 0x05, 0x04, 0x03, 0x02, 0x00,
      ...ascii('b'), 0, 1, 0, 2, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0,
    ]);
    const ms = 0x0002030405060708;
    expect(toHex(digsHash([
      { account: 'a.near', x: 0x134, y: 0xdf, clueIndex: 2, dugAtMs: ms },
      { account: 'b', x: 1, y: 2, clueIndex: 0, dugAtMs: 0 },
    ]))).toBe(nodeSha(expected));
  });

  it('refuses seeds of the wrong length', () => {
    expect(() => rollSeed(1, 1, new Uint8Array(31), bytes(2), bytes(3))).toThrow();
    expect(() => layoutSeed(1, bytes(1), new Uint8Array(33))).toThrow();
  });

  it('converts hex both ways', () => {
    expect(toHex(fromHex('00ff10'))).toBe('00ff10');
    expect(() => fromHex('0g')).toThrow();
  });
});
