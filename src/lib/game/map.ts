// Turns each map's design into the finished pixel grids and landmark list. Only plain arithmetic
// goes into anything that affects the rules, so every machine gets the same map, bit for bit.
import { CATEGORY, FOOTPRINT, MAP_DEFS } from './mapDefs';
import type { Field, Hill, MapDef, Oval, Pt, Surface, Zone } from './mapDefs';
import type { Kind, Landmark, MapId, Point, Rng, Tag } from './types';

export { LANDMARKS_PER_MAP, MAP_IDS, MAP_DEFS } from './mapDefs';

/** The map in pixels. All game positions are whole pixels on this grid. */
export const W = 320;
export const H = 224;

const MIN_SPACING = 20;
const BOX_GAP = 2;
const WATER_NEAR = 22;
const INLAND_FROM = 44;

export const WATER_NONE = 0;
export const WATER_SEA = 1;
export const WATER_LAKE = 2;
export const WATER_RIVER = 3;

export const BEACH_SAND = 1;
export const BEACH_ROCK = 2;

export const PATH_EDGE = 1;
export const PATH_INNER = 2;
export const PATH_MIDDLE = 3;

export const DECK_ACROSS = 1;
export const DECK_DOWN = 2;

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

function lattice(ix: number, iy: number, seed: number): number {
  let h = Math.imul(ix, 374761393) + Math.imul(iy, 668265263) + Math.imul(seed, 1442695041);
  h = Math.imul(h ^ (h >>> 13), 1274126177);
  return ((h ^ (h >>> 16)) >>> 0) / 4294967296;
}

/** Smooth value noise from 0 to 1, with features about one unit across. */
export function noise(x: number, y: number, seed: number): number {
  const ix = Math.floor(x);
  const iy = Math.floor(y);
  const fx = x - ix;
  const fy = y - iy;
  const sx = fx * fx * (3 - 2 * fx);
  const sy = fy * fy * (3 - 2 * fy);
  const top = lattice(ix, iy, seed) * (1 - sx) + lattice(ix + 1, iy, seed) * sx;
  const bottom = lattice(ix, iy + 1, seed) * (1 - sx) + lattice(ix + 1, iy + 1, seed) * sx;
  return top * (1 - sy) + bottom * sy;
}

/** Distance in pixels from each cell to the nearest cell where `isSource` is true. */
export function distanceField(isSource: (i: number) => boolean): Float32Array {
  const d = new Float32Array(W * H).fill(1e6);
  for (let i = 0; i < d.length; i++) if (isSource(i)) d[i] = 0;
  const relax = (i: number, from: number, cost: number) => {
    if (d[from] + cost < d[i]) d[i] = d[from] + cost;
  };
  const SQRT2 = 1.414;
  for (let y = 0; y < H; y++) {
    for (let x = 0; x < W; x++) {
      const i = y * W + x;
      if (x > 0) relax(i, i - 1, 1);
      if (y > 0) relax(i, i - W, 1);
      if (x > 0 && y > 0) relax(i, i - W - 1, SQRT2);
      if (x < W - 1 && y > 0) relax(i, i - W + 1, SQRT2);
    }
  }
  for (let y = H - 1; y >= 0; y--) {
    for (let x = W - 1; x >= 0; x--) {
      const i = y * W + x;
      if (x < W - 1) relax(i, i + 1, 1);
      if (y < H - 1) relax(i, i + W, 1);
      if (x < W - 1 && y < H - 1) relax(i, i + W + 1, SQRT2);
      if (x > 0 && y < H - 1) relax(i, i + W - 1, SQRT2);
    }
  }
  return d;
}

