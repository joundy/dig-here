import { describe, expect, it } from 'vitest';
import { advance, createGame, placeDig, rankDigs, scoreDig, splitPot } from './engine';
import { isLand, MAP, seededRng } from './map';
import { RULES } from './rules';
import { GameError } from './types';
import type { Dig, Game, Point } from './types';

const input = { name: 'Test', host: 'host.near', fee: 1000, durationSec: 100, hostCutBps: 500 };
const landSpot: Point = { x: MAP.landmarks[0].x, y: MAP.landmarks[0].y };

function newGame(seed = 1): Game {
  return createGame('g', input, seededRng(seed));
}

function digAt(x: number, bonus: number, dugAt = 0): Dig {
  return { account: `p${x}`, x, y: 0, clueIndex: 0, bonus, dugAt };
}

describe('map', () => {
  it('keeps landmarks far enough apart for their sprites', () => {
    for (const a of MAP.landmarks) {
      for (const b of MAP.landmarks) {
        if (a.id !== b.id) expect(Math.hypot(a.x - b.x, a.y - b.y)).toBeGreaterThanOrEqual(58);
      }
    }
  });

  it('places every landmark on land and has several of each kind', () => {
    expect(MAP.landmarks.every((l) => isLand(l))).toBe(true);
    const counts = new Map<string, number>();
    for (const l of MAP.landmarks) counts.set(l.kind, (counts.get(l.kind) ?? 0) + 1);
    expect(counts.size).toBe(14);
    expect(Math.min(...counts.values())).toBeGreaterThanOrEqual(3);
  });
});

describe('clues', () => {
  it('appears at 0%, 50% and 90% of the round, and only narrows the candidates', () => {
    const rng = seededRng(7);
    const game = createGame('g', input, rng);
    expect(game.clues).toHaveLength(1);
    const first = game.candidateIds.length;

    advance(game, 49, rng);
    expect(game.clues).toHaveLength(1);
    advance(game, 1, rng);
    expect(game.clues).toHaveLength(2);
    const second = game.candidateIds.length;
    expect(second).toBeLessThan(first);

    advance(game, 40, rng);
    expect(game.clues).toHaveLength(3);
    expect(game.candidateIds.length).toBeLessThanOrEqual(second);
    expect(game.candidateIds.length).toBeGreaterThan(0);
  });

  it('stores no treasure location until the round has ended', () => {
    const rng = seededRng(3);
    const game = createGame('g', input, rng);
    placeDig(game, 'a.near', landSpot);
    advance(game, 99, rng);
    expect(game.result).toBeNull();
    expect(JSON.stringify(game)).not.toContain('treasure');
  });

  it('always lands the treasure near a landmark matching the final clue', () => {
    for (let seed = 0; seed < 200; seed++) {
      const rng = seededRng(seed);
      const game = createGame('g', input, rng);
      placeDig(game, 'a.near', landSpot);
      placeDig(game, 'b.near', landSpot);
      advance(game, 95, rng);
      const finalCandidates = [...game.candidateIds];
      advance(game, 5, rng);

      const treasure = game.result!.treasure!;
      expect(finalCandidates).toContain(treasure.landmarkId);
      const landmark = MAP.landmarks[treasure.landmarkId];
      expect(Math.hypot(treasure.x - landmark.x, treasure.y - landmark.y)).toBeLessThanOrEqual(RULES.treasureScatter);
      expect(isLand(treasure)).toBe(true);
    }
  });
});

describe('scoring', () => {
  const treasure = { x: 0, y: 0 };
  const range = RULES.closenessRange;

  it('matches the worked example: an early dig can beat a closer late dig, but not a far one', () => {
    const ana = scoreDig(digAt(range * 0.3, 1.5), treasure);
    const ben = scoreDig(digAt(range * 0.1, 1), treasure);
    const cara = scoreDig(digAt(range * 0.45, 1.5), treasure);
    expect(ana.score).toBeCloseTo(105);
    expect(ben.score).toBeCloseTo(90);
    expect(cara.score).toBeCloseTo(82.5);
    expect(rankDigs([cara, ben, ana]).map((d) => d.account)).toEqual([ana.account, ben.account, cara.account]);
  });

  it('gives equal scores to whoever dug first', () => {
    const late = { ...scoreDig(digAt(30, 1, 50), treasure), account: 'late' };
    const early = { ...scoreDig(digAt(30, 1, 10), treasure), account: 'early' };
    expect(rankDigs([late, early])[0].account).toBe('early');
  });

  it('falls back to the closest dig when nobody scored', () => {
    const far = scoreDig(digAt(range * 3, 2), treasure);
    const nearer = scoreDig(digAt(range * 2, 1, 50), treasure);
    expect(far.score).toBe(0);
    expect(rankDigs([far, nearer])[0].account).toBe(nearer.account);
  });

  it('records the bonus of the clue showing when the player dug', () => {
    const rng = seededRng(2);
    const game = createGame('g', input, rng);
    expect(placeDig(game, 'a.near', landSpot).bonus).toBe(2);
    advance(game, 50, rng);
    expect(placeDig(game, 'b.near', landSpot).bonus).toBe(1.5);
    advance(game, 40, rng);
    expect(placeDig(game, 'c.near', landSpot).bonus).toBe(1);
  });
});

describe('money', () => {
  it('never loses or creates money when splitting the pot', () => {
    for (const [pot, bps] of [[1000, 500], [3333, 777], [7, 2000], [100000, 0], [1, 1999]]) {
      const { hostCut, prize } = splitPot(pot, bps);
      expect(hostCut + prize).toBe(pot);
      expect(hostCut).toBeGreaterThanOrEqual(0);
    }
  });

  it('pays the winner the pot minus the host share', () => {
    const rng = seededRng(5);
    const game = createGame('g', input, rng);
    placeDig(game, 'a.near', landSpot);
    placeDig(game, 'b.near', landSpot);
    advance(game, 100, rng);
    expect(game.status).toBe('finished');
    expect(game.result).toMatchObject({ pot: 2000, hostCut: 100, prize: 1900 });
  });

  it('refunds when fewer than two players joined, and rolls no treasure', () => {
    const rng = seededRng(5);
    const game = createGame('g', input, rng);
    placeDig(game, 'a.near', landSpot);
    advance(game, 100, rng);
    expect(game.status).toBe('refunded');
    expect(game.result?.treasure).toBeNull();
  });
});

describe('rules', () => {
  it('rejects a second dig from the same wallet', () => {
    const game = newGame();
    placeDig(game, 'a.near', landSpot);
    expect(() => placeDig(game, 'a.near', landSpot)).toThrow(GameError);
  });

  it('rejects a dig in the sea', () => {
    expect(() => placeDig(newGame(), 'a.near', { x: 2, y: 2 })).toThrow(/water/);
  });

  it('rejects a dig after the round ends', () => {
    const rng = seededRng(1);
    const game = createGame('g', input, rng);
    advance(game, 100, rng);
    expect(() => placeDig(game, 'a.near', landSpot)).toThrow(/ended/);
  });

  it('rejects a host share above the cap', () => {
    expect(() => createGame('g', { ...input, hostCutBps: 2001 }, seededRng(1))).toThrow(/20%/);
  });
});
