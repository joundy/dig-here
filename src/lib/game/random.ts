// The number stream every roll draws from, and the hashes that feed it. The Rust contract does exactly
// the same, so a player's browser can recheck a round. `contract/tests/README.md` has the byte layouts.
import type { Rng } from './types';

const ROUND = new Uint32Array([
  0x428a2f98, 0x71374491, 0xb5c0fbcf, 0xe9b5dba5, 0x3956c25b, 0x59f111f1, 0x923f82a4, 0xab1c5ed5,
  0xd807aa98, 0x12835b01, 0x243185be, 0x550c7dc3, 0x72be5d74, 0x80deb1fe, 0x9bdc06a7, 0xc19bf174,
  0xe49b69c1, 0xefbe4786, 0x0fc19dc6, 0x240ca1cc, 0x2de92c6f, 0x4a7484aa, 0x5cb0a9dc, 0x76f988da,
  0x983e5152, 0xa831c66d, 0xb00327c8, 0xbf597fc7, 0xc6e00bf3, 0xd5a79147, 0x06ca6351, 0x14292967,
  0x27b70a85, 0x2e1b2138, 0x4d2c6dfc, 0x53380d13, 0x650a7354, 0x766a0abb, 0x81c2c92e, 0x92722c85,
  0xa2bfe8a1, 0xa81a664b, 0xc24b8b70, 0xc76c51a3, 0xd192e819, 0xd6990624, 0xf40e3585, 0x106aa070,
  0x19a4c116, 0x1e376c08, 0x2748774c, 0x34b0bcb5, 0x391c0cb3, 0x4ed8aa4a, 0x5b9cca4f, 0x682e6ff3,
  0x748f82ee, 0x78a5636f, 0x84c87814, 0x8cc70208, 0x90befffa, 0xa4506ceb, 0xbef9a3f7, 0xc67178f2,
]);

const rotr = (x: number, n: number) => (x >>> n) | (x << (32 - n));

/**
 * Plain SHA-256. `Rng` is synchronous, so a roll can't await the browser's own `crypto.subtle`,
 * and the rules shouldn't need a dependency just for this.
 */
export function sha256(data: Uint8Array): Uint8Array {
  // Padding: 0x80, zeros up to 8 bytes short of a block, then the length in bits, big endian.
  const padded = new Uint8Array((((data.length + 8) >>> 6) + 1) * 64);
  padded.set(data);
  padded[data.length] = 0x80;
  const view = new DataView(padded.buffer);
  view.setUint32(padded.length - 8, Math.floor(data.length / 0x20000000));
  view.setUint32(padded.length - 4, (data.length << 3) >>> 0);

  const h = new Uint32Array([0x6a09e667, 0xbb67ae85, 0x3c6ef372, 0xa54ff53a, 0x510e527f, 0x9b05688c, 0x1f83d9ab, 0x5be0cd19]);
  const w = new Uint32Array(64);
  for (let block = 0; block < padded.length; block += 64) {
    for (let t = 0; t < 16; t++) w[t] = view.getUint32(block + t * 4);
    for (let t = 16; t < 64; t++) {
      const s0 = rotr(w[t - 15], 7) ^ rotr(w[t - 15], 18) ^ (w[t - 15] >>> 3);
      const s1 = rotr(w[t - 2], 17) ^ rotr(w[t - 2], 19) ^ (w[t - 2] >>> 10);
      w[t] = w[t - 16] + s0 + w[t - 7] + s1;
    }
    let [a, b, c, d, e, f, g, hh] = h;
    for (let t = 0; t < 64; t++) {
      const s1 = rotr(e, 6) ^ rotr(e, 11) ^ rotr(e, 25);
      const ch = (e & f) ^ (~e & g);
      const t1 = (hh + s1 + ch + ROUND[t] + w[t]) | 0;
      const s0 = rotr(a, 2) ^ rotr(a, 13) ^ rotr(a, 22);
      const maj = (a & b) ^ (a & c) ^ (b & c);
      const t2 = (s0 + maj) | 0;
      hh = g;
      g = f;
      f = e;
      e = (d + t1) | 0;
      d = c;
      c = b;
      b = a;
      a = (t1 + t2) | 0;
    }
    h[0] += a;
    h[1] += b;
    h[2] += c;
    h[3] += d;
    h[4] += e;
    h[5] += f;
    h[6] += g;
    h[7] += hh;
  }

  const out = new Uint8Array(32);
  const outView = new DataView(out.buffer);
  h.forEach((word, i) => outView.setUint32(i * 4, word));
  return out;
}

