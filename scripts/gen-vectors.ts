// Writes the cases the TypeScript rules and the Rust contract must agree on. `npm run gen-vectors`, then
// commit the output. Everything comes from fixed seeds, so the file only changes when the rules do, and
// a test fails if the committed file drifts. contract/tests/README.md explains each area.
import { closeSeason, deedId, newLedger, payRoom } from '../src/lib/game/economy';
import mapData from '../src/lib/game/generated/map-data.json';
import { rollNextClue } from '../src/lib/game/clues';
import { advance, createGame, finishAt, isCrowded, joinGame, placeDig, potOf, rankDigs, refund, rollTreasure, scoreDig, splitPot, startGame } from '../src/lib/game/engine';
import { H, isLand, MAP_IDS, rollLayout, rosterOf, spotsOf, W } from '../src/lib/game/map';
import { digsHash, fromHex, hashChain, layoutSeed, rollSeed, sha256, streamRng, toHex } from '../src/lib/game/random';
import { RULES } from '../src/lib/game/rules';
import { CATEGORY } from '../src/lib/game/mapDefs';
import type { Clue, Dig, Game, Kind, Landmark, MapId, Rng, Tag } from '../src/lib/game/types';

const MS_EPOCH = 1_790_000_000_000;

const bytes = (label: string) => sha256(new TextEncoder().encode(label));
const hex = (label: string) => toHex(bytes(label));
const rngFor = (label: string): Rng => streamRng(bytes(`vectors/${label}`));

/** Counts the draws, and takes one more so a stream that drifted out of step can't go unnoticed. */
function tracked(seed: Uint8Array): { rng: Rng; finish: () => { draws: number; after: number } } {
  const stream = streamRng(seed);
  let draws = 0;
  return {
    rng: (n) => {
      draws++;
      return stream(n);
    },
    finish: () => ({ draws, after: stream(1_000_000) }),
  };
}

const pick = <T>(rng: Rng, items: readonly T[]): T => items[rng(items.length)];

function range(count: number): number[] {
  return Array.from({ length: count }, (_, i) => i);
}

function layoutOf(map: MapId, label: string): Landmark[] {
  return rollLayout(map, rngFor(`layout/${label}`));
}

const noRng: Rng = () => {
  throw new Error('This step must not draw any numbers');
};

function belowStreams() {
  const shapes: [string, (rng: Rng, i: number) => number][] = [
    ['small', (rng) => 1 + rng(50)],
    ['dice', () => 6],
    ['one', () => 1],
    ['two', () => 2],
    ['spots', () => 500],
    ['largest', () => 0xffffffff],
    // The limit equals n here, so about half of all words get thrown away.
    ['half-rejected', () => 0x80000001],
    ['high-reject', () => 0xc0000000 + 1],
    ['power-of-two', (_, i) => 2 ** (i % 32)],
    ['any', (rng) => 1 + rng(0xfffffffe)],
  ];
  return range(60).map((i) => {
    const [name, size] = shapes[i % shapes.length];
    const rng = rngFor(`below/${i}`);
    const seed = hex(`below-seed/${i}`);
    const ns = range(4 + (i % 7) * 7).map((j) => size(rng, j));
    const stream = streamRng(fromHex(seed));
    return { shape: name, seed, ns, values: ns.map((n) => stream(n)) };
  });
}

const landmarkJson = (l: Landmark) => ({ kind: l.kind, x: l.x, y: l.y, tags: l.tags, flip: l.flip });

function layouts() {
  return range(60).map((i) => {
    const map = MAP_IDS[i % MAP_IDS.length];
    const seed = layoutSeed(i, bytes(`layout-block/${i}`), bytes(`layout-tip/${i}`));
    const { rng, finish } = tracked(seed);
    const landmarks = rollLayout(map, rng);
    return { map, seed: toHex(seed), landmarks: landmarks.map(landmarkJson), ...finish() };
  });
}

type CluePoint = { id: number; kind: Kind; category: string; tags: Tag[] };

const clueCandidate = (l: Landmark): CluePoint => ({ id: l.id, kind: l.kind, category: l.category, tags: l.tags });

/** Runs one clue from a stated position. `rollNextClue` looks landmarks up by id, so a made-up list stays indexable. */
function rollClue(landmarks: Landmark[], candidateIds: number[], level: number, seed: Uint8Array) {
  const game = { clues: new Array<Clue>(level).fill({ level: 'yolo' }), candidateIds, landmarks } as unknown as Game;
  const { rng, finish } = tracked(seed);
  rollNextClue(game, rng);
  return { clue: game.clues[level], candidates_after: game.candidateIds, ...finish() };
}

