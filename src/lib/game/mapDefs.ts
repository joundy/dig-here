// What makes each map different. All of it is public, and the land never changes between games. Every coordinate is a pixel on the 320 by 224 map.
import type { Category, Kind, MapId } from './types';

export const LANDMARKS_PER_MAP = 40;

export type Pt = readonly [number, number];

/** A wobbly oval. `rough` is how far its edge strays, as a share of its size. */
export type Oval = { x: number; y: number; rx: number; ry: number; rough?: number };

/** A plateau. Tier 2 sits on top of tier 1. `face` is how tall its cliff is. */
export type Hill = Oval & { tier?: 1 | 2; face?: number };

/** Flows from `points[0]`, inside a lake, to the last point, out at sea. */
export type River = { points: Pt[]; from: number; to: number };

export type Trail = { points: Pt[]; half?: number };

export type GroundKind = 'meadow' | 'forest' | 'dirt' | 'rocky' | 'lush' | 'cracked' | 'dune' | 'drift' | 'icy';
export type Patch = Oval & { kind: GroundKind };

/** A rectangle of crop rows. `crop` picks the colours from the theme. */
export type Field = { x: number; y: number; w: number; h: number; crop: number };

/** A plank walkway out over water, which counts as land. */
export type Pier = { x: number; y: number; w: number; h: number };

/** Where a landmark may stand. */
export type Surface = 'any' | 'shore' | 'waterline';

/** Most kinds can go anywhere on land. These look wrong away from water. */
export const HABITAT: Partial<Record<Kind, Surface>> = {
  boat: 'waterline', seal: 'waterline', duck: 'shore', lighthouse: 'shore', palm: 'shore',
};

export type MapDef = {
  id: MapId;
  name: string;
  seed: number;
  /** Closed outlines, in order round the coast. The first is the main island. */
  coasts: Pt[][];
  /** How many pixels a coast strays from its outline, and how tight those wiggles are. */
  coastRough: number;
  coastScale: number;
  /** How wide the beach is. */
  beach: number;
  /** Coast with rock in place of sand, under a cliff where it faces south. */
  bluffs: Oval[];
  lakes: Oval[];
  rivers: River[];
  hills: Hill[];
  trails: Trail[];
  patches: Patch[];
  fields: Field[];
  piers: Pier[];
  /** Low fences, as open polylines. */
  fences: Pt[][];
  /** Tumbled-down stone walls, as rectangles from the middle out. */
  ruins: Oval[];
  /** How many of each kind stand on this map. Where they stand is rolled for every game. */
  roster: Partial<Record<Kind, number>>;
};

export const CATEGORY: Record<Kind, Category> = {
  horse: 'animal', cow: 'animal', sheep: 'animal', duck: 'animal',
  penguin: 'animal', seal: 'animal', husky: 'animal',
  camel: 'animal', lizard: 'animal', vulture: 'animal',
  palm: 'tree', pine: 'tree', apple: 'tree', snowpine: 'tree', birch: 'tree', cactus: 'tree', deadtree: 'tree',
  hut: 'building', windmill: 'building', well: 'building', lighthouse: 'building',
  igloo: 'building', cabin: 'building', tent: 'building', pyramid: 'building',
  scarecrow: 'thing', campfire: 'thing', boat: 'thing', snowman: 'thing', sled: 'thing', skull: 'thing', cart: 'thing',
};

/** How much ground each sprite covers, width then height. The windmill's sails reach above its art. */
export const FOOTPRINT: Record<Kind, readonly [number, number]> = {
  horse: [16, 16], cow: [16, 13], sheep: [16, 11], duck: [12, 12],
  penguin: [14, 16], seal: [16, 15], husky: [16, 15],
  camel: [16, 17], lizard: [16, 11], vulture: [14, 17],
  palm: [16, 17], pine: [13, 16], apple: [14, 14], snowpine: [13, 16], birch: [14, 17], cactus: [13, 16], deadtree: [14, 15],
  hut: [16, 15], windmill: [16, 23], well: [14, 12], lighthouse: [12, 20],
  igloo: [16, 11], cabin: [16, 17], tent: [16, 12], pyramid: [20, 11],
  scarecrow: [14, 17], campfire: [12, 12], boat: [16, 15], snowman: [13, 16], sled: [16, 11], skull: [13, 12], cart: [16, 14],
};

