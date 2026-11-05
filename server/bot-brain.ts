import { isLand, type MapData } from './map-data.ts';

export type Rand = () => number;
export type Point = { x: number; y: number };

const CROWD_RADIUS = 6;
const below = (n: number, rand: Rand) => Math.floor(rand() * n);
export const pick = <T>(list: readonly T[], rand: Rand = Math.random): T => list[below(list.length, rand)];

/** A mix of early gamblers and late, careful players, so the bonus trade-off shows up in play. Same spread as the dummy. */
export function digPercent(rand: Rand = Math.random): number {
  const style = rand();
  if (style < 0.18) return 3 + rand() * 24;
  if (style < 0.5) return 32 + rand() * 26;
  if (style < 0.84) return 62 + rand() * 21;
  return 86 + rand() * 10;
}

function isCrowded(digs: Point[], spot: Point): boolean {
  return digs.some((d) => (d.x - spot.x) ** 2 + (d.y - spot.y) ** 2 <= CROWD_RADIUS ** 2);
}

/** Only what any player can see: a landmark that still fits the clues, plus some sloppiness. As the dummy's bots do. */
export function aim(room: any, map: MapData, slop: number, rand: Rand = Math.random): Point {
  const id = pick<number>(room.candidates, rand);
  const spot = map.spots[room.landmarks[id][0]];
  let fallback: Point = { x: spot.x, y: spot.y };
  for (let attempt = 0; attempt < 30; attempt++) {
    const p = { x: spot.x + below(slop * 2 + 1, rand) - slop, y: spot.y + below(slop * 2 + 1, rand) - slop };
    if (!isLand(map, p.x, p.y)) continue;
    fallback = p;
    if (!isCrowded(room.digs, p)) return p;
  }
  return fallback;
}

const ROOM_NAMES = ['Low tide', 'Sunday dig', 'Old map', 'Quick one', 'Treasure run', 'Lucky spade', 'Dusty trail', 'Salt and sand', 'Cold hands', 'Far shore', 'Last shovel', 'High noon', 'Moss and stone', 'North wind'];

export type RoomDesign = { name: string; map: string; fee: number; duration_sec: number; host_cut_bps: number; min_players: number; max_players: number; countdown_sec: number };

/** Varied rooms on cheap settings. `map` is passed in so hosts can walk through all three in turn. */
export function designRoom(map: string, rand: Rand = Math.random): RoomDesign {
  const min = 2 + below(3, rand);
  return {
    name: pick(ROOM_NAMES, rand),
    map,
    fee: pick([10, 10, 25, 50, 50, 100], rand),
    duration_sec: pick([60, 60, 60, 180, 180, 300], rand),
    host_cut_bps: pick([0, 200, 500, 500, 1000], rand),
    min_players: min,
    max_players: min + 2 + below(5, rand),
    countdown_sec: pick([0, 30, 30, 60], rand),
  };
}

/** How many bots this room should have, given who's in it. Never above its maximum. */
export function botTarget(room: any, isBot: (id: string) => boolean, available: number, rand: Rand = Math.random): number {
  const bots = room.players.filter(isBot).length;
  const humans = room.players.length - bots;
  const free = room.max_players - humans;
  const hostIsHuman = !isBot(room.host);
  if (humans === 0 && !hostIsHuman) return Math.min(room.min_players, free, available);
  const extra = 1 + below(3, rand);
  return Math.max(0, Math.min(Math.max(room.min_players - humans, 0) + extra, free - (hostIsHuman && room.max_players > 2 ? 1 : 0), available));
}
