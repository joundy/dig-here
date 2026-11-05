import { describe, expect, it } from 'vitest';
import { rankDigs, scoreDig } from './game/engine';
import { digsHash, fromHex, rollSeed, sha256, toHex } from './game/random';
import { RULES } from './game/rules';
import type { ChainRoom } from './near/rooms';
import { makeRoom } from './verify.fixture';
import { overallState, verifyRound } from './verify';

const failures = (room: ChainRoom) => verifyRound(room).flatMap((g) => g.checks).filter((c) => c.state === 'fail').map((c) => c.title);

describe('verify this round', () => {
  it('passes every line on an honest round', () => {
    const room = makeRoom();
    expect(failures(room)).toEqual([]);
    expect(overallState(verifyRound(room))).toBe('pass');
    expect(verifyRound(room).flatMap((g) => g.checks).filter((c) => c.state === 'pass').length).toBeGreaterThan(20);
  });

  describe('scores a round by the range it was created under', () => {
    it('passes a new room at 96 and an old room at 48', () => {
      expect(failures(makeRoom(RULES.closenessRange))).toEqual([]);
      expect(failures(makeRoom(RULES.closenessRangeBefore))).toEqual([]);
    });

    /** A dig close enough to the treasure to score under either range, ranked as the contract would under `range`. */
    function nearTheTreasure(range: number): ChainRoom {
      const room = makeRoom(range);
      const { x, y } = room.result!.treasure!;
      Object.assign(room.digs[0], { x: x + 30, y });
      const toDig = (d: ChainRoom['digs'][number]) => ({ account: d.account, x: d.x, y: d.y, clueIndex: d.clue_index, bonusBps: d.bonus_bps, crowded: d.crowded, dugAt: d.dug_at_ms - room.started_ms! });
      const ranked = rankDigs(room.digs.map((d) => scoreDig(toDig(d), { x, y }, range)));
      room.result!.ranking = ranked.map((d) => ({ account: d.account, x: d.x, y: d.y, clue_index: d.clueIndex, bonus_bps: d.bonusBps, crowded: d.crowded, dug_at_ms: d.dugAt + room.started_ms!, distance: d.distance, closeness: d.closeness, score: d.score }));
      room.result!.winner = ranked[0].account;
      return room;
    }
    const RANKING = 'Every score and the ranking add up';

    it('tells the two ranges apart, so it is the range doing the work', () => {
      const old = nearTheTreasure(RULES.closenessRangeBefore);
      const fresh = nearTheTreasure(RULES.closenessRange);
      expect(old.result!.ranking[0].closeness).toBe(375);
      expect(fresh.result!.ranking[0].closeness).toBe(688);
      expect(failures(old)).not.toContain(RANKING);
      expect(failures(fresh)).not.toContain(RANKING);
    });

    it('takes 48 for a round from before the field existed', () => {
      const old = nearTheTreasure(RULES.closenessRangeBefore);
      delete old.closeness_range;
      expect(failures(old)).not.toContain(RANKING);
      const lostItsRange = nearTheTreasure(RULES.closenessRange);
      delete lostItsRange.closeness_range;
      expect(failures(lostItsRange)).toContain(RANKING);
    });

    it('catches a room that claims a different range from the one its scores used', () => {
      const room = nearTheTreasure(RULES.closenessRangeBefore);
      room.closeness_range = RULES.closenessRange;
      expect(failures(room)).toContain(RANKING);
    });
  });

  const flip = (hex: string) => (hex[0] === '0' ? '1' : '0') + hex.slice(1);
  const asHashed = (d: ChainRoom['digs'][number]) => ({ account: d.account, x: d.x, y: d.y, clueIndex: d.clue_index, dugAtMs: d.dug_at_ms });

  // Each of these fits together on its face and passed before: the security review's forged rounds.
  it.each<[string, (room: ChainRoom) => void, RegExp]>([
    ['finished with no result', (r) => { r.result = null; }, /all here/],
    ['finished with no rolls and no result', (r) => { r.rolls = []; r.result = null; }, /all here/],
    ['finished with clues and steps missing', (r) => { r.rolls = r.rolls!.slice(0, 2); r.clues = r.clues.slice(0, 3); }, /all here/],
    ['a step locked but never revealed', (r) => { r.rolls![2].link = null; r.rolls![2].roll_seed = null; r.rolls![2].reveal_ms = null; r.rolls![2].reveal_height = null; }, /all here/],
    ['a round that hasn\'t ended', (r) => { r.status = 'live'; r.result = null; }, /all here/],
    ['a late dig stamped with the first clue\'s bonus', (r) => {
      const dig = r.digs[2];
      dig.dug_at_ms = r.started_ms! + 58_000;
      dig.clue_index = 0;
      dig.bonus_bps = RULES.clueSchedule[0].bonusBps;
    }, /right clue/],
    ['a treasure lock that leaves out a dig', (r) => {
      const roll = r.rolls![3];
      roll.digs_hash = toHex(digsHash(r.digs.slice(0, 2).map(asHashed)));
      roll.roll_seed = toHex(rollSeed(r.room_id, 4, fromHex(roll.lock_seed!), fromHex(roll.link!), fromHex(roll.digs_hash)));
    }, /digs locked in for the treasure/],
    ['a clue lock that leaves out an earlier dig', (r) => {
      const roll = r.rolls![1];
      roll.digs_hash = toHex(digsHash([]));
      roll.roll_seed = toHex(rollSeed(r.room_id, 2, fromHex(roll.lock_seed!), fromHex(roll.link!), fromHex(roll.digs_hash)));
    }, /digs locked in for clue 3/],
    ['the same player digging twice', (r) => { r.digs[1].account = r.digs[0].account; }, /Every dig/],
    ['a dig before the start', (r) => { r.digs[0].dug_at_ms = r.started_ms! - 1; }, /Every dig/],
    ['a step locked before it was due', (r) => { r.rolls![0].lock_ms = r.rolls![0].due_ms - 1; }, /clock was kept/],
    ['a reveal after its deadline', (r) => { r.rolls![0].reveal_ms = r.rolls![0].due_ms + 120_001; }, /clock was kept/],
    ['a moved dig in the ranking only', (r) => { r.result!.ranking[0].x += 1; }, /Every score/],
  ])('goes red on %s', (_name, tamper, expected) => {
    const room = makeRoom();
    tamper(room);
    const found = failures(room);
    expect(found.some((title) => expected.test(title)), found.join(' | ')).toBe(true);
    expect(overallState(verifyRound(room))).toBe('fail');
  });

  it('goes red on a missed-reveal refund when every reveal was on time', () => {
    const room = makeRoom();
    room.status = 'refunded';
    room.result = { ...room.result!, refund_reason: 'missed-reveal', treasure: null, winner: null, ranking: [], split: null };
    expect(failures(room)).toContain('The refund had a valid reason');
  });

  it('goes red on a too-few-digs refund before the round could have ended', () => {
    const room = makeRoom();
    room.status = 'refunded';
    room.digs = room.digs.slice(0, 1);
    room.result = { ...room.result!, refund_reason: 'too-few-digs', treasure: null, winner: null, ranking: [], split: null, ended_ms: room.ends_at_ms! - 1 };
    expect(failures(room)).toContain('The refund had a valid reason');
  });

  it('accepts a real missed reveal, and an expired room that never started', () => {
    const missed = makeRoom();
    missed.status = 'refunded';
    missed.rolls = missed.rolls!.slice(0, 1);
    missed.clues = missed.clues.slice(0, 2);
    missed.digs = missed.digs.slice(0, 1);
    missed.result = { ...missed.result!, refund_reason: 'missed-reveal', treasure: null, winner: null, ranking: [], split: null, ended_ms: missed.started_ms! + 36_000 + 120_000 };
    expect(failures(missed)).toEqual([]);

    const expired = makeRoom();
    expired.status = 'refunded';
    expired.started_ms = null;
    expired.ends_at_ms = null;
    expired.rolls = [];
    expired.clues = expired.clues.slice(0, 1);
    expired.digs = [];
    expired.players = ['a.testnet'];
    expired.result = { ...expired.result!, refund_reason: 'expired', treasure: null, winner: null, ranking: [], split: null, ended_ms: expired.deadline_ms };
    expect(failures(expired)).toEqual([]);
  });

  it('never calls an empty list of checks a pass', () => {
    expect(overallState([])).toBe('fail');
    expect(overallState([{ title: 'x', checks: [{ state: 'note', title: 'y' }] }])).toBe('fail');
  });

  it('calls a line nobody could check partial, not a pass', () => {
    const groups = [{ title: 'x', checks: [{ state: 'pass' as const, title: 'a' }, { state: 'unchecked' as const, title: 'b' }] }];
    expect(overallState(groups)).toBe('partial');
  });

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
    ['a wrong bonus', (r) => { r.digs[0].bonus_bps = 99; }, /right clue, bonus/],
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
