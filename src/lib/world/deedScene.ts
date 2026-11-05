// The little place an NFT's landmark stands in on its card: its own island's sky and ground, in the same chunky
// pixels as the sprite. Everything is seeded by the NFT's id, so a card looks the same on every visit and for everyone.
import { HABITAT } from '../game/mapDefs';
import type { Kind, MapId } from '../game/types';
import { themeOf } from './themes';

export type Painter = (x: number, y: number, w: number, h: number, color: string) => void;

type Backdrop = {
  /** Top to the horizon, in hard bands. */
  sky: string[];
  /** The far distance sitting on the horizon. */
  far: string;
  farLit: string;
  orb: string;
  orbGlow: string;
  /** How much of the way down the sky the sun or moon sits, and its radius in chunks. */
  orbAt: number;
  orbSize: number;
  cloud: string | null;
  cloudShade: string;
  stars: string | null;
};

// Each island is a different time of day, so a set reads as one set from across the page.
const BACKDROPS: Record<MapId, Backdrop> = {
  tropical: {
    sky: ['#3aa8e4', '#55b9ea', '#74c9ef', '#97d9f3', '#bde8f6'],
    far: '#2a9ede', farLit: '#4cd0d8',
    orb: '#fff6c2', orbGlow: '#d8f1ec', orbAt: 0.2, orbSize: 2,
    cloud: '#f7f7ee', cloudShade: '#cfe6f2', stars: null,
  },
  snowy: {
    sky: ['#142c58', '#183a68', '#1f4d7c', '#2d6890', '#4a8aa8'],
    far: '#7d9dbb', farLit: '#d5e6f2',
    orb: '#eef6fb', orbGlow: '#1f4d7c', orbAt: 0.2, orbSize: 3,
    cloud: null, cloudShade: '', stars: '#cfe0fb',
  },
  desert: {
    sky: ['#e0603f', '#ec7a45', '#f4954f', '#f9b160', '#fccf80'],
    far: '#cf8246', farLit: '#e8a25c',
    orb: '#fff0b8', orbGlow: '#fdbf72', orbAt: 0.62, orbSize: 4,
    cloud: '#fbbf7e', cloudShade: '#f0975b', stars: null,
  },
};

/** A small generator, so a scene never changes and two NFTs never share one. */
export function seeded(text: string): () => number {
  let h = 2166136261;
  for (let i = 0; i < text.length; i++) h = Math.imul(h ^ text.charCodeAt(i), 16777619);
  return () => {
    h = Math.imul(h ^ (h >>> 15), 2246822507);
    h = Math.imul(h ^ (h >>> 13), 3266489909);
    h ^= h >>> 16;
    return (h >>> 0) / 4294967296;
  };
}

export type Surface = 'land' | 'sand' | 'water';

/** Where a kind stands. A boat on grass would look lost. */
export function surfaceOf(kind: Kind): Surface {
  const habitat = HABITAT[kind];
  if (habitat === 'waterline') return 'water';
  if (habitat === 'shore') return 'sand';
  return 'land';
}

function blend(a: string, b: string, amount: number): string {
  const channel = (hex: string, at: number) => parseInt(hex.slice(at, at + 2), 16);
  const part = (at: number) => Math.round(channel(a, at) + (channel(b, at) - channel(a, at)) * amount);
  return `#${[1, 3, 5].map((at) => part(at).toString(16).padStart(2, '0')).join('')}`;
}

function drawCloud(paint: Painter, x: number, y: number, size: number, color: string, under: string) {
  paint(x + size * 2, y, size * 3, size, color);
  paint(x, y + size, size * 7, size, color);
  paint(x + size, y + size * 2, size * 4, 1, under);
}

/** Discs drawn in chunks, so they sit on the same grid as everything else. */
function drawDisc(paint: Painter, cx: number, cy: number, radius: number, unit: number, color: string, bite?: { x: number; y: number; radius: number }) {
  for (let dy = -radius; dy <= radius; dy++) {
    for (let dx = -radius; dx <= radius; dx++) {
      if (dx * dx + dy * dy > radius * radius + radius * 0.6) continue;
      if (bite && (dx - bite.x) ** 2 + (dy - bite.y) ** 2 < bite.radius * bite.radius) continue;
      paint(cx + dx * unit, cy + dy * unit, unit, unit, color);
    }
  }
}

function drawOrb(paint: Painter, map: MapId, x: number, y: number, unit: number, look: Backdrop) {
  const radius = look.orbSize;
  if (map === 'snowy') {
    // A crescent, so it can only be the moon.
    drawDisc(paint, x, y, radius, unit, look.orb, { x: 2, y: -1, radius });
    return;
  }
  drawDisc(paint, x, y, radius + 1, unit, look.orbGlow);
  drawDisc(paint, x, y, radius, unit, look.orb);
}

