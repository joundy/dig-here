// "Verify this round", the part that needs no network: every roll redone in the player's browser, with the
// same rules code that ran the screens and that the shared test vectors hold the contract to. This only says
// the numbers it's given fit together. Whether they're real is verifyChain.ts's job.
import { rollNextClue } from './game/clues';
import { clueText } from './game/copy';
import { isCrowded, rankDigs, rollTreasure, scoreDig, splitPot } from './game/engine';
import { rollLayout } from './game/map';
import { digsHash, fromHex, layoutSeed, rollSeed, sha256, streamRng, toHex } from './game/random';
import { RULES } from './game/rules';
import type { Clue, Dig, Game, Landmark } from './game/types';
import type { ChainRoom, ChainRoll } from './near/rooms';
import { landmarksOf } from './near/rooms';

/** `unchecked` is amber: we couldn't find out. It never counts as a pass, and it isn't an accusation either. */
export type CheckState = 'pass' | 'fail' | 'note' | 'unchecked';
export type OverallState = 'pass' | 'partial' | 'fail';
export type Check = {
  state: CheckState;
  /** A plain sentence saying what was checked. */
  title: string;
  /** What was found, when it's worth saying. */
  detail?: string;
};
export type CheckGroup = { title: string; checks: Check[] };

const short = (hex: string | null | undefined) => (hex ? `${hex.slice(0, 10)}…` : 'nothing');
const same = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);
const STEP_NAME = ['', 'clue 2', 'clue 3', 'clue 4', 'the treasure'];
/** How long after a roll is due its reveal may land: contract/src/rules.rs. */
const REVEAL_WINDOW_MS = 120_000;
const STEPS = [1, 2, 3, 4];

/** When a step falls due, as the contract works it out: clues by the schedule, the treasure at the end. */
function dueMs(room: ChainRoom, step: number): number {
  const started = room.started_ms ?? 0;
  return step < 4 ? started + RULES.clueSchedule[step].startsAt * room.duration_sec * 10 : started + room.duration_sec * 1000;
}

function pass(ok: boolean, title: string, detail?: string): Check {
  return { state: ok ? 'pass' : 'fail', title, detail };
}

function safely(title: string, work: () => Check): Check {
  try {
    return work();
  } catch (e) {
    return { state: 'fail', title, detail: `Couldn't be rechecked: ${(e as Error).message}` };
  }
}

function layoutChecks(room: ChainRoom, landmarks: Landmark[]): Check[] {
  return [
    safely('The map layout seed comes from the block seed and the commitment', () => {
      const mine = toHex(layoutSeed(room.room_id, fromHex(room.block_seed!), fromHex(room.tip!)));
      return pass(mine === room.layout_seed, 'The map layout seed comes from the block seed and the commitment', `Recalculated ${short(mine)}, the contract stored ${short(room.layout_seed)}.`);
    }),
    safely('Every landmark stands where the layout seed puts it', () => {
      const rolled = rollLayout(room.map, streamRng(fromHex(room.layout_seed!)));
      const wrong = rolled.filter((l, i) => !same(comparable(l), comparable(landmarks[i]))).length;
      return pass(rolled.length === landmarks.length && wrong === 0, 'Every landmark stands where the layout seed puts it', wrong ? `${wrong} of ${rolled.length} landmarks differ.` : `All ${rolled.length} landmarks match.`);
    }),
    {
      state: 'note',
      title: 'The commitment was fixed before anyone could join',
      detail: `The contract says it's number ${room.tip_index} from its pool. The layout above depends on it, so it can't have been swapped once the room existed.`,
    },
  ];
}

function comparable(l: Landmark | undefined) {
  return l && { id: l.id, kind: l.kind, category: l.category, x: l.x, y: l.y, tags: l.tags, flip: l.flip };
}

function chainChecks(room: ChainRoom): Check[] {
  const checks: Check[] = [];
  let previous = room.tip!;
  for (const roll of room.rolls ?? []) {
    if (!roll.link) continue;
    const title = `The secret for ${STEP_NAME[roll.step]} hashes back to ${roll.step === 1 ? 'the commitment' : 'the one before it'}`;
    checks.push(safely(title, () => {
      const hashed = toHex(sha256(fromHex(roll.link!)));
      return pass(hashed === previous, title, `H(${short(roll.link)}) is ${short(hashed)}, expected ${short(previous)}.`);
    }));
    previous = roll.link;
  }
  return checks;
}

