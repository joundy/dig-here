import { describe, expect, it } from 'vitest';
import { clueText } from './copy';
import {
  advance, createGame, currentBonus, finishAt, joinGame, leaveGame, placeDig, potOf, rankDigs, scoreDig,
  secondsToNextClue, splitPot, standing, startGame,
} from './engine';
import { H, isLand, LANDMARKS_PER_MAP, MAP_IDS, rollLayout, seededRng, W } from './map';
import { RULES } from './rules';
import { GameError } from './types';
import type { Dig, Game, MapId, Point } from './types';

const rng = seededRng(7);
const input = {
  name: 'Test', host: 'host.near', mapId: 'tropical' as MapId, fee: 1000, durationSec: 100, hostCutBps: 500,
  minPlayers: 2, maxPlayers: 4, countdownSec: 0,
};

function room(over: Partial<typeof input> = {}): Game {
  const mapped = { ...input, ...over };
  return createGame('g', mapped, rollLayout(mapped.mapId, rng));
}

function live(players = ['a.near', 'b.near', 'c.near'], over: Partial<typeof input> = {}): Game {
  const game = room(over);
  players.forEach((p) => joinGame(game, p));
  startGame(game, game.host, rng);
  return game;
}

/** A land cell a safe distance from the first landmark. */
function landSpot(game: Game, index = 0): Point {
  const { x, y } = game.landmarks[index];
  return { x, y };
}

function dig(x: number, bonusBps: number, dugAt = 0, crowded = false): Dig {
  return { account: `p${x}`, x, y: 0, clueIndex: 0, bonusBps, crowded, dugAt };
}

describe('layout', () => {
  it('rolls different landmark positions for every game on the same map', () => {
    const spots = (g: Game) => g.landmarks.map((l) => `${l.kind}:${l.x},${l.y}`).join(' ');
    expect(spots(room())).not.toBe(spots(room()));
  });

  it('keeps the same roster of kinds in every game', () => {
    const kinds = (g: Game) => g.landmarks.map((l) => l.kind).sort().join();
    expect(kinds(room())).toBe(kinds(room()));
  });
});

