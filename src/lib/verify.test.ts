import { describe, expect, it } from 'vitest';
import { rollNextClue } from './game/clues';
import { isCrowded, rankDigs, rollTreasure, scoreDig, splitPot } from './game/engine';
import { rollLayout, isLand, H, W } from './game/map';
import { digsHash, fromHex, hashChain, layoutSeed, rollSeed, sha256, streamRng, toHex } from './game/random';
import { RULES } from './game/rules';
import type { Game, Point } from './game/types';
import type { ChainRoom, ChainRoll } from './near/rooms';
import { overallState, verifyRound } from './verify';

const bytes = (n: number) => sha256(new Uint8Array([n]));

/** A whole round made by the rules, as the contract would store it. */
function makeRoom(): ChainRoom {
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
  const ranked = rankDigs(digs.map((d) => scoreDig({ account: d.account, x: d.x, y: d.y, clueIndex: d.clue_index, bonusBps: d.bonus_bps, crowded: d.crowded, dugAt: d.dug_at_ms - started }, treasure)));
  const pot = 100 * players.length;
  const split = splitPot(pot, 500);
  const jackpot = split.jackpot + split.deed;
  return {
    room_id: roomId, version: 1, name: 'Test', host: 'h.testnet', map: 'tropical', fee: 100, pot, duration_sec: duration, host_cut_bps: 500,
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


const failures = (room: ChainRoom) => verifyRound(room).flatMap((g) => g.checks).filter((c) => c.state === 'fail').map((c) => c.title);

describe('verify this round', () => {
  it('passes every line on an honest round', () => {
    const room = makeRoom();
    expect(failures(room)).toEqual([]);
    expect(overallState(verifyRound(room))).toBe('pass');
    expect(verifyRound(room).flatMap((g) => g.checks).filter((c) => c.state === 'pass').length).toBeGreaterThan(20);
  });

  const flip = (hex: string) => (hex[0] === '0' ? '1' : '0') + hex.slice(1);

  it.each<[string, (room: ChainRoom) => void, RegExp]>([
    ['a swapped layout seed', (r) => { r.layout_seed = flip(r.layout_seed!); }, /layout seed|landmark/],
    ['a moved landmark', (r) => { (r.landmarks as any)[0].x += 1; }, /landmark/],
    ['a link that doesn\'t hash back', (r) => { r.rolls![1].link = flip(r.rolls![1].link!); }, /hashes back/],
    ['a changed lock seed', (r) => { r.rolls![0].lock_seed = flip(r.rolls![0].lock_seed!); }, /roll for clue 2/],
    ['a dig edited after the lock', (r) => { r.digs[0].x += 1; }, /digs locked/],
    ['a changed clue', (r) => { r.rolls![0].clue = { level: 'category', category: 'tree' }; }, /Clue 2/],
    ['a moved treasure', (r) => { r.result!.treasure!.x += 1; }, /treasure landed/],
    ['a changed winner', (r) => { r.result!.winner = 'x.testnet'; }, /winner/],
    ['a skimmed pot', (r) => { r.result!.split!.prize -= 1; }, /pot split/],
    ['a shrunk pot', (r) => { r.result!.pot -= 1; }, /pot is the entry fee/],
    ['a wrong jackpot', (r) => { r.result!.jackpot_after += 1; }, /jackpot/],
    ['wrong season points', (r) => { r.result!.season_points[0].amount += 1; }, /Season points/],
    ['a reveal in the lock\'s own block', (r) => { r.rolls![0].reveal_height = r.rolls![0].lock_height; }, /later block/],
    ['a wrong bonus', (r) => { r.digs[0].bonus_bps = 99; }, /right bonus/],
  ])('goes red on %s', (_name, tamper, expected) => {
    const room = makeRoom();
    tamper(room);
    const found = failures(room);
    expect(found.some((title) => expected.test(title))).toBe(true);
    expect(overallState(verifyRound(room))).toBe('fail');
  });

  it('checks a refund without inventing a treasure', () => {
    const room = makeRoom();
    room.status = 'refunded';
    room.digs = room.digs.slice(0, 1);
    room.rolls = room.rolls!.slice(0, 1);
    room.result = { ...room.result!, refund_reason: 'too-few-digs', treasure: null, winner: null, ranking: [], split: null };
    room.clues = room.clues.slice(0, 2);
    const titles = verifyRound(room).map((g) => g.title);
    expect(titles).toContain('Refund');
    expect(titles).not.toContain('Treasure and pot');
  });
});
