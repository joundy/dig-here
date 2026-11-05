import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import generateMapData from '../../../scripts/gen-map-data';
import generateVectors from '../../../scripts/gen-vectors';
import economySource from './economy.ts?raw';
import engineSource from './engine.ts?raw';
import cluesSource from './clues.ts?raw';
import mapData from './generated/map-data.json';
import { getGrids, H, isLand, MAP_IDS, rollLayout, rosterOf, W } from './map';
import { sha256, streamRng, fromHex, toHex } from './random';

const onDisk = (path: string) => readFileSync(new URL(`../../../${path}`, import.meta.url));
const asBytes = (contents: string | Uint8Array) => (typeof contents === 'string' ? new TextEncoder().encode(contents) : contents);

function expectMatchesDisk(outputs: Record<string, string | Uint8Array>, command: string) {
  for (const [path, contents] of Object.entries(outputs)) {
    expect(toHex(sha256(new Uint8Array(onDisk(path)))), `${path} has drifted: run ${command}`).toBe(toHex(sha256(asBytes(contents))));
  }
}

describe('generated map data', () => {
  it('is what the generator makes from today\'s maps', () => {
    expectMatchesDisk(generateMapData(), 'npm run gen-map-data');
  });

  it('keeps the contract\'s data under 40 KB', () => {
    const total = MAP_IDS.reduce((sum, id) => sum + onDisk(`contract/data/land-${id}.bin`).length + onDisk(`contract/data/spots-${id}.bin`).length, 0);
    expect(total).toBeLessThan(40 * 1024);
  });

  it.each(MAP_IDS)('has a bitmap for %s that matches the carved land, bit by bit', (id) => {
    const bitmap = onDisk(`contract/data/land-${id}.bin`);
    expect(bitmap.length).toBe((W * H) / 8);
    const { land } = getGrids(id);
    for (let y = 0; y < H; y++) {
      for (let x = 0; x < W; x++) {
        const i = y * W + x;
        expect((bitmap[i >> 3] >> (i & 7)) & 1).toBe(land[i]);
      }
    }
  });

  it.each(MAP_IDS)('has the same spots in both formats for %s', (id) => {
    const file = onDisk(`contract/data/spots-${id}.bin`);
    const view = new DataView(file.buffer, file.byteOffset, file.length);
    const spots = mapData.maps[id].spots;
    expect(file.length).toBe(spots.length * 6);
    spots.forEach(([x, y, tags, kindMask], i) => {
      expect([view.getUint16(i * 6, true), view.getUint8(i * 6 + 2), view.getUint8(i * 6 + 3), view.getUint16(i * 6 + 4, true)]).toEqual([x, y, tags, kindMask]);
    });
    expect(mapData.maps[id].kinds).toEqual(rosterOf(id));
  });
});

describe('shared test vectors', () => {
  const vectors = JSON.parse(new TextDecoder().decode(onDisk('contract/tests/vectors.json')));

  it('are what the generator makes from today\'s rules', () => {
    expectMatchesDisk(generateVectors(), 'npm run gen-vectors');
  });

  it('come out the same on every run', () => {
    expect(generateVectors()).toEqual(generateVectors());
  });

  it('have at least 50 cases in every area', () => {
    for (const [area, cases] of Object.entries(vectors)) {
      if (area === 'rules' || area === 'map_facts') continue;
      expect((cases as unknown[]).length, area).toBeGreaterThanOrEqual(50);
    }
  });

  it('reach the edge cases they claim to', () => {
    const { below_streams: below, treasure_rolls: treasure, settlements, refunds, rankings, season_closes: closes, crowding, scores } = vectors;
    expect(below.some((c: { ns: number[] }) => c.ns.includes(1))).toBe(true);
    expect(treasure.filter((c: { draws: number }) => c.draws === 121).length).toBeGreaterThan(0);
    for (const reason of ['too-few-digs', 'expired', 'missed-reveal']) expect(refunds.some((c: { reason: string }) => c.reason === reason)).toBe(true);
    expect(crowding.some((c: { crowded: boolean }) => c.crowded)).toBe(true);
    expect(crowding.some((c: { crowded: boolean }) => !c.crowded)).toBe(true);
    expect(scores.some((c: { closeness: number }) => c.closeness === 0)).toBe(true);
    expect(scores.some((c: { closeness: number }) => c.closeness === 1000)).toBe(true);
    // The cap: a win that took all it could, rather than 80% of the jackpot.
    expect(settlements.some((c: { pot: number; jackpot_win: { amount: number } | null }) => c.jackpot_win?.amount === c.pot * 100)).toBe(true);
    expect(settlements.some((c: { pot: number; jackpot_win: { amount: number } | null }) => c.jackpot_win && c.jackpot_win.amount < c.pot * 100)).toBe(true);
    expect(settlements.some((c: { season_points: object }) => Object.values(c.season_points).includes(0))).toBe(true);
    expect(settlements.some((c: { deed_paid_to: string | null }) => c.deed_paid_to)).toBe(true);
    expect(rankings.some((c: { scores: number[] }) => c.scores.every((s) => s === 0))).toBe(true);
    expect(closes.some((c: { excluded_suffix: string; prizes: unknown[] }) => c.excluded_suffix && c.prizes.length)).toBe(true);
  });

  it('roll the same layouts when read back from the file', () => {
    for (const c of vectors.layouts) {
      const layout = rollLayout(c.map, streamRng(fromHex(c.seed)));
      expect(layout.map((l) => ({ kind: l.kind, x: l.x, y: l.y, tags: l.tags, flip: l.flip }))).toEqual(c.landmarks);
    }
  });

  it('agree with the land map', () => {
    for (const c of vectors.land_points) expect(isLand(c.map, c)).toBe(c.land);
  });
});

describe('rules code', () => {
  it.each([['engine', engineSource], ['economy', economySource], ['clues', cluesSource]])('%s has nothing a contract could not reproduce', (_, source) => {
    for (const banned of ['Math.random', 'Math.sqrt', 'localeCompare', 'Date.now', 'parseFloat', 'toFixed', 'Infinity']) {
      expect(source.includes(banned), banned).toBe(false);
    }
  });
});