describe('room stages', () => {
  it('starts in waiting, where nobody can dig', () => {
    const game = room();
    joinGame(game, 'a.near');
    expect(game.stage).toBe('waiting');
    expect(() => placeDig(game, 'a.near', landSpot(game))).toThrow(GameError);
  });

  it('counts a fee for every player who joined', () => {
    const game = room();
    joinGame(game, 'a.near');
    joinGame(game, 'b.near');
    expect(potOf(game)).toBe(2000);
    leaveGame(game, 'b.near');
    expect(potOf(game)).toBe(1000);
  });

  it('turns away a second join, a full room, and anyone after the start', () => {
    const game = room({ maxPlayers: 2 });
    joinGame(game, 'a.near');
    expect(() => joinGame(game, 'a.near')).toThrow(GameError);
    joinGame(game, 'b.near');
    expect(() => joinGame(game, 'c.near')).toThrow(/full/);
    startGame(game, game.host, rng);
    expect(() => joinGame(game, 'c.near')).toThrow(/started/);
    expect(() => leaveGame(game, 'a.near')).toThrow(GameError);
  });

  it('lets only the host start, and only at the minimum', () => {
    const game = room({ minPlayers: 3 });
    joinGame(game, 'a.near');
    joinGame(game, 'b.near');
    expect(() => startGame(game, game.host, rng)).toThrow(/3 players/);
    joinGame(game, 'c.near');
    expect(() => startGame(game, 'a.near', rng)).toThrow(/host/);
    startGame(game, game.host, rng);
    expect(game.stage).toBe('live');
  });

  it('runs the host\'s countdown from the minimum, and cancels it if players leave', () => {
    const game = room({ countdownSec: 30 });
    joinGame(game, 'a.near');
    expect(game.startIn).toBeNull();
    joinGame(game, 'b.near');
    expect(game.startIn).toBe(30);
    advance(game, 10, rng);
    expect(game.startIn).toBe(20);
    leaveGame(game, 'b.near');
    expect(game.startIn).toBeNull();
    joinGame(game, 'b.near');
    advance(game, 30, rng);
    expect(game.stage).toBe('live');
  });

  it('starts a full room in 5 seconds, with no countdown set', () => {
    const game = room({ maxPlayers: 2 });
    joinGame(game, 'a.near');
    joinGame(game, 'b.near');
    expect(game.startIn).toBe(RULES.fullRoomStartSec);
    advance(game, RULES.fullRoomStartSec, rng);
    expect(game.stage).toBe('live');
  });

  it('at the deadline, starts a room at its minimum', () => {
    const game = room();
    joinGame(game, 'a.near');
    joinGame(game, 'b.near');
    advance(game, RULES.waitingDeadlineSec, rng);
    expect(game.stage).toBe('live');
  });

  it('at the deadline, refunds a room below its minimum, so a missing host traps nothing', () => {
    const game = room();
    joinGame(game, 'a.near');
    advance(game, RULES.waitingDeadlineSec, rng);
    expect(game.stage).toBe('refunded');
    expect(game.result?.refundReason).toBe('expired');
    expect(game.result?.treasure).toBeNull();
  });

  it('refunds when fewer than 2 players dug, and rolls no treasure', () => {
    const game = live();
    placeDig(game, 'a.near', landSpot(game));
    advance(game, 100, rng);
    expect(game.stage).toBe('refunded');
    expect(game.result?.refundReason).toBe('too-few-digs');
    expect(game.result?.treasure).toBeNull();
  });

  it('keeps a no-show\'s fee in the pot when the round finishes', () => {
    const game = live();
    placeDig(game, 'a.near', landSpot(game, 0));
    placeDig(game, 'b.near', landSpot(game, 1));
    advance(game, 100, rng);
    expect(game.stage).toBe('finished');
    expect(game.result?.pot).toBe(3000);
    expect(game.result?.ranking).toHaveLength(2);
  });

  it('validates the host\'s settings', () => {
    expect(() => room({ name: ' ' })).toThrow(GameError);
    expect(() => room({ fee: 0 })).toThrow(GameError);
    expect(() => room({ hostCutBps: 2001 })).toThrow(/20%/);
    expect(() => room({ minPlayers: 1 })).toThrow(GameError);
    expect(() => room({ maxPlayers: 31 })).toThrow(GameError);
    expect(() => room({ minPlayers: 5, maxPlayers: 4 })).toThrow(GameError);
  });
});

describe('clues', () => {
  it('starts with a YOLO clue that narrows nothing and pays the top bonus', () => {
    const game = live();
    expect(game.clues).toEqual([{ level: 'yolo' }]);
    expect(game.candidateIds).toHaveLength(LANDMARKS_PER_MAP);
    expect(currentBonus(game)).toBe(25000);
  });

  it('appears at 0, 30, 60 and 85 percent of the round, and only narrows', () => {
    const game = live();
    const counts = [game.candidateIds.length];
    expect(secondsToNextClue(game)).toBe(30);
    advance(game, 29, rng);
    expect(game.clues).toHaveLength(1);
    advance(game, 1, rng);
    expect(game.clues).toHaveLength(2);
    expect(game.clues[1].level).toBe('category');
    counts.push(game.candidateIds.length);
    advance(game, 30, rng);
    expect(game.clues[2].level).toBe('kind');
    counts.push(game.candidateIds.length);
    advance(game, 25, rng);
    expect(game.clues[3].level).toBe('detail');
    expect(secondsToNextClue(game)).toBeNull();
    counts.push(game.candidateIds.length);
    for (let i = 1; i < counts.length; i++) expect(counts[i]).toBeLessThanOrEqual(counts[i - 1]);
    expect(counts[3]).toBeGreaterThan(0);
  });

  it('has wording for every clue that can come up on every map', () => {
    for (const mapId of MAP_IDS) {
      for (let seed = 0; seed < 30; seed++) {
        const game = live(['a.near', 'b.near'], { mapId });
        advance(game, 90, seededRng(seed));
        for (const clue of game.clues) {
          const { text, plain } = clueText(mapId, clue);
          expect(text.length).toBeGreaterThan(5);
          expect(plain.length).toBeGreaterThan(5);
          expect(`${text} ${plain}`).not.toContain('undefined');
        }
      }
    }
  });

});

