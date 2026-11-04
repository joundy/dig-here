// Bakes the island into pixels once, and animates the water by cycling colours by distance from shore.
import { getMap, H, W } from '../game/map';
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

/** Distance in pixels from each cell to the nearest cell where `isSource` is true. */
function distanceField(isSource: (i: number) => boolean): Float32Array {
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

export type Terrain = {
  land: HTMLCanvasElement;
  water: HTMLCanvasElement;
  paintWater: (time: number) => void;
};

export function buildTerrain(mapId: MapId): Terrain {
  const { land: landMask, hills: hillMask } = getMap(mapId);
  const { land: colors, water: waters } = themeOf(mapId);

  const toLand = distanceField((i) => landMask[i] === 1);
  const toWater = distanceField((i) => landMask[i] === 0);
  const toHillEdge = distanceField((i) => hillMask[i] === 0);

  const landCanvas = document.createElement('canvas');
  landCanvas.width = W;
  landCanvas.height = H;
  const landCtx = landCanvas.getContext('2d')!;
  const landImage = landCtx.createImageData(W, H);
  const landPixels = new Uint32Array(landImage.data.buffer);

  const SHORE = rgba(colors.shore);
  const SAND = rgba(colors.sand);
  const BASE = rgba(colors.base);
  const HILL = rgba(colors.hill);
  const BASE_SPECK = rgba(colors.baseSpeck);
  const HILL_SPECK = rgba(colors.hillSpeck);
  const RIPPLE = colors.ripple ? rgba(colors.ripple) : null;
  let reach = colors.speck;
  const flecks = colors.flecks.map(([color, share]) => ({ color: rgba(color), upTo: (reach += share) }));

  for (let y = 0; y < H; y++) {
    for (let x = 0; x < W; x++) {
      const i = y * W + x;
      if (!landMask[i]) continue;
      const shore = toWater[i] + hash(x, y) * 0.7;
      const checker = (x + y) % 2 === 0;
      const r = hash(x + 3, y + 7);
      let color: number;
      if (shore < 1.6) color = SHORE;
      else if (shore < 3.6) color = SAND;
      else if (shore < 5 && checker) color = SAND;
      else {
        const hill = hillMask[i] && (toHillEdge[i] > 2 || checker);
        color = hill ? HILL : BASE;
        if (r < colors.speck) color = hill ? HILL_SPECK : BASE_SPECK;
        else if (!hill) color = flecks.find((fleck) => r < fleck.upTo)?.color ?? color;
        else if (RIPPLE !== null && Math.floor(y + Math.sin(x * 0.2) * 2.4) % 5 === 0) color = RIPPLE;
      }
      landPixels[i] = color;
    }
  }
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
  let n = 0;
  for (let y = 0; y < H; y++) {
    for (let x = 0; x < W; x++) {
      const i = y * W + x;
      if (landMask[i]) continue;
      index[n] = i;
      depth[n] = toLand[i];
      wobble[n] = Math.sin(x * 0.19 + y * 0.07) * 1.2 + Math.sin(y * 0.31 - x * 0.11) * 0.9;
      // Glints stay clear of the canvas edge, so the water meets the page without a seam.
      const edge = Math.min(x, y, W - 1 - x, H - 1 - y);
      const r = hash(x + 11, y + 29);
      glint[n] = edge > 6 && r < 0.016 ? r * 5000 : -1;
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
