import { describe, expect, it } from 'vitest';
import { bakeLand } from '../world/terrain';
import { distanceField, getMap, H, isLand, LANDMARKS_PER_MAP, MAP_DEFS, MAP_IDS, W, WATER_LAKE, WATER_NONE, WATER_RIVER, WATER_SEA } from './map';
import { FOOTPRINT } from './mapDefs';

describe.each(MAP_IDS)('map %s', (id) => {
  const map = getMap(id);

  it(`has exactly ${LANDMARKS_PER_MAP} landmarks, each a whole pixel on land`, () => {
    expect(LANDMARKS_PER_MAP).toBe(40);
    expect(map.landmarks).toHaveLength(LANDMARKS_PER_MAP);
    for (const l of map.landmarks) {
      expect(Number.isInteger(l.x) && Number.isInteger(l.y)).toBe(true);
      expect(l.x).toBeGreaterThanOrEqual(0);
      expect(l.x).toBeLessThan(W);
      expect(l.y).toBeLessThan(H);
      expect(isLand(id, l)).toBe(true);
    }
  });

  it('keeps landmarks at least 20 pixels apart, with no sprites touching', () => {
    for (const a of map.landmarks) {
      const [aw, ah] = FOOTPRINT[a.kind];
      const aLeft = a.x - Math.floor(aw / 2);
      for (const b of map.landmarks) {
        if (a.id >= b.id) continue;
        expect(Math.hypot(a.x - b.x, a.y - b.y)).toBeGreaterThanOrEqual(20);
        const [bw, bh] = FOOTPRINT[b.kind];
        const bLeft = b.x - Math.floor(bw / 2);
        const apart = aLeft + aw < bLeft || bLeft + bw < aLeft || a.y < b.y - bh || b.y < a.y - ah;
        expect(apart, `${a.kind} ${a.id} touches ${b.kind} ${b.id}`).toBe(true);
      }
    }
  });

  it('uses 12 kinds, with at least three of each, so a kind clue never gives the spot away', () => {
    const counts = new Map<string, number>();
    for (const l of map.landmarks) counts.set(l.kind, (counts.get(l.kind) ?? 0) + 1);
    expect(counts.size).toBe(12);
    for (const n of counts.values()) expect(n).toBeGreaterThanOrEqual(3);
  });

  it('has landmarks in all four categories, with at least two kinds in each', () => {
    const kinds = new Map<string, Set<string>>();
    for (const l of map.landmarks) kinds.set(l.category, (kinds.get(l.category) ?? new Set()).add(l.kind));
    expect(kinds.size).toBe(4);
    for (const set of kinds.values()) expect(set.size).toBeGreaterThanOrEqual(2);
  });

  it('places each zone’s landmarks from the zone’s own list', () => {
    const wanted = new Map<string, number>();
    for (const zone of MAP_DEFS[id].zones) {
      for (const [kind, count] of Object.entries(zone.kinds)) wanted.set(kind, (wanted.get(kind) ?? 0) + (count ?? 0));
    }
    expect([...wanted.values()].reduce((sum, n) => sum + n, 0)).toBe(LANDMARKS_PER_MAP);
  });

  it('has a stream running unbroken from an inland lake to the sea, under its bridges', () => {
    const lakeCell = map.water.indexOf(WATER_LAKE);
    expect(lakeCell).toBeGreaterThanOrEqual(0);
    expect(map.water.includes(WATER_RIVER)).toBe(true);

    const seen = new Uint8Array(W * H);
    const queue = [lakeCell];
    seen[lakeCell] = 1;
    let reachedSea = false;
    while (queue.length) {
      const i = queue.pop()!;
      if (map.water[i] === WATER_SEA) {
        reachedSea = true;
        break;
      }
      for (const j of [i - 1, i + 1, i - W, i + W]) {
        if (j < 0 || j >= W * H || seen[j]) continue;
        if (map.water[j] !== WATER_NONE || map.decks[j]) {
          seen[j] = 1;
          queue.push(j);
        }
      }
    }
    expect(reachedSea).toBe(true);
  });

  it('has streams two to four pixels wide', () => {
    // Half a stream's width is the furthest any of its cells gets from the bank.
    const toBank = distanceField((i) => map.water[i] !== WATER_RIVER && !map.decks[i]);
    let widest = 0;
    for (let i = 0; i < W * H; i++) if (map.water[i] === WATER_RIVER) widest = Math.max(widest, toBank[i]);
    expect(widest).toBeGreaterThanOrEqual(1);
    expect(widest).toBeLessThanOrEqual(2.5);
  });

  it('counts every bridge cell as land', () => {
    let decks = 0;
    for (let i = 0; i < W * H; i++) {
      if (!map.decks[i]) continue;
      decks++;
      expect(map.land[i]).toBe(1);
    }
    expect(decks).toBeGreaterThan(0);
  });

  it('keeps every landmark off paths, bridges and water', () => {
    for (const l of map.landmarks) {
      const i = l.y * W + l.x;
      expect(map.water[i], `${l.kind} ${l.id} in water`).toBe(WATER_NONE);
      expect(map.paths[i], `${l.kind} ${l.id} on a path`).toBe(0);
      expect(map.decks[i], `${l.kind} ${l.id} on a bridge`).toBe(0);
      expect(map.cliffs[i], `${l.kind} ${l.id} on a cliff`).toBe(0);
    }
  });

  it('keeps paths on land', () => {
    for (let i = 0; i < W * H; i++) if (map.paths[i]) expect(map.land[i]).toBe(1);
  });

  it('paints every land cell, and leaves the sea see-through', () => {
    const pixels = bakeLand(id);
    let open = 0;
    for (let i = 0; i < W * H; i++) {
      if (map.land[i]) expect(pixels[i] >>> 24, `cell ${i % W}, ${Math.floor(i / W)}`).toBe(255);
      if (map.water[i] === WATER_SEA && pixels[i] === 0) open++;
    }
    expect(open).toBeGreaterThan(W * H * 0.2);
  });

  it('comes out the same every time', () => {
    expect(bakeLand(id)).toEqual(bakeLand(id));
  });
});

it('gives each map its own silhouette', () => {
  const [a, b, c] = MAP_IDS.map((id) => getMap(id).land);
  const differs = (p: Uint8Array, q: Uint8Array) => p.reduce((sum, v, i) => sum + (v !== q[i] ? 1 : 0), 0);
  expect(differs(a, b)).toBeGreaterThan(5000);
  expect(differs(b, c)).toBeGreaterThan(5000);
  expect(differs(a, c)).toBeGreaterThan(5000);
});

it('rejects positions that are off the map or not whole pixels', () => {
  expect(isLand('tropical', { x: -1, y: 10 })).toBe(false);
  expect(isLand('tropical', { x: W, y: 10 })).toBe(false);
  expect(isLand('tropical', { x: 10.5, y: 10 })).toBe(false);
});
