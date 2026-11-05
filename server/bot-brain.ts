import { isLand, type MapData } from './map-data.ts';

export type Rand = () => number;
export type Point = { x: number; y: number };

const CROWD_RADIUS = 6;
const HOUR_MS = 3_600_000;

/** What a human host's room can ask of a bot. Above this, a host's cut could farm the bots' budget. Sent to the browser in `/api/health`. */
export const BOT_JOIN_LIMITS = { max_fee_milli: 50, max_host_cut_bps: 1000 };
export const HUMAN_ROOMS_PER_HOUR = 3;

export function botsWillJoin(room: { fee: number; host_cut_bps: number }): boolean {
  return room.fee <= BOT_JOIN_LIMITS.max_fee_milli && room.host_cut_bps <= BOT_JOIN_LIMITS.max_host_cut_bps;
}

/** Rooms per human host that bots went into in the last hour. Forgotten on restart, which only gives a host a few more. */
export class HumanRoomLimit {
  readonly #perHour: number;
  readonly #hosts = new Map<string, Map<number, number>>();

  constructor(perHour = HUMAN_ROOMS_PER_HOUR) {
    this.#perHour = perHour;
  }

  /** Call only when a bot is about to join, since this counts the room. A room already counted stays allowed. */
  allow(host: string, roomId: number, nowMs: number = Date.now()): boolean {
    for (const [name, rooms] of this.#hosts) {
      for (const [id, at] of rooms) if (nowMs - at >= HOUR_MS) rooms.delete(id);
      if (!rooms.size) this.#hosts.delete(name);
    }
    const rooms = this.#hosts.get(host) ?? new Map<number, number>();
    if (rooms.has(roomId)) return true;
    if (rooms.size >= this.#perHour) return false;
    rooms.set(roomId, nowMs);
    this.#hosts.set(host, rooms);
    return true;
  }
}
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

/** What a bot asks for an NFT it holds, in yocto: a little over what minting one costs, so a human can always outbid the mint. */
export function askingPrice(mintPriceMilli: number, rand: Rand = Math.random): bigint {
  return BigInt(Math.round(mintPriceMilli * (1.1 + rand() * 0.5))) * 10n ** 21n;
}

export type ListingRow = { token_id: string; seller: string; price: string; in_progress: boolean; stale: boolean };

/** NFTs a bot holds with nothing good on the market, so they should be listed. */
export function unlistedBotNfts(nfts: Array<{ token_id: string; owner: string | null }>, listings: ListingRow[], isBot: (id: string) => boolean) {
  const listed = new Set(listings.filter((l) => !l.stale).map((l) => l.token_id));
  return nfts.filter((n): n is { token_id: string; owner: string } => n.owner !== null && isBot(n.owner) && !listed.has(n.token_id));
}

/**
 * A sale between two bots, so the market has real activity. Only a bot's own listing: buying from a human would let
 * anyone list at the limit and farm the budget. Prefers a buyer who already holds the coins, since sales pay the
 * seller's wallet and so the same coins can go round. `short` is what the chosen buyer still needs.
 */
export function chooseBotTrade(
  listings: ListingRow[],
  wallets: Array<{ id: string; spare: bigint }>,
  isBot: (id: string) => boolean,
  maxPrice: bigint,
  rand: Rand = Math.random,
): { token_id: string; price: bigint; buyer: string; short: bigint } | null {
  const fits = listings.filter((l) => !l.stale && !l.in_progress && isBot(l.seller) && BigInt(l.price) <= maxPrice);
  if (!fits.length) return null;
  const listing = pick(fits, rand);
  const price = BigInt(listing.price);
  const others = wallets.filter((w) => w.id !== listing.seller);
  if (!others.length) return null;
  const richest = others.reduce((best, w) => (w.spare > best.spare ? w : best));
  const able = others.filter((w) => w.spare >= price);
  const buyer = able.length ? pick(able, rand) : richest;
  return { token_id: listing.token_id, price, buyer: buyer.id, short: buyer.spare >= price ? 0n : price - buyer.spare };
}
