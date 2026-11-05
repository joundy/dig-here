// The contract's rooms, as the screens' `Game`. Pure, so it can be tested without a network.
import { CATEGORY } from '../game/mapDefs';
import { rosterOf, spotsOf, TAG_ORDER } from '../game/map';
import type { Clue, Dig, Game, Landmark, MapId, PotSplit, RankedDig, RefundReason, Result, Tag } from '../game/types';
import { DIG_CLOSE_MS } from './config';

export type ChainDig = { account: string; x: number; y: number; clue_index: number; bonus_bps: number; crowded: boolean; dug_at_ms: number };
export type ChainRanked = ChainDig & { distance: number; closeness: number; score: number };
export type ChainLandmark = { id: number; kind: Landmark['kind']; category: Landmark['category']; x: number; y: number; tags: Tag[]; flip: boolean };
export type ChainRoll = {
  step: number;
  due_ms: number;
  lock_seed: string | null;
  digs_hash: string | null;
  lock_ms: number | null;
  lock_height: number | null;
  link: string | null;
  reveal_ms: number | null;
  reveal_height: number | null;
  roll_seed: string | null;
  clue: Clue | null;
};
export type ChainResult = {
  ended_ms: number;
  pot: number;
  split: { host_cut: number; jackpot: number; deed: number; season: number; prize: number } | null;
  refund_reason: RefundReason | null;
  treasure: { x: number; y: number; landmark_id: number } | null;
  winner: string | null;
  ranking: ChainRanked[];
  deed_owner: string | null;
  jackpot_win: { account: string; amount: number } | null;
  jackpot_before: number;
  jackpot_after: number;
  season_points: { account: string; amount: number }[];
};
export type ChainRoom = {
  room_id: number;
  version: number;
  name: string;
  host: string;
  map: MapId;
  fee: number;
  pot: number;
  duration_sec: number;
  host_cut_bps: number;
  min_players: number;
  max_players: number;
  countdown_sec: number;
  status: 'waiting' | 'live' | 'finished' | 'refunded';
  created_ms: number;
  deadline_ms: number;
  start_at_ms: number | null;
  started_ms: number | null;
  ends_at_ms: number | null;
  tip_index: number;
  next_step: number | null;
  next_due_ms: number | null;
  reveal_deadline_ms: number | null;
  locked: boolean;
  lock_height: number | null;
  players: string[];
  digs: ChainDig[];
  clues: Clue[];
  candidates: number[];
  /** Compact in `live_state`, as [spot, kind, flip]; full objects in `get_room`. */
  landmarks?: [number, number, number][] | ChainLandmark[];
  // Only in `get_room`.
  created_height?: number;
  tip?: string;
  block_seed?: string;
  layout_seed?: string;
  rolls?: ChainRoll[];
  result?: ChainResult | null;
  /** Only when rebuilt from indexed events: the transactions behind the round, for explorer links. */
  txs?: { label: string; hash: string }[];
};
export type ChainSeason = { number: number; ends_at_ms: number; pool: number; top: { account: string; points: number }[]; last_winners: { account: string; prize: number }[] };
export type LiveState = {
  version: number;
  now_ms: number;
  jackpot: number;
  season: ChainSeason;
  commitments_left: number;
  missed_reveals: number;
  max_open_rooms: number;
  rooms: ChainRoom[];
};
export type FinishedSummary = {
  room_id: number;
  name: string;
  host: string;
  map: MapId;
  fee: number;
  pot: number;
  players: number;
  digs: number;
  status: 'finished' | 'refunded';
  ended_ms: number;
  refund_reason: RefundReason | null;
  treasure: { x: number; y: number; landmark_id: number } | null;
  winner: string | null;
};

export function landmarksOf(map: MapId, raw: ChainRoom['landmarks']): Landmark[] {
  if (!raw) return [];
  const spots = spotsOf(map);
  const roster = rosterOf(map);
  return (raw as (ChainLandmark | [number, number, number])[]).map((entry, id) => {
    if (!Array.isArray(entry)) return { ...entry };
    const [spotIndex, kindIndex, flip] = entry;
    const [x, y, tagBits] = spots[spotIndex];
    const kind = roster[kindIndex];
    return { id, kind, category: CATEGORY[kind], x, y, tags: TAG_ORDER.filter((_, bit) => tagBits & (1 << bit)), flip: flip === 1 };
  });
}

