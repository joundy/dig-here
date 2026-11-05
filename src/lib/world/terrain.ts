// Bakes the island into pixels once, and animates the water by cycling colours by distance from shore.
import {
  BEACH_ROCK, BEACH_SAND, DECK_ACROSS, distanceField, getMap, H, MAP_DEFS, noise,
  PATH_EDGE, PATH_INNER, PATH_MIDDLE, W, WATER_LAKE, WATER_RIVER, WATER_SEA,
} from '../game/map';
import type { GroundKind } from '../game/mapDefs';
import type { MapId } from '../game/types';
import { themeOf } from './themes';

export { W, H } from '../game/map';

function rgba(hex: string): number {
  const n = parseInt(hex.slice(1), 16);
  return (255 << 24) | ((n & 255) << 16) | (n & 0xff00) | (n >> 16);
}

function hash(x: number, y: number): number {
  const s = Math.sin(x * 127.1 + y * 311.7) * 43758.5453;
  return s - Math.floor(s);
}

const BAYER = [0, 8, 2, 10, 12, 4, 14, 6, 3, 11, 1, 9, 15, 7, 13, 5];
const bayer = (x: number, y: number) => BAYER[(y & 3) * 4 + (x & 3)] / 16;

// What a cell ended up as, so later passes know where they may draw.
const OPEN_GROUND = 1;
const HILLTOP = 2;
const SAND = 3;
const ROCK = 4;
const OTHER = 5;

