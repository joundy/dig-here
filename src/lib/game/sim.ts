// Plays many rounds with the real rules and reports how each dig timing does. `npm run sim`.
import { advance, createGame, joinGame, placeDig, startGame } from './engine';
import { isLand, MAP_IDS, rollLayout, seededRng } from './map';
import { RULES } from './rules';
import type { Game, MapId, Point, Rng } from './types';

function aim(game: Game, rng: Rng): Point {
  const { mapId, candidateIds } = game;
  const landmark = game.landmarks[candidateIds[rng(candidateIds.length)]];
  const slop = 2 + rng(10);
  for (let i = 0; i < 20; i++) {
    const spot = { x: landmark.x + rng(slop * 2 + 1) - slop, y: landmark.y + rng(slop * 2 + 1) - slop };
    if (isLand(mapId, spot)) return spot;
  }
  return { x: landmark.x, y: landmark.y };
}

export type SimResult = {
  players: number;
  /** Win chance per dig, in percent, for digs made under each clue. */
  winPctByClue: number[];
  evenPct: number;
  jackpotPerRoundPct: number;
};

/** Players split evenly across the clues and aim near a landmark that still fits. */
export function simulate(players: number, rounds: number, seed = 1, mapId?: MapId): SimResult {
  const rng = seededRng(seed);
  const clueCount = RULES.clueSchedule.length;
  const wins = new Array<number>(clueCount).fill(0);
  const digs = new Array<number>(clueCount).fill(0);
  let jackpots = 0;
  const duration = 100;
  // Rolling a layout is slow next to playing a round, so rounds share a pool of them.
  const pool = new Map(MAP_IDS.map((id) => [id, Array.from({ length: 25 }, () => rollLayout(id, rng))]));

  for (let round = 0; round < rounds; round++) {
    const map = mapId ?? MAP_IDS[round % MAP_IDS.length];
    const layouts = pool.get(map)!;
    const game = createGame('sim', {
      name: 'sim', host: 'h', mapId: map, fee: 1000, durationSec: duration,
      hostCutBps: 0, minPlayers: 2, maxPlayers: RULES.maxPlayersCap, countdownSec: 0,
    }, layouts[rng(layouts.length)]);
    for (let i = 0; i < players; i++) joinGame(game, `p${i}`);
    startGame(game, 'h', rng);

    for (let clue = 0; clue < clueCount; clue++) {
      for (let i = 0; i < players; i++) {
        if (i % clueCount !== clue) continue;
        placeDig(game, `p${i}`, aim(game, rng));
        digs[clue]++;
      }
      const next = RULES.clueSchedule[clue + 1]?.startsAt ?? 100;
      advance(game, (next * duration) / 100 - game.elapsed, rng);
    }

    const { result } = game;
    if (!result?.treasure) continue;
    const winner = result.ranking[0];
    wins[winner.clueIndex]++;
    if (result.ranking.some((d) => d.x === result.treasure!.x && d.y === result.treasure!.y)) jackpots++;
  }

  return {
    players,
    winPctByClue: wins.map((w, i) => Math.round((1000 * w) / Math.max(1, digs[i])) / 10),
    evenPct: Math.round(1000 / players) / 10,
    jackpotPerRoundPct: Math.round((10000 * jackpots) / rounds) / 100,
  };
}
