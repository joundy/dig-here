import assert from 'node:assert/strict';
import { resolve } from 'node:path';
import { test } from 'node:test';
import { aim, botTarget, designRoom, digPercent } from './bot-brain.ts';
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