function madeUp(kind: Kind, tagsById: Tag[][]): Landmark[] {
  return tagsById.map((tags, id) => ({ id, kind, category: CATEGORY[kind], x: id, y: id, tags, flip: false }));
}

function clueRolls() {
  const cases: object[] = [];
  const add = (note: string, landmarks: Landmark[], candidateIds: number[], level: number, label: string) => {
    const seed = bytes(`clue-seed/${label}`);
    cases.push({
      note, level, seed: toHex(seed),
      candidates: candidateIds.map((id) => clueCandidate(landmarks[id])),
      ...rollClue(landmarks, candidateIds, level, seed),
    });
  };

  // Each game runs all three rolling levels, so candidates shrink the way they do in play.
  range(20).forEach((i) => {
    const map = MAP_IDS[i % MAP_IDS.length];
    const landmarks = layoutOf(map, `clues/${i}`);
    let ids = landmarks.map((l) => l.id);
    for (const level of [1, 2, 3]) {
      const label = `play/${i}/${level}`;
      add('in play', landmarks, ids, level, label);
      ids = rollClue(landmarks, ids, level, bytes(`clue-seed/${label}`)).candidates_after;
    }
  });

  // Every tag narrows nothing, so the fallback to all of the seed's tags applies.
  range(8).forEach((i) => {
    const same: Tag[][] = range(3 + i).map(() => ['north', 'west', 'water']);
    add('no tag narrows', madeUp('palm', same), range(3 + i), 3, `no-narrow/${i}`);
  });
  // One candidate left: nothing can narrow, and the roll below 1 still uses up a word.
  range(8).forEach((i) => add('last candidate', madeUp('cow', [['south', 'east', i % 2 ? 'inland' : 'water']]), [0], 3 - (i % 3), `last/${i}`));
  // A tag could narrow, but only to one, so it isn't ideal and the second-choice list applies.
  range(8).forEach((i) => add('only narrowing leaves one', madeUp('hut', [['north', 'west'], ['north', 'east'], ['south', 'west']]), [0, 1], 3, `single/${i}`));
  // A mix, so ideal tags are chosen by their position in the seed's own list.
  range(8).forEach((i) => add('ideal tags', madeUp('well', [
    ['north', 'west', 'water'], ['north', 'east', 'water'], ['south', 'west', 'water'], ['south', 'east', 'inland'], ['north', 'west', 'inland'],
  ]), [0, 1, 2, 3, 4], 3, `ideal/${i}`));
  // The first clue never rolls: it's the same for every game.
  range(4).forEach((i) => {
    const landmarks = layoutOf(MAP_IDS[i % 3], `yolo/${i}`);
    add('first clue draws nothing', landmarks, landmarks.map((l) => l.id), 0, `yolo/${i}`);
  });
  return cases;
}

function treasureRolls() {
  const cases: object[] = [];
  const add = (note: string, map: MapId, candidates: { id: number; x: number; y: number }[], label: string) => {
    const seed = bytes(`treasure-seed/${label}`);
    const landmarks: Landmark[] = [];
    for (const c of candidates) landmarks[c.id] = { ...c, kind: 'cow', category: 'animal', tags: [], flip: false };
    const game = { mapId: map, candidateIds: candidates.map((c) => c.id), landmarks } as unknown as Game;
    const { rng, finish } = tracked(seed);
    const { x, y, landmarkId } = rollTreasure(game, rng);
    cases.push({ note, map, seed: toHex(seed), candidates, treasure: { x, y, landmark_id: landmarkId }, ...finish() });
  };
  range(36).forEach((i) => {
    const map = MAP_IDS[i % 3];
    const rng = rngFor(`treasure/${i}`);
    const layout = layoutOf(map, `treasure/${i}`);
    const count = 1 + rng(i % 2 ? 4 : 40);
    const ids = layout.map((l) => l.id).slice(0, count);
    add('landmarks in play', map, ids.map((id) => ({ id, x: layout[id].x, y: layout[id].y })), `play/${i}`);
  });
  // Close to the coast, so many draws land in the sea and are thrown away.
  range(9).forEach((i) => {
    const map = MAP_IDS[i % 3];
    const coastal = layoutOf(map, `coast/${i}`).filter((l) => l.tags.includes('water')).slice(0, 2);
    add('by the coast', map, coastal.map((l) => ({ id: l.id, x: l.x, y: l.y })), `coast/${i}`);
  });
  // Open sea all round, so all 60 attempts fail and the treasure falls back to the landmark itself.
  range(6).forEach((i) => add('all 60 attempts fail', MAP_IDS[i % 3], [{ id: i, x: 40 + i, y: 3 }], `fallback/${i}`));
  return cases;
}

