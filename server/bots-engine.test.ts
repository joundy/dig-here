import assert from 'node:assert/strict';
import { resolve } from 'node:path';
import { after, test } from 'node:test';
import { methodOf, sleepMs, startStubRpc, viewResult } from './stub-rpc.ts';

const NEAR = 10n ** 24n;
const signed: string[] = [];
const stub = await startStubRpc(async (call) => {
  const method = methodOf(call);
  if (method === 'view_account') return { amount: (10n * NEAR).toString(), locked: '0', storage_usage: 200 };
  if (method === 'view_access_key') return { nonce: 1, permission: 'FullAccess' };
  if (method === 'get_account') return viewResult({ balance: NEAR.toString() });
  if (method === 'get_config') return viewResult({ mint_price: 500 });
  if (method === 'block') return { header: { hash: '11111111111111111111111111111111', height: 100 } };
  if (method === 'send_tx') {
    signed.push(Buffer.from(call.params.signed_tx_base64, 'base64').toString('latin1'));
    return { status: { SuccessValue: '' }, transaction_outcome: { outcome: { tokens_burnt: '0' } }, receipts_outcome: [] };
  }
  throw new Error(`UNEXPECTED_${method}`);
});
process.env.RPC_PRIMARY = stub.url;
process.env.RPC_FALLBACK = stub.url;
after(() => stub.server.close());

const { Bots } = await import('./bots.ts');
const { PROJECT_ROOT } = await import('./config.ts');
const { openDb } = await import('./db.ts');
const { deriveKeyPair } = await import('./keys.ts');
const { NearAccount } = await import('./signer.ts');

async function engine(market: any = null, over: object = {}) {
  const watchers: Array<(frame: any) => void> = [];
  const state: any = { market, demand: { active: () => true }, onPoll: (fn: any) => watchers.push(fn) };
  const config: any = {
    contract: 'game.test', marketContract: 'market.test', botsParent: 'bots.test', botCount: 8, keySeed: 's', botsBudget: 8n * NEAR, botNftMints: 0,
    botTradeEverySec: 3600, botMaxBuy: NEAR, botHoldMinSec: 60, botHoldMaxSec: 60, mapDataDir: resolve(PROJECT_ROOT, 'contract/data'), ...over,
  };
  const funding: any = { rootCanSpend: async () => true, topUp: async () => 0n };
  const root = new NearAccount('root.test', 'test', [deriveKeyPair('s', 'root')]);
  const bots = new Bots(config, openDb(':memory:'), state, funding, root);
  await bots.start();
  // No tips stops the bots hosting rooms of their own, so every send here is about the rooms in the frame.
  const tick = (rooms: any[], nowMs: number) => watchers.forEach((fn) => fn({ live: { now_ms: nowMs, rooms, commitments_left: 0 } }));
  return { tick };
}

const waitingRoom = (room_id: number, over: object = {}) => ({
  room_id, host: 'farmer.testnet', status: 'waiting', fee: 50, host_cut_bps: 1000, min_players: 4, max_players: 8, players: ['farmer.testnet'],
  start_at_ms: null, countdown_sec: 0, deadline_ms: Date.now() + 800_000, ...over,
});

const joinsOf = (id: number) => signed.filter((tx) => tx.includes('join') && tx.includes(`{"room_id":${id}}`)).length;

async function runTicks(tick: (rooms: any[], now: number) => void, rooms: any[], ms: number) {
  const stop = Date.now() + ms;
  while (Date.now() < stop) {
    tick(rooms, Date.now());
    await sleepMs(100);
  }
}

test('real bots stay out of a greedy room, join a modest one, and stop at the limit per host', async () => {
  signed.length = 0;
  const { tick } = await engine();
  const greedyFee = waitingRoom(1, { fee: 200 });
  const greedyCut = waitingRoom(2, { host_cut_bps: 2000 });
  const modest = [3, 4, 5, 6].map((id) => waitingRoom(id));
  await runTicks(tick, [greedyFee, greedyCut, ...modest], 5000);
  assert.equal(joinsOf(1), 0, 'fee over the limit');
  assert.equal(joinsOf(2), 0, 'host cut over the limit');
  const roomsJoined = [3, 4, 5, 6].filter((id) => joinsOf(id) > 0);
  assert.equal(roomsJoined.length, 3, `joined rooms ${roomsJoined}, ${signed.length} sends`);
});

test('a bot-hosted room is unaffected by the limits on human rooms', async () => {
  signed.length = 0;
  const { tick } = await engine();
  const own = waitingRoom(7, { host: 'vega.bots.test', fee: 100, host_cut_bps: 2000, players: ['juror.testnet'] });
  await runTicks(tick, [own], 2500);
  assert.ok(joinsOf(7) > 0);
});

test('bots hold their digs while a roll is locked', async () => {
  signed.length = 0;
  const { tick } = await engine();
  const now = Date.now();
  const landmarks = Array.from({ length: 40 }, (_, i) => [i, 0, 0]);
  const live = (locked: boolean) => ({
    room_id: 8, host: 'vega.bots.test', status: 'live', players: ['wren.bots.test', 'willow.bots.test'], digs: [], clues: [{}], candidates: [1, 2], landmarks, map: 'tropical', locked,
    // Past every bot's chosen moment, and still well before the end.
    started_ms: now - 590_000 * 0.97, ends_at_ms: now + 600_000 * 0.03, duration_sec: 600,
  });
  await runTicks(tick, [live(true)], 1500);
  const digsOf = () => signed.filter((tx) => tx.includes('"seen_clue"')).length;
  assert.equal(digsOf(), 0, 'digs sent during the lock would only be refused');
  await runTicks(tick, [live(false)], 1500);
  assert.ok(digsOf() > 0, 'and they dig once it has been revealed');
});

test('a bot lists what it holds through the market, with the deposit and message it needs', async () => {
  signed.length = 0;
  const market = { listings: [], nfts: [{ token_id: 'snowy:seal', owner: 'vega.bots.test' }, { token_id: 'snowy:pine', owner: 'someone.testnet' }] };
  const { tick } = await engine(market);
  await runTicks(tick, [], 300);
  const approvals = signed.filter((tx) => tx.includes('nft_approve'));
  assert.equal(approvals.length, 1, 'one at a time');
  assert.ok(approvals[0].includes('snowy:seal') && approvals[0].includes('market.test') && approvals[0].includes('\\"price\\":\\"'), approvals[0]);
  assert.ok(!signed.some((tx) => tx.includes('list_nft') || tx.includes('buy_nft')), 'the old methods are gone');
});

test('a bot buys a bot\'s listing through the market, and leaves a human\'s alone', async () => {
  signed.length = 0;
  const price = (NEAR / 10n).toString();
  const listing = { approval_id: 1, in_progress: false, stale: false };
  const market = {
    listings: [{ ...listing, token_id: 'snowy:seal', seller: 'vega.bots.test', price }, { ...listing, token_id: 'snowy:pine', seller: 'human.testnet', price }],
    nfts: [{ token_id: 'snowy:seal', owner: 'vega.bots.test' }, { token_id: 'snowy:pine', owner: 'human.testnet' }],
  };
  // The listing step needs nothing here, so the trade comes straight after it.
  const { tick } = await engine(market, { botTradeEverySec: 0 });
  await runTicks(tick, [], 600);
  const buys = signed.filter((tx) => tx.includes('"token_id"') && tx.includes('buy'));
  assert.ok(buys.length >= 1, `${signed.length} sends`);
  assert.ok(buys.every((tx) => tx.includes('snowy:seal') && tx.includes('market.test')), 'only the bot\'s own listing');
});
