import { describe, expect, it } from 'vitest';
import { MAP_IDS } from '../game/map';
import { deedKinds } from '../game/economy';
import type { Grid } from './heroArt';
import { heroFrames, heroGrid, heroLayers, heroSize, scale2x, shade, silhouette, thinOutline } from './heroArt';
import { paintScene, seeded, surfaceOf } from './deedScene';
import { PALETTE } from './sprites';

const K = PALETTE.k;
const W = PALETTE.w;

describe('the art at card size', () => {
  it('doubles the resolution, and rounds a staircase', () => {
    const grid: Grid = [['', K], [K, K]];
    const big = scale2x(grid);
    expect(big).toHaveLength(4);
    expect(big[0]).toHaveLength(4);
    // The inside of the step fills in, so the edge runs on the diagonal.
    expect(big[0][0]).toBe('');
    expect(big[1][1]).toBe(K);
    expect(big[0][2]).toBe(K);
  });

  it('keeps inside details square when asked to round only the outside', () => {
    const grid: Grid = [[K, W, K], [W, K, W], [K, W, K]];
    expect(scale2x(grid, true)[1][1]).toBe(K);
    expect(scale2x(grid)[1][1]).toBe(W);
  });

  it('thins an outline that has colour behind it, and leaves a line with nothing behind it', () => {
    const edge: Grid = [['', K, K, W, W], ['', K, K, W, W], ['', K, K, W, W]];
    expect(thinOutline(edge)[1]).toEqual(['', '', K, W, W]);
    const line: Grid = [['', K, K, ''], ['', K, K, ''], ['', K, K, '']];
    expect(thinOutline(line)).toEqual(line);
  });

  it('takes the nub off a thinned corner', () => {
    const nub: Grid = [['', K, ''], ['', W, ''], ['', W, '']];
    expect(thinOutline(nub)[0][1]).toBe('');
  });

  it('never recolours an outline when shading', () => {
    const grid: Grid = [[K, K, K], [K, W, K], [K, K, K]];
    const shaded = shade([[K, K, K, K], [K, W, W, K], [K, W, W, K], [K, K, K, K]]);
    expect(shaded[0]).toEqual([K, K, K, K]);
    expect(shaded[1][1]).not.toBe(W);
    expect(shade(grid)[1][1]).toBe(W);
  });

  it('turns everything one colour for a silhouette, and keeps the holes', () => {
    expect(silhouette([[K, ''], [W, W]], '#000000')).toEqual([['#000000', ''], ['#000000', '#000000']]);
  });

  for (const map of MAP_IDS) {
    for (const kind of deedKinds(map)) {
      it(`${map} ${kind} still looks like something at card size`, () => {
        const grid = heroGrid(heroLayers(kind)[0].name);
        const filled = grid.flat().filter(Boolean).length;
        expect(filled).toBeGreaterThan(100);
        const { w, h } = heroSize(kind);
        // The largest hero must fit a card: the windmill reaches 46 art pixels with its sails.
        expect(w).toBeLessThanOrEqual(40);
        expect(h).toBeLessThanOrEqual(46);
        expect(grid.flat().every((cell) => cell === '' || /^#[0-9a-f]{6}$/.test(cell))).toBe(true);
      });
    }
  }

  it('gives a campfire and a windmill their moving parts', () => {
    expect(heroFrames('horse')).toBe(1);
    expect(heroFrames('windmill')).toBe(2);
    expect(heroLayers('windmill', 1)[1].name).toBe('bladesCross');
    expect(heroLayers('campfire', 2)[0].name).toBe('campfire3');
    expect(heroSize('windmill').overhang).toBe(4);
  });
});

describe('the scene behind it', () => {
  const paintOf = (seed: string) => {
    const calls: unknown[][] = [];
    paintScene((...args) => calls.push(args), 'snowy', 'penguin', seed, 40, 50, 30);
    return calls;
  };

  it('is the same every time for one NFT, and different for another', () => {
    expect(paintOf('snowy:penguin')).toEqual(paintOf('snowy:penguin'));
    expect(paintOf('snowy:penguin')).not.toEqual(paintOf('snowy:seal'));
    expect(seeded('a')()).toBe(seeded('a')());
  });

  it('puts a boat on water and a palm on sand', () => {
    expect(surfaceOf('boat')).toBe('water');
    expect(surfaceOf('palm')).toBe('sand');
    expect(surfaceOf('horse')).toBe('land');
  });
});