/**
 * How many digs the lock covered, or null if no honest count gives its hash. A dig in the lock's own block may
 * fall either side of it, so the hash picks out which. Anything earlier must be in, and the treasure's lock
 * comes after digging has closed, so it must cover every dig.
 */
function digsAtLock(room: ChainRoom, roll: ChainRoll) {
  const lockMs = roll.lock_ms ?? -Infinity;
  const most = room.digs.filter((d) => d.dug_at_ms <= lockMs).length;
  const least = roll.step === 4 ? room.digs.length : room.digs.filter((d) => d.dug_at_ms < lockMs).length;
  for (let count = most; count >= least; count--) {
    const prefix = room.digs.slice(0, count).map((d) => ({ account: d.account, x: d.x, y: d.y, clueIndex: d.clue_index, dugAtMs: d.dug_at_ms }));
    if (toHex(digsHash(prefix)) === roll.digs_hash) return count;
  }
  return null;
}

function rollChecks(room: ChainRoom): Check[] {
  const checks: Check[] = [];
  for (const roll of room.rolls ?? []) {
    if (!roll.link || !roll.lock_seed || !roll.digs_hash) continue;
    const name = STEP_NAME[roll.step];
    const lockTitle = `The digs locked in for ${name} hash to what the contract stored`;
    checks.push(safely(lockTitle, () => {
      const count = digsAtLock(room, roll);
      return pass(count !== null, lockTitle, count === null ? `The digs made by then don't give ${short(roll.digs_hash)}.` : `${count} ${count === 1 ? 'dig' : 'digs'} had happened by the lock.`);
    }));
    const seedTitle = `The roll for ${name} comes from the lock seed, the secret and those digs`;
    checks.push(safely(seedTitle, () => {
      const mine = toHex(rollSeed(room.room_id, roll.step, fromHex(roll.lock_seed!), fromHex(roll.link!), fromHex(roll.digs_hash!)));
      return pass(mine === roll.roll_seed, seedTitle, `Recalculated ${short(mine)}, the contract stored ${short(roll.roll_seed)}.`);
    }));
    const orderTitle = `The secret for ${name} came out in a later block than its lock`;
    checks.push(pass((roll.reveal_height ?? 0) > (roll.lock_height ?? Infinity), orderTitle, `Locked in block ${roll.lock_height}, revealed in block ${roll.reveal_height}.`));
  }
  return checks;
}

/** A blank room with just what the clue and treasure rules read, replayed from the start. */
function replayGame(room: ChainRoom, landmarks: Landmark[]): Game {
  return {
    id: String(room.room_id), name: room.name, host: room.host, mapId: room.map, fee: room.fee, durationSec: room.duration_sec,
    hostCutBps: room.host_cut_bps, minPlayers: room.min_players, maxPlayers: room.max_players, countdownSec: room.countdown_sec,
    stage: 'live', waited: 0, startIn: null, elapsed: 0, players: room.players, clues: [{ level: 'yolo' }], landmarks,
    candidateIds: landmarks.map((l) => l.id), digs: [], result: null, paid: false,
  };
}

function clueChecks(room: ChainRoom, game: Game): Check[] {
  const checks: Check[] = [];
  for (const roll of room.rolls ?? []) {
    if (!roll.roll_seed || roll.step > 3) continue;
    const title = `Clue ${roll.step + 1} is what its roll says`;
    checks.push(safely(title, () => {
      rollNextClue(game, streamRng(fromHex(roll.roll_seed!)));
      const clue = game.clues[game.clues.length - 1];
      const played: Clue | undefined = room.clues[roll.step];
      const ok = same(clue, roll.clue) && same(clue, played);
      return pass(ok, title, ok ? `${clueText(room.map, clue).plain}, leaving ${game.candidateIds.length} spots.` : `Rolled ${JSON.stringify(clue)}, the round showed ${JSON.stringify(played)}.`);
    }));
  }
  return checks;
}