function digList(label: string, count: number) {
  const rng = rngFor(label);
  const names = ['a.testnet', 'bob.near', 'x', 'g-a1b2c3.guests.dighere.testnet', 'long-name_with.parts.bots.dighere.testnet', 'é.utf8'];
  return range(count).map((i) => ({
    account: `${pick(rng, names)}${i}`,
    x: rng(W),
    y: rng(H),
    clue_index: rng(4),
    dug_at_ms: MS_EPOCH + rng(1_000_000) * 1000 + rng(1000),
  }));
}

function digsHashes() {
  return range(60).map((i) => {
    const digs = digList(`digs/${i}`, i === 0 ? 0 : 1 + (i % 12));
    const hash = digsHash(digs.map((d) => ({ account: d.account, x: d.x, y: d.y, clueIndex: d.clue_index, dugAtMs: d.dug_at_ms })));
    return { digs, hash: toHex(hash) };
  });
}

function rollSeeds() {
  return range(60).map((i) => {
    const rng = rngFor(`roll-seed/${i}`);
    const roomId = i < 3 ? [0, 1, Number.MAX_SAFE_INTEGER][i] : rng(1_000_000);
    const step = 1 + (i % 4);
    const [lock, link, digs] = ['lock', 'link', 'digs'].map((part) => bytes(`roll-seed/${part}/${i}`));
    return { room_id: roomId, step, lock_seed: toHex(lock), link: toHex(link), digs_hash: toHex(digs), seed: toHex(rollSeed(roomId, step, lock, link, digs)) };
  });
}

function layoutSeeds() {
  return range(60).map((i) => {
    const roomId = i < 2 ? [0, Number.MAX_SAFE_INTEGER][i] : i * 977;
    const [block, tip] = ['block', 'tip'].map((part) => bytes(`layout-seed/${part}/${i}`));
    return { room_id: roomId, block_seed: toHex(block), tip: toHex(tip), seed: toHex(layoutSeed(roomId, block, tip)) };
  });
}

function hashChains() {
  return range(60).map((i) => {
    const secret = bytes(`chain/${i}`);
    const { tip, links } = hashChain(secret);
    return { secret: toHex(secret), tip: toHex(tip), links: links.map(toHex) };
  });
}

function landPoints() {
  const edges = [[-1, 10], [W, 10], [10, -1], [10, H], [0, 0], [W - 1, H - 1]];
  return MAP_IDS.flatMap((map) => {
    const rng = rngFor(`land/${map}`);
    const random = range(24).map(() => [rng(W), rng(H)]);
    return [...edges, ...random].map(([x, y]) => ({ map, x, y, land: isLand(map, { x, y }) }));
  });
}

const makeDig = (d: { account?: string; x: number; y: number; bonus_bps: number; crowded: boolean; dug_at: number }): Dig => ({
  account: d.account ?? 'a', x: d.x, y: d.y, bonusBps: d.bonus_bps, crowded: d.crowded, dugAt: d.dug_at, clueIndex: 0,
});

function crowding() {
  const radius = RULES.crowdRadius;
  return range(60).map((i) => {
    const rng = rngFor(`crowding/${i}`);
    const spot = { x: 30 + rng(W - 60), y: 30 + rng(H - 60) };
    // Half the cases sit right around the radius, where <= versus < matters.
    const offsets: [number, number][] = i % 2
      ? [[radius, 0], [0, -radius], [radius + 1, 0], [4, 4], [4, 5], [5, 4], [3, 5], [-6, 1]]
      : [[0, 0], [20, 20], [rng(40) - 20, rng(40) - 20]];
    const offset = offsets[i % offsets.length];
    const near = { x: spot.x + offset[0], y: spot.y + offset[1] };
    const far = { x: spot.x + 30, y: spot.y };
    const digs = i % 7 === 0 ? [] : i % 3 === 0 ? [far, near] : [near];
    return { digs, spot, crowded: isCrowded(digs.map((d) => makeDig({ ...d, bonus_bps: 0, crowded: false, dug_at: 0 })), spot) };
  });
}

