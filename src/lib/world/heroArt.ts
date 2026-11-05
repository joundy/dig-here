// The landmark sprites at collectible-card size. Blowing up a 16-pixel sprite as it is gives a stair-stepped lump,
// so the art doubles its resolution first, which rounds the staircases, then picks up light from the top left.
import { PALETTE, SPRITE_ART } from './sprites';
import type { Kind } from '../game/types';
import type { SpriteName } from './sprites';

/** One colour per cell, '' for see-through. */
export type Grid = string[][];

const OUTLINE = PALETTE.k;
const SIDES = [[1, 0], [-1, 0], [0, 1], [0, -1]];

export function toGrid(rows: readonly string[], palette: Record<string, string> = PALETTE): Grid {
  return rows.map((row) => [...row].map((letter) => palette[letter] ?? ''));
}

/**
 * Scale2x: each cell becomes four, and a corner only takes a neighbour's colour where two neighbours agree on an edge.
 * With `edgesOnly`, only the silhouette rounds, because inside a building the same rule melts windows and doors.
 */
export function scale2x(grid: Grid, edgesOnly = false): Grid {
  const h = grid.length;
  const w = grid[0]?.length ?? 0;
  const at = (x: number, y: number) => grid[Math.min(h - 1, Math.max(0, y))][Math.min(w - 1, Math.max(0, x))];
  const out: Grid = Array.from({ length: h * 2 }, () => new Array<string>(w * 2).fill(''));
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const e = at(x, y);
      const up = at(x, y - 1);
      const down = at(x, y + 1);
      const left = at(x - 1, y);
      const right = at(x + 1, y);
      const open = up !== down && left !== right;
      const takes = (a: string, b: string) => open && a === b && (!edgesOnly || (a === '' && e === OUTLINE) || (a === OUTLINE && e === ''));
      out[y * 2][x * 2] = takes(left, up) ? left : e;
      out[y * 2][x * 2 + 1] = takes(up, right) ? right : e;
      out[y * 2 + 1][x * 2] = takes(left, down) ? left : e;
      out[y * 2 + 1][x * 2 + 1] = takes(down, right) ? right : e;
    }
  }
  return out;
}

function mix(hex: string, toward: [number, number, number], amount: number): string {
  const n = parseInt(hex.slice(1), 16);
  const part = (value: number, target: number) => Math.round(value + (target - value) * amount);
  const r = part(n >> 16, toward[0]);
  const g = part((n >> 8) & 255, toward[1]);
  const b = part(n & 255, toward[2]);
  return `#${((1 << 24) | (r << 16) | (g << 8) | b).toString(16).slice(1)}`;
}

/**
 * Doubling doubles the outline too, and at card size that's a heavy black band. This takes the outer half off wherever
 * there's colour behind it. A line that's only outline, like a thin branch, keeps its full width or it would vanish.
 */
export function thinOutline(grid: Grid): Grid {
  const cell = (x: number, y: number) => grid[y]?.[x] ?? '';
  const thinned = grid.map((row, y) => row.map((value, x) => {
    if (value !== OUTLINE) return value;
    for (const [dx, dy] of SIDES) {
      if (cell(x + dx, y + dy) !== '') continue;
      const inner = cell(x - dx, y - dy);
      const behind = cell(x - dx * 2, y - dy * 2);
      if (inner === OUTLINE && behind !== '' && behind !== OUTLINE) return '';
    }
    return value;
  }));
  // Thinning both sides of a convex corner leaves a nub poking out of it.
  return withoutNubs(withoutNubs(thinned));
}

function withoutNubs(grid: Grid): Grid {
  return grid.map((row, y) => row.map((value, x) => {
    if (value !== OUTLINE) return value;
    const touching = SIDES.filter(([dx, dy]) => (grid[y + dy]?.[x + dx] ?? '') !== '').length;
    return touching <= 1 ? '' : value;
  }));
}

const LIGHT: [number, number, number] = [255, 250, 225];
const SHADE: [number, number, number] = [20, 27, 90];

/** A lit edge wherever a colour meets the outline above or left of it, and a shaded one below or right. Outlines stay. */
export function shade(grid: Grid): Grid {
  const dark = (x: number, y: number) => {
    const cell = grid[y]?.[x];
    return cell === undefined || cell === '' || cell === OUTLINE;
  };
  return grid.map((row, y) => row.map((cell, x) => {
    if (cell === '' || cell === OUTLINE) return cell;
    const shadeBelow = dark(x, y + 1) || dark(x + 1, y);
    const litAbove = dark(x, y - 1) || dark(x - 1, y);
    if (shadeBelow && !litAbove) return mix(cell, SHADE, 0.28);
    if (litAbove && !shadeBelow) return mix(cell, LIGHT, 0.3);
    return cell;
  }));
}

/** Plants, animals with soft outlines, and round things take the full treatment. The rest have straight lines or tiny faces worth keeping. */
const SOFT = new Set<SpriteName>(['palm', 'pine', 'apple', 'duck', 'camel', 'cactus', 'deadtree', 'cart', 'igloo', 'pyramid', 'vulture', 'penguin', 'snowpine', 'campfire', 'campfire2', 'campfire3', 'bladesPlus', 'bladesCross']);

const cache = new Map<SpriteName, Grid>();

export function heroGrid(name: SpriteName): Grid {
  let found = cache.get(name);
  if (!found) {
    found = shade(thinOutline(scale2x(toGrid(SPRITE_ART[name]), !SOFT.has(name))));
    cache.set(name, found);
  }
  return found;
}

export type HeroFrame = { name: SpriteName; x: number; y: number };

/** What a kind is drawn from, in layers. Two pairs of frames take turns on the world map too. */
export function heroLayers(kind: Kind, frame = 0): HeroFrame[] {
  if (kind === 'windmill') return [{ name: 'windmill', x: 0, y: 0 }, { name: frame % 2 ? 'bladesCross' : 'bladesPlus', x: 0, y: -4 }];
  if (kind === 'campfire') return [{ name: (['campfire', 'campfire2', 'campfire3'] as const)[frame % 3], x: 0, y: 0 }];
  return [{ name: kind, x: 0, y: 0 }];
}

/** How many frames a kind has, for the screens that animate it. */
export const heroFrames = (kind: Kind): number => (kind === 'windmill' ? 2 : kind === 'campfire' ? 3 : 1);

/** Width and height of a kind's whole drawing, and how far its top sticks up above the base sprite. */
export function heroSize(kind: Kind): { w: number; h: number; overhang: number } {
  const layers = heroLayers(kind);
  const base = heroGrid(layers[0].name);
  const overhang = Math.max(0, ...layers.map((l) => -l.y));
  return { w: base[0].length, h: base.length + overhang, overhang };
}

/** Every filled cell turned one colour, for an NFT nobody has found yet. */
export function silhouette(grid: Grid, color: string): Grid {
  return grid.map((row) => row.map((cell) => (cell === '' ? '' : color)));
}