/** A smooth curve through the points, `steps` samples to a span. */
function spline(points: readonly Pt[], closed: boolean, steps: number): Point[] {
  const n = points.length;
  const at = (i: number): Pt => (closed ? points[(i + n) % n] : points[Math.max(0, Math.min(n - 1, i))]);
  const out: Point[] = [];
  const spans = closed ? n : n - 1;
  for (let i = 0; i < spans; i++) {
    const [a, b, c, d] = [at(i - 1), at(i), at(i + 1), at(i + 2)];
    for (let s = 0; s < steps; s++) {
      const t = s / steps;
      const t2 = t * t;
      const t3 = t2 * t;
      const blend = (p0: number, p1: number, p2: number, p3: number) =>
        0.5 * (2 * p1 + (p2 - p0) * t + (2 * p0 - 5 * p1 + 4 * p2 - p3) * t2 + (3 * p1 - p0 - 3 * p2 + p3) * t3);
      out.push({ x: blend(a[0], b[0], c[0], d[0]), y: blend(a[1], b[1], c[1], d[1]) });
    }
  }
  if (!closed) out.push({ x: points[n - 1][0], y: points[n - 1][1] });
  return out;
}

function roughen(curve: Point[], amount: number, scale: number, seed: number): Point[] {
  let travelled = 0;
  return curve.map((p, i) => {
    const next = curve[(i + 1) % curve.length];
    const prev = curve[(i + curve.length - 1) % curve.length];
    const dx = next.x - prev.x;
    const dy = next.y - prev.y;
    const len = Math.sqrt(dx * dx + dy * dy) || 1;
    travelled += len / 2;
    const push = (noise(travelled / scale, 0.5, seed) - 0.5) * 2 + (noise(travelled / (scale / 3), 7.5, seed) - 0.5);
    return { x: p.x + (dy / len) * push * amount, y: p.y - (dx / len) * push * amount };
  });
}

function fillPolygon(poly: Point[], grid: Uint8Array): void {
  for (let y = 0; y < H; y++) {
    const py = y + 0.5;
    const crossings: number[] = [];
    for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
      const a = poly[i];
      const b = poly[j];
      if (a.y > py !== b.y > py) crossings.push(((b.x - a.x) * (py - a.y)) / (b.y - a.y) + a.x);
    }
    crossings.sort((m, n) => m - n);
    for (let c = 0; c + 1 < crossings.length; c += 2) {
      const from = Math.max(0, Math.ceil(crossings[c] - 0.5));
      const to = Math.min(W - 1, Math.floor(crossings[c + 1] - 0.5));
      for (let x = from; x <= to; x++) grid[y * W + x] = 1;
    }
  }
}

function insideOval(x: number, y: number, o: Oval, seed: number): boolean {
  const dx = (x - o.x) / o.rx;
  const dy = (y - o.y) / o.ry;
  const wobble = o.rough ? (noise(x / 11, y / 11, seed) - 0.5) * 2 * o.rough + (noise(x / 4, y / 4, seed + 1) - 0.5) * o.rough : 0;
  return dx * dx + dy * dy < (1 + wobble) * (1 + wobble);
}

function eachCellOf(o: Oval, grow: number, visit: (x: number, y: number, i: number) => void): void {
  const y0 = Math.max(0, Math.floor(o.y - o.ry * (1 + grow)));
  const y1 = Math.min(H - 1, Math.ceil(o.y + o.ry * (1 + grow)));
  const x0 = Math.max(0, Math.floor(o.x - o.rx * (1 + grow)));
  const x1 = Math.min(W - 1, Math.ceil(o.x + o.rx * (1 + grow)));
  for (let y = y0; y <= y1; y++) for (let x = x0; x <= x1; x++) visit(x, y, y * W + x);
}

function stamp(cx: number, cy: number, radius: number, visit: (i: number, distance: number) => void): void {
  const reach = Math.ceil(radius);
  for (let y = Math.max(0, Math.floor(cy) - reach); y <= Math.min(H - 1, Math.floor(cy) + reach); y++) {
    for (let x = Math.max(0, Math.floor(cx) - reach); x <= Math.min(W - 1, Math.floor(cx) + reach); x++) {
      const dx = x + 0.5 - cx;
      const dy = y + 0.5 - cy;
      const distance = Math.sqrt(dx * dx + dy * dy);
      if (distance <= radius) visit(y * W + x, distance);
    }
  }
}