function scores() {
  const bonuses = RULES.clueSchedule.map((c) => c.bonusBps);
  return range(120).map((i) => {
    const rng = rngFor(`score/${i}`);
    const treasure = { x: rng(W), y: rng(H) };
    // Exact, close, at the edge of either closeness range, and far beyond them.
    const reach = [0, 1, 6, 13, 34, 47, 48, 49, 95, 96, 97, 200][i % 12];
    const closenessRange = i % 5 === 0 ? RULES.closenessRangeBefore : RULES.closenessRange;
    const angle = rng(3);
    const dx = angle === 0 ? reach : angle === 1 ? Math.floor((reach * 3) / 5) : rng(reach + 1);
    const dy = angle === 0 ? 0 : angle === 1 ? Math.floor((reach * 4) / 5) : rng(reach + 1);
    const dig = { x: treasure.x + dx, y: treasure.y + dy, bonus_bps: bonuses[i % 4], crowded: i % 3 === 0, dug_at: 0 };
    if (i === 0) {
      // Opposite corners: the longest distance there is.
      Object.assign(treasure, { x: 0, y: 0 });
      Object.assign(dig, { x: W - 1, y: H - 1 });
    }
    const { distance, closeness, score } = scoreDig(makeDig(dig), treasure, closenessRange);
    return { dig: { x: dig.x, y: dig.y, bonus_bps: dig.bonus_bps, crowded: dig.crowded }, treasure, range: closenessRange, distance, closeness, score };
  });
}

function rankings() {
  const bonuses = RULES.clueSchedule.map((c) => c.bonusBps);
  return range(60).map((i) => {
    const rng = rngFor(`ranking/${i}`);
    const treasure = { x: 100 + rng(100), y: 80 + rng(60) };
    const count = 2 + rng(8);
    const style = i % 5;
    const digs = range(count).map((n) => {
      const account = `p${n}.testnet`;
      if (style === 0) return { account, x: treasure.x + 1, y: treasure.y, bonus_bps: bonuses[0], crowded: false, dug_at: rng(3) };
      if (style === 1) return { account, x: treasure.x + 60 + rng(40), y: 0 + rng(10), bonus_bps: bonuses[rng(4)], crowded: rng(2) === 0, dug_at: rng(100) };
      if (style === 2) return { account, x: treasure.x + 60 + rng(2), y: treasure.y, bonus_bps: bonuses[rng(4)], crowded: false, dug_at: rng(3) };
      return { account, x: treasure.x + rng(30) - 15, y: treasure.y + rng(30) - 15, bonus_bps: bonuses[rng(4)], crowded: rng(2) === 0, dug_at: rng(100) };
    });
    const ranked = rankDigs(digs.map((d) => scoreDig(makeDig(d), treasure)));
    return { note: ['equal scores', 'all zero', 'all zero, near ties', 'mixed', 'mixed'][style], digs, treasure, order: ranked.map((d) => d.account), scores: ranked.map((d) => d.score) };
  });
}

function potSplits() {
  const pots = [0, 1, 2, 3, 9, 10, 33, 99, 100, 101, 333, 999, 1000, 1001, 9999, 10000, 10001, 123457, 5_000_000, 30_000_000];
  const cuts = [0, 1, 500, 1999, 2000];
  return pots.flatMap((pot, i) => [cuts[i % 5], cuts[(i + 2) % 5], cuts[(i + 3) % 5]].map((hostCutBps) => {
    const s = splitPot(pot, hostCutBps);
    return { pot, host_cut_bps: hostCutBps, host_cut: s.hostCut, jackpot: s.jackpot, deed: s.deed, season: s.season, prize: s.prize };
  }));
}

