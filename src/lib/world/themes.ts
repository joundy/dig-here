// How each map is coloured. Tones are kept close together on the ground, so the outlined sprites stand out.
import type { GroundKind } from '../game/mapDefs';
import type { MapId } from '../game/types';

export type Rgb = [number, number, number];

/** Dark, middle, light. */
export type Tones = [string, string, string];

export type LandTheme = {
  ground: Tones;
  /** The shadow cast on the ground by a cliff or a bank. */
  shadow: string;
  /** The dark lip where ground meets the beach. */
  fringe: string;
  sand: { light: string; mid: string; shadow: string; wet: string; wetter: string };
  rock: Tones;
  hill: {
    tops: [[string, string], [string, string]];
    /** The lit edge along the top of a plateau. */
    lit: string;
    /** The shaded side of a plateau. */
    shade: string;
    /** Top of the face to the bottom. */
    face: Tones;
    /** Ground hanging over the lip of a cliff. */
    drip: string;
    /** Long streaks across a hilltop: bare rock, or strata. */
    mark: string;
  };
  path: { edge: string; mid: string; light: string; rut: string };
  patches: Record<GroundKind, Tones>;
  /** A thin line drawn over cracked ground, or a ripple over dunes. */
  crack: string;
  ripple: string;
  soil: [string, string];
  crops: [string, string][];
  deck: { light: string; dark: string; rail: string; shadow: string };
  bank: string;
  reed: [string, string];
  lily: [string, string, string];
  fence: [string, string];
  /** Colours of the small things strewn about, keyed by what they are. */
  flowers: string[];
  tuft: string;
  pebble: [string, string];
  mushroom: [string, string];
  shell: [string, string];
  driftwood: [string, string];
  /** Frozen lakes only. */
  ice?: { light: string; mid: string; dark: string; crack: string };
};

export type Theme = {
  /** Page background. Equal to the deepest water colour, so the canvas edge shows no seam. */
  sea: Rgb;
  deep: Rgb;
  land: LandTheme;
  /** From the foam at the shore out to the open sea. */
  water: { foam: string; glow: string; shallow: string; mid: string; open: string };
};

function rgb(hex: string): Rgb {
  const n = parseInt(hex.slice(1), 16);
  return [n >> 16, (n >> 8) & 255, n & 255];
}

function theme(land: LandTheme, water: Theme['water'], deep: string): Theme {
  return { sea: rgb(water.open), deep: rgb(deep), land, water };
}