const utf8 = (text: string) => new TextEncoder().encode(text);

function concat(parts: Uint8Array[]): Uint8Array {
  const out = new Uint8Array(parts.reduce((sum, p) => sum + p.length, 0));
  let at = 0;
  for (const part of parts) {
    out.set(part, at);
    at += part.length;
  }
  return out;
}

function le(value: number, bytes: 1 | 2 | 4 | 8): Uint8Array {
  if (!Number.isSafeInteger(value) || value < 0) throw new Error(`Not a whole number: ${value}`);
  const out = new Uint8Array(bytes);
  let rest = value;
  for (let i = 0; i < bytes; i++) {
    out[i] = rest % 256;
    rest = Math.floor(rest / 256);
  }
  if (rest !== 0) throw new Error(`${value} doesn't fit in ${bytes} bytes`);
  return out;
}

function hash32(bytes: Uint8Array): Uint8Array {
  if (bytes.length !== 32) throw new Error('Expected 32 bytes');
  return bytes;
}

export function toHex(bytes: Uint8Array): string {
  return Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('');
}

export function fromHex(hex: string): Uint8Array {
  if (hex.length % 2 !== 0 || /[^0-9a-f]/.test(hex)) throw new Error('Not lowercase hex');
  return Uint8Array.from({ length: hex.length / 2 }, (_, i) => parseInt(hex.slice(i * 2, i * 2 + 2), 16));
}

/** How many links a commitment reveals: one for each of clues 2, 3, 4 and the treasure. */
export const CHAIN_STEPS = 4;

/**
 * `tip` = H(H(H(H(secret)))), committed before the room exists. `links` are in reveal order, so
 * H(links[0]) is the tip, H(links[1]) is links[0], and the last link is the secret itself.
 */
export function hashChain(secret: Uint8Array): { tip: Uint8Array; links: Uint8Array[] } {
  const hashes = [secret];
  for (let i = 0; i < CHAIN_STEPS; i++) hashes.push(sha256(hashes[i]));
  const tip = hashes[CHAIN_STEPS];
  return { tip, links: hashes.slice(0, CHAIN_STEPS).reverse() };
}

/** `step` is 1, 2, 3 for clues 2, 3, 4, and 4 for the treasure. */
export function rollSeed(roomId: number, step: number, lockSeed: Uint8Array, link: Uint8Array, digsHashBytes: Uint8Array): Uint8Array {
  return sha256(concat([utf8('dig-here-v1'), le(roomId, 8), le(step, 1), hash32(lockSeed), hash32(link), hash32(digsHashBytes)]));
}

export function layoutSeed(roomId: number, blockSeed: Uint8Array, tip: Uint8Array): Uint8Array {
  return sha256(concat([utf8('dig-here-layout-v1'), le(roomId, 8), hash32(blockSeed), hash32(tip)]));
}

/** What goes into the hash for one dig. `dugAtMs` is the contract's block time, not the rules' seconds into the round. */
export type HashedDig = { account: string; x: number; y: number; clueIndex: number; dugAtMs: number };

export function digsHash(digs: HashedDig[]): Uint8Array {
  return sha256(concat(digs.flatMap((d) => [utf8(d.account), new Uint8Array(1), le(d.x, 2), le(d.y, 2), le(d.clueIndex, 1), le(d.dugAtMs, 8)])));
}

const TWO_32 = 4294967296;

/**
 * Block k is SHA256(seed || k as u32 LE), read as little-endian u32 words. `below(n)` throws away
 * words at or above the largest multiple of n, so no result is more likely than another. Even n = 1
 * uses up a word: the stream's position must not depend on what the answer turned out to be.
 */
export function streamRng(seed: Uint8Array): Rng {
  let block = 0;
  let words: DataView = new DataView(new ArrayBuffer(0));
  let at = 0;
  const next = () => {
    if (at >= words.byteLength) {
      const hash = sha256(concat([seed, le(block, 4)]));
      words = new DataView(hash.buffer);
      block++;
      at = 0;
    }
    const word = words.getUint32(at, true);
    at += 4;
    return word;
  };
  return (n) => {
    if (!Number.isInteger(n) || n < 1 || n >= TWO_32) throw new Error(`Can't roll a number below ${n}`);
    const limit = TWO_32 - (TWO_32 % n);
    let word = next();
    while (word >= limit) word = next();
    return word % n;
  };
}