/** Plays out the money for one room from a stated start, with every balance at zero, so `credits` is all that moved. */
function settleCase(args: {
  note: string; map: MapId; fee: number; hostCutBps: number; host: string; players: string[];
  digs: { account: string; x: number; y: number; bonus_bps: number; crowded: boolean; dug_at: number }[];
  landmarkId: number; treasure: { x: number; y: number }; jackpotBefore: number; deedOwner: string | null; layout: Landmark[];
}) {
  const { map, fee, hostCutBps, host, players, digs, landmarkId, treasure, jackpotBefore, deedOwner, layout } = args;
  const game = createGame('v', { name: 'v', host, mapId: map, fee, durationSec: 100, hostCutBps, minPlayers: 2, maxPlayers: 30, countdownSec: 0 }, layout);
  players.forEach((p) => joinGame(game, p));
  startGame(game, host, noRng);
  game.digs = digs.map(makeDig);
  finishAt(game, { ...treasure, landmarkId });
  const ledger = newLedger(0);
  ledger.jackpot = jackpotBefore;
  ledger.held = RULES.hostBond + potOf(game);
  const kind = layout[landmarkId].kind;
  const id = deedId(map, kind);
  if (deedOwner) ledger.deeds[id] = { owner: deedOwner, price: null, earned: 0, landings: 0 };
  payRoom(ledger, game);
  if (ledger.held !== 0) throw new Error('Money left behind');
  const { result } = game;
  const deed = ledger.deeds[id];
  return {
    note: args.note, map, fee, host, host_cut_bps: hostCutBps, players, digs, treasure, treasure_kind: kind,
    jackpot_before: jackpotBefore, deed_owner: deedOwner,
    pot: result!.pot, split: result!.split, winner: result!.winner, ranking: result!.ranking.map((d) => d.account),
    credits: ledger.balances, jackpot_after: ledger.jackpot, season_pool: ledger.season.pool,
    deed_paid_to: result!.deedOwner, deed_earned: deed.earned, deed_landings: deed.landings,
    jackpot_win: result!.jackpotWin, season_points: result!.seasonPoints,
  };
}

function settlements() {
  const bonuses = RULES.clueSchedule.map((c) => c.bonusBps);
  return range(84).map((i) => {
    const rng = rngFor(`settle/${i}`);
    const map = MAP_IDS[i % 3];
    const layout = layoutOf(map, `settle/${i}`);
    const landmarkId = rng(layout.length);
    const treasure = { x: layout[landmarkId].x, y: layout[landmarkId].y };
    const style = i % 7;
    const count = style === 1 ? 2 : 3 + rng(8);
    const players = range(count + (i % 2)).map((n) => `p${n}.testnet`);
    const host = i % 4 === 0 ? players[0] : 'host.testnet';
    const digAt = (n: number, x: number, y: number, dugAt: number) => ({
      account: players[n], x, y, bonus_bps: bonuses[rng(4)], crowded: rng(4) === 0, dug_at: dugAt,
    });
    const digs = range(count).map((n) => digAt(n, 20 + rng(280), 20 + rng(180), n * 2));
    const fees = [1, 3, 7, 10, 50, 100, 250, 1000, 1234];
    let fee = fees[rng(fees.length)];
    let jackpotBefore = rng(100_000);
    let note = 'plain';
    if (style === 1) note = 'two digs earn no season points';
    if (style === 2) {
      // Hits the treasure exactly, and the jackpot is small enough that 80% of it is below the cap.
      fee = 1000;
      jackpotBefore = rng(500);
      digs[1] = { ...digs[1], x: treasure.x, y: treasure.y };
      note = 'exact hit, under the cap';
    }
    if (style === 3) {
      fee = 1;
      jackpotBefore = 50_000_000;
      digs[0] = { ...digs[0], x: treasure.x, y: treasure.y };
      note = 'exact hit, capped at 100 pots';
    }
    if (style === 4) {
      // Two exact hits. The earlier one takes the jackpot, even listed second.
      digs[0] = { ...digs[0], x: treasure.x, y: treasure.y, dug_at: 9 };
      digs[1] = { ...digs[1], x: treasure.x, y: treasure.y, dug_at: 5 };
      note = 'two exact hits';
    }
    if (style === 5) {
      for (const [n, d] of digs.entries()) digs[n] = { ...d, x: (treasure.x + 100 + n) % W, y: (treasure.y + 100) % H, crowded: false };
      note = 'all-zero scores';
    }
    if (style === 6) {
      fee = 1 + rng(9);
      note = 'tiny pot: points round down, possibly to zero';
    }
    const deedOwner = i % 3 === 0 ? null : i % 3 === 1 ? 'owner.testnet' : players[0];
    return settleCase({ note, map, fee, hostCutBps: pick(rng, [0, 1, 500, 2000]), host, players, digs, landmarkId, treasure, jackpotBefore, deedOwner, layout });
  });
}

