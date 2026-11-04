// What makes each map different. All of it is public: a contract only needs the finished landmark
// list and land grid, not this generator.
import type { Category, Kind, MapId } from './types';

export type Placement = { kind: Kind; count: number; minShore: number; maxShore: number };

/** A wobbly oval in design units, where the map is 1000 by 700. `fit` stretches it to exactly fill a box. */
export type Blob = { cx: number; cy: number; rx: number; ry: number; points: number; rough: number; fit?: [number, number, number, number] };

export type MapDef = {
  id: MapId;
  name: string;
  seed: number;
  lands: Blob[];
  lakes: Blob[];
  hills: Blob[];
  placement: Placement[];
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

// In each list, the rarest and most location-picky come first, so they still find room.
export const MAP_DEFS: Record<MapId, MapDef> = {
  tropical: {
    id: 'tropical',
    name: 'Tropical island',
    seed: 20261103,
    lands: [{ cx: 500, cy: 350, rx: 440, ry: 292, points: 160, rough: 0.13, fit: [66, 56, 934, 644] }],
    lakes: [{ cx: 585, cy: 300, rx: 72, ry: 46, points: 60, rough: 0.12 }],
    hills: [
      { cx: 300, cy: 250, rx: 130, ry: 70, points: 50, rough: 0.14 },
      { cx: 690, cy: 480, rx: 150, ry: 75, points: 50, rough: 0.14 },
      { cx: 360, cy: 500, rx: 95, ry: 55, points: 50, rough: 0.14 },
      { cx: 800, cy: 270, rx: 80, ry: 60, points: 50, rough: 0.14 },
    ],
    placement: [
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
    ],
  },
  snowy: {
    id: 'snowy',
    name: 'Snowy island',
    seed: 20261105,
    lands: [
      { cx: 450, cy: 380, rx: 380, ry: 260, points: 160, rough: 0.12, fit: [46, 90, 850, 660] },
      { cx: 810, cy: 170, rx: 130, ry: 100, points: 80, rough: 0.12, fit: [700, 50, 960, 250] },
    ],
    lakes: [{ cx: 390, cy: 390, rx: 70, ry: 40, points: 60, rough: 0.14 }],
    hills: [
      { cx: 210, cy: 280, rx: 110, ry: 70, points: 50, rough: 0.14 },
      { cx: 620, cy: 300, rx: 120, ry: 60, points: 50, rough: 0.14 },
      { cx: 560, cy: 540, rx: 130, ry: 62, points: 50, rough: 0.14 },
      { cx: 820, cy: 165, rx: 60, ry: 40, points: 50, rough: 0.14 },
    ],
    placement: [
      { kind: 'lighthouse', count: 3, minShore: 12, maxShore: 34 },
      { kind: 'boat', count: 4, minShore: 8, maxShore: 26 },
      { kind: 'seal', count: 5, minShore: 8, maxShore: 34 },
      { kind: 'penguin', count: 6, minShore: 10, maxShore: 55 },
      { kind: 'well', count: 3, minShore: 45, maxShore: 999 },
      { kind: 'igloo', count: 5, minShore: 30, maxShore: 999 },
      { kind: 'cabin', count: 4, minShore: 40, maxShore: 999 },
      { kind: 'pine', count: 6, minShore: 40, maxShore: 999 },
      { kind: 'snowpine', count: 6, minShore: 40, maxShore: 999 },
      { kind: 'birch', count: 4, minShore: 35, maxShore: 999 },
      { kind: 'husky', count: 5, minShore: 25, maxShore: 999 },
      { kind: 'snowman', count: 4, minShore: 25, maxShore: 999 },
      { kind: 'sled', count: 3, minShore: 25, maxShore: 999 },
      { kind: 'campfire', count: 2, minShore: 25, maxShore: 999 },
    ],
  },
  desert: {
    id: 'desert',
    name: 'Desert oasis',
    seed: 20261107,
    lands: [{ cx: 500, cy: 350, rx: 450, ry: 285, points: 160, rough: 0.09, fit: [50, 66, 950, 640] }],
    lakes: [
      { cx: 470, cy: 340, rx: 92, ry: 58, points: 60, rough: 0.14 },
      { cx: 770, cy: 480, rx: 44, ry: 28, points: 50, rough: 0.12 },
    ],
    hills: [
      { cx: 240, cy: 210, rx: 130, ry: 58, points: 50, rough: 0.12 },
      { cx: 720, cy: 220, rx: 150, ry: 62, points: 50, rough: 0.12 },
      { cx: 300, cy: 500, rx: 150, ry: 60, points: 50, rough: 0.12 },
      { cx: 610, cy: 560, rx: 90, ry: 42, points: 50, rough: 0.12 },
    ],
    placement: [
      { kind: 'palm', count: 7, minShore: 10, maxShore: 42 },
      { kind: 'well', count: 3, minShore: 90, maxShore: 999 },
      { kind: 'pyramid', count: 3, minShore: 60, maxShore: 999 },
      { kind: 'windmill', count: 3, minShore: 60, maxShore: 999 },
      { kind: 'tent', count: 6, minShore: 20, maxShore: 999 },
      { kind: 'cactus', count: 7, minShore: 45, maxShore: 999 },
      { kind: 'deadtree', count: 4, minShore: 45, maxShore: 999 },
      { kind: 'camel', count: 6, minShore: 25, maxShore: 999 },
      { kind: 'horse', count: 3, minShore: 25, maxShore: 999 },
      { kind: 'lizard', count: 4, minShore: 25, maxShore: 999 },
      { kind: 'vulture', count: 3, minShore: 45, maxShore: 999 },
      { kind: 'skull', count: 4, minShore: 40, maxShore: 999 },
      { kind: 'cart', count: 4, minShore: 25, maxShore: 999 },
      { kind: 'campfire', count: 3, minShore: 25, maxShore: 999 },
    ],
  },
};

export const MAP_IDS = Object.keys(MAP_DEFS) as MapId[];
