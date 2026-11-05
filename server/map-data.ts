import { readFileSync } from 'node:fs';
import { join } from 'node:path';

export type MapData = { land: Buffer; spots: Array<{ x: number; y: number }> };

const W = 320;
const H = 224;
const MAPS = ['tropical', 'snowy', 'desert'];

/** The same bytes the contract compiled in, so a bot's "is this land" can't disagree with the contract's. */
export function loadMaps(dir: string): Record<string, MapData> {
  const out: Record<string, MapData> = {};
  for (const map of MAPS) {
    const raw = readFileSync(join(dir, `spots-${map}.bin`));
    const spots = [];
    for (let i = 0; i + 6 <= raw.length; i += 6) spots.push({ x: raw.readUInt16LE(i), y: raw[i + 2] });
    out[map] = { land: readFileSync(join(dir, `land-${map}.bin`)), spots };
  }
  return out;
}

export function isLand(data: MapData, x: number, y: number): boolean {
  if (x < 0 || y < 0 || x >= W || y >= H) return false;
  const i = y * W + x;
  return ((data.land[i >> 3] >> (i & 7)) & 1) === 1;
}