const THEMES: Record<MapId, Theme> = {
  tropical: theme(
    {
      ground: ['#5a9f43', '#66ac48', '#74b84e'],
      shadow: '#458a3e',
      fringe: '#4b923f',
      sand: { light: '#fbe9b2', mid: '#f6dc98', shadow: '#dfc381', wet: '#d9b97c', wetter: '#bf9c66' },
      rock: ['#6e6c66', '#918e82', '#b6b2a2'],
      hill: {
        tops: [['#7cbf53', '#84c558'], ['#93cf60', '#9bd566']],
        lit: '#b9e67c',
        shade: '#5a9c45',
        face: ['#ac8050', '#8b643c', '#634a32'],
        drip: '#6cb04a',
        mark: '#8ccb5e',
      },
      path: { edge: '#ae8a53', mid: '#c49f64', light: '#d6b478', rut: '#a4814d' },
      patches: {
        meadow: ['#6db348', '#7cc050', '#88ca58'],
        forest: ['#458e41', '#4d9542', '#569c44'],
        dirt: ['#ae9358', '#bda166', '#cbb074'],
        rocky: ['#5a9f43', '#66ac48', '#74b84e'],
        lush: ['#5a9f43', '#66ac48', '#74b84e'],
        cracked: ['#5a9f43', '#66ac48', '#74b84e'],
        dune: ['#5a9f43', '#66ac48', '#74b84e'],
        drift: ['#5a9f43', '#66ac48', '#74b84e'],
        icy: ['#5a9f43', '#66ac48', '#74b84e'],
      },
      crack: '#4b923f',
      ripple: '#5a9f43',
      soil: ['#8d6840', '#73532f'],
      crops: [['#d9b745', '#f0d564'], ['#58a53f', '#86cb50']],
      deck: { light: '#cfa066', dark: '#ab7f4a', rail: '#6d4c2e', shadow: '#1d70a8' },
      bank: '#4b923f',
      reed: ['#3d7d3b', '#c0a650'],
      lily: ['#3f9a4c', '#66c05a', '#f7a3c6'],
      fence: ['#8a6a42', '#a98655'],
      flowers: ['#f6f2d6', '#f4d44e', '#f498bb'],
      tuft: '#4f9540',
      pebble: ['#a29e90', '#7d7a70'],
      mushroom: ['#e0705a', '#efe6d0'],
      shell: ['#fff6e4', '#e8a8a0'],
      driftwood: ['#a88a62', '#86694a'],
    },
    { foam: '#f2fbf7', glow: '#9cefe6', shallow: '#4cd0d8', mid: '#2a9ede', open: '#1668c8' },
    '#123f9a',
  ),
  snowy: theme(
    {
      ground: ['#c5d6e9', '#d5e2f0', '#e5eef7'],
      shadow: '#a4bbd6',
      fringe: '#b9cce0',
      sand: { light: '#c3d0dc', mid: '#b1c0ce', shadow: '#99aabd', wet: '#8496ab', wetter: '#6a7c93' },
      rock: ['#566780', '#7a8ba3', '#a4b3c6'],
      hill: {
        tops: [['#eef5fb', '#e6f0f8'], ['#fbfdff', '#f4f8fc']],
        lit: '#ffffff',
        shade: '#c4d5e7',
        face: ['#8499b6', '#5f7699', '#3e5578'],
        drip: '#f4f8fc',
        mark: '#a3b5cc',
      },
      path: { edge: '#a9bbd0', mid: '#93a8c2', light: '#b4c4d7', rut: '#8197b3' },
      patches: {
        meadow: ['#cedced', '#dbe6f2', '#e8f0f8'],
        forest: ['#b7c9de', '#c1d1e3', '#cbd9e9'],
        dirt: ['#b9c6d6', '#c3cfde', '#ccd7e4'],
        rocky: ['#c5d6e9', '#d5e2f0', '#e5eef7'],
        lush: ['#cedced', '#dbe6f2', '#e8f0f8'],
        cracked: ['#cedced', '#dbe6f2', '#e8f0f8'],
        dune: ['#cedced', '#dbe6f2', '#e8f0f8'],
        drift: ['#e0e9f4', '#ebf2f9', '#f6fafd'],
        icy: ['#bfdfee', '#cbe6f2', '#d8edf6'],
      },
      crack: '#b9cce0',
      ripple: '#c6d6e8',
      soil: ['#8a9bb0', '#74869c'],
      crops: [['#a4b3c6', '#c3d0dc']],
      deck: { light: '#a98a68', dark: '#886c50', rail: '#54453a', shadow: '#1d5f88' },
      bank: '#a8bdd4',
      reed: ['#7c8a70', '#a89a6c'],
      lily: ['#c3d0dc', '#dbe6f2', '#ffffff'],
      fence: ['#6e6358', '#8c7e70'],
      flowers: ['#ffffff'],
      tuft: '#94a08a',
      pebble: ['#94a5ba', '#6f8199'],
      mushroom: ['#94a5ba', '#ffffff'],
      shell: ['#e4ecf4', '#94a5ba'],
      driftwood: ['#8e7c6a', '#6e5e50'],
      ice: { light: '#d6eff6', mid: '#b7e0ee', dark: '#8ec6de', crack: '#f4fcfe' },
    },
    { foam: '#eaf7fb', glow: '#a9e4ee', shallow: '#5db8cb', mid: '#2f88a8', open: '#1d5f88' },
    '#123f60',
  ),
  desert: theme(
    {
      ground: ['#e3b56b', '#ebc078', '#f2cb86'],
      shadow: '#c28a4f',
      fringe: '#d8a862',
      sand: { light: '#fbecc2', mid: '#f7e2ae', shadow: '#e4c88e', wet: '#cfa96a', wetter: '#b08c56' },
      rock: ['#7a5e4a', '#a58262', '#cba980'],
      hill: {
        tops: [['#dd9e60', '#e2a768'], ['#e9b478', '#eebc80']],
        lit: '#fad69c',
        shade: '#bd7c4a',
        face: ['#b9673f', '#964e33', '#6f392b'],
        drip: '#e2a768',
        mark: '#cf9058',
      },
      path: { edge: '#c99a58', mid: '#b58a4f', light: '#c79c5c', rut: '#a07642' },
      patches: {
        meadow: ['#e3b56b', '#ebc078', '#f2cb86'],
        forest: ['#e3b56b', '#ebc078', '#f2cb86'],
        dirt: ['#cda160', '#d6ad6c', '#dfb878'],
        rocky: ['#e3b56b', '#ebc078', '#f2cb86'],
        lush: ['#7ba043', '#8fb049', '#a4bd56'],
        cracked: ['#dcae68', '#e2b672', '#e8bf7c'],
        dune: ['#eabd74', '#f1ca84', '#f7d592'],
        drift: ['#e3b56b', '#ebc078', '#f2cb86'],
        icy: ['#e3b56b', '#ebc078', '#f2cb86'],
      },
      crack: '#bd8d50',
      ripple: '#d9aa62',
      soil: ['#9c7240', '#825c34'],
      crops: [['#5e9a3e', '#8cc050']],
      deck: { light: '#c79a60', dark: '#a37845', rail: '#6a4a2c', shadow: '#0f7d84' },
      bank: '#6f9a3f',
      reed: ['#54803a', '#c2aa58'],
      lily: ['#3f9a58', '#6cc068', '#f6e27a'],
      fence: ['#8d6c42', '#ab8856'],
      flowers: ['#f6e27a', '#f0a050'],
      tuft: '#a89a52',
      pebble: ['#b89570', '#8f7055'],
      mushroom: ['#c0a070', '#f0e0c0'],
      shell: ['#fff3da', '#e0b48e'],
      driftwood: ['#a08660', '#7f6648'],
    },
    { foam: '#f4f1dc', glow: '#8ff0d8', shallow: '#3fd0c0', mid: '#1aa3a3', open: '#0c7585' },
    '#0a5566',
  ),
};

export function themeOf(mapId: MapId): Theme {
  return THEMES[mapId];
}
