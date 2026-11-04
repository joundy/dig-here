// Turns each map's design into the finished pixel grid and landmark list.
import { CATEGORY, MAP_DEFS } from './mapDefs';
import type { Blob } from './mapDefs';
import type { Landmark, MapId, Point, Rng, Tag } from './types';

export { MAP_IDS, MAP_DEFS } from './mapDefs';

/** The map in pixels. All game positions are whole pixels on this grid. */
export const W = 320;
export const H = 224;

// The shapes are designed in a roomier 1000 by 700 space.
const DESIGN_W = 1000;
const DESIGN_H = 700;
const UNIT = DESIGN_W / W;

// Sprites are 16 art pixels wide.
const MIN_SPACING = 58;
const WATER_NEAR = 70;
const INLAND_FROM = 140;

type Unit = () => number;

function seededUnit(seed: number): Unit {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Repeatable randomness, for tests and for anything that must look the same on every visit. */
export function seededRng(seed: number): Rng {
  const unit = seededUnit(seed);
  return (n) => Math.floor(unit() * n);
}

export const mathRng: Rng = (n) => Math.floor(Math.random() * n);

function outline(shape: Blob, rng: Unit): Point[] {
  const { cx, cy, rx, ry, points, rough, fit } = shape;
  const waves = [2, 3, 4, 5, 7].map((k) => ({
    k,
    phase: rng() * Math.PI * 2,
    amp: (rough * (0.5 + rng() * 0.5)) / Math.sqrt(k - 1),
  }));
  const poly = Array.from({ length: points }, (_, i) => {
    const t = (i / points) * Math.PI * 2;
    const r = 1 + waves.reduce((sum, w) => sum + w.amp * Math.sin(w.k * t + w.phase), 0);
    return { x: cx + Math.cos(t) * rx * r, y: cy + Math.sin(t) * ry * r };
  });
  if (!fit) return poly;
  const [x0, y0, x1, y1] = fit;
  const xs = poly.map((p) => p.x);
  const ys = poly.map((p) => p.y);
  const [minX, maxX, minY, maxY] = [Math.min(...xs), Math.max(...xs), Math.min(...ys), Math.max(...ys)];
  return poly.map((p) => ({
    x: x0 + ((p.x - minX) / (maxX - minX)) * (x1 - x0),
    y: y0 + ((p.y - minY) / (maxY - minY)) * (y1 - y0),
  }));
}

function inside(p: Point, poly: Point[]): boolean {
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

export type GameMap = {
  id: MapId;
  name: string;
  landmarks: Landmark[];
  /** 1 for land, in rows of W. */
  land: Uint8Array;
  hills: Uint8Array;
};

function build(id: MapId): GameMap {
  const def = MAP_DEFS[id];
  const rng = seededUnit(def.seed);
  const lands = def.lands.map((shape) => outline(shape, rng));
  const lakes = def.lakes.map((shape) => outline(shape, rng));
  const hills = def.hills.map((shape) => outline(shape, rng));

  const onLand = (p: Point) => lands.some((poly) => inside(p, poly)) && !lakes.some((poly) => inside(p, poly));
  const coast = (p: Point) => Math.min(...[...lands, ...lakes].map((poly) => shoreDistance(p, poly)));

  const landGrid = new Uint8Array(W * H);
  const hillGrid = new Uint8Array(W * H);
  for (let y = 0; y < H; y++) {
    for (let x = 0; x < W; x++) {
      const p = { x: (x + 0.5) * UNIT, y: (y + 0.5) * UNIT };
      const i = y * W + x;
      landGrid[i] = onLand(p) ? 1 : 0;
      hillGrid[i] = landGrid[i] && hills.some((poly) => inside(p, poly)) ? 1 : 0;
    }
  }

  const spots: Point[] = [];
  const landmarks: Landmark[] = [];
  for (const rule of def.placement) {
    for (let n = 0; n < rule.count; n++) {
      for (let attempt = 0; attempt < 6000; attempt++) {
        const p = { x: Math.round(rng() * DESIGN_W), y: Math.round(rng() * DESIGN_H) };
        const cell = { x: Math.floor(p.x / UNIT), y: Math.floor(p.y / UNIT) };
        if (cell.x >= W || cell.y >= H || !landGrid[cell.y * W + cell.x] || !onLand(p)) continue;
        const shore = coast(p);
        if (shore < rule.minShore || shore > rule.maxShore) continue;
        if (spots.some((s) => Math.hypot(s.x - p.x, s.y - p.y) < MIN_SPACING)) continue;

        const tags: Tag[] = [p.y < DESIGN_H / 2 ? 'north' : 'south', p.x < DESIGN_W / 2 ? 'west' : 'east'];
        if (shore < WATER_NEAR) tags.push('water');
        if (shore >= INLAND_FROM) tags.push('inland');
        spots.push(p);
        landmarks.push({
          id: landmarks.length,
          kind: rule.kind,
          category: CATEGORY[rule.kind],
          x: cell.x,
          y: cell.y,
          tags,
          flip: rng() < 0.5,
        });
        break;
      }
    }
  }

  return { id, name: def.name, landmarks, land: landGrid, hills: hillGrid };
}

const built = new Map<MapId, GameMap>();

export function getMap(id: MapId): GameMap {
  let found = built.get(id);
  if (!found) {
    found = build(id);
    built.set(id, found);
  }
  return found;
}

export function isLand(id: MapId, p: Point): boolean {
  if (!Number.isInteger(p.x) || !Number.isInteger(p.y) || p.x < 0 || p.y < 0 || p.x >= W || p.y >= H) return false;
  return getMap(id).land[p.y * W + p.x] === 1;
}