// A rough edge can leave crumbs of plateau behind, which look like mistakes.
function dropSpecks(mask: Uint8Array): void {
  const seen = new Uint8Array(mask.length);
  for (let start = 0; start < mask.length; start++) {
    if (!mask[start] || seen[start]) continue;
    const group = [start];
    seen[start] = 1;
    for (let n = 0; n < group.length; n++) {
      const i = group[n];
      for (const j of [i - 1, i + 1, i - W, i + W]) {
        if (j >= 0 && j < mask.length && mask[j] && !seen[j]) {
          seen[j] = 1;
          group.push(j);
        }
      }
    }
    if (group.length < 90) for (const i of group) mask[i] = 0;
  }
}

export type GameMap = {
  id: MapId;
  name: string;
  landmarks: Landmark[];
  /** 1 for land, in rows of W. Bridges and piers count. */
  land: Uint8Array;
  /** Height of the ground: 0 flat, or which tier of hill. */
  hills: Uint8Array;
  /** Cliff face, counted in rows below its lip. 0 where there is none. */
  cliffs: Uint8Array;
  /** Trails: PATH_EDGE, PATH_INNER or PATH_MIDDLE. 0 off the trail. */
  paths: Uint8Array;
  /** Planks: DECK_ACROSS runs left to right, DECK_DOWN top to bottom. 0 where there are none. */
  decks: Uint8Array;
  /** WATER_SEA, WATER_LAKE or WATER_RIVER. WATER_NONE on land. */
  water: Uint8Array;
  /** BEACH_SAND or BEACH_ROCK along the coast. */
  beach: Uint8Array;
  /** Index into the def's fields plus one. */
  fields: Uint8Array;
  /** How far down the river each river cell is, in pixels. */
  flow: Float32Array;
};

type Grids = Omit<GameMap, 'id' | 'name' | 'landmarks'>;

