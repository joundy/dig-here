// The game rules, with no UI, wallet or storage. A NEAR contract will implement the same steps.
import { rollNextClue } from './clues';
import { isLand, MAP } from './map';
import { RULES } from './rules';
import { GameError } from './types';
import type { Dig, Game, NewGameInput, Point, RankedDig, Result, Rng } from './types';

export function createGame(id: string, input: NewGameInput, rng: Rng): Game {
  if (!input.name.trim()) throw new GameError('Give the game a name.');
  if (!(input.fee > 0)) throw new GameError('Set an entry fee above 0.');
  if (input.hostCutBps < 0 || input.hostCutBps > RULES.maxHostCutBps) {
    throw new GameError(`The host can keep at most ${RULES.maxHostCutBps / 100}% of the pot.`);
  }
  if (!(input.durationSec > 0)) throw new GameError('Pick a timer.');

  const game: Game = {
    id,
    name: input.name.trim(),
    host: input.host,
    fee: input.fee,
    durationSec: input.durationSec,
    hostCutBps: input.hostCutBps,
    elapsed: 0,
    status: 'open',
    clues: [],
    candidateIds: MAP.landmarks.map((l) => l.id),
    digs: [],
    result: null,
  };
  rollNextClue(game, rng);
  return game;
}

export function currentBonus(game: Game): number {
  return RULES.clueSchedule[game.clues.length - 1].bonus;
}

/** Seconds until the bonus drops, or null once the last clue is out. */
export function secondsToNextClue(game: Game): number | null {
  const next = RULES.clueSchedule[game.clues.length];
  return next ? next.startsAt * game.durationSec - game.elapsed : null;
}

export function secondsLeft(game: Game): number {
  return Math.max(0, game.durationSec - game.elapsed);
}

export function potOf(game: Game): number {
  return game.fee * game.digs.length;
}

export function splitPot(pot: number, hostCutBps: number): { hostCut: number; prize: number } {
  const hostCut = Math.floor((pot * hostCutBps) / 10000);
  return { hostCut, prize: pot - hostCut };
}

/** Moves the clock, rolling clues and finishing the round as their times come up. */
export function advance(game: Game, seconds: number, rng: Rng): void {
  if (game.status !== 'open') return;
  game.elapsed += seconds;
  const fraction = game.elapsed / game.durationSec;
  while (game.clues.length < RULES.clueSchedule.length && RULES.clueSchedule[game.clues.length].startsAt <= fraction) {
    rollNextClue(game, rng);
  }
  if (fraction >= 1) settle(game, rng);
}

export function placeDig(game: Game, account: string, spot: Point): Dig {
  if (game.status !== 'open') throw new GameError('This game has ended.');
  if (game.digs.some((d) => d.account === account)) throw new GameError('You already dug in this game.');
  if (!isLand(spot)) throw new GameError('That spot is water. Pick a spot on land.');
  const dig: Dig = {
    account,
    x: spot.x,
    y: spot.y,
    clueIndex: game.clues.length - 1,
    bonus: currentBonus(game),
    dugAt: game.elapsed,
  };
  game.digs.push(dig);
  return dig;
}

export function scoreDig(dig: Dig, treasure: Point): RankedDig {
  const distance = Math.hypot(dig.x - treasure.x, dig.y - treasure.y);
  const closeness = Math.max(0, Math.round(1000 * (1 - distance / RULES.closenessRange)) / 10);
  return { ...dig, distance, closeness, score: Math.round(closeness * dig.bonus * 10) / 10 };
}

/** Best score first. Equal scores go to whoever dug first; if nobody scored, closest wins. */
export function rankDigs(digs: RankedDig[]): RankedDig[] {
  return [...digs].sort((a, b) => {
    if (a.score !== b.score) return b.score - a.score;
    if (a.score === 0 && a.distance !== b.distance) return a.distance - b.distance;
    return a.dugAt - b.dugAt;
  });
}

function rollTreasure(game: Game, rng: Rng): NonNullable<Result['treasure']> {
  const landmarkId = game.candidateIds[Math.floor(rng() * game.candidateIds.length)];
  const landmark = MAP.landmarks[landmarkId];
  for (let attempt = 0; attempt < 50; attempt++) {
    const angle = rng() * Math.PI * 2;
    const radius = Math.sqrt(rng()) * RULES.treasureScatter;
    const spot = { x: landmark.x + Math.cos(angle) * radius, y: landmark.y + Math.sin(angle) * radius };
    if (isLand(spot)) return { ...spot, landmarkId };
  }
  return { x: landmark.x, y: landmark.y, landmarkId };
}

function settle(game: Game, rng: Rng): void {
  game.elapsed = game.durationSec;
  const pot = potOf(game);

  if (game.digs.length < RULES.minPlayers) {
    game.status = 'refunded';
    game.result = { treasure: null, ranking: [], winner: null, pot, hostCut: 0, prize: 0 };
    return;
  }

  const treasure = rollTreasure(game, rng);
  const ranking = rankDigs(game.digs.map((d) => scoreDig(d, treasure)));
  const { hostCut, prize } = splitPot(pot, game.hostCutBps);
  game.status = 'finished';
  game.result = { treasure, ranking, winner: ranking[0].account, pot, hostCut, prize };
}