describe('treasure', () => {
  it('stores no location until the round has ended', () => {
    const game = live();
    placeDig(game, 'a.near', landSpot(game));
    advance(game, 90, rng);
    expect(game.result).toBeNull();
    expect(JSON.stringify(game)).not.toContain('treasure');
  });

  it.each(MAP_IDS)('always lands on land, close to a landmark that fits the clues, on %s', (mapId) => {
    for (let seed = 0; seed < 150; seed++) {
      const r = seededRng(seed);
      const game = live(['a.near', 'b.near'], { mapId });
      placeDig(game, 'a.near', landSpot(game, 0));
      placeDig(game, 'b.near', landSpot(game, 1));
      advance(game, 99, r);
      const candidates = [...game.candidateIds];
      advance(game, 1, r);
      const t = game.result!.treasure!;
      const landmark = game.landmarks[t.landmarkId];
      expect(isLand(mapId, t)).toBe(true);
      expect(candidates).toContain(t.landmarkId);
      expect(Math.hypot(t.x - landmark.x, t.y - landmark.y)).toBeLessThanOrEqual(RULES.treasureScatter);
    }
  });
});

describe('scoring', () => {
  it('matches the tutorial: 90 closeness at ×1.5 scores 135, and beats a perfect dig at ×1', () => {
    const t = { x: 0, y: 0 };
    const early = scoreDig({ ...dig(0, 15000), x: 4, y: 3 }, t);
    expect(early.distance).toBe(5000);
    expect(early.closeness).toBe(948);
    const ninety = scoreDig({ ...dig(0, 15000), x: 4, y: 3 }, { x: 0, y: 0 });
    expect(ninety.score).toBe(Math.floor((948 * 15000) / 10000));
    const perfect = scoreDig(dig(0, 10000), t);
    expect(perfect.closeness).toBe(1000);
    expect(perfect.score).toBe(1000);
    expect(ninety.score).toBeGreaterThan(perfect.score);
  });

  it('reaches zero at the closeness range', () => {
    expect(scoreDig(dig(RULES.closenessRange, 25000), { x: 0, y: 0 }).closeness).toBe(0);
  });

  it('scores an old round by the range it was played under', () => {
    const old = scoreDig(dig(RULES.closenessRangeBefore, 25000), { x: 0, y: 0 }, RULES.closenessRangeBefore);
    expect(old.closeness).toBe(0);
    expect(scoreDig(dig(RULES.closenessRangeBefore, 25000), { x: 0, y: 0 }).closeness).toBe(500);
  });

  it('multiplies a crowded dig by 0.85', () => {
    const t = { x: 0, y: 0 };
    expect(scoreDig(dig(0, 10000, 0, true), t).score).toBe(850);
    expect(scoreDig(dig(0, 10000, 0, false), t).score).toBe(1000);
  });

  it('crowds only the later digger, within 6 pixels', () => {
    const game = live();
    const base = landSpot(game);
    const first = placeDig(game, 'a.near', base);
    const second = placeDig(game, 'b.near', { x: base.x, y: base.y });
    expect(first.crowded).toBe(false);
    expect(second.crowded).toBe(true);
    expect(game.digs[0].crowded).toBe(false);
  });

  it('doesn\'t crowd a dig just outside the radius', () => {
    const game = live();
    let a: Point | null = null;
    for (let i = 0; i < W * H && !a; i++) {
      const x = i % W;
      const y = Math.floor(i / W);
      if (isLand(game.mapId, { x, y }) && isLand(game.mapId, { x: x + RULES.crowdRadius + 1, y })) a = { x, y };
    }
    placeDig(game, 'a.near', a!);
    expect(placeDig(game, 'b.near', { x: a!.x + RULES.crowdRadius + 1, y: a!.y }).crowded).toBe(false);
  });

  it('gives equal scores to whoever dug first', () => {
    const t = { x: 0, y: 0 };
    const ranked = rankDigs([scoreDig({ ...dig(1, 10000, 5), account: 'late' }, t), scoreDig({ ...dig(1, 10000, 1), account: 'early' }, t)]);
    expect(ranked[0].account).toBe('early');
  });

  it('falls back to the closest dig when nobody scored', () => {
    const t = { x: 0, y: 0 };
    const ranked = rankDigs([scoreDig(dig(200, 25000), t), scoreDig(dig(100, 10000), t)]);
    expect(ranked[0].x).toBe(100);
  });

  it('records the bonus of the clue showing when the player dug', () => {
    const game = live();
    const yolo = placeDig(game, 'a.near', landSpot(game, 0));
    advance(game, 30, rng);
    const second = placeDig(game, 'b.near', landSpot(game, 1));
    expect(yolo.bonusBps).toBe(25000);
    expect(second.bonusBps).toBe(15000);
    expect(second.clueIndex).toBe(1);
  });
});

