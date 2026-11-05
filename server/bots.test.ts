import assert from 'node:assert/strict';
import { resolve } from 'node:path';
import { test } from 'node:test';
import { aim, askingPrice, BOT_JOIN_LIMITS, botsWillJoin, botTarget, chooseBotTrade, designRoom, digPercent, HumanRoomLimit, unlistedBotNfts } from './bot-brain.ts';
import { PROJECT_ROOT } from './config.ts';
import { isLand, loadMaps } from './map-data.ts';

const maps = loadMaps(resolve(PROJECT_ROOT, 'contract/data'));
const isBot = (id: string) => id.endsWith('.bots');

test('map files load with every spot on land', () => {
  for (const map of Object.values(maps)) {
    assert.ok(map.spots.length > 100);
    assert.ok(map.spots.every((s) => isLand(map, s.x, s.y)));
  }
  assert.equal(isLand(maps.desert, -1, 5), false);
  assert.equal(isLand(maps.desert, 320, 5), false);
});

test('a bot aims on land near a landmark that still fits the clues', () => {
  const landmarks = Array.from({ length: 40 }, (_, i) => [i, 0, 0]);
  for (let i = 0; i < 200; i++) {
    const room = { candidates: [3, 11], landmarks, digs: [] };
    const p = aim(room, maps.tropical, 1 + (i % 12));
    assert.ok(isLand(maps.tropical, p.x, p.y));
    const near = [3, 11].map((id) => maps.tropical.spots[id]).some((s) => Math.abs(s.x - p.x) <= 12 && Math.abs(s.y - p.y) <= 12);
    assert.ok(near);
  }
});

test('dig times spread out and leave the final seconds alone', () => {
  const values = Array.from({ length: 500 }, () => digPercent());
  assert.ok(values.every((v) => v >= 3 && v <= 96));
  assert.ok(values.some((v) => v < 30) && values.some((v) => v > 80));
});

test('rooms stay within the cheap ranges', () => {
  for (let i = 0; i < 300; i++) {
    const room = designRoom('snowy');
    assert.ok(room.fee >= 10 && room.fee <= 100);
    assert.ok(room.min_players >= 2 && room.max_players >= room.min_players && room.max_players <= 30);
    assert.ok([60, 180, 300, 600].includes(room.duration_sec));
    assert.ok([0, 30, 60, 120].includes(room.countdown_sec));
    assert.ok(room.host_cut_bps <= 2000);
  }
});

test('bots never fill a room past its maximum', () => {
  for (let i = 0; i < 300; i++) {
    const humans = ['juror.testnet', 'other.testnet'].slice(0, 1 + (i % 2));
    const room = { players: humans, host: 'juror.testnet', min_players: 2, max_players: 2 + (i % 4) };
    const target = botTarget(room, isBot, 8);
    assert.ok(target + humans.length <= room.max_players, `${target} bots with ${humans.length} humans in ${room.max_players}`);
  }
  const lone = { players: ['juror.testnet'], host: 'a.bots', min_players: 3, max_players: 6 };
  assert.ok(botTarget(lone, isBot, 8) >= 2, 'a lone juror gets enough bots to start');
});

test('a human-hosted room is only for bots at a modest fee and host cut', () => {
  assert.deepEqual(BOT_JOIN_LIMITS, { max_fee_milli: 50, max_host_cut_bps: 1000 });
  assert.equal(botsWillJoin({ fee: 50, host_cut_bps: 1000 }), true);
  assert.equal(botsWillJoin({ fee: 10, host_cut_bps: 0 }), true);
  assert.equal(botsWillJoin({ fee: 51, host_cut_bps: 0 }), false);
  assert.equal(botsWillJoin({ fee: 10, host_cut_bps: 1001 }), false);
  assert.equal(botsWillJoin({ fee: 200, host_cut_bps: 2000 }), false);
});

test('each human host gets bots in a few rooms an hour, and a room already counted stays allowed', () => {
  const limit = new HumanRoomLimit(3);
  const t = 1_000_000;
  assert.equal(limit.allow('a', 1, t), true);
  assert.equal(limit.allow('a', 1, t + 10), true);
  assert.equal(limit.allow('a', 2, t + 20), true);
  assert.equal(limit.allow('a', 3, t + 30), true);
  assert.equal(limit.allow('a', 4, t + 40), false);
  assert.equal(limit.allow('a', 2, t + 50), true);
  assert.equal(limit.allow('b', 5, t + 60), true, 'hosts are counted apart');
  assert.equal(limit.allow('a', 4, t + 3_600_001), true, 'the oldest fell out of the hour');
});

const NEAR = 10n ** 24n;
const row = (token_id: string, seller: string, price: bigint, over: object = {}) => ({ token_id, seller, price: price.toString(), in_progress: false, stale: false, ...over });

test('a bot asks a little over the mint price', () => {
  assert.equal(askingPrice(500, () => 0), (55n * NEAR) / 100n);
  assert.equal(askingPrice(500, () => 0.999999), (80n * NEAR) / 100n);
});

test('every NFT a bot holds with nothing good on the market needs listing', () => {
  const nfts = [
    { token_id: 'a', owner: 'x.bots' }, { token_id: 'b', owner: 'y.bots' }, { token_id: 'c', owner: 'z.bots' },
    { token_id: 'd', owner: 'human' }, { token_id: 'e', owner: null },
  ];
  const listings = [row('a', 'x.bots', NEAR), row('c', 'old.bots', NEAR, { stale: true })];
  assert.deepEqual(unlistedBotNfts(nfts, listings, isBot).map((n) => n.token_id), ['b', 'c']);
});

test('bots only ever buy a bot\'s listing, within the limit, and never their own', () => {
  const wallets = [{ id: 'x.bots', spare: 2n * NEAR }, { id: 'y.bots', spare: 2n * NEAR }];
  const max = NEAR;
  assert.equal(chooseBotTrade([row('h', 'human', NEAR / 2n)], wallets, isBot, max), null, 'a human could farm the budget');
  assert.equal(chooseBotTrade([row('p', 'x.bots', 2n * NEAR)], wallets, isBot, max), null, 'over the limit');
  assert.equal(chooseBotTrade([row('s', 'x.bots', NEAR / 2n, { stale: true })], wallets, isBot, max), null, 'stale');
  assert.equal(chooseBotTrade([row('f', 'x.bots', NEAR / 2n, { in_progress: true })], wallets, isBot, max), null, 'being sold');
  assert.equal(chooseBotTrade([row('o', 'x.bots', NEAR / 2n)], [wallets[0]], isBot, max), null, 'no other bot to buy it');
  for (let i = 0; i < 50; i++) {
    const trade = chooseBotTrade([row('a', 'x.bots', NEAR / 2n)], wallets, isBot, max)!;
    assert.deepEqual([trade.token_id, trade.buyer, trade.short], ['a', 'y.bots', 0n]);
  }
});

test('a buyer short of coins is the closest to affording it, and says how short', () => {
  const trade = chooseBotTrade([row('a', 's.bots', NEAR)], [{ id: 'x.bots', spare: NEAR / 4n }, { id: 'y.bots', spare: NEAR / 2n }], isBot, NEAR)!;
  assert.deepEqual([trade.buyer, trade.short], ['y.bots', NEAR / 2n]);
});