function carveTerrain(def: MapDef): Grids {
  const size = W * H;
  const land = new Uint8Array(size);
  for (const [n, coast] of def.coasts.entries()) {
    fillPolygon(roughen(spline(coast, true, 8), def.coastRough, def.coastScale, def.seed + n), land);
  }
  const water = new Uint8Array(size);
  for (let i = 0; i < size; i++) water[i] = land[i] ? WATER_NONE : WATER_SEA;

  for (const lake of def.lakes) {
    eachCellOf(lake, 0.5, (x, y, i) => {
      if (land[i] && insideOval(x + 0.5, y + 0.5, lake, def.seed + 3)) {
        land[i] = 0;
        water[i] = WATER_LAKE;
      }
    });
  }

  const flow = new Float32Array(size);
  for (const river of def.rivers) {
    const line = spline(river.points, false, 14);
    let travelled = 0;
    let previous = line[0];
    for (const [n, p] of line.entries()) {
      const dx = p.x - previous.x;
      const dy = p.y - previous.y;
      travelled += Math.sqrt(dx * dx + dy * dy);
      previous = p;
      const along = n / (line.length - 1);
      const half = (river.from + (river.to - river.from) * along) / 2;
      stamp(p.x, p.y, half + 0.2, (i) => {
        if (land[i]) {
          land[i] = 0;
          water[i] = WATER_RIVER;
        }
        if (water[i] === WATER_RIVER) flow[i] = travelled;
      });
    }
  }

  const hills = new Uint8Array(size);
  const faces = new Uint8Array(size);
  const tiers = [...new Set(def.hills.map((hill) => hill.tier ?? 1))].sort();
  const cliffs = new Uint8Array(size);
  for (const tier of tiers) {
    const mask = new Uint8Array(size);
    const inTier = def.hills.filter((hill: Hill) => (hill.tier ?? 1) === tier);
    for (const [n, hill] of inTier.entries()) {
      eachCellOf(hill, 0.6, (x, y, i) => {
        if (land[i] && insideOval(x + 0.5, y + 0.5, hill, def.seed + 10 + n)) {
          mask[i] = 1;
          faces[i] = hill.face ?? 3;
        }
      });
    }
    dropSpecks(mask);
    for (let i = 0; i < size; i++) if (mask[i]) hills[i] = tier;
    // Whichever cliff face hangs off this tier falls on the south side.
    for (let y = 0; y < H - 1; y++) {
      for (let x = 0; x < W; x++) {
        const i = y * W + x;
        if (!mask[i] || mask[i + W]) continue;
        for (let k = 1; k <= faces[i]; k++) {
          const below = i + W * k;
          if (below >= size || !land[below] || mask[below]) break;
          cliffs[below] = k;
        }
      }
    }
  }

  const beach = new Uint8Array(size);
  const toSea = distanceField((i) => water[i] === WATER_SEA);
  for (let y = 0; y < H; y++) {
    for (let x = 0; x < W; x++) {
      const i = y * W + x;
      if (!land[i] || hills[i] || cliffs[i]) continue;
      const wide = def.beach + (noise(x / 15, y / 15, def.seed + 21) - 0.5) * def.beach * 1.1 + (noise(x / 4, y / 4, def.seed + 22) - 0.5) * 1.6;
      if (toSea[i] < wide) beach[i] = BEACH_SAND;
    }
  }
  for (const bluff of def.bluffs) {
    eachCellOf(bluff, 0, (x, y, i) => {
      if (!land[i]) return;
      const dx = (x - bluff.x) / bluff.rx;
      const dy = (y - bluff.y) / bluff.ry;
      if (dx * dx + dy * dy >= 1) return;
      if (beach[i]) beach[i] = BEACH_ROCK;
      if (i + W < size && water[i + W] === WATER_SEA) {
        for (let k = 1; k <= 3; k++) {
          const up = i - W * (k - 1);
          if (up >= 0 && land[up]) cliffs[up] = 4 - k;
        }
      }
    });
  }

  const paths = new Uint8Array(size);
  const decks = new Uint8Array(size);
  for (const [n, trail] of def.trails.entries()) {
    const half = trail.half ?? 2.3;
    const line = spline(trail.points, false, 14);
    const crossing: Point[] = [];
    const span = () => {
      if (!crossing.length) return;
      const first = crossing[0];
      const last = crossing[crossing.length - 1];
      const wide = Math.abs(last.x - first.x) >= Math.abs(last.y - first.y);
      const midX = Math.round((first.x + last.x) / 2);
      const midY = Math.round((first.y + last.y) / 2);
      const x0 = wide ? Math.floor(Math.min(first.x, last.x)) - 2 : midX - 2;
      const x1 = wide ? Math.ceil(Math.max(first.x, last.x)) + 2 : midX + 2;
      const y0 = wide ? midY - 2 : Math.floor(Math.min(first.y, last.y)) - 2;
      const y1 = wide ? midY + 2 : Math.ceil(Math.max(first.y, last.y)) + 2;
      for (let y = y0; y <= y1; y++) {
        for (let x = x0; x <= x1; x++) {
          const i = y * W + x;
          decks[i] = wide ? DECK_ACROSS : DECK_DOWN;
          land[i] = 1;
          water[i] = WATER_NONE;
          hills[i] = 0;
          cliffs[i] = 0;
          beach[i] = 0;
        }
      }
      crossing.length = 0;
    };
    let travelled = 0;
    for (const [s, p] of line.entries()) {
      if (s > 0) {
        const dx = p.x - line[s - 1].x;
        const dy = p.y - line[s - 1].y;
        travelled += Math.sqrt(dx * dx + dy * dy);
      }
      const here = Math.floor(p.y) * W + Math.floor(p.x);
      if (water[here] === WATER_RIVER) {
        crossing.push(p);
        continue;
      }
      span();
      const reach = half + (noise(travelled / 7, n * 3.5, def.seed + 31) - 0.5) * 0.9;
      stamp(p.x, p.y, reach, (i, distance) => {
        if (!land[i] || decks[i]) return;
        const level = distance < 0.75 ? PATH_MIDDLE : distance < reach - 0.7 ? PATH_INNER : PATH_EDGE;
        if (level > paths[i]) paths[i] = level;
      });
    }
    span();
  }

  for (const pier of def.piers) {
    for (let y = pier.y; y < pier.y + pier.h; y++) {
      for (let x = pier.x; x < pier.x + pier.w; x++) {
        const i = y * W + x;
        land[i] = 1;
        water[i] = WATER_NONE;
        decks[i] = DECK_DOWN;
        beach[i] = 0;
      }
    }
  }

  const fields = new Uint8Array(size);
  def.fields.forEach((field: Field, n) => {
    for (let y = field.y; y < field.y + field.h; y++) {
      for (let x = field.x; x < field.x + field.w; x++) {
        const i = y * W + x;
        if (land[i] && !hills[i] && !cliffs[i] && !paths[i] && !beach[i]) fields[i] = n + 1;
      }
    }
  });

  return { land, hills, cliffs, paths, decks, water, beach, fields, flow };
}