function asDig(room: ChainRoom, d: ChainRoom['digs'][number]): Dig {
  return { account: d.account, x: d.x, y: d.y, clueIndex: d.clue_index, bonusBps: d.bonus_bps, crowded: d.crowded, dugAt: d.dug_at_ms - (room.started_ms ?? 0) };
}

function digChecks(room: ChainRoom): Check[] {
  const digs = room.digs.map((d) => asDig(room, d));
  const bad: string[] = [];
  const revealed = (room.rolls ?? []).filter((r) => r.step < 4 && r.reveal_ms !== null);
  digs.forEach((d, i) => {
    const at = room.digs[i].dug_at_ms;
    if (!room.players.includes(d.account)) bad.push(`${d.account} dug without joining`);
    if (digs.slice(0, i).some((earlier) => earlier.account === d.account)) bad.push(`${d.account} dug twice`);
    if (RULES.clueSchedule[d.clueIndex]?.bonusBps !== d.bonusBps) bad.push(`${d.account} got the wrong bonus`);
    // A dig's bonus follows clues actually out, and a reveal in the dig's own block may fall either side of it.
    const least = revealed.filter((r) => r.reveal_ms! < at).length;
    const most = revealed.filter((r) => r.reveal_ms! <= at).length;
    if (d.clueIndex < least || d.clueIndex > most) bad.push(`${d.account}'s dig claims clue ${d.clueIndex + 1}, but ${most + 1} ${most === 0 ? 'was' : 'were'} out by then`);
    if (isCrowded(digs.slice(0, i), d) !== d.crowded) bad.push(`${d.account}'s crowding is wrong`);
    if (room.ends_at_ms !== null && at >= room.ends_at_ms) bad.push(`${d.account} dug after the end`);
    if (room.started_ms === null || at < room.started_ms) bad.push(`${d.account} dug before the start`);
    if (i > 0 && at < room.digs[i - 1].dug_at_ms) bad.push(`${d.account}'s dig is out of order`);
  });
  return [pass(bad.length === 0, 'Every dig was by a player, once, in time, with the right clue, bonus and crowding', bad.length ? bad.join('; ') : `${digs.length} ${digs.length === 1 ? 'dig' : 'digs'} checked.`)];
}

/** What a round of this kind can't be without. A missing piece is a red line, not a shorter list. */
function completeChecks(room: ChainRoom): Check[] {
  const title = 'The round is all here';
  const gaps: string[] = [];
  const need = (ok: unknown, what: string) => { if (!ok) gaps.push(what); };
  const result = room.result;
  need(room.tip && room.block_seed && room.layout_seed, 'the seeds');
  need(room.landmarks?.length, 'the landmarks');
  if (room.status === 'finished') {
    need(result, 'the result');
    need(result?.treasure, 'the treasure');
    need(result?.winner, 'the winner');
    need(result?.split, 'the pot split');
    need(result?.ranking.length === room.digs.length, 'a ranking row for every dig');
    need(room.started_ms !== null && room.ends_at_ms !== null, 'the start and end times');
    need(room.digs.length >= RULES.minDigs, `at least ${RULES.minDigs} digs`);
    need(room.clues.length === RULES.clueSchedule.length, 'all four clues');
    for (const step of STEPS) {
      const rolls = (room.rolls ?? []).filter((r) => r.step === step);
      const roll = rolls[0];
      need(rolls.length === 1 && roll.lock_seed && roll.digs_hash && roll.lock_ms !== null && roll.lock_height !== null && roll.link && roll.reveal_ms !== null && roll.reveal_height !== null && roll.roll_seed, `step ${step}'s lock and reveal`);
      if (step < 4) need(roll?.clue, `clue ${step + 1}`);
    }
    need((room.rolls ?? []).every((r, i) => r.step === i + 1), 'the steps in order');
  } else if (room.status === 'refunded') {
    need(result, 'the result');
    need(result?.refund_reason, 'a reason for the refund');
  } else {
    return [{ state: 'fail', title, detail: "This round hasn't ended, so there's nothing final to check yet." }];
  }
  return [pass(gaps.length === 0, title, gaps.length ? `Missing: ${gaps.join(', ')}.` : undefined)];
}