function drawFar(paint: Painter, map: MapId, w: number, horizon: number, unit: number, random: () => number, look: Backdrop) {
  if (map === 'tropical') {
    // Open sea, and an islet out on it.
    paint(0, horizon - unit * 2, w, unit * 2, look.far);
    paint(0, horizon - unit * 2, w, 1, look.farLit);
    const x = Math.floor(random() * w * 0.7);
    const land = themeOf('tropical').land.ground;
    paint(x, horizon - unit * 3, unit * 6, unit, land[0]);
    paint(x + unit, horizon - unit * 4, unit * 3, unit, land[1]);
    return;
  }
  let x = -Math.floor(random() * unit * 6);
  while (x < w) {
    const steps = 2 + Math.floor(random() * (map === 'snowy' ? 4 : 3));
    const stepW = map === 'snowy' ? unit : unit * 2;
    const width = steps * stepW * 2 + unit * 2;
    for (let step = 0; step < steps; step++) {
      const inset = step * stepW;
      const top = horizon - (step + 1) * unit;
      const snowcap = map === 'snowy' && step >= steps - 2;
      paint(x + inset, top, width - inset * 2, unit, snowcap ? look.farLit : look.far);
      // Light from the sun on one side of every dune.
      if (map === 'desert') paint(x + inset, top, Math.max(unit, Math.floor((width - inset * 2) / 3)), unit, look.farLit);
    }
    x += width - unit * Math.floor(random() * 3 + 1);
  }
}

function drawGround(paint: Painter, map: MapId, surface: Surface, w: number, h: number, horizon: number, unit: number, random: () => number) {
  const land = themeOf(map).land;
  const water = themeOf(map).water;
  if (surface === 'water') {
    const bands = [water.shallow, water.mid, water.open];
    const bandH = Math.ceil((h - horizon) / bands.length);
    bands.forEach((color, i) => paint(0, horizon + i * bandH, w, bandH, color));
    for (let i = 0; i < Math.ceil(w / (unit * 2)); i++) {
      const y = horizon + Math.floor(random() * (h - horizon));
      paint(Math.floor(random() * w), y, unit * (1 + Math.floor(random() * 3)), 1, i % 3 ? water.glow : water.foam);
    }
    return;
  }
  const base = surface === 'sand' ? land.sand.mid : land.ground[1];
  const lit = surface === 'sand' ? land.sand.light : land.ground[2];
  const dim = blend(base, surface === 'sand' ? land.sand.shadow : land.ground[0], 0.6);
  paint(0, horizon, w, h - horizon, base);
  paint(0, horizon, w, unit, lit);
  // Flat strokes that lengthen towards the viewer, which is most of what makes this read as ground.
  const strokes = Math.ceil((w * (h - horizon)) / (unit * unit * 26));
  for (let i = 0; i < strokes; i++) {
    const depth = random();
    const y = horizon + unit + Math.floor(depth * (h - horizon - unit));
    const length = unit * (2 + Math.floor(depth * 5 * random()));
    paint(Math.floor(random() * w) - unit, y, length, 1 + Math.floor(depth * (unit - 1)), random() < 0.6 ? dim : lit);
  }
  // Only what grows or washes up on this surface.
  const strewn = surface === 'sand' ? [land.shell[0], land.shell[1]] : [land.tuft, ...land.flowers.slice(0, 3)];
  for (let i = 0; i < Math.ceil(w / (unit * 12)); i++) {
    const y = horizon + unit * 2 + Math.floor(random() * (h - horizon - unit * 3));
    const x = Math.floor(random() * w);
    const color = strewn[Math.floor(random() * strewn.length)];
    paint(x, y, unit, 1, color);
    paint(x, y - 1, 1, 1, color);
  }
}

/** Sky, distance and ground, across a `w` by `h` canvas of art pixels. `unit` is how big one chunk of scenery is. */
export function paintScene(paint: Painter, map: MapId, kind: Kind | null, seed: string, w: number, h: number, horizon: number, unit = 2): void {
  const random = seeded(seed);
  const look = BACKDROPS[map];
  const bandH = Math.ceil(horizon / look.sky.length);
  look.sky.forEach((color, i) => {
    paint(0, i * bandH, w, bandH, color);
    // One dithered row at each seam, the way a palette game fades one colour into the next.
    if (i) for (let x = i % 2; x < w; x += 2) paint(x, i * bandH, 1, 1, look.sky[i - 1]);
  });

  if (look.stars) {
    for (let i = 0; i < Math.ceil(w / 3); i++) {
      paint(Math.floor(random() * w), Math.floor(random() * horizon * 0.8), 1, 1, random() < 0.25 ? '#f7f7ee' : blend(look.stars, look.sky[1], 0.5));
    }
  }
  drawOrb(paint, map, Math.floor(w * (0.14 + random() * 0.72)), Math.floor(horizon * look.orbAt + random() * unit * 2), unit, look);

  if (look.cloud) {
    for (let i = 0; i < 2; i++) {
      drawCloud(paint, Math.floor(random() * w) - unit * 3, Math.floor(horizon * (0.1 + random() * 0.45)), unit, look.cloud, look.cloudShade);
    }
  }
  drawFar(paint, map, w, horizon, unit, random, look);
  drawGround(paint, map, kind ? surfaceOf(kind) : 'land', w, h, horizon, unit, random);
}

/** A soft pool of shade under a landmark. */
export function paintShadow(paint: Painter, x: number, y: number, width: number, rows = 3): void {
  for (let row = 0; row < rows; row++) {
    const inset = Math.floor((row * width) / (rows * 3));
    for (let i = x + inset + (row % 2); i < x + width - inset; i += 2) paint(i, y + row, 1, 1, '#141b3c');
  }
}