function placeLandmarks(def: MapDef, grids: Grids, rng: Unit): Landmark[] {
  const { land, hills, cliffs, paths, decks, water, beach, fields } = grids;
  const toWater = distanceField((i) => !land[i]);
  const landmarks: Landmark[] = [];

  const offLimits = (i: number) => paths[i] > 0 || decks[i] > 0;
  const shoreKinds = new Set<Kind>(['boat', 'seal', 'duck', 'penguin', 'palm']);

  const canStand = (kind: Kind, x: number, y: number, on: Surface): boolean => {
    const [w, h] = FOOTPRINT[kind];
    const left = x - Math.floor(w / 2);
    const top = y - h;
    if (left < 1 || top < 1 || left + w >= W - 1 || y >= H - 1) return false;
    const i = y * W + x;
    if (!land[i]) return false;

    // The feet want level, solid ground, clear of everything that would look wrong underfoot.
    const footLeft = kind === 'boat' ? left + 3 : left + 1;
    const footRight = kind === 'boat' ? left + w - 4 : left + w - 2;
    for (let fy = y - 2; fy <= y + 1; fy++) {
      for (let fx = footLeft; fx <= footRight; fx++) {
        const f = fy * W + fx;
        if (fy === y || fy === y - 1) {
          if (!land[f]) return false;
        }
        if (land[f] && (cliffs[f] || offLimits(f) || hills[f] !== hills[i])) return false;
        if (fields[f] && kind !== 'scarecrow') return false;
      }
    }
    // Nothing paints across a path, a river or a lake. Shore creatures may overlap the water behind them.
    for (let by = top; by < y; by++) {
      for (let bx = left; bx < left + w; bx++) {
        const b = by * W + bx;
        if (offLimits(b)) return false;
        // The lower half stands clear of any cliff, so a sprite never seems stuck in the hillside.
        if (by >= y - h / 2 && land[b] && (cliffs[b] || hills[b] !== hills[i])) return false;
        if (!shoreKinds.has(kind) && !land[b]) return false;
        if (fields[b] && kind !== 'scarecrow') return false;
      }
    }

    for (const other of landmarks) {
      const dx = other.x - x;
      const dy = other.y - y;
      if (dx * dx + dy * dy < MIN_SPACING * MIN_SPACING) return false;
      const [ow, oh] = FOOTPRINT[other.kind];
      const oLeft = other.x - Math.floor(ow / 2);
      const clearX = oLeft >= left + w + BOX_GAP || left >= oLeft + ow + BOX_GAP;
      const clearY = other.y - oh >= y + BOX_GAP || top >= other.y + BOX_GAP;
      if (!clearX && !clearY) return false;
    }

    if (on === 'beach' && !beach[i]) return false;
    if (on === 'waterline' && toWater[i] > 3) return false;
    if (on === 'shore' && toWater[i] > 5) return false;
    if (on === 'hill' && !hills[i]) return false;
    if (on === 'flat' && hills[i]) return false;
    return true;
  };

  const add = (kind: Kind, x: number, y: number) => {
    const shore = toWater[y * W + x];
    const tags: Tag[] = [y < H / 2 ? 'north' : 'south', x < W / 2 ? 'west' : 'east'];
    if (shore < WATER_NEAR) tags.push('water');
    if (shore >= INLAND_FROM) tags.push('inland');
    landmarks.push({ id: landmarks.length, kind, category: CATEGORY[kind], x, y, tags, flip: rng() < 0.5 });
  };

  // The nearest spot to where it was meant to go.
  const near = (kind: Kind, zone: Zone, tx: number, ty: number): Point | null => {
    const on = zone.on ?? 'any';
    for (let reach = 0; reach <= 14; reach++) {
      for (let dy = -reach; dy <= reach; dy++) {
        for (let dx = -reach; dx <= reach; dx++) {
          if (Math.max(Math.abs(dx), Math.abs(dy)) !== reach) continue;
          const x = Math.round(tx) + dx;
          const y = Math.round(ty) + dy;
          if (canStand(kind, x, y, on)) return { x, y };
        }
      }
    }
    return null;
  };

  // Of many random spots, the one with the most room around it.
  const roomiest = (kind: Kind, zone: Zone): Point | null => {
    const on = zone.on ?? 'any';
    let best: Point | null = null;
    let bestRoom = -1;
    for (let tries = 0; tries < 400; tries++) {
      const dx = (rng() * 2 - 1) * zone.r;
      const dy = (rng() * 2 - 1) * zone.r;
      if (dx * dx + dy * dy > zone.r * zone.r) continue;
      const x = Math.round(zone.x + dx);
      const y = Math.round(zone.y + dy);
      if (!canStand(kind, x, y, on)) continue;
      let room = 40;
      for (const other of landmarks) {
        room = Math.min(room, Math.sqrt((other.x - x) ** 2 + (other.y - y) ** 2));
      }
      if (room > bestRoom) {
        bestRoom = room;
        best = { x, y };
      }
    }
    return best;
  };

  let stuck = '';
  const placeAll = (): boolean => {
    for (const zone of def.zones) {
      const kinds = Object.entries(zone.kinds).flatMap(([kind, count]) => Array.from({ length: count ?? 0 }, () => kind as Kind));
      const layout = zone.layout ?? 'scatter';
      for (const [n, kind] of kinds.entries()) {
        let spot: Point | null;
        if (layout === 'ring') {
          const around = kinds.length - 1;
          if (n === 0) spot = near(kind, zone, zone.x, zone.y);
          else {
            // A compass star, so no trigonometry reaches the rules.
            const step = RING[around - 1][n - 1];
            spot = near(kind, zone, zone.x + step[0] * zone.r * 1.2 + (rng() - 0.5) * 3, zone.y + step[1] * zone.r * 0.85 + (rng() - 0.5) * 3);
          }
        } else if (layout === 'line') {
          const [tx, ty] = zone.to ?? [zone.x, zone.y];
          const along = kinds.length > 1 ? n / (kinds.length - 1) : 0.5;
          spot = near(kind, zone, zone.x + (tx - zone.x) * along, zone.y + (ty - zone.y) * along);
        } else {
          spot = roomiest(kind, zone) ?? near(kind, zone, zone.x, zone.y);
        }
        if (!spot) {
          stuck = zone.name;
          return false;
        }
        add(kind, spot.x, spot.y);
      }
    }
    return true;
  };

  // Scattering can paint itself into a corner, so start over from the next rolls. Still repeatable.
  for (let attempt = 0; attempt < 400; attempt++) {
    landmarks.length = 0;
    if (placeAll()) return landmarks;
  }
  throw new Error(`No room for every landmark on ${def.id}, last stuck at ${stuck}`);
}

const RING: Pt[][] = [
  [[0, -1]],
  [[-1, 0], [1, 0]],
  [[-0.87, 0.5], [0.87, 0.5], [0, -1]],
  [[-0.8, -0.65], [0.8, -0.65], [-0.8, 0.65], [0.8, 0.65]],
  [[-0.95, -0.2], [-0.5, 0.85], [0.5, 0.85], [0.95, -0.2], [0, -1]],
];

function build(id: MapId): GameMap {
  const def = MAP_DEFS[id];
  const rng = seededUnit(def.seed);
  const grids = carveTerrain(def);
  return { id, name: def.name, landmarks: placeLandmarks(def, grids, rng), ...grids };
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