function digOf(raw: ChainDig, startedMs: number | null): Dig {
  return {
    account: raw.account,
    x: raw.x,
    y: raw.y,
    clueIndex: raw.clue_index,
    bonusBps: raw.bonus_bps,
    crowded: raw.crowded,
    dugAt: startedMs === null ? 0 : (raw.dug_at_ms - startedMs) / 1000,
  };
}

export const digsOf = (room: ChainRoom): Dig[] => room.digs.map((d) => digOf(d, room.started_ms));

function splitOf(raw: ChainResult['split']): PotSplit {
  if (!raw) return { hostCut: 0, jackpot: 0, deed: 0, season: 0, prize: 0 };
  return { hostCut: raw.host_cut, jackpot: raw.jackpot, deed: raw.deed, season: raw.season, prize: raw.prize };
}

export function resultOf(room: ChainRoom): Result | null {
  const raw = room.result;
  if (!raw) return null;
  return {
    treasure: raw.treasure && { x: raw.treasure.x, y: raw.treasure.y, landmarkId: raw.treasure.landmark_id },
    ranking: raw.ranking.map((d): RankedDig => ({ ...digOf(d, room.started_ms), distance: d.distance, closeness: d.closeness, score: d.score })),
    winner: raw.winner,
    pot: raw.pot,
    split: splitOf(raw.split),
    refundReason: raw.refund_reason,
    deedOwner: raw.deed_owner,
    jackpotWin: raw.jackpot_win,
    seasonPoints: Object.fromEntries(raw.season_points.map((p) => [p.account, p.amount])),
  };
}

export type RoomClocks = { waited: number; startIn: number | null; elapsed: number };

/**
 * `elapsed` runs from the on-chain start to 2.5 s before the on-chain end, so everything drawn from it
 * (the countdown, the dig button, the dusk) closes early enough that a last-moment dig still lands.
 */
export function clocksOf(times: Pick<ChainRoom, 'created_ms' | 'start_at_ms' | 'started_ms' | 'ends_at_ms' | 'duration_sec'>, now: number): RoomClocks {
  const waited = Math.max(0, (now - times.created_ms) / 1000);
  const startIn = times.start_at_ms === null ? null : Math.max(0, (times.start_at_ms - now) / 1000);
  if (times.started_ms === null || times.ends_at_ms === null) return { waited, startIn, elapsed: 0 };
  const span = times.ends_at_ms - DIG_CLOSE_MS - times.started_ms;
  const elapsed = Math.min(times.duration_sec, Math.max(0, ((now - times.started_ms) / span) * times.duration_sec));
  return { waited, startIn, elapsed };
}

export function gameOf(room: ChainRoom, now: number): Game {
  const over = room.status === 'finished' || room.status === 'refunded';
  const clocks = clocksOf(room, now);
  return {
    id: String(room.room_id),
    name: room.name,
    host: room.host,
    mapId: room.map,
    fee: room.fee,
    durationSec: room.duration_sec,
    hostCutBps: room.host_cut_bps,
    minPlayers: room.min_players,
    maxPlayers: room.max_players,
    countdownSec: room.countdown_sec,
    stage: room.status,
    waited: clocks.waited,
    startIn: over ? null : clocks.startIn,
    elapsed: over ? room.duration_sec : clocks.elapsed,
    players: [...room.players],
    clues: room.clues,
    landmarks: landmarksOf(room.map, room.landmarks),
    candidateIds: room.candidates,
    digs: digsOf(room),
    result: over ? resultOf(room) : null,
    paid: over,
  };
}

/**
 * A finished room from the short list has no details yet. The players are placeholders, so the card's
 * count and pot are right and it can never read as "you're in".
 */
export function gameFromSummary(row: FinishedSummary): Game {
  return {
    id: String(row.room_id),
    name: row.name,
    host: row.host,
    mapId: row.map,
    fee: row.fee,
    durationSec: 0,
    hostCutBps: 0,
    minPlayers: 2,
    maxPlayers: row.players,
    countdownSec: 0,
    stage: row.status,
    waited: 0,
    startIn: null,
    elapsed: 0,
    players: Array.from({ length: row.players }, (_, i) => `?${i}`),
    clues: [],
    landmarks: [],
    candidateIds: [],
    digs: [],
    result: {
      treasure: row.treasure && { x: row.treasure.x, y: row.treasure.y, landmarkId: row.treasure.landmark_id },
      ranking: [],
      winner: row.winner,
      pot: row.pot,
      split: { hostCut: 0, jackpot: 0, deed: 0, season: 0, prize: 0 },
      refundReason: row.refund_reason,
      deedOwner: null,
      jackpotWin: null,
      seasonPoints: {},
    },
    paid: true,
  };
}

