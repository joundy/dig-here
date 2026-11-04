import type { Category, Kind, Landmark, Point, Rng, Tag } from './types';

export const MAP_W = 1000;
export const MAP_H = 700;

// One fixed map: a future contract only needs this landmark list, not a generator.
const MAP_SEED = 20261103;

export function seededRng(seed: number): Rng {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function blob(cx: number, cy: number, rx: number, ry: number, rng: Rng, points = 140, rough = 0.1): Point[] {
  const waves = [2, 3, 4, 5, 7].map((k) => ({
    k,
    phase: rng() * Math.PI * 2,
    amp: (rough * (0.5 + rng() * 0.5)) / Math.sqrt(k - 1),
  }));
  return Array.from({ length: points }, (_, i) => {
    const t = (i / points) * Math.PI * 2;
    const r = 1 + waves.reduce((sum, w) => sum + w.amp * Math.sin(w.k * t + w.phase), 0);
    return { x: cx + Math.cos(t) * rx * r, y: cy + Math.sin(t) * ry * r };
  });
}

function fitInto(poly: Point[], x0: number, y0: number, x1: number, y1: number): Point[] {
  const xs = poly.map((p) => p.x);
  const ys = poly.map((p) => p.y);
  const [minX, maxX, minY, maxY] = [Math.min(...xs), Math.max(...xs), Math.min(...ys), Math.max(...ys)];
  return poly.map((p) => ({
    x: x0 + ((p.x - minX) / (maxX - minX)) * (x1 - x0),
    y: y0 + ((p.y - minY) / (maxY - minY)) * (y1 - y0),
  }));
}

export function inside(p: Point, poly: Point[]): boolean {
  let hit = false;
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
    const a = poly[i];
    const b = poly[j];
    if (a.y > p.y !== b.y > p.y && p.x < ((b.x - a.x) * (p.y - a.y)) / (b.y - a.y) + a.x) hit = !hit;
  }
  return hit;
}

function segmentDistance(p: Point, a: Point, b: Point): number {
  const dx = b.x - a.x;
  const dy = b.y - a.y;
  const t = Math.max(0, Math.min(1, ((p.x - a.x) * dx + (p.y - a.y) * dy) / (dx * dx + dy * dy)));
  return Math.hypot(p.x - a.x - t * dx, p.y - a.y - t * dy);
}

function shoreDistance(p: Point, poly: Point[]): number {
  let best = Infinity;
  poly.forEach((a, i) => {
    best = Math.min(best, segmentDistance(p, a, poly[(i + 1) % poly.length]));
  });
  return best;
}

const CATEGORY: Record<Kind, Category> = {
  horse: 'animal', cow: 'animal', sheep: 'animal', duck: 'animal',
  palm: 'tree', pine: 'tree', apple: 'tree',
  hut: 'building', windmill: 'building', well: 'building', lighthouse: 'building',
  scarecrow: 'thing', campfire: 'thing', boat: 'thing',
};

// Rarest and most location-picky first, so they still find room.
const PLACEMENT: { kind: Kind; count: number; minShore: number; maxShore: number }[] = [
  { kind: 'lighthouse', count: 3, minShore: 14, maxShore: 34 },
  { kind: 'boat', count: 5, minShore: 8, maxShore: 26 },
  { kind: 'windmill', count: 3, minShore: 90, maxShore: 999 },
  { kind: 'well', count: 3, minShore: 60, maxShore: 999 },
  { kind: 'duck', count: 4, minShore: 12, maxShore: 45 },
  { kind: 'palm', count: 6, minShore: 16, maxShore: 70 },
  { kind: 'pine', count: 7, minShore: 80, maxShore: 999 },
  { kind: 'apple', count: 5, minShore: 50, maxShore: 999 },
  { kind: 'horse', count: 5, minShore: 25, maxShore: 999 },
  { kind: 'cow', count: 4, minShore: 40, maxShore: 999 },
  { kind: 'sheep', count: 5, minShore: 40, maxShore: 999 },
  { kind: 'hut', count: 4, minShore: 30, maxShore: 999 },
  { kind: 'scarecrow', count: 3, minShore: 50, maxShore: 999 },
  { kind: 'campfire', count: 3, minShore: 25, maxShore: 999 },
];

// Sprites are 16 art pixels wide, and one art pixel is about 3 map units.
const MIN_SPACING = 58;
const WATER_NEAR = 70;
const INLAND_FROM = 140;

function build() {
  const rng = seededRng(MAP_SEED);
  // The margin leaves room for the shallows drawn around the coast.
  const island = fitInto(blob(500, 350, 440, 292, rng, 160, 0.13), 66, 56, 934, 644);
  const lake = blob(585, 300, 72, 46, rng, 60, 0.12);
  const hills = [
    blob(300, 250, 130, 70, rng, 50, 0.14),
    blob(690, 480, 150, 75, rng, 50, 0.14),
    blob(360, 500, 95, 55, rng, 50, 0.14),
    blob(800, 270, 80, 60, rng, 50, 0.14),
  ];

  const isLand = (p: Point) => inside(p, island) && !inside(p, lake);
  const coast = (p: Point) => Math.min(shoreDistance(p, island), shoreDistance(p, lake));

  const landmarks: Landmark[] = [];
  for (const rule of PLACEMENT) {
    for (let n = 0; n < rule.count; n++) {
      for (let attempt = 0; attempt < 4000; attempt++) {
        const p = { x: Math.round(rng() * MAP_W), y: Math.round(rng() * MAP_H) };
        if (!isLand(p)) continue;
        const shore = coast(p);
        if (shore < rule.minShore || shore > rule.maxShore) continue;
        if (landmarks.some((l) => Math.hypot(l.x - p.x, l.y - p.y) < MIN_SPACING)) continue;

        const tags: Tag[] = [p.y < MAP_H / 2 ? 'north' : 'south', p.x < MAP_W / 2 ? 'west' : 'east'];
        if (shore < WATER_NEAR) tags.push('water');
        if (shore >= INLAND_FROM) tags.push('inland');
        landmarks.push({
          id: landmarks.length,
          kind: rule.kind,
          category: CATEGORY[rule.kind],
          x: p.x,
          y: p.y,
          tags,
          flip: rng() < 0.5,
        });
        break;
      }
    }
  }

  return {
    hills,
    landmarks,
    isLand,
  };
}

export const MAP = build();

export const isLand = MAP.isLand;
