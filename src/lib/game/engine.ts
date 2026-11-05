// The game rules, with no UI, wallet or storage. The NEAR contract implements the same steps, and players
// recheck rounds with this code, so every rule works in whole numbers and draws only from the `Rng` it's given.
import { rollNextClue } from './clues';
import { isLand } from './map';
import { RULES } from './rules';
import { GameError } from './types';
import type { Dig, Game, Landmark, NewGameInput, Point, PotSplit, RankedDig, RefundReason, Result, Rng } from './types';

export function createGame(id: string, input: NewGameInput, landmarks: Landmark[]): Game {
  const { name, fee, hostCutBps, minPlayers, maxPlayers, durationSec, countdownSec } = input;
  if (!name.trim()) throw new GameError('Give the game a name.');
  if (!Number.isInteger(fee) || fee <= 0) throw new GameError('Set an entry fee above 0.');
  if (hostCutBps < 0 || hostCutBps > RULES.maxHostCutBps) {
    throw new GameError(`The host can keep at most ${RULES.maxHostCutBps / 100}% of the pot.`);
  }
  if (!(durationSec > 0)) throw new GameError('Set a timer.');
  if (minPlayers < RULES.minPlayersFloor) throw new GameError(`A game needs at least ${RULES.minPlayersFloor} players.`);
  if (maxPlayers > RULES.maxPlayersCap) throw new GameError(`A game can have at most ${RULES.maxPlayersCap} players.`);
  if (minPlayers > maxPlayers) throw new GameError('The minimum can\'t be above the maximum.');
  if (countdownSec < 0) throw new GameError('The countdown can\'t be negative.');


  return {
    id,
    name: name.trim(),
    host: input.host,
    mapId: input.mapId,
    fee,
    durationSec,
    hostCutBps,
    minPlayers,
    maxPlayers,
    countdownSec,
    stage: 'waiting',
    waited: 0,
    startIn: null,
    elapsed: 0,
    players: [],
    clues: [],
    landmarks,
    candidateIds: landmarks.map((l) => l.id),
    digs: [],
    result: null,
    paid: false,
  };
}

export function isOpen(game: Game): boolean {
  return game.stage === 'waiting' || game.stage === 'live';
}

export function joinGame(game: Game, account: string): void {
  if (game.stage !== 'waiting') throw new GameError('This round has already started.');
  if (game.players.includes(account)) throw new GameError('You already joined this game.');
  if (game.players.length >= game.maxPlayers) throw new GameError('This game is full.');
  game.players.push(account);

  const count = game.players.length;
  if (count >= game.maxPlayers) {
    game.startIn = game.startIn === null ? RULES.fullRoomStartSec : Math.min(game.startIn, RULES.fullRoomStartSec);
  } else if (count >= game.minPlayers && game.countdownSec > 0 && game.startIn === null) {
    game.startIn = game.countdownSec;
  }
}

export function leaveGame(game: Game, account: string): void {
  if (game.stage !== 'waiting') throw new GameError('You can only leave before the round starts.');
  if (!game.players.includes(account)) throw new GameError('You haven\'t joined this game.');
  game.players = game.players.filter((p) => p !== account);
  if (game.players.length < game.minPlayers || game.countdownSec === 0) game.startIn = null;
}

function begin(game: Game, rng: Rng): void {
  game.stage = 'live';
  game.startIn = null;
  game.elapsed = 0;
  rollNextClue(game, rng);
}

export function startGame(game: Game, by: string, rng: Rng): void {
  if (game.stage !== 'waiting') throw new GameError('This round has already started.');
  if (by !== game.host) throw new GameError('Only the host can start this game.');
  if (game.players.length < game.minPlayers) throw new GameError(`This game needs ${game.minPlayers} players to start.`);
  begin(game, rng);
}

/** The bonus a dig placed right now would get. */
export function currentBonus(game: Game): number {
  return RULES.clueSchedule[Math.max(0, game.clues.length - 1)].bonusBps;
}

/** Seconds until the bonus drops, or null once the last clue is out. For the screen only: it can be a fraction. */
export function secondsToNextClue(game: Game): number | null {
  const next = RULES.clueSchedule[game.clues.length];
  return next ? (next.startsAt * game.durationSec) / 100 - game.elapsed : null;
}

export function secondsLeft(game: Game): number {
  return Math.max(0, game.durationSec - game.elapsed);
}

/** Every joined player's fee is in the pot, whether or not they end up digging. */
export function potOf(game: Game): number {
  return game.fee * game.players.length;
}

export function splitPot(pot: number, hostCutBps: number): PotSplit {
  const share = (bps: number) => Math.floor((pot * bps) / 10000);
  const hostCut = share(hostCutBps);
  const jackpot = share(RULES.jackpotBps);
  const deed = share(RULES.deedBps);
  const season = share(RULES.seasonBps);
  return { hostCut, jackpot, deed, season, prize: pot - hostCut - jackpot - deed - season };
}

/** Moves the clock: room countdowns and deadlines, clues as their times come up, and the end. */
export function advance(game: Game, seconds: number, rng: Rng): void {
  if (game.stage === 'waiting') {
    game.waited += seconds;
    if (game.startIn !== null) {
      game.startIn -= seconds;
      if (game.startIn <= 0) {
        begin(game, rng);
        return;
      }
    }
    if (game.waited >= RULES.waitingDeadlineSec) {
      if (game.players.length >= game.minPlayers) begin(game, rng);
      else refund(game, 'expired');
    }
    return;
  }
  if (game.stage !== 'live') return;

  game.elapsed += seconds;
  const schedule = RULES.clueSchedule;
  while (game.clues.length < schedule.length && schedule[game.clues.length].startsAt * game.durationSec <= game.elapsed * 100) {
    rollNextClue(game, rng);
  }
  if (game.elapsed >= game.durationSec) settle(game, rng);
}