/** The land layer, as canvas pixels. Water cells stay see-through unless something floats on them. */
export function bakeLand(mapId: MapId): Uint32Array {
  const map = getMap(mapId);
  const def = MAP_DEFS[mapId];
  const T = themeOf(mapId).land;
  const { land, hills, cliffs, paths, decks, water, beach, fields } = map;
  const seed = def.seed;
  const size = W * H;
  const px = new Uint32Array(size);
  const kind = new Uint8Array(size);

  const toSea = distanceField((i) => water[i] === WATER_SEA);
  const toFresh = distanceField((i) => water[i] === WATER_LAKE || water[i] === WATER_RIVER);

  const reserved = new Uint8Array(size);

  // Patches of different ground, with crumbly edges.
  const patchOf = new Int8Array(size).fill(-1);
  def.patches.forEach((patch, n) => {
    for (let y = 0; y < H; y++) {
      for (let x = 0; x < W; x++) {
        const dx = (x - patch.x) / patch.rx;
        const dy = (y - patch.y) / patch.ry;
        const e = dx * dx + dy * dy + (noise(x / 9, y / 9, seed + 41 + n) - 0.5) * 0.7 + (bayer(x, y) - 0.5) * 0.12;
        if (e < 1) patchOf[y * W + x] = n;
      }
    }
  });

  const toneOf = (x: number, y: number, tones: [string, string, string]) => {
    const v = 0.7 * noise(x / 26, y / 18, seed + 51) + 0.3 * noise(x / 9, y / 7, seed + 52) + (bayer(x, y) - 0.5) * 0.045;
    return rgba(v < 0.44 ? tones[0] : v < 0.6 ? tones[1] : tones[2]);
  };

  const groundAt = (x: number, y: number): [string, string, string] => {
    const p = patchOf[y * W + x];
    return p < 0 ? T.ground : T.patches[def.patches[p].kind as GroundKind];
  };

  // Base pass.
  for (let y = 0; y < H; y++) {
    for (let x = 0; x < W; x++) {
      const i = y * W + x;
      if (!land[i]) continue;
      let color: number;
      if (decks[i]) {
        kind[i] = OTHER;
        const across = decks[i] === DECK_ACROSS;
        const plank = across ? x % 2 === 0 : y % 2 === 0;
        const sideA = across ? y === 0 || !decks[i - W] : x === 0 || !decks[i - 1];
        const sideB = across ? y === H - 1 || !decks[i + W] : x === W - 1 || !decks[i + 1];
        color = rgba(sideA || sideB ? T.deck.rail : plank ? T.deck.light : T.deck.dark);
      } else if (cliffs[i]) {
        kind[i] = OTHER;
        if (paths[i] >= PATH_INNER) {
          // Steps cut into the rock.
          color = rgba(y % 2 === 0 ? T.path.light : T.path.rut);
        } else {
          const below = i + W < size && land[i + W] && !cliffs[i + W];
          const column = noise(x / 2.3, 3.5, seed + 61);
          if (cliffs[i] === 1 && hash(x, 91) < 0.35) color = rgba(T.hill.drip);
          else if (below) color = rgba(T.hill.face[2]);
          else if (cliffs[i] === 1) color = rgba(T.hill.face[0]);
          else color = rgba(column < 0.36 ? T.hill.face[2] : column < 0.72 ? T.hill.face[1] : T.hill.face[0]);
        }
      } else if (paths[i]) {
        kind[i] = OTHER;
        const r = hash(x + 5, y + 2);
        if (paths[i] === PATH_EDGE) {
          color = r < 0.72 ? rgba(T.path.edge) : hills[i] ? rgba(T.hill.tops[hills[i] - 1][0]) : toneOf(x, y, groundAt(x, y));
        } else if (paths[i] === PATH_MIDDLE) {
          color = rgba(r < 0.12 ? T.path.rut : T.path.light);
        } else {
          color = rgba(r < 0.1 ? T.path.light : T.path.mid);
        }
      } else if (beach[i] === BEACH_ROCK) {
        kind[i] = ROCK;
        const v = noise(x / 3.2, y / 3.2, seed + 71);
        color = rgba(v < 0.38 ? T.rock[0] : v < 0.66 ? T.rock[1] : T.rock[2]);
      } else if (beach[i] === BEACH_SAND) {
        kind[i] = SAND;
        const d = toSea[i] + (noise(x / 5, y / 5, seed + 72) - 0.5) * 1.2;
        const dither = bayer(x, y) * 0.8;
        if (d < 1.3) color = rgba(T.sand.wetter);
        else if (d + dither < 3.2) color = rgba(T.sand.wet);
        else color = rgba(noise(x / 8, y / 6, seed + 73) + (bayer(x, y) - 0.5) * 0.08 < 0.5 ? T.sand.mid : T.sand.light);
      } else if (fields[i]) {
        kind[i] = OTHER;
        const field = def.fields[fields[i] - 1];
        const crop = T.crops[field.crop % T.crops.length];
        const row = (y - field.y) % 3;
        const r = hash(x, y + 41);
        const rim = x === field.x || x === field.x + field.w - 1 || y === field.y || y === field.y + field.h - 1;
        if (rim) color = rgba(T.soil[0]);
        else if (row === 2) color = rgba(T.soil[r < 0.6 ? 0 : 1]);
        else if (row === 0) color = rgba(r < 0.75 ? crop[1] : crop[0]);
        else color = rgba(r < 0.88 ? crop[0] : T.soil[0]);
      } else if (hills[i]) {
        kind[i] = HILLTOP;
        const tones = T.hill.tops[hills[i] - 1];
        color = rgba(noise(x / 10, y / 7, seed + 81) + (bayer(x, y) - 0.5) * 0.08 < 0.5 ? tones[0] : tones[1]);
        if (hills[i] === 1 && noise(x / 11, y / 2.2, seed + 82) > 0.68) color = rgba(T.hill.mark);
      } else {
        kind[i] = OPEN_GROUND;
        color = toneOf(x, y, groundAt(x, y));
      }
      px[i] = color;
    }
  }

  const isLow = (i: number) => kind[i] === OPEN_GROUND || kind[i] === SAND || kind[i] === ROCK;

  // Plateau edges: lit along the top and the lip, shaded on the side away from the sun.
  for (let y = 1; y < H - 1; y++) {
    for (let x = 1; x < W - 1; x++) {
      const i = y * W + x;
      if (kind[i] !== HILLTOP) continue;
      const tier = hills[i];
      const out = (j: number) => hills[j] < tier;
      if (out(i + W) || out(i - W) || out(i - 1)) px[i] = rgba(T.hill.lit);
      else if (out(i + 1)) px[i] = rgba(T.hill.shade);
      else if (out(i + W * 2)) px[i] = rgba(T.hill.tops[tier - 1][1]);
    }
  }
  for (let y = 1; y < H - 1; y++) {
    for (let x = 1; x < W - 1; x++) {
      const i = y * W + x;
      if (kind[i] !== OPEN_GROUND) continue;
      // Around the back of a hill.
      if (hills[i + W] || hills[i + 1] || hills[i - 1]) px[i] = rgba(T.shadow);
    }
  }

  // The shadow at the foot of a cliff.
  for (let y = 1; y < H; y++) {
    for (let x = 0; x < W; x++) {
      const i = y * W + x;
      if (!cliffs[i - W] || cliffs[i] || !land[i]) continue;
      if (paths[i] >= PATH_INNER) continue;
      const shade = kind[i] === SAND ? T.sand.shadow : kind[i] === ROCK ? T.rock[0] : T.shadow;
      if (isLow(i) || kind[i] === HILLTOP) px[i] = rgba(shade);
      const next = i + W;
      if (next < size && land[next] && (x + y) % 2 === 0 && kind[next] === kind[i] && isLow(next)) px[next] = rgba(shade);
    }
  }

  // Where ground drops to the beach.
  for (let y = 1; y < H - 2; y++) {
    for (let x = 0; x < W; x++) {
      const i = y * W + x;
      if (kind[i] === OPEN_GROUND && (kind[i + W] === SAND || kind[i + W] === ROCK)) px[i] = rgba(T.fringe);
      else if (kind[i] === OPEN_GROUND && (kind[i - W] === SAND || kind[i - W] === ROCK)) px[i] = rgba(T.fringe);
      else if (kind[i] === SAND && kind[i - W] === OPEN_GROUND) {
        px[i] = rgba(T.sand.shadow);
        if (kind[i + W] === SAND && (x + y) % 2 === 0) px[i + W] = rgba(T.sand.shadow);
      }
    }
  }

  // Banks of lakes and rivers.
  for (let y = 1; y < H - 1; y++) {
    for (let x = 1; x < W - 1; x++) {
      const i = y * W + x;
      if (!isLow(i) && kind[i] !== HILLTOP) continue;
      if (toFresh[i] < 1.5) px[i] = rgba(T.bank);
      else if (toFresh[i] < 2.5 && (x + y) % 2 === 0) px[i] = rgba(T.bank);
    }
  }

  // Trails sink a little into the ground, with a dark edge on the sunny side.
  for (let y = 1; y < H - 1; y++) {
    for (let x = 0; x < W; x++) {
      const i = y * W + x;
      if (paths[i] === PATH_INNER && paths[i - W] === 0) px[i] = rgba(T.path.rut);
    }
  }

  // Bridges and piers throw a shadow on the water below them.
  for (let y = 0; y < H - 1; y++) {
    for (let x = 0; x < W; x++) {
      const i = y * W + x;
      if (decks[i] && !land[i + W]) px[i + W] = rgba(T.deck.shadow);
    }
  }

  // Lakes: ice on the frozen ones, lilies on the rest.
  bakeLakes(mapId, px);

  // Texture and small decoration, in that order.
  const free = (i: number) => (isLow(i) || kind[i] === HILLTOP) && !reserved[i] && toFresh[i] > 2.5;
  scatter(mapId, px, kind, free);

  return px;
}

