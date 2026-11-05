import { describe, expect, it } from 'vitest';
import { bakeLand } from '../world/terrain';
import { canStand, distanceField, getGrids, getMap, H, isLand, LANDMARKS_PER_MAP, MAP_DEFS, MAP_IDS, nearestLand, rollLayout, rosterOf, spotsOf, spotTags, TAG_ORDER, W, WATER_LAKE, WATER_NONE, WATER_RIVER, WATER_SEA } from './map';
import { FOOTPRINT } from './mapDefs';
import { sha256, streamRng } from './random';

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

  describe('nearestLand', () => {
  it('walks out of the oasis in the middle of the desert to the nearest land', () => {
    const middle = { x: 160, y: 112 };
    const found = nearestLand('desert', middle);
    expect(isLand('desert', found)).toBe(true);
    for (const id of MAP_IDS) expect(isLand(id, nearestLand(id, middle))).toBe(true);
  });
});

describe('layouts over 500 games', () => {
    const SEEDS = 500;
    const layouts = Array.from({ length: SEEDS }, (_, game) => rollLayout(id, streamRng(sha256(new TextEncoder().encode(`layout-test/${id}/${game}`)))));

    it('always rolls 40 landmarks of the right kinds, from the table, on good ground', () => {
      const spots = new Set(spotsOf(id).map(([x, y]) => `${x},${y}`));
      const roster = Object.entries(MAP_DEFS[id].roster).map(([kind, count]) => `${kind}:${count}`).sort();
      for (const layout of layouts) {
        expect(layout).toHaveLength(LANDMARKS_PER_MAP);
        const counts = new Map<string, number>();
        for (const [index, a] of layout.entries()) {
          expect(a.id).toBe(index);
          counts.set(a.kind, (counts.get(a.kind) ?? 0) + 1);
          expect(spots.has(`${a.x},${a.y}`)).toBe(true);
          const i = a.y * W + a.x;
          expect(map.land[i]).toBe(1);
          expect(map.paths[i]).toBe(0);
          expect(map.decks[i]).toBe(0);
          expect(map.cliffs[i]).toBe(0);
        }
        expect([...counts].map(([kind, count]) => `${kind}:${count}`).sort()).toEqual(roster);
      }
    });

    it('keeps landmarks apart, with no sprites touching and each kind at least 36 pixels from its own', () => {
      for (const layout of layouts) {
        for (const a of layout) {
          const [aw, ah] = FOOTPRINT[a.kind];
          const aLeft = a.x - Math.floor(aw / 2);
          for (const b of layout) {
            if (a.id >= b.id) continue;
            const d2 = (a.x - b.x) ** 2 + (a.y - b.y) ** 2;
            expect(d2).toBeGreaterThanOrEqual(400);
            if (a.kind === b.kind) expect(d2, `${a.kind} ${a.id} and ${b.id}`).toBeGreaterThanOrEqual(36 * 36);
            const [bw, bh] = FOOTPRINT[b.kind];
            const bLeft = b.x - Math.floor(bw / 2);
            const apart = bLeft >= aLeft + aw + 2 || aLeft >= bLeft + bw + 2 || b.y - bh >= a.y + 2 || a.y - ah >= b.y + 2;
            expect(apart, `${a.kind} ${a.id} touches ${b.kind} ${b.id}`).toBe(true);
          }
        }
      }
    });

    it('spreads each kind well, rather than only just meeting the minimum', () => {
      let total = 0;
      let pairs = 0;
      let under50 = 0;
      for (const layout of layouts) {
        for (const a of layout) for (const b of layout) {
          if (a.id >= b.id || a.kind !== b.kind) continue;
          const d = Math.hypot(a.x - b.x, a.y - b.y);
          total += d;
          pairs++;
          if (d < 50) under50++;
        }
      }
      expect(total / pairs).toBeGreaterThan(140);
      expect(under50 / pairs).toBeLessThan(0.002);
    });

    it('differs from game to game', () => {
      const whole = new Set(layouts.map((l) => l.map((a) => `${a.kind}:${a.x},${a.y}`).join(' ')));
      expect(whole.size).toBe(SEEDS);
      let shared = 0;
      for (let g = 1; g < SEEDS; g++) {
        const previous = new Set(layouts[g - 1].map((a) => `${a.kind}:${a.x},${a.y}`));
        shared += layouts[g].filter((a) => previous.has(`${a.kind}:${a.x},${a.y}`)).length;
      }
      // Fewer than 5 of 40 landmarks repeat on average, even with kinds like boats limited to the shore.
      expect(shared / (SEEDS - 1)).toBeLessThan(5);
    });
  });

  describe('spot table', () => {
    const spots = spotsOf(id);
    const roster = rosterOf(id);

    it('holds at most 500 spots, at least 5 pixels apart', () => {
      expect(spots.length).toBeLessThanOrEqual(500);
      for (const [i, a] of spots.entries()) {
        for (const b of spots.slice(i + 1)) expect((a[0] - b[0]) ** 2 + (a[1] - b[1]) ** 2).toBeGreaterThanOrEqual(25);
      }
    });

    it('says exactly which kinds fit, and the tags of the spot', () => {
      const grids = getGrids(id);
      for (const [x, y, tags, kindMask] of spots) {
        expect(kindMask).toBeGreaterThan(0);
        roster.forEach((kind, bit) => expect(canStand(grids, kind, x, y)).toBe((kindMask & (1 << bit)) !== 0));
        expect(TAG_ORDER.filter((_, bit) => tags & (1 << bit))).toEqual(spotTags(grids, x, y));
      }
    });

    it('has enough room for every kind', () => {
      for (const [bit, kind] of roster.entries()) {
        expect(spots.filter((s) => s[3] & (1 << bit)).length, kind).toBeGreaterThanOrEqual(MAP_DEFS[id].roster[kind]! * 8);
      }
    });
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