function isqrt(n: number): number {
  if (n < 2) return n;
  let x = n;
  let next = Math.floor((x + 1) / 2);
  while (next < x) {
    x = next;
    next = Math.floor((x + Math.floor(n / x)) / 2);
  }
  return x;
}

function squaredDistance(a: Point, b: Point): number {
  return (a.x - b.x) ** 2 + (a.y - b.y) ** 2;
}

export function isCrowded(digs: Dig[], spot: Point): boolean {
  return digs.some((d) => squaredDistance(d, spot) <= RULES.crowdRadius ** 2);
}

/**
 * `seenClue` is how many clues the player could see. A clue arriving while the dig is on its way
 * would quietly cost them bonus, so the dig is turned down instead and they can decide again.
 */
export function placeDig(game: Game, account: string, spot: Point, seenClue?: number): Dig {
  if (game.stage === 'waiting') throw new GameError('The round hasn\'t started yet.');
  if (game.stage !== 'live') throw new GameError('This game has ended.');
  if (!game.players.includes(account)) throw new GameError('Only players who joined before the start can dig.');
  if (game.digs.some((d) => d.account === account)) throw new GameError('You already dug in this game.');
  if (!isLand(game.mapId, spot)) throw new GameError('That spot is water. Pick a spot on land.');
  if (seenClue !== undefined && seenClue !== game.clues.length) throw new GameError('A new clue just arrived. Check it, then dig again.');

  const dig: Dig = {
    account,
    x: spot.x,
    y: spot.y,
    clueIndex: game.clues.length - 1,
    bonusBps: currentBonus(game),
    crowded: isCrowded(game.digs, spot),
    dugAt: game.elapsed,
  };
  game.digs.push(dig);
  return dig;
}

export function scoreDig(dig: Dig, treasure: Point): RankedDig {
  const distance = isqrt(squaredDistance(dig, treasure) * 1_000_000);
  const closeness = Math.max(0, 1000 - Math.floor(distance / RULES.closenessRange));
  const crowd = dig.crowded ? RULES.crowdBps : 10000;
  return { ...dig, distance, closeness, score: Math.floor((closeness * dig.bonusBps * crowd) / 100_000_000) };
}

/**
 * Best score first. Equal scores go to whoever dug first; if nobody scored, closest wins.
 * Digs tied on everything keep their dig order, so the contract must sort stably too.
 */
export function rankDigs(digs: RankedDig[]): RankedDig[] {
  return [...digs].sort((a, b) => {
    if (a.score !== b.score) return b.score - a.score;
    if (a.score === 0 && a.distance !== b.distance) return a.distance - b.distance;
    return a.dugAt - b.dugAt;
  });
}

/** Who would win if the treasure landed right on each landmark that's still possible. */
export function standing(game: Game, account: string): { wins: number[]; of: number } | null {
  if (!game.digs.some((d) => d.account === account)) return null;
  const { landmarks } = game;
  const wins = game.candidateIds.filter((id) => rankDigs(game.digs.map((d) => scoreDig(d, landmarks[id])))[0].account === account);
  return { wins, of: game.candidateIds.length };
}

/** Spots off the land are thrown out, so the odds stay level on any coastline. The cap only keeps a contract's gas bounded. */
export function rollTreasure(game: Game, rng: Rng): NonNullable<Result['treasure']> {
  const landmarkId = game.candidateIds[rng(game.candidateIds.length)];
  const landmark = game.landmarks[landmarkId];
  const reach = RULES.treasureScatter;
  for (let attempt = 0; attempt < 60; attempt++) {
    const x = landmark.x + rng(reach * 2 + 1) - reach;
    const y = landmark.y + rng(reach * 2 + 1) - reach;
    const spot = { x, y };
    if ((x - landmark.x) ** 2 + (y - landmark.y) ** 2 <= reach ** 2 && isLand(game.mapId, spot)) return { x, y, landmarkId };
  }
  return { x: landmark.x, y: landmark.y, landmarkId };
}

function emptySplit(): PotSplit {
  return { hostCut: 0, jackpot: 0, deed: 0, season: 0, prize: 0 };
}

export function refund(game: Game, reason: RefundReason): void {
  game.stage = 'refunded';
  game.startIn = null;
  game.result = {
    treasure: null, ranking: [], winner: null, pot: potOf(game), split: emptySplit(),
    refundReason: reason, deedOwner: null, jackpotWin: null, seasonPoints: {},
  };
}

/** Ends the round on a given treasure. Only the dummy's playtest controls call this directly. */
export function finishAt(game: Game, treasure: NonNullable<Result['treasure']>): void {
  const ranking = rankDigs(game.digs.map((d) => scoreDig(d, treasure)));
  const pot = potOf(game);
  game.elapsed = game.durationSec;
  game.stage = 'finished';
  game.result = {
    treasure, ranking, winner: ranking[0].account, pot, split: splitPot(pot, game.hostCutBps),
    refundReason: null, deedOwner: null, jackpotWin: null, seasonPoints: {},
  };
}

function settle(game: Game, rng: Rng): void {
  game.elapsed = game.durationSec;
  if (game.digs.length < RULES.minDigs) refund(game, 'too-few-digs');
  else finishAt(game, rollTreasure(game, rng));
}
