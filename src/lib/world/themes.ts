// How each map is coloured. Tropical uses PALETTE so it stays the same as the sprites around it.
import type { MapId } from '../game/types';
import { PALETTE } from './sprites';

export type Rgb = [number, number, number];

export type Theme = {
  /** Page background. Equal to the deepest water colour, so the canvas edge shows no seam. */
  sea: Rgb;
  deep: Rgb;
  land: {
    shore: string;
    sand: string;
    base: string;
    hill: string;
    baseSpeck: string;
    hillSpeck: string;
    /** Share of land pixels that get a speck. */
    speck: number;
    /** Small accents on flat ground: a colour, and how much of the land it covers. */
    flecks: [string, number][];
    /** Wavy lines across the hills, for maps where hills are dunes. */
    ripple?: string;
  };
  /** From the foam at the shore out to the open sea. */
  water: { foam: string; glow: string; shallow: string; mid: string; open: string };
};

function rgb(hex: string): Rgb {
  const n = parseInt(hex.slice(1), 16);
  return [n >> 16, (n >> 8) & 255, n & 255];
}

function theme(land: Theme['land'], water: Theme['water'], deep: string): Theme {
  return { sea: rgb(water.open), deep: rgb(deep), land, water };
}

const THEMES: Record<MapId, Theme> = {
  tropical: theme(
    {
      shore: PALETTE.S,
      sand: PALETTE.s,
      base: PALETTE.g,
      hill: PALETTE.G,
      baseSpeck: PALETTE.G,
      hillSpeck: PALETTE.f,
      speck: 0.022,
      flecks: [[PALETTE.w, 0.005], [PALETTE.y, 0.004], [PALETTE.p, 0.002]],
    },
    { foam: PALETTE.w, glow: PALETTE.l, shallow: PALETTE.u, mid: PALETTE.U, open: PALETTE.n },
    PALETTE.N,
  ),
  snowy: theme(
    {
      shore: '#8fc4e0',
      sand: '#c4e4f4',
      base: '#f1f6fa',
      hill: '#d9e6f3',
      baseSpeck: '#dfe9f4',
      hillSpeck: '#bdd0e6',
      speck: 0.03,
      flecks: [['#ffffff', 0.01], ['#a9dcf2', 0.004], [PALETTE.d, 0.0012]],
    },
    { foam: '#eaf7fb', glow: '#a9e4ee', shallow: '#5db8cb', mid: '#2f88a8', open: '#1d5f88' },
    '#123f60',
  ),
  desert: theme(
    {
      shore: '#c2945a',
      sand: '#f8e2a8',
      base: '#f0c878',
      hill: '#e4b468',
      baseSpeck: '#e4b566',
      hillSpeck: '#d09c52',
      ripple: '#d39d55',
      speck: 0.012,
      flecks: [['#b98a55', 0.002], ['#8aa84a', 0.0012], ['#fbe6b0', 0.002]],
    },
    { foam: '#f4f1dc', glow: '#8ff0d8', shallow: '#3fd0c0', mid: '#1aa3a3', open: '#0c7585' },
    '#0a5566',
  ),
};

export function themeOf(mapId: MapId): Theme {
  return THEMES[mapId];
}
