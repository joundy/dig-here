// A real guest against the running backend: generates a browser key, asks for an account,
// and signs join and dig with only that key, timing each step.
//   node server/tools/guest-test.ts [--keep]
import { KeyPair } from 'near-api-js';
import { sleep } from '../log.ts';
import { viewAccount, viewFunction } from '../rpc.ts';
import { NearAccount } from '../signer.ts';
import { near, toNear } from '../units.ts';
import { c, removeAccount, throwaway } from './lib.ts';

const API = process.env.API ?? 'http://localhost:8787';
const before = (await viewAccount('dighere.testnet'))!;

const key = KeyPair.fromRandom('ed25519');
const publicKey = key.getPublicKey().toString();
const t0 = Date.now();
const res = await fetch(`${API}/api/guest-accounts`, {
  method: 'POST',
  headers: { 'content-type': 'application/json', origin: 'http://localhost:5173' },
  body: JSON.stringify({ public_key: publicKey }),
});
const body: any = await res.json();
const tResponse = Date.now() - t0;
console.log('response', res.status, body, `${tResponse} ms`);
if (!res.ok) process.exit(1);

const again = await fetch(`${API}/api/guest-accounts`, {
  method: 'POST',
  headers: { 'content-type': 'application/json', origin: 'http://localhost:5173' },
  body: JSON.stringify({ public_key: publicKey }),
});
console.log('same key again', again.status, await again.json());

const refused = await fetch(`${API}/api/guest-accounts`, { method: 'POST', headers: { 'content-type': 'application/json', origin: 'https://evil.example' }, body: JSON.stringify({ public_key: publicKey }) });
console.log('other origin', refused.status);

const guest = new NearAccount(body.account_id, 'guest', [key]);
const host = await throwaway(`wg${Date.now().toString(36).slice(-5)}`, '0.25');
try {
  const created = await host.call(c, 'create_room', { name: 'Guest test', map: 'snowy', fee: 10, duration_sec: 60, host_cut_bps: 0, min_players: 2, max_players: 4, countdown_sec: 0 }, 60, near('0.13'));
  if (!created.ok) throw new Error(created.failure);
  const id = created.value;
  const t1 = Date.now();
  const joined = await guest.call(c, 'join', { room_id: id }, 10);
  console.log('guest join', joined.ok, joined.failure ?? joined.hash, `${Date.now() - t1} ms`, 'usable (request to joined)', Date.now() - t0, 'ms');
  await host.call(c, 'join', { room_id: id }, 10);
  await host.call(c, 'start', { room_id: id }, 10);
  const room: any = await viewFunction(c, 'get_room', { id });
  const t2 = Date.now();
  const dug = await guest.call(c, 'dig', { room_id: id, x: room.landmarks[3].x, y: room.landmarks[3].y, seen_clue: room.clues.length }, 5);
  console.log('guest dig', dug.ok, dug.failure ?? dug.hash, `${Date.now() - t2} ms`);
  const blocked = await guest.call(c, 'withdraw', { amount: '1' }, 10, 1n).catch((e) => ({ ok: false, failure: e.message }));
  console.log('browser key cannot withdraw', !blocked.ok, String((blocked as any).failure).slice(0, 90));
  console.log('guest game balance', toNear((await viewFunction<any>(c, 'get_account', { id: body.account_id })).balance), 'wallet', toNear((await viewAccount(body.account_id))!.amount));
  const roomGas = await guest.call(c, 'create_room', { name: 'Guest hosts', map: 'tropical', fee: 10, duration_sec: 60, host_cut_bps: 0, min_players: 2, max_players: 4, countdown_sec: 30 }, 60);
  console.log('guest create_room', roomGas.ok, roomGas.failure ?? roomGas.value);
  await sleep(1000);
} finally {
  await sleep(3000);
  console.log('host', host.id, '(deleted once its room has finished, by round cleanup)');
  if (!process.argv.includes('--keep')) await removeAccount(host);
  console.log('root spent', toNear(BigInt(before.amount) - BigInt((await viewAccount('dighere.testnet'))!.amount)));
}