export const MAP_DEFS: Record<MapId, MapDef> = {
  // A green crescent curled round a turquoise harbour, with a lighthouse islet in the bay's mouth.
  tropical: {
    id: 'tropical',
    name: 'Tropical island',
    seed: 20261103,
    coasts: [
      [
        [70, 24], [94, 30], [118, 15], [172, 12], [232, 18], [276, 32], [300, 62], [292, 84], [305, 106], [312, 130], [300, 150], [274, 150],
        [250, 138], [226, 128], [204, 130], [190, 140], [186, 156], [196, 176], [200, 194], [176, 210], [128, 214],
        [86, 212], [50, 202], [30, 208], [16, 172], [10, 124], [16, 82], [22, 40], [40, 30],
      ],
      [[238, 190], [248, 178], [268, 176], [282, 186], [276, 202], [252, 206]],
    ],
    coastRough: 2.6,
    coastScale: 16,
    beach: 9,
    bluffs: [
      { x: 306, y: 140, rx: 18, ry: 14 },
      { x: 26, y: 40, rx: 20, ry: 18 },
    ],
    lakes: [{ x: 118, y: 104, rx: 20, ry: 13, rough: 0.2 }],
    rivers: [{ points: [[126, 110], [136, 124], [136, 140], [146, 152], [160, 156], [176, 154], [200, 156]], from: 2, to: 4 }],
    hills: [
      { x: 252, y: 62, rx: 44, ry: 23, rough: 0.2, face: 4 },
      { x: 144, y: 46, rx: 44, ry: 24, rough: 0.16, face: 3 },
      { x: 146, y: 34, rx: 15, ry: 7, rough: 0.2, tier: 2, face: 3 },
      { x: 62, y: 188, rx: 20, ry: 10, rough: 0.22, face: 3 },
    ],
    trails: [
      { points: [[72, 116], [100, 128], [124, 131], [150, 130], [172, 124], [192, 112], [204, 100]] },
      { points: [[92, 74], [130, 78], [170, 76], [192, 84], [204, 100]] },
      { points: [[56, 100], [58, 86], [72, 76], [92, 74]], half: 1.9 },
      { points: [[240, 100], [244, 88], [246, 68]], half: 1.9 },
      { points: [[204, 100], [232, 100], [262, 102], [284, 112], [296, 128]], half: 2 },
      { points: [[100, 128], [100, 152]], half: 1.9 },
      { points: [[150, 130], [158, 146], [160, 166], [162, 178]], half: 1.9 },
      { points: [[50, 128], [42, 138], [38, 148]], half: 1.8 },
    ],
    patches: [
      { kind: 'dirt', x: 56, y: 113, rx: 15, ry: 10 },
      { kind: 'meadow', x: 112, y: 176, rx: 40, ry: 26 },
      { kind: 'meadow', x: 196, y: 38, rx: 18, ry: 12 },
      { kind: 'forest', x: 144, y: 50, rx: 50, ry: 30 },
      { kind: 'meadow', x: 30, y: 92, rx: 14, ry: 20 },
      { kind: 'rocky', x: 276, y: 96, rx: 16, ry: 9 },
      { kind: 'rocky', x: 172, y: 146, rx: 10, ry: 6 },
    ],
    fields: [
      { x: 42, y: 44, w: 28, h: 18, crop: 0 },
      { x: 76, y: 42, w: 22, h: 24, crop: 1 },
      { x: 22, y: 156, w: 26, h: 16, crop: 0 },
    ],
    piers: [{ x: 216, y: 124, w: 5, h: 18 }],
    fences: [[[84, 156], [84, 198], [146, 198], [146, 156], [106, 156]]],
    ruins: [],
    roster: { lighthouse: 3, well: 3, hut: 4, windmill: 3, pine: 4, apple: 3, scarecrow: 3, cow: 3, sheep: 3, duck: 3, boat: 3, palm: 5 },
  },

  // Two jagged lumps of ice either side of a long fjord, with a frozen lake and a dark forest.
  snowy: {
    id: 'snowy',
    name: 'Snowy island',
    seed: 20261105,
    coasts: [
      [
        [28, 62], [62, 30], [104, 20], [150, 26], [200, 16], [246, 22], [262, 46], [256, 70], [226, 78], [194, 80],
        [168, 86], [160, 100], [170, 112], [200, 110], [238, 110], [278, 118], [304, 146], [294, 182], [254, 206],
        [206, 196], [172, 212], [120, 208], [78, 212], [38, 192], [14, 150], [24, 112], [12, 88],
      ],
      [[252, 28], [272, 14], [298, 18], [310, 38], [294, 54], [266, 52]],
      [[12, 198], [22, 190], [32, 200], [26, 212], [14, 212]],
    ],
    coastRough: 4.5,
    coastScale: 9,
    beach: 4,
    bluffs: [
      { x: 110, y: 212, rx: 60, ry: 18 },
      { x: 240, y: 200, rx: 40, ry: 16 },
      { x: 210, y: 80, rx: 50, ry: 12 },
    ],
    lakes: [{ x: 86, y: 136, rx: 26, ry: 14, rough: 0.22 }],
    rivers: [{ points: [[96, 144], [108, 156], [118, 172], [132, 186], [136, 200], [140, 224]], from: 2, to: 4 }],
    hills: [
      { x: 72, y: 60, rx: 56, ry: 28, rough: 0.2, face: 4 },
      { x: 68, y: 54, rx: 30, ry: 13, rough: 0.18, tier: 2, face: 4 },
      { x: 226, y: 42, rx: 24, ry: 13, rough: 0.2, face: 3 },
    ],
    trails: [
      { points: [[220, 156], [190, 142], [160, 140], [132, 140], [116, 158], [90, 170], [68, 174]] },
      { points: [[190, 142], [186, 130], [182, 122]], half: 2 },
      { points: [[132, 140], [134, 116], [132, 96], [146, 82], [176, 72], [200, 72]], half: 2 },
      { points: [[246, 158], [258, 164], [268, 172]], half: 1.9 },
      { points: [[50, 176], [26, 158], [24, 136], [36, 124]], half: 1.8 },
    ],
    patches: [
      { kind: 'dirt', x: 232, y: 158, rx: 16, ry: 10 },
      { kind: 'forest', x: 184, y: 46, rx: 72, ry: 30 },
      { kind: 'drift', x: 60, y: 174, rx: 34, ry: 20 },
      { kind: 'rocky', x: 76, y: 98, rx: 44, ry: 8 },
      { kind: 'icy', x: 150, y: 176, rx: 22, ry: 14 },
      { kind: 'drift', x: 270, y: 165, rx: 24, ry: 20 },
      { kind: 'rocky', x: 286, y: 40, rx: 16, ry: 8 },
    ],
    fields: [],
    piers: [{ x: 178, y: 104, w: 5, h: 14 }],
    fences: [],
    ruins: [],
    roster: { campfire: 3, cabin: 4, seal: 3, boat: 3, penguin: 3, snowpine: 5, pine: 4, birch: 3, igloo: 3, husky: 3, sled: 3, snowman: 3 },
  },

  // A long straight north shore and two great lobes split by an inlet, with an oasis at the heart.
  desert: {
    id: 'desert',
    name: 'Desert oasis',
    seed: 20261107,
    coasts: [
      [
        [34, 60], [78, 30], [136, 22], [196, 26], [252, 20], [296, 38], [310, 80], [304, 124], [306, 162], [284, 196],
        [244, 212], [208, 206], [192, 186], [182, 164], [170, 156], [158, 162], [146, 182], [128, 206], [82, 216],
        [36, 198], [14, 152], [12, 100],
      ],
    ],
    coastRough: 1.6,
    coastScale: 30,
    beach: 6,
    bluffs: [{ x: 70, y: 216, rx: 50, ry: 14 }],
    lakes: [{ x: 160, y: 100, rx: 34, ry: 19, rough: 0.16 }],
    rivers: [{ points: [[160, 114], [166, 126], [160, 138], [168, 150], [170, 172]], from: 2, to: 4 }],
    hills: [
      { x: 58, y: 68, rx: 32, ry: 19, rough: 0.3, face: 4 },
      { x: 56, y: 64, rx: 15, ry: 8, rough: 0.28, tier: 2, face: 4 },
      { x: 118, y: 178, rx: 14, ry: 9, rough: 0.28, face: 4 },
      { x: 272, y: 108, rx: 22, ry: 14, rough: 0.3, face: 4 },
    ],
    trails: [
      { points: [[30, 124], [70, 118], [110, 132], [160, 134], [214, 132], [252, 138], [286, 150]] },
      { points: [[214, 132], [218, 100], [224, 76]] },
      { points: [[116, 132], [120, 104], [122, 74], [136, 60]], half: 2 },
      { points: [[252, 138], [244, 156], [238, 170]], half: 1.9 },
      { points: [[70, 118], [66, 134], [62, 146]], half: 1.9 },
    ],
    patches: [
      { kind: 'lush', x: 160, y: 100, rx: 52, ry: 32 },
      { kind: 'dirt', x: 160, y: 54, rx: 18, ry: 9 },
      { kind: 'cracked', x: 60, y: 164, rx: 44, ry: 34 },
      { kind: 'dune', x: 246, y: 50, rx: 56, ry: 26 },
      { kind: 'dune', x: 256, y: 182, rx: 44, ry: 20 },
      { kind: 'rocky', x: 100, y: 38, rx: 26, ry: 8 },
      { kind: 'rocky', x: 282, y: 124, rx: 22, ry: 8 },
    ],
    fields: [{ x: 194, y: 104, w: 18, h: 15, crop: 0 }],
    piers: [],
    fences: [],
    ruins: [
      { x: 196, y: 56, rx: 11, ry: 7 },
      { x: 272, y: 42, rx: 9, ry: 6 },
    ],
    roster: { pyramid: 3, palm: 5, well: 3, tent: 4, campfire: 3, camel: 3, lizard: 3, skull: 3, deadtree: 3, vulture: 3, cactus: 4, cart: 3 },
  },
};

export const MAP_IDS = Object.keys(MAP_DEFS) as MapId[];