function bakeLakes(mapId: MapId, px: Uint32Array): void {
  const map = getMap(mapId);
  const seed = MAP_DEFS[mapId].seed;
  const T = themeOf(mapId).land;
  const { land, water } = map;
  const toLand = distanceField((i) => land[i] === 1);
  const toRiver = distanceField((i) => water[i] === WATER_RIVER);

  if (T.ice) {
    for (let y = 0; y < H; y++) {
      for (let x = 0; x < W; x++) {
        const i = y * W + x;
        if (water[i] !== WATER_LAKE) continue;
        // Open water where the stream leaves.
        const melt = toRiver[i] + (noise(x / 4, y / 4, seed + 95) - 0.5) * 4;
        if (melt < 6) continue;
        const ridge = Math.abs(noise(x / 9, y / 7, seed + 91) - 0.5);
        const ridge2 = Math.abs(noise(x / 6, y / 11, seed + 92) - 0.5);
        const shade = noise(x / 12, y / 9, seed + 93) + (bayer(x, y) - 0.5) * 0.08;
        let color = shade < 0.5 ? T.ice.mid : T.ice.light;
        if (ridge < 0.022 || ridge2 < 0.018) color = T.ice.crack;
        if (toLand[i] < 1.5) color = T.ice.dark;
        px[i] = rgba(color);
      }
    }
    return;
  }

  // Lily pads float on open water.
  for (let gy = 0; gy < H; gy += 7) {
    for (let gx = 0; gx < W; gx += 7) {
      const x = gx + Math.floor(hash(gx, gy + 1) * 6);
      const y = gy + Math.floor(hash(gx + 1, gy) * 6);
      if (x < 2 || x >= W - 3 || y >= H - 2) continue;
      const i = y * W + x;
      if (water[i] !== WATER_LAKE || toLand[i] < 2 || toLand[i] > 7 || hash(gx + 9, gy + 3) > 0.7) continue;
      const cells = [i, i + 1, i + W, i + W + 1, i - 1];
      if (cells.some((c) => water[c] !== WATER_LAKE)) continue;
      px[i] = rgba(T.lily[1]);
      px[i + 1] = rgba(T.lily[1]);
      px[i - 1] = rgba(T.lily[0]);
      px[i + W] = rgba(T.lily[0]);
      px[i + W + 1] = rgba(T.lily[0]);
      if (hash(gx + 2, gy + 8) < 0.35) px[i] = rgba(T.lily[2]);
    }
  }

  // Reeds stand along the shore, with their feet in the water.
  for (let y = 2; y < H - 1; y++) {
    for (let x = 1; x < W - 1; x++) {
      const i = y * W + x;
      if (water[i] !== WATER_LAKE || !land[i - W]) continue;
      if (noise(x / 5, y / 5, seed + 97) < 0.56 || hash(x, y) < 0.4) continue;
      px[i] = rgba(T.reed[0]);
      if (land[i - W]) px[i - W] = rgba(T.reed[0]);
      if (land[i - W * 2]) px[i - W * 2] = rgba(T.reed[1]);
    }
  }
}

