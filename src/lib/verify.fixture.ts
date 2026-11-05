// A whole round made by the rules, in both of the shapes the verify screen is given, and a fake chain that holds it.
import { rollNextClue } from './game/clues';
import { isCrowded, rankDigs, rollTreasure, scoreDig, splitPot } from './game/engine';
import { rollLayout, isLand, H, W } from './game/map';
import { digsHash, fromHex, hashChain, layoutSeed, rollSeed, sha256, streamRng, toHex } from './game/random';
import { RULES } from './game/rules';
import type { Game, Point } from './game/types';
import { CONTRACT } from './near/config';
import type { ChainRoom, ChainRoll } from './near/rooms';
import type { BlockRead, ChainReader, ProofEvent, TxLookup } from './verifyChain';

const bytes = (n: number) => sha256(new Uint8Array([n]));

/** A whole round made by the rules, as the contract would store it. */
export function makeRoom(range: number = RULES.closenessRange): ChainRoom {
  const roomId = 7;
  const blockSeed = bytes(1);
  const { tip, links } = hashChain(bytes(2));
  const seed = layoutSeed(roomId, blockSeed, tip);
  const landmarks = rollLayout('tropical', streamRng(seed));
  const started = 1_000_000;
  const duration = 60;
  const players = ['a.testnet', 'b.testnet', 'c.testnet'];
  const land: Point[] = [];
  for (let y = 40; y < H && land.length < 3; y += 13) {
    for (let x = 40; x < W && land.length < 3; x += 31) {
      if (isLand('tropical', { x, y })) land.push({ x, y });
    }
  }

  const digs: ChainRoom['digs'] = [];
  const dig = (account: string, spot: Point, clueIndex: number, at: number) => {
    const crowded = isCrowded(digs.map((d) => ({ account: d.account, x: d.x, y: d.y, clueIndex: d.clue_index, bonusBps: d.bonus_bps, crowded: d.crowded, dugAt: 0 })), spot);
    digs.push({ account, x: spot.x, y: spot.y, clue_index: clueIndex, bonus_bps: RULES.clueSchedule[clueIndex].bonusBps, crowded, dug_at_ms: started + at });
  };
  dig(players[0], land[0], 0, 5000);

  const game = { clues: [{ level: 'yolo' }], landmarks, candidateIds: landmarks.map((l) => l.id), mapId: 'tropical' } as unknown as Game;
  const rolls: ChainRoll[] = [];
  const clues: ChainRoom['clues'] = [{ level: 'yolo' }];
  for (let step = 1; step <= 4; step++) {
    if (step === 2) dig(players[1], land[1], 1, 25_000);
    if (step === 3) dig(players[2], land[2], 2, 40_000);
    const lockSeed = bytes(10 + step);
    const lockMs = started + [0, 18_000, 36_000, 51_000, 60_000][step];
    const atLock = digs.filter((d) => d.dug_at_ms <= lockMs);
    const hash = digsHash(atLock.map((d) => ({ account: d.account, x: d.x, y: d.y, clueIndex: d.clue_index, dugAtMs: d.dug_at_ms })));
    const rs = rollSeed(roomId, step, lockSeed, links[step - 1], hash);
    let clue = null;
    if (step < 4) {
      rollNextClue(game, streamRng(rs));
      clue = game.clues[game.clues.length - 1];
      clues.push(clue);
    }
    rolls.push({
      step, due_ms: lockMs, lock_seed: toHex(lockSeed), digs_hash: toHex(hash), lock_ms: lockMs, lock_height: 100 + step * 2,
      link: toHex(links[step - 1]), reveal_ms: lockMs + 1000, reveal_height: 101 + step * 2, roll_seed: toHex(rs), clue,
    });
  }

  const treasure = rollTreasure(game, streamRng(fromHex(rolls[3].roll_seed!)));
  const ranked = rankDigs(digs.map((d) => scoreDig({ account: d.account, x: d.x, y: d.y, clueIndex: d.clue_index, bonusBps: d.bonus_bps, crowded: d.crowded, dugAt: d.dug_at_ms - started }, treasure, range)));
  const pot = 100 * players.length;
  const split = splitPot(pot, 500);
  const jackpot = split.jackpot + split.deed;
  return {
    room_id: roomId, version: 1, name: 'Test', host: 'h.testnet', map: 'tropical', fee: 100, pot, duration_sec: duration, host_cut_bps: 500, closeness_range: range,
    min_players: 2, max_players: 5, countdown_sec: 0, status: 'finished', created_ms: 1, deadline_ms: 2, start_at_ms: null, started_ms: started,
    ends_at_ms: started + 60_000, tip_index: 3, next_step: null, next_due_ms: null, reveal_deadline_ms: null, locked: false, lock_height: null,
    players, digs, clues, candidates: game.candidateIds, landmarks: landmarks as never, created_height: 99, tip: toHex(tip), block_seed: toHex(blockSeed), layout_seed: toHex(seed), rolls,
    result: {
      ended_ms: started + 61_000, pot, split: { host_cut: split.hostCut, jackpot: split.jackpot, deed: split.deed, season: split.season, prize: split.prize },
      refund_reason: null, treasure: { x: treasure.x, y: treasure.y, landmark_id: treasure.landmarkId }, winner: ranked[0].account,
      ranking: ranked.map((d) => ({ account: d.account, x: d.x, y: d.y, clue_index: d.clueIndex, bonus_bps: d.bonusBps, crowded: d.crowded, dug_at_ms: d.dugAt + started, distance: d.distance, closeness: d.closeness, score: d.score })),
      deed_owner: null, jackpot_win: null, jackpot_before: 0, jackpot_after: jackpot,
      season_points: RULES.seasonPointsPerNear.map((perNear, place) => ({ account: ranked[place].account, amount: Math.floor((pot * perNear) / 1000) })),
    },
  };
}