describe('digging', () => {
  it('rejects anyone who didn\'t join', () => {
    const game = live();
    expect(() => placeDig(game, 'stranger.near', landSpot(game))).toThrow(/joined/);
  });

  it('rejects a second dig from the same wallet', () => {
    const game = live();
    placeDig(game, 'a.near', landSpot(game, 0));
    expect(() => placeDig(game, 'a.near', landSpot(game, 1))).toThrow(/already/);
  });

  it('rejects water, and positions that aren\'t whole pixels', () => {
    const game = live();
    expect(() => placeDig(game, 'a.near', { x: 0, y: 0 })).toThrow(/water/);
    expect(() => placeDig(game, 'a.near', { x: 100.5, y: 100 })).toThrow(/water/);
  });

  it('turns a dig down if a new clue arrived on the way, so it never quietly loses bonus', () => {
    const game = live();
    const seen = game.clues.length;
    advance(game, 30, rng);
    expect(() => placeDig(game, 'a.near', landSpot(game), seen)).toThrow(/new clue/);
    expect(game.digs).toHaveLength(0);
    expect(placeDig(game, 'a.near', landSpot(game), game.clues.length).bonusBps).toBe(15000);
  });

  it('rejects a dig after the round ends', () => {
    const game = live();
    advance(game, 100, rng);
    expect(() => placeDig(game, 'a.near', landSpot(game))).toThrow(/ended/);
  });
});

describe('standing', () => {
  it('is null before you dig, and counts the spots you would win', () => {
    const game = live();
    expect(standing(game, 'a.near')).toBeNull();
    placeDig(game, 'a.near', landSpot(game, 0));
    const alone = standing(game, 'a.near')!;
    const count = LANDMARKS_PER_MAP;
    expect(alone.of).toBe(count);
    expect(alone.wins).toHaveLength(count);
    placeDig(game, 'b.near', landSpot(game, 1));
    const shared = standing(game, 'a.near')!;
    const theirs = standing(game, 'b.near')!;
    expect(shared.wins).toContain(0);
    expect(theirs.wins).toContain(1);
    expect(shared.wins.length + theirs.wins.length).toBe(count);
  });
});

describe('splitPot', () => {
  it('matches the plan\'s example and never loses a coin', () => {
    expect(splitPot(10000, 500)).toEqual({ hostCut: 500, jackpot: 300, deed: 200, season: 100, prize: 8900 });
    for (const pot of [1, 7, 999, 1234567]) {
      for (const bps of [0, 333, 2000]) {
        const s = splitPot(pot, bps);
        expect(s.hostCut + s.jackpot + s.deed + s.season + s.prize).toBe(pot);
      }
    }
  });
});

it('finishAt ranks digs against the given treasure', () => {
  const game = live();
  const spot = landSpot(game, 0);
  placeDig(game, 'a.near', spot);
  placeDig(game, 'b.near', landSpot(game, 1));
  finishAt(game, { ...spot, landmarkId: 0 });
  expect(game.result?.winner).toBe('a.near');
});