/** Marks and small objects, on a jittered grid so they never bunch up. */
function scatter(mapId: MapId, px: Uint32Array, kind: Uint8Array, free: (i: number) => boolean): void {
  const map = getMap(mapId);
  const def = MAP_DEFS[mapId];
  const T = themeOf(mapId).land;
  const seed = def.seed;

  const groundKind = (x: number, y: number): GroundKind | null => {
    for (let n = def.patches.length - 1; n >= 0; n--) {
      const p = def.patches[n];
      const dx = (x - p.x) / p.rx;
      const dy = (y - p.y) / p.ry;
      if (dx * dx + dy * dy < 0.85) return p.kind;
    }
    return null;
  };

  const put = (x: number, y: number, rows: string[], colors: Record<string, string>, want: number): boolean => {
    for (const [ry, row] of rows.entries()) {
      for (let rx = 0; rx < row.length; rx++) {
        if (row[rx] === '.') continue;
        const cx = x + rx;
        const cy = y + ry;
        if (cx < 1 || cy < 1 || cx >= W - 1 || cy >= H - 1) return false;
        const i = cy * W + cx;
        if (!free(i) || kind[i] !== want) return false;
      }
    }
    for (const [ry, row] of rows.entries()) {
      for (let rx = 0; rx < row.length; rx++) {
        if (row[rx] !== '.') px[(y + ry) * W + x + rx] = rgba(colors[row[rx]]);
      }
    }
    return true;
  };

  // Ripples and cracks, drawn over whole patches.
  for (let y = 1; y < H - 1; y++) {
    for (let x = 1; x < W - 1; x++) {
      const i = y * W + x;
      if (!free(i) || kind[i] !== OPEN_GROUND) continue;
      const g = groundKind(x, y);
      if (g === 'dune') {
        const wave = y + noise(x / 16, y / 12, seed + 101) * 9;
        if (Math.floor(wave) % 5 === 0 && noise(x / 7, y / 3, seed + 102) > 0.34) px[i] = rgba(T.ripple);
      } else if (g === 'cracked') {
        const a = Math.abs(noise(x / 8, y / 8, seed + 103) - 0.5);
        const b = Math.abs(noise(x / 7, y / 9, seed + 104) - 0.5);
        if (a < 0.02 || b < 0.016) px[i] = rgba(T.crack);
      }
    }
  }

  const FLAT_TUFT = ['g.g', '.g.'];
  const TALL_TUFT = ['.g.', 'g.g'];
  const STONE = ['ab', 'bb'];
  const STONE_WIDE = ['.a.', 'abb'];
  const SPECK = ['ab'];
  const FLOWER = ['.f.', 'f.f'];
  const MUSHROOM = ['aa', '.b'];
  const SHELL = ['ab'];
  const WOOD = ['aabb.', '..abb'];
  const DRIFT = ['..www..', '.wwwwww', 'bbbbbbb'];
  const BOULDER = ['.ll.', 'lmmd', 'mmdd'];
  const COBBLE = ['lm', 'md'];

  for (let gy = 0; gy < H; gy += 6) {
    for (let gx = 0; gx < W; gx += 6) {
      const x = gx + Math.floor(hash(gx, gy + 13) * 6);
      const y = gy + Math.floor(hash(gx + 17, gy) * 6);
      if (x >= W || y >= H) continue;
      const i = y * W + x;
      if (!map.land[i] || !free(i)) continue;
      const r = hash(gx + 5, gy + 31);
      const pick = hash(gx + 23, gy + 7);
      const surface = kind[i];

      if (surface === SAND) {
        if (r > 0.3) continue;
        if (pick < 0.5) put(x, y, SHELL, { a: T.shell[0], b: T.shell[1] }, SAND);
        else if (pick < 0.7) put(x, y, WOOD, { a: T.driftwood[0], b: T.driftwood[1] }, SAND);
        else put(x, y, STONE, { a: T.pebble[0], b: T.pebble[1] }, SAND);
        continue;
      }
      if (surface === HILLTOP) {
        if (r > 0.07) continue;
        if (mapId === 'desert') put(x, y, STONE_WIDE, { a: T.rock[2], b: T.rock[1] }, HILLTOP);
        else put(x, y, STONE, { a: T.pebble[0], b: T.pebble[1] }, HILLTOP);
        continue;
      }
      if (surface !== OPEN_GROUND) continue;

      const g = groundKind(x, y);
      const tuft = { g: T.tuft };
      if (g === 'rocky') {
        const stones = { l: T.rock[2], m: T.rock[1], d: T.rock[0] };
        if (r < 0.34) put(x, y, BOULDER, stones, OPEN_GROUND);
        else if (r < 0.8) put(x, y, COBBLE, stones, OPEN_GROUND);
      } else if (mapId === 'snowy') {
        if (g === 'icy') {
          if (r < 0.45) put(x, y, ['iiii', '.ii.'], { i: T.ice?.mid ?? T.ground[0] }, OPEN_GROUND);
        } else if (r < 0.09) put(x, y, DRIFT, { w: T.ground[2], b: T.ground[0] }, OPEN_GROUND);
        else if (r < 0.14) put(x, y, SPECK, { a: T.pebble[0], b: T.pebble[1] }, OPEN_GROUND);
        else if (r < 0.2) put(x, y, FLAT_TUFT, tuft, OPEN_GROUND);
      } else if (mapId === 'desert') {
        if (g === 'lush') {
          if (r < 0.4) put(x, y, TALL_TUFT, { g: T.patches.lush[0] }, OPEN_GROUND);
          else if (r < 0.5) put(x, y, FLOWER, { f: T.flowers[pick < 0.5 ? 0 : 1] }, OPEN_GROUND);
        } else if (r < 0.1) put(x, y, STONE, { a: T.pebble[0], b: T.pebble[1] }, OPEN_GROUND);
        else if (r < 0.16) put(x, y, FLAT_TUFT, tuft, OPEN_GROUND);
        else if (r < 0.2) put(x, y, SPECK, { a: T.pebble[0], b: T.pebble[1] }, OPEN_GROUND);
      } else {
        if (g === 'meadow') {
          if (r < 0.6) put(x, y, FLOWER, { f: T.flowers[Math.floor(pick * T.flowers.length)] }, OPEN_GROUND);
          else if (r < 0.75) put(x, y, TALL_TUFT, tuft, OPEN_GROUND);
        } else if (g === 'forest') {
          if (r < 0.14) put(x, y, MUSHROOM, { a: T.mushroom[0], b: T.mushroom[1] }, OPEN_GROUND);
          else if (r < 0.4) put(x, y, TALL_TUFT, { g: T.patches.forest[0] }, OPEN_GROUND);
        } else if (r < 0.22) put(x, y, pick < 0.5 ? FLAT_TUFT : TALL_TUFT, tuft, OPEN_GROUND);
        else if (r < 0.26) put(x, y, SPECK, { a: T.pebble[0], b: T.pebble[1] }, OPEN_GROUND);
        else if (r < 0.29) put(x, y, FLOWER, { f: T.flowers[Math.floor(pick * T.flowers.length)] }, OPEN_GROUND);
      }
    }
  }

  // Fences round the pasture, with gaps wherever a sprite or trail needs through.
  for (const line of def.fences) {
    for (let n = 0; n + 1 < line.length; n++) {
      const [ax, ay] = line[n];
      const [bx, by] = line[n + 1];
      const steps = Math.max(Math.abs(bx - ax), Math.abs(by - ay));
      for (let s = 0; s <= steps; s++) {
        const x = Math.round(ax + ((bx - ax) * s) / steps);
        const y = Math.round(ay + ((by - ay) * s) / steps);
        const i = y * W + x;
        if (!free(i)) continue;
        const post = s % 5 === 0;
        px[i] = rgba(T.fence[post ? 0 : 1]);
        if (post && free(i - W)) px[i - W] = rgba(T.fence[1]);
      }
    }
  }

  // Stones marking out where walls once stood, with plenty missing.
  for (const ruin of def.ruins) {
    const stones = { l: T.rock[2], m: T.rock[1], d: T.rock[0] };
    const block = (x: number, y: number) => {
      if (noise(x / 5, y / 5, seed + 111) > 0.3) put(x, y, COBBLE, stones, OPEN_GROUND);
    };
    for (let x = ruin.x - ruin.rx; x <= ruin.x + ruin.rx; x += 3) {
      block(x, ruin.y - ruin.ry);
      block(x, ruin.y + ruin.ry);
    }
    for (let y = ruin.y - ruin.ry + 3; y < ruin.y + ruin.ry; y += 3) {
      block(ruin.x - ruin.rx, y);
      block(ruin.x + ruin.rx, y);
    }
  }
}