/** Times the contract would have enforced. Skipped for a room that never started, which has none. */
function timingChecks(room: ChainRoom): Check[] {
  if (room.started_ms === null) return [];
  const title = "The clock was kept: each step locked once it was due and revealed before its deadline";
  const bad: string[] = [];
  if (room.ends_at_ms !== room.started_ms + room.duration_sec * 1000) bad.push("the end time doesn't match the round's length");
  for (const roll of room.rolls ?? []) {
    const due = dueMs(room, roll.step);
    if (roll.due_ms !== due) bad.push(`step ${roll.step} says it was due at ${roll.due_ms}, the rules say ${due}`);
    if (roll.lock_ms !== null && roll.lock_ms < due) bad.push(`step ${roll.step} locked before it was due`);
    if (roll.reveal_ms !== null && roll.lock_ms !== null && roll.reveal_ms < roll.lock_ms) bad.push(`step ${roll.step} was revealed before its lock`);
    if (roll.reveal_ms !== null && roll.reveal_ms > due + REVEAL_WINDOW_MS) bad.push(`step ${roll.step} was revealed after its deadline`);
  }
  return [pass(bad.length === 0, title, bad.length ? `${bad.join('; ')}.` : undefined)];
}

function endChecks(room: ChainRoom, game: Game, landmarks: Landmark[]): Check[] {
  const result = room.result;
  // The absence itself is a red line in `completeChecks`.
  if (!result?.treasure) return [];
  const roll = room.rolls?.find((r) => r.step === 4);
  const checks: Check[] = [];
  const treasure = result.treasure;
  checks.push(safely('The treasure landed where its roll says', () => {
    const rolled = rollTreasure(game, streamRng(fromHex(roll!.roll_seed!)));
    const ok = rolled.x === treasure.x && rolled.y === treasure.y && rolled.landmarkId === treasure.landmark_id;
    return pass(ok, 'The treasure landed where its roll says', ok ? `By the ${landmarks[treasure.landmark_id].kind} at ${treasure.x}, ${treasure.y}.` : `Rolled ${rolled.x}, ${rolled.y}, the contract says ${treasure.x}, ${treasure.y}.`);
  }));

  const point = { x: treasure.x, y: treasure.y };
  // A round keeps the range it was created under, for good. contract/README.md has the rule.
  const range = room.closeness_range ?? RULES.closenessRangeBefore;
  const ranked = rankDigs(room.digs.map((d) => scoreDig(asDig(room, d), point, range)));
  const rankOk = ranked.length === result.ranking.length && ranked.every((d, i) => {
    const row = result.ranking[i];
    return row.account === d.account && row.x === d.x && row.y === d.y && row.distance === d.distance && row.closeness === d.closeness && row.score === d.score;
  });
  checks.push(pass(rankOk, 'Every score and the ranking add up', rankOk ? `${ranked[0]?.account} came first, with closeness reaching zero ${range} pixels from the treasure.` : `The ranking differs when rescored with a closeness range of ${range}.`));
  checks.push(pass(result.winner === ranked[0]?.account, 'The winner is the top score', `${result.winner}.`));

  const pot = room.fee * room.players.length;
  checks.push(pass(pot === result.pot, 'The pot is the entry fee times the players', `${room.fee} × ${room.players.length} = ${pot} thousandths of a coin.`));
  const split = splitPot(pot, room.host_cut_bps);
  const raw = result.split;
  const splitOk = !!raw && raw.host_cut === split.hostCut && raw.jackpot === split.jackpot && raw.deed === split.deed && raw.season === split.season && raw.prize === split.prize;
  checks.push(pass(splitOk, 'The pot split matches the rules', `Winner ${split.prize}, host ${split.hostCut}, jackpot ${split.jackpot}, NFT ${split.deed}, season ${split.season}.`));

  checks.push(safely('The jackpot moved by the rules', () => {
    const before = result.jackpot_before + split.jackpot + (result.deed_owner ? 0 : split.deed);
    const hit = [...room.digs].sort((a, b) => a.dug_at_ms - b.dug_at_ms).find((d) => d.x === treasure.x && d.y === treasure.y);
    const amount = hit ? Math.min(Math.floor((before * RULES.jackpotPayBps) / 10000), pot * RULES.jackpotCapPots) : 0;
    const ok = result.jackpot_after === before - amount && (hit ? result.jackpot_win?.account === hit.account && result.jackpot_win?.amount === amount : !result.jackpot_win);
    return pass(ok, 'The jackpot moved by the rules', `${result.jackpot_before} before, ${result.jackpot_after} after${hit ? `, with ${amount} won on the exact pixel` : ', nobody hit the exact pixel'}.`);
  }));

  const expected = result.ranking.length >= RULES.seasonMinDigs
    ? RULES.seasonPointsPerNear.map((perNear, place) => ({ account: ranked[place]?.account, amount: Math.floor((pot * perNear) / 1000) })).filter((p) => p.account)
    : [];
  checks.push(pass(same(expected, result.season_points.map((p) => ({ account: p.account, amount: p.amount }))), 'Season points match the rules', expected.length ? expected.map((p) => `${p.account} ${p.amount}`).join(', ') : `Fewer than ${RULES.seasonMinDigs} digs, so nobody gets any.`));
  return checks;
}