function refunds() {
  return range(60).map((i) => {
    const rng = rngFor(`refund/${i}`);
    const map = MAP_IDS[i % 3];
    const reason = (['too-few-digs', 'expired', 'missed-reveal'] as const)[i % 3];
    const layout = layoutOf(map, `refund/${i}`);
    const fee = 1 + rng(2000);
    const minPlayers = 4;
    const players = range(reason === 'expired' ? rng(minPlayers) : minPlayers + rng(4)).map((n) => `p${n}.testnet`);
    const host = i % 4 === 0 && players.length ? players[0] : 'host.testnet';
    const game = createGame('v', { name: 'v', host, mapId: map, fee, durationSec: 100, hostCutBps: 500, minPlayers, maxPlayers: 30, countdownSec: 0 }, layout);
    players.forEach((p) => joinGame(game, p));
    let digCount = 0;
    if (reason === 'expired') {
      advance(game, RULES.waitingDeadlineSec, noRng);
    } else {
      startGame(game, host, noRng);
      digCount = reason === 'too-few-digs' ? i % 2 : 2 + rng(2);
      for (let n = 0; n < digCount; n++) placeDig(game, players[n], layout[n]);
      if (reason === 'too-few-digs') advance(game, game.durationSec, rngFor(`refund-clues/${i}`));
      else refund(game, 'missed-reveal');
    }
    if (game.stage !== 'refunded' || game.result!.refundReason !== reason) throw new Error(`Expected a ${reason} refund`);
    const ledger = newLedger(0);
    const jackpotBefore = rng(5000);
    ledger.jackpot = jackpotBefore;
    ledger.held = RULES.hostBond + potOf(game);
    payRoom(ledger, game);
    if (ledger.held !== 0) throw new Error('Money left behind');
    return {
      reason, fee, host, players, dig_count: digCount, jackpot_before: jackpotBefore,
      credits: ledger.balances, jackpot_after: ledger.jackpot, host_expired_count: ledger.hosts[host]?.expired ?? 0,
    };
  });
}

function seasonCloses() {
  const suffix = '.bots.dighere.testnet';
  return range(60).map((i) => {
    const rng = rngFor(`season/${i}`);
    const count = i % 6;
    const names = ['alice.testnet', 'Bob.testnet', 'carol.testnet', 'a-b.testnet', 'a.testnet', 'a_b.testnet', 'zed.testnet', 'x1.bots.dighere.testnet', 'x2.bots.dighere.testnet'];
    const points: Record<string, number> = {};
    for (let n = 0; n < count + (i % 4); n++) {
      // Few distinct values, so ties are common. Zero points still rank.
      points[names[rng(names.length)]] = (i % 5 === 0 ? 0 : rng(4) * 100);
    }
    const pool = [0, 1, 2, 9, 10, 333, 1000, 12345, 1_000_001][i % 9];
    const excluded = i % 2 ? suffix : '';
    const ledger = newLedger(0);
    ledger.season.pool = pool;
    ledger.season.points = { ...points };
    closeSeason(ledger, 0, excluded);
    return { pool, points, excluded_suffix: excluded, prizes: ledger.season.lastWinners, pool_after: ledger.season.pool, credits: ledger.balances };
  });
}