/** Rebuilds a room from its events, for one the contract has already dropped from its ring of 30. */
export function roomFromEvents(events: { event: string; data: any }[]): ChainRoom | null {
  const of = (name: string) => events.filter((e) => e.event === name).map((e) => e.data);
  const created = of('room_created')[0];
  if (!created) return null;
  const started = of('started')[0] ?? null;
  const finished = of('finished')[0] ?? null;
  const refunded = of('refunded')[0] ?? null;
  const players = new Set<string>();
  for (const e of events) {
    if (e.event === 'joined') players.add(e.data.account);
    if (e.event === 'left') players.delete(e.data.account);
  }
  const locked = new Map<number, any>(of('locked').map((l) => [l.step, l]));
  const rolls: ChainRoll[] = [...locked.values()].map((lock) => {
    const reveal = of('revealed').find((r) => r.step === lock.step) ?? null;
    return {
      step: lock.step,
      due_ms: lock.due_ms,
      lock_seed: lock.lock_seed,
      digs_hash: lock.digs_hash,
      lock_ms: lock.lock_ms,
      lock_height: lock.lock_height,
      link: reveal?.link ?? null,
      reveal_ms: reveal?.reveal_ms ?? null,
      reveal_height: reveal?.reveal_height ?? null,
      roll_seed: reveal?.roll_seed ?? null,
      clue: reveal?.clue ?? null,
    };
  });
  const lastCandidates = [...of('revealed')].reverse().find((r) => r.candidates_after)?.candidates_after;
  const landmarks = created.landmarks as ChainLandmark[];
  const clues: Clue[] = [{ level: 'yolo' }, ...of('revealed').map((r) => r.clue).filter(Boolean)];
  const ended = finished ?? refunded;
  return {
    room_id: created.room_id,
    version: 0,
    name: created.name,
    host: created.host,
    map: created.map,
    fee: created.fee,
    pot: finished?.pot ?? refunded?.pot ?? 0,
    duration_sec: created.duration_sec,
    host_cut_bps: created.host_cut_bps,
    min_players: created.min_players,
    max_players: created.max_players,
    countdown_sec: created.countdown_sec,
    status: finished ? 'finished' : refunded ? 'refunded' : started ? 'live' : 'waiting',
    created_ms: created.created_ms,
    deadline_ms: created.deadline_ms,
    start_at_ms: null,
    started_ms: started?.started_ms ?? null,
    ends_at_ms: started?.ends_at_ms ?? null,
    tip_index: created.tip_index,
    next_step: null,
    next_due_ms: null,
    reveal_deadline_ms: null,
    locked: false,
    lock_height: null,
    players: finished?.players ?? refunded?.players ?? [...players],
    digs: of('dig').map((d) => ({ account: d.account, x: d.x, y: d.y, clue_index: d.clue_index, bonus_bps: d.bonus_bps, crowded: d.crowded, dug_at_ms: d.dug_at_ms })),
    clues,
    candidates: lastCandidates ?? landmarks.map((l) => l.id),
    landmarks,
    created_height: created.block_height,
    tip: created.tip,
    block_seed: created.block_seed,
    layout_seed: created.layout_seed,
    rolls,
    result: ended ? {
      ended_ms: ended.ended_ms,
      pot: ended.pot,
      split: finished?.split ?? null,
      refund_reason: refunded?.reason ?? null,
      treasure: finished?.treasure ?? null,
      winner: finished?.winner ?? null,
      ranking: finished?.ranking ?? [],
      deed_owner: finished?.deed?.owner ?? null,
      jackpot_win: finished?.jackpot_win ?? null,
      jackpot_before: finished?.jackpot_before ?? 0,
      jackpot_after: finished?.jackpot_after ?? refunded?.jackpot_after ?? 0,
      season_points: (finished?.season_points ?? []).map((p: any) => ({ account: p.account, amount: p.points ?? p.amount })),
    } : null,
  };
}