function refundChecks(room: ChainRoom): Check[] {
  const result = room.result;
  if (!result?.refund_reason) return [];
  const digs = room.digs.length;
  const ended = result.ended_ms;
  let ok = false;
  let said = 'That reason is one the contract never gives.';
  if (result.refund_reason === 'too-few-digs') {
    ok = room.started_ms !== null && room.ends_at_ms !== null && digs < RULES.minDigs && ended >= room.ends_at_ms;
    said = `${digs} ${digs === 1 ? 'dig' : 'digs'} by the end, and a round needs ${RULES.minDigs}.`;
  } else if (result.refund_reason === 'expired') {
    ok = room.started_ms === null && ended >= room.deadline_ms && room.players.length < room.min_players;
    said = `${room.players.length} of the ${room.min_players} players needed had joined when its deadline passed.`;
  } else if (result.refund_reason === 'missed-reveal') {
    const next = STEPS.find((step) => !room.rolls?.some((r) => r.step === step && r.reveal_ms !== null));
    ok = room.started_ms !== null && next !== undefined && ended >= dueMs(room, next) + REVEAL_WINDOW_MS;
    said = next === undefined
      ? 'Every roll was revealed, so this reason is false.'
      : `The roll for ${STEP_NAME[next]} was never revealed by its deadline, so everyone was paid back and the host lost nothing.`;
  }
  const clean = !result.treasure && !result.winner;
  return [
    pass(ok, 'The refund had a valid reason', said),
    pass(clean, 'No treasure was rolled and nobody won', clean ? 'Everyone who joined gets their entry fee back.' : 'A refunded round names a treasure or a winner.'),
  ];
}

/** Every check that needs no network. Each one stands alone, so one bad value can't hide the rest. */
export function verifyRound(room: ChainRoom): CheckGroup[] {
  const landmarks = landmarksOf(room.map, room.landmarks);
  const game = replayGame(room, landmarks);
  const groups: CheckGroup[] = [
    { title: 'Whole round', checks: completeChecks(room) },
    { title: 'Map', checks: layoutChecks(room, landmarks) },
    { title: 'Secrets', checks: chainChecks(room) },
    { title: 'Rolls', checks: rollChecks(room) },
    { title: 'Clues', checks: clueChecks(room, game) },
    { title: 'Timing', checks: timingChecks(room) },
    { title: 'Digs', checks: digChecks(room) },
    { title: room.status === 'refunded' ? 'Refund' : 'Treasure and pot', checks: room.status === 'refunded' ? refundChecks(room) : endChecks(room, game, landmarks) },
  ];
  return groups.filter((g) => g.checks.length);
}

/** Green only with something passed and nothing failed or left unknown: no checks at all is not a pass. */
export function overallState(groups: CheckGroup[]): OverallState {
  const checks = groups.flatMap((g) => g.checks);
  if (checks.some((c) => c.state === 'fail') || !checks.some((c) => c.state === 'pass')) return 'fail';
  return checks.some((c) => c.state === 'unchecked') ? 'partial' : 'pass';
}