/** Whole rounds in the contract's order, so the seams between the other areas get tested too. */
function rounds() {
  return range(51).map((i) => {
    const rng = rngFor(`round/${i}`);
    const map = MAP_IDS[i % 3];
    const roomId = 1 + i;
    const durationSec = 300;
    const startMs = MS_EPOCH + i * 1000;
    const chain = hashChain(bytes(`round-secret/${i}`));
    const blockSeed = bytes(`round-block/${i}`);
    const seed = layoutSeed(roomId, blockSeed, chain.tip);
    const landmarks = rollLayout(map, streamRng(seed));
    const players = range(3 + rng(6)).map((n) => `p${n}.testnet`);
    const host = 'host.testnet';
    const fee = pick(rng, [10, 50, 100, 250]);
    const game = createGame(String(roomId), { name: 'r', host, mapId: map, fee, durationSec, hostCutBps: pick(rng, [0, 250, 2000]), minPlayers: 2, maxPlayers: 30, countdownSec: 0 }, landmarks);
    players.forEach((p) => joinGame(game, p));
    startGame(game, host, noRng);

    const digs: object[] = [];
    const steps: object[] = [];
    const hashedDigs: { account: string; x: number; y: number; clueIndex: number; dugAtMs: number }[] = [];
    let waiting = [...players];
    const digSome = (atSec: number, count: number) => {
      for (const account of waiting.splice(0, count)) {
        game.elapsed = atSec;
        const target = landmarks[pick(rng, game.candidateIds)];
        let spot = { x: target.x, y: target.y };
        const nudged = { x: target.x + rng(7) - 3, y: target.y + rng(7) - 3 };
        if (isLand(map, nudged)) spot = nudged;
        const dig = placeDig(game, account, spot, game.clues.length);
        const dugAtMs = startMs + atSec * 1000;
        hashedDigs.push({ account, x: dig.x, y: dig.y, clueIndex: dig.clueIndex, dugAtMs });
        digs.push({ account, x: dig.x, y: dig.y, clue_index: dig.clueIndex, dug_at_ms: dugAtMs, crowded: dig.crowded, bonus_bps: dig.bonusBps });
      }
    };
    const stepTimes = [90, 180, 255, 300];
    const toDig = (step: number) => (step === 3 ? waiting.length : 1 + rng(2));
    for (let step = 1; step <= 4; step++) {
      digSome(stepTimes[step - 1] - 1, toDig(step - 1));
      const lockSeed = bytes(`round-lock/${i}/${step}`);
      const link = chain.links[step - 1];
      const hash = digsHash(hashedDigs);
      const roll = rollSeed(roomId, step, lockSeed, link, hash);
      const { rng: stream, finish } = tracked(roll);
      const entry = { step, lock_seed: toHex(lockSeed), link: toHex(link), digs_hash: toHex(hash), roll_seed: toHex(roll) };
      if (step < 4) {
        rollNextClue(game, stream);
        steps.push({ ...entry, clue: game.clues[step], candidates_after: game.candidateIds, ...finish() });
      } else {
        const treasure = rollTreasure(game, stream);
        finishAt(game, treasure);
        steps.push({ ...entry, treasure: { x: treasure.x, y: treasure.y, landmark_id: treasure.landmarkId }, ...finish() });
      }
    }
    const { result } = game;
    return {
      room_id: roomId, map, block_seed: toHex(blockSeed), secret: toHex(chain.links[3]), tip: toHex(chain.tip), layout_seed: toHex(seed),
      fee, host_cut_bps: game.hostCutBps, players, digs, steps,
      ranking: result!.ranking.map((d) => ({ account: d.account, distance: d.distance, closeness: d.closeness, score: d.score })),
      winner: result!.winner, pot: result!.pot, split: result!.split,
    };
  });
}

function mapFacts() {
  return MAP_IDS.map((map) => {
    const { landSha256, spotsSha256 } = mapData.maps[map];
    return { map, kinds: rosterOf(map), spot_count: spotsOf(map).length, land_sha256: landSha256, spots_sha256: spotsSha256 };
  });
}

function area(name: string, cases: readonly unknown[]): string {
  return `  ${JSON.stringify(name)}: [\n${cases.map((c) => `    ${JSON.stringify(c)}`).join(',\n')}\n  ]`;
}

export default function generate(): Record<string, string> {
  const sections: [string, readonly unknown[]][] = [
    ['map_facts', mapFacts()],
    ['below_streams', belowStreams()],
    ['layouts', layouts()],
    ['clue_rolls', clueRolls()],
    ['treasure_rolls', treasureRolls()],
    ['digs_hashes', digsHashes()],
    ['roll_seeds', rollSeeds()],
    ['layout_seeds', layoutSeeds()],
    ['hash_chains', hashChains()],
    ['land_points', landPoints()],
    ['crowding', crowding()],
    ['scores', scores()],
    ['rankings', rankings()],
    ['pot_splits', potSplits()],
    ['settlements', settlements()],
    ['refunds', refunds()],
    ['season_closes', seasonCloses()],
    ['rounds', rounds()],
  ];
  const rules = JSON.stringify({ host_bond: RULES.hostBond, expired_bond_penalty_bps: RULES.expiredBondPenaltyBps, closeness_range: RULES.closenessRange, closeness_range_before: RULES.closenessRangeBefore });
  return {
    'contract/tests/vectors.json': `{\n  "rules": ${rules},\n${sections.map(([name, cases]) => area(name, cases)).join(',\n')}\n}\n`,
  };
}
