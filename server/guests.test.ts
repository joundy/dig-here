import assert from 'node:assert/strict';
import { test } from 'node:test';
import { parseEnv } from './config.ts';
import { openDb } from './db.ts';
import { clientIp, GUEST_METHODS, GuestError, Guests, originAllowed } from './guests.ts';
import { deriveKeyPair } from './keys.ts';
import { near, toNear } from './units.ts';

const open = { allowedOrigins: ['https://dig.joundy.dev'], allowLocalOrigins: true };
const strict = { allowedOrigins: ['https://dig.joundy.dev'], allowLocalOrigins: false };

test('only the game itself may ask for a guest', () => {
  assert.equal(originAllowed(strict, 'https://dig.joundy.dev', 'other'), true);
  assert.equal(originAllowed(strict, 'https://a.example', 'a.example'), true);
  assert.equal(originAllowed(strict, 'https://evil.example', 'dig.joundy.dev'), false);
  assert.equal(originAllowed(strict, undefined, 'dig.joundy.dev'), false);
  assert.equal(originAllowed(strict, 'http://localhost:5173', 'x'), false);
  assert.equal(originAllowed(open, 'http://localhost:5173', 'x'), true);
  assert.equal(originAllowed(open, 'not a url', 'x'), false);
});

test('the Cloudflare header only counts when the deploy says traffic really comes through Cloudflare', () => {
  const req: any = { headers: { 'cf-connecting-ip': '1.2.3.4' }, socket: { remoteAddress: '10.0.0.9' } };
  assert.equal(clientIp(req, false), '10.0.0.9');
  assert.equal(clientIp(req, true), '1.2.3.4');
  assert.equal(clientIp({ headers: {}, socket: { remoteAddress: '10.0.0.9' } } as any, true), '10.0.0.9');
});

test('the browser key can use exactly the methods the spec lists', () => {
  assert.deepEqual([...GUEST_METHODS].sort(), ['buy_nft', 'create_room', 'dig', 'join', 'leave', 'list_nft', 'mint_nft', 'poke', 'start']);
  assert.ok(!GUEST_METHODS.includes('withdraw'));
});

test('derived keys are stable, and differ per label', () => {
  const a = deriveKeyPair('seed', 'x').getPublicKey().toString();
  assert.equal(a, deriveKeyPair('seed', 'x').getPublicKey().toString());
  assert.notEqual(a, deriveKeyPair('seed', 'y').getPublicKey().toString());
  assert.match(a, /^ed25519:/);
});

test('env files parse, without quotes or comments getting in', () => {
  assert.deepEqual(parseEnv('A=1\n# B=2\nexport C="x y"\nD=\'z\'\n'), { A: '1', C: 'x y', D: 'z' });
});

test('coin amounts round-trip exactly', () => {
  assert.equal(near('0.3'), 300000000000000000000000n);
  assert.equal(toNear(near('1.25')), '1.2500');
  assert.equal(toNear(-near('0.5')), '-0.5000');
});

function limited(rows: Array<[string, number]>, config: object) {
  const db = openDb(':memory:');
  rows.forEach(([ip, ms], i) => db.prepare('INSERT INTO guests(public_key, account_id, ip_hash, created_ms) VALUES (?, ?, ?, ?)').run(`k${i}`, `a${i}`, ip, ms));
  return new Guests({ guestsParent: 'guests.test', keySeed: 's', guestGas: 1n, guestCredit: 1n, guestsPerIpPerHour: 3, guestDailyCap: 5, ...config } as any, db, {} as any, {} as any);
}

test('a fourth new guest from one IP within the hour is refused', async () => {
  const now = Date.now();
  const guests = limited([['ip', now], ['ip', now], ['ip', now]], {});
  await assert.rejects(guests.request('ed25519:new', 'ip'), (e: GuestError) => e.status === 429);
});

test('the daily cap holds across IPs', async () => {
  const now = Date.now();
  const guests = limited(Array.from({ length: 5 }, (_, i): [string, number] => [`ip${i}`, now - 7_200_000]), {});
  await assert.rejects(guests.request('ed25519:new', 'someone'), (e: GuestError) => e.status === 429);
});
