import { describe, expect, it } from 'vitest';
import { getMap, H, isLand, MAP_IDS, W } from './map';

describe.each(MAP_IDS)('map %s', (id) => {
  const map = getMap(id);

  it('has exactly 60 landmarks, each a whole pixel on land', () => {
    expect(map.landmarks).toHaveLength(60);
    for (const l of map.landmarks) {
      expect(Number.isInteger(l.x) && Number.isInteger(l.y)).toBe(true);
      expect(l.x).toBeGreaterThanOrEqual(0);
      expect(l.x).toBeLessThan(W);
      expect(l.y).toBeLessThan(H);
      expect(isLand(id, l)).toBe(true);
    }
  });

  it('keeps landmarks far enough apart for their sprites', () => {
    for (const a of map.landmarks) {
      for (const b of map.landmarks) {
        if (a.id < b.id) expect(Math.hypot(a.x - b.x, a.y - b.y)).toBeGreaterThanOrEqual(17);
      }
    }
  });

  it('has at least two of every kind, so a kind clue never gives the spot away alone', () => {
    const counts = new Map<string, number>();
    for (const l of map.landmarks) counts.set(l.kind, (counts.get(l.kind) ?? 0) + 1);
    expect(counts.size).toBe(14);
    for (const n of counts.values()) expect(n).toBeGreaterThanOrEqual(2);
  });

  it('has landmarks in all four categories', () => {
    expect(new Set(map.landmarks.map((l) => l.category)).size).toBe(4);
  });
});

it('rejects positions that are off the map or not whole pixels', () => {
  expect(isLand('tropical', { x: -1, y: 10 })).toBe(false);
  expect(isLand('tropical', { x: W, y: 10 })).toBe(false);
  expect(isLand('tropical', { x: 10.5, y: 10 })).toBe(false);
});
