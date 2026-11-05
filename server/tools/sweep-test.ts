// A real guest gets created through the running backend, then swept, and the browser key must stop working.
import { KeyPair } from 'near-api-js';
import { openDb } from '../db.ts';
import { sleep } from '../log.ts';
import { viewAccount, viewFunction } from '../rpc.ts';
import { NearAccount } from '../signer.ts';
import { Sweeper } from '../sweeper.ts';
import { toNear } from '../units.ts';
import { c, config } from './lib.ts';

const key = KeyPair.fromRandom('ed25519');
const res = await fetch('http://localhost:8787/api/guest-accounts', {
  method: 'POST',
  headers: { 'content-type': 'application/json', origin: 'http://localhost:5173' },
  body: JSON.stringify({ public_key: key.getPublicKey().toString() }),
});
const body: any = await res.json();
if (!res.ok) throw new Error(JSON.stringify(body));
const id = body.account_id;
const guest = new NearAccount(id, 'guest', [key]);
console.log('guest', id);
await sleep(4000);
const [gameBefore, walletBefore, rootBefore] = await Promise.all([
  viewFunction<any>(c, 'get_account', { id }),
  viewAccount(id),
  viewAccount(config.rootAccount),
]);
console.log('holds', toNear(gameBefore.balance), 'in the game and', toNear(walletBefore!.amount), 'in its wallet');

const db = openDb(config.dbPath);
const state: any = { current: { frame: { live: { rooms: [] } } } };
const started = Date.now();
const sweeper = new Sweeper(config, db, state);
const result = await sweeper.sweep(id);
console.log('swept', result, `${Date.now() - started} ms`);
await sleep(3000);

const after = await viewAccount(id);
const rootAfter = await viewAccount(config.rootAccount);
console.log('account gone', after === null, 'root gained', toNear(BigInt(rootAfter!.amount) - BigInt(rootBefore!.amount)));
console.log('game balance now', toNear((await viewFunction<any>(c, 'get_account', { id })).balance));
const bad = await guest.call(c, 'poke', { room_id: 1 }, 5, 0n, { giveUpMs: 0, resign: false }).catch((e: Error) => ({ ok: false, failure: e.message }));
console.log('browser key after the sweep', bad.ok ? 'STILL WORKS' : `refused: ${String((bad as any).failure).slice(0, 80)}`);