/** The same round as the contract's logs. Each event gets its own transaction, signed by whoever would. */
export function eventsOf(room: ChainRoom): ProofEvent[] {
  const events: ProofEvent[] = [];
  const add = (event: string, data: any) => events.push({ event, standard: 'dig-here', tx_hash: `tx-${events.length}`, data: { room_id: room.room_id, ...data } });
  add('room_created', {
    name: room.name, host: room.host, map: room.map, fee: room.fee, bond: 100, duration_sec: room.duration_sec, host_cut_bps: room.host_cut_bps, closeness_range: room.closeness_range,
    min_players: room.min_players, max_players: room.max_players, countdown_sec: room.countdown_sec, created_ms: room.created_ms, deadline_ms: room.deadline_ms,
    block_height: room.created_height, tip_index: room.tip_index, tip: room.tip, block_seed: room.block_seed, layout_seed: room.layout_seed, landmarks: room.landmarks,
  });
  add('started', { by: 'timer', started_ms: room.started_ms, ends_at_ms: room.ends_at_ms, block_height: 100, players: room.players, pot: room.pot });
  const timeline: { at: number; run: () => void }[] = room.digs.map((d) => ({ at: d.dug_at_ms, run: () => add('dig', { ...d }) }));
  for (const roll of room.rolls ?? []) {
    timeline.push({ at: roll.lock_ms!, run: () => add('locked', { step: roll.step, lock_seed: roll.lock_seed, digs_hash: roll.digs_hash, digs_count: 0, lock_ms: roll.lock_ms, lock_height: roll.lock_height, due_ms: roll.due_ms, reveal_deadline_ms: roll.due_ms + 120_000 }) });
    timeline.push({ at: roll.reveal_ms!, run: () => add('revealed', { step: roll.step, lock_seed: roll.lock_seed, link: roll.link, digs_hash: roll.digs_hash, roll_seed: roll.roll_seed, clue: roll.clue, candidates_after: roll.step < 4 ? room.candidates : null, treasure: roll.step === 4 ? room.result!.treasure : null, reveal_ms: roll.reveal_ms, reveal_height: roll.reveal_height }) });
  }
  timeline.sort((a, b) => a.at - b.at).forEach((t) => t.run());
  const r = room.result!;
  add('finished', {
    map: room.map, host: room.host, players: room.players, fee: room.fee, host_cut_bps: room.host_cut_bps, bond: 100, pot: r.pot, split: r.split, treasure: r.treasure, winner: r.winner, ranking: r.ranking,
    deed: { token_id: 'x', owner: r.deed_owner, paid: 0, earned: 0, landings: 1 }, jackpot_before: r.jackpot_before, jackpot_after: r.jackpot_after, jackpot_win: r.jackpot_win,
    season_number: 1, season_pool_after: 0, season_points: r.season_points.map((p) => ({ account: p.account, points: p.amount })), ended_ms: r.ended_ms, block_height: 200,
  });
  const milli = 10n ** 21n;
  const end = events[events.length - 1];
  events.push({
    event: 'balance', standard: 'dig-here', tx_hash: end.tx_hash, data: {
      changes: [
        { account: r.winner, delta: (BigInt(r.split!.prize) * milli).toString(), balance: '0', reason: 'prize' },
        { account: room.host, delta: (BigInt(r.split!.host_cut) * milli).toString(), balance: '0', reason: 'host_cut' },
      ],
    },
  });
  return events;
}

const signerOf = (e: ProofEvent) => (e.event === 'dig' ? e.data.account : e.event === 'room_created' ? e.data.host : 'oracle.dighere.testnet');
const logLine = (e: ProofEvent) => `EVENT_JSON:${JSON.stringify({ standard: e.standard, version: '1.0.0', event: e.event, data: e.data })}`;

/** What `tx` answers for each hash, built from the honest logs. Tests then edit these or the list. */
export function txsOf(events: ProofEvent[]): Map<string, any> {
  const txs = new Map<string, any>();
  for (const e of events) {
    const hash = e.tx_hash!;
    if (!txs.has(hash)) {
      txs.set(hash, {
        transaction: { hash, signer_id: signerOf(e), receiver_id: CONTRACT },
        status: { SuccessValue: '' },
        receipts_outcome: [{ id: `r-${hash}`, outcome: { executor_id: CONTRACT, logs: [], status: { SuccessValue: '' } } }],
      });
    }
    txs.get(hash).receipts_outcome[0].outcome.logs.push(logLine(e));
  }
  return txs;
}

/** A chain holding those transactions and the round's blocks. Anything it doesn't hold, it says it never saw. */
export function fakeChain(room: ChainRoom, txs: Map<string, any>, overrides: Partial<ChainReader> = {}): ChainReader {
  const blockMs = new Map<number, number>();
  if (room.created_height) blockMs.set(room.created_height, room.created_ms);
  for (const roll of room.rolls ?? []) {
    if (roll.lock_height) blockMs.set(roll.lock_height, roll.lock_ms!);
    if (roll.reveal_height) blockMs.set(roll.reveal_height, roll.reveal_ms!);
  }
  return {
    tx: async (hash): Promise<TxLookup> => (txs.has(hash) ? { found: txs.get(hash) } : { gone: true }),
    block: async (height): Promise<BlockRead | 'gone'> => {
      const ms = blockMs.get(height);
      return ms === undefined ? 'gone' : { hash: `b${height}`, random_value: '1', timestamp_nanosec: `${ms}000000` };
    },
    roomOnEachNode: async () => [room, room],
    codeHash: async () => 'CodeHash111',
    ...overrides,
  };
}