export type Terrain = {
  land: HTMLCanvasElement;
  water: HTMLCanvasElement;
  paintWater: (time: number) => void;
};

export function buildTerrain(mapId: MapId): Terrain {
  const { land: landMask, water: waterKind, flow } = getMap(mapId);
  const { water: waters } = themeOf(mapId);

  const toLand = distanceField((i) => landMask[i] === 1);

  const landCanvas = document.createElement('canvas');
  landCanvas.width = W;
  landCanvas.height = H;
  const landCtx = landCanvas.getContext('2d')!;
  const landImage = landCtx.createImageData(W, H);
  new Uint32Array(landImage.data.buffer).set(bakeLand(mapId));
  landCtx.putImageData(landImage, 0, 0);

  const waterCanvas = document.createElement('canvas');
  waterCanvas.width = W;
  waterCanvas.height = H;
  const waterCtx = waterCanvas.getContext('2d')!;
  const waterImage = waterCtx.createImageData(W, H);
  const waterPixels = new Uint32Array(waterImage.data.buffer);

  const count = W * H - landMask.reduce((sum, v) => sum + v, 0);
  const index = new Uint32Array(count);
  const depth = new Float32Array(count);
  const wobble = new Float32Array(count);
  const glint = new Float32Array(count);
  const body = new Uint8Array(count);
  const along = new Float32Array(count);
  let n = 0;
  for (let y = 0; y < H; y++) {
    for (let x = 0; x < W; x++) {
      const i = y * W + x;
      if (landMask[i]) continue;
      index[n] = i;
      // Bands fade out toward the canvas edge, so the water meets the page without a seam.
      const edge = Math.min(x, y, W - 1 - x, H - 1 - y);
      depth[n] = Math.max(toLand[i], 22 - edge * 1.6);
      wobble[n] = Math.sin(x * 0.19 + y * 0.07) * 1.2 + Math.sin(y * 0.31 - x * 0.11) * 0.9;
      const r = hash(x + 11, y + 29);
      glint[n] = edge > 6 && r < 0.016 ? r * 5000 : -1;
      body[n] = waterKind[i];
      along[n] = flow[i] + hash(x + 3, y + 4) * 1.5;
      n++;
    }
  }

  const FOAM = rgba(waters.foam);
  const GLOW = rgba(waters.glow);
  const SHALLOW = rgba(waters.shallow);
  const MID = rgba(waters.mid);
  const OPEN = rgba(waters.open);

  const paintWater = (time: number) => {
    const shift = time * 1.1;
    const glintClock = Math.floor(time * 2);
    for (let k = 0; k < count; k++) {
      const d = depth[k];
      if (body[k] === WATER_RIVER) {
        // Streaks run down the stream toward the sea.
        const streak = Math.floor((along[k] - time * 7) / 3) & 3;
        waterPixels[index[k]] = streak === 0 ? SHALLOW : MID;
        continue;
      }
      if (body[k] === WATER_LAKE) {
        // Still water, with a rare slow ripple.
        const ripple = Math.floor((d + wobble[k] + time * 0.4) / 2.6) & 7;
        waterPixels[index[k]] = d < 1.5 ? SHALLOW : ripple === 0 ? SHALLOW : MID;
        continue;
      }
      // Bands get closer to shore as time passes, which reads as waves rolling in.
      const band = Math.floor((d + wobble[k] + shift) / 3.4) & 3;
      let color = OPEN;
      if (d < 2) color = band <= 1 ? FOAM : SHALLOW;
      else if (d < 7) color = band === 0 ? GLOW : SHALLOW;
      else if (d < 13) color = band === 0 ? SHALLOW : MID;
      else if (d < 21) color = band === 0 ? MID : OPEN;
      else if (glint[k] >= 0 && (glintClock + Math.floor(glint[k])) % 9 === 0) color = MID;
      waterPixels[index[k]] = color;
    }
    waterCtx.putImageData(waterImage, 0, 0);
  };
  paintWater(0);

  return { land: landCanvas, water: waterCanvas, paintWater };
}
