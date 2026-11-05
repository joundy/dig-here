import { describe, expect, it } from 'vitest';
import {
  balanceOf, buyDeed, closeSeason, deedChance, deedId, deedKinds, deedOf, deposit, hostRecord, joinRoom, leaveRoom, listDeed, mintDeed, newLedger, openRoom,
  payRoom, seasonRanking, totalMoney, walletOf, withdraw,
} from './economy';
import type { Ledger } from './economy';
import { advance, finishAt, placeDig, startGame } from './engine';
import { MAP_IDS, seededRng } from './map';
import { RULES } from './rules';
import { GameError } from './types';
import type { Game, MapId } from './types';

const rng = seededRng(3);
const NOW = 1_000_000;

function fund(ledger: Ledger, accounts: string[], amount = 50000): void {
  for (const a of accounts) {
    ledger.wallets[a] = amount;
    deposit(ledger, a, amount);
  }
}

function setup(players = ['a.near', 'b.near', 'c.near'], over: Partial<{ fee: number; hostCutBps: number; mapId: MapId }> = {}) {
  const ledger = newLedger(NOW);
  fund(ledger, ['host.near', ...players]);
  const game = openRoom(ledger, [], '1', {
    name: 'T', host: 'host.near', mapId: 'tropical', fee: 1000, durationSec: 100, hostCutBps: 500,
    minPlayers: 2, maxPlayers: 30, countdownSec: 0, ...over,
  });
  players.forEach((p) => joinRoom(ledger, game, p));
  return { ledger, game };
}

function finish(ledger: Ledger, game: Game, spots: Record<string, number>, landmarkId: number, shift = 0) {
  startGame(game, game.host, rng);
  const { landmarks } = game;
  for (const [account, id] of Object.entries(spots)) placeDig(game, account, landmarks[id]);
  const l = landmarks[landmarkId];
  finishAt(game, { x: l.x + shift, y: l.y, landmarkId });
  payRoom(ledger, game);
}

describe('balance', () => {
  it('moves coins between wallet and balance, and refuses more than you have', () => {
    const ledger = newLedger(NOW);
    ledger.wallets['a.near'] = 5000;
    deposit(ledger, 'a.near', 2000);
    expect(walletOf(ledger, 'a.near')).toBe(3000);
    expect(balanceOf(ledger, 'a.near')).toBe(2000);
    expect(() => deposit(ledger, 'a.near', 9000)).toThrow(GameError);
    expect(() => withdraw(ledger, 'a.near', 2001)).toThrow(GameError);
    expect(() => deposit(ledger, 'a.near', 0)).toThrow(GameError);
    withdraw(ledger, 'a.near', 500);
    expect(balanceOf(ledger, 'a.near')).toBe(1500);
    expect(walletOf(ledger, 'a.near')).toBe(3500);
  });

  it('charges nothing when a join fails for too little balance', () => {
    const { ledger, game } = setup();
    ledger.wallets['poor.near'] = 500;
    deposit(ledger, 'poor.near', 500);
    const players = game.players.length;
    const held = ledger.held;
    expect(() => joinRoom(ledger, game, 'poor.near')).toThrow(/Not enough/);
    expect(balanceOf(ledger, 'poor.near')).toBe(500);
    expect(game.players).toHaveLength(players);
    expect(ledger.held).toBe(held);
  });

  it('charges nothing when a join fails because of the room', () => {
    const { ledger, game } = setup();
    const before = balanceOf(ledger, 'a.near');
    expect(() => joinRoom(ledger, game, 'a.near')).toThrow(/already/);
    expect(balanceOf(ledger, 'a.near')).toBe(before);
  });

  it('locks the fee on joining, so it can\'t be withdrawn, and returns it on leaving', () => {
    const { ledger, game } = setup();
    expect(balanceOf(ledger, 'a.near')).toBe(49000);
    expect(() => withdraw(ledger, 'a.near', 50000)).toThrow(GameError);
    leaveRoom(ledger, game, 'a.near');
    expect(balanceOf(ledger, 'a.near')).toBe(50000);
  });
});

describe('hosting', () => {
  it('locks the bond, and refuses a host without enough balance', () => {
    const { ledger } = setup();
    expect(balanceOf(ledger, 'host.near')).toBe(50000 - RULES.hostBond);
    expect(() => openRoom(ledger, [], '2', {
      name: 'T', host: 'nobody.near', mapId: 'tropical', fee: 1000, durationSec: 100, hostCutBps: 0, minPlayers: 2, maxPlayers: 4, countdownSec: 0,
    })).toThrow(GameError);
  });

  it('allows at most 3 open rooms per host', () => {
    const ledger = newLedger(NOW);
    fund(ledger, ['host.near']);
    const games: Game[] = [];
    const input = { name: 'T', host: 'host.near', mapId: 'tropical' as MapId, fee: 1000, durationSec: 100, hostCutBps: 0, minPlayers: 2, maxPlayers: 4, countdownSec: 0 };
    for (let i = 0; i < 3; i++) games.push(openRoom(ledger, games, String(i), input));
    expect(() => openRoom(ledger, games, '9', input)).toThrow(/at most 3/);
  });

  it('returns the bond and adds to the host\'s record when a room finishes', () => {
    const { ledger, game } = setup();
    finish(ledger, game, { 'a.near': 0, 'b.near': 1 }, 0);
    expect(hostRecord(ledger, 'host.near')).toEqual({ finished: 1, expired: 0 });
    expect(balanceOf(ledger, 'host.near')).toBe(50000 + 150);
  });

  it('takes 10% of the bond into the jackpot when a room expires, and refunds its players', () => {
    const { ledger, game } = setup(['a.near'], {});
    advance(game, RULES.waitingDeadlineSec, rng);
    payRoom(ledger, game);
    expect(game.stage).toBe('refunded');
    expect(balanceOf(ledger, 'a.near')).toBe(50000);
    expect(balanceOf(ledger, 'host.near')).toBe(50000 - 10);
    expect(ledger.jackpot).toBe(10);
    expect(hostRecord(ledger, 'host.near')).toEqual({ finished: 0, expired: 1 });
  });

  it('returns everything when too few players dug, with no mark on the host', () => {
    const { ledger, game } = setup();
    startGame(game, game.host, rng);
    advance(game, 100, rng);
    payRoom(ledger, game);
    expect(balanceOf(ledger, 'a.near')).toBe(50000);
    expect(balanceOf(ledger, 'host.near')).toBe(50000);
    expect(hostRecord(ledger, 'host.near')).toEqual({ finished: 0, expired: 0 });
  });
});

describe('payout', () => {
  it('splits the pot as the plan says: 10 NEAR at 5% gives 0.5, 0.3, 0.2, 0.1 and 8.9', () => {
    const players = Array.from({ length: 10 }, (_, i) => `p${i}.near`);
    const { ledger, game } = setup(players);
    const owner = 'owner.near';
    fund(ledger, [owner]);
    const landing = 5;
    const kind = game.landmarks[landing].kind;
    mintDeed(ledger, owner, deedId('tropical', kind));
    const jackpotBefore = ledger.jackpot;
    const spots = { 'p0.near': 0, 'p1.near': 1 };
    // Off by one pixel, so the jackpot isn't hit.
    finish(ledger, game, spots, landing, 1);
    expect(game.result!.split).toEqual({ hostCut: 500, jackpot: 300, deed: 200, season: 100, prize: 8900 });
    expect(ledger.jackpot - jackpotBefore).toBe(300);
    expect(ledger.season.pool).toBe(100);
    expect(balanceOf(ledger, owner)).toBe(50000 - RULES.deedMintPrice + 200);
    expect(balanceOf(ledger, 'host.near')).toBe(50000 + 500);
    expect(balanceOf(ledger, game.result!.winner!)).toBe(49000 + 8900);
    expect(game.result!.deedOwner).toBe(owner);
    expect(deedOf(ledger, deedId('tropical', kind))).toMatchObject({ earned: 200, landings: 1 });
  });

  it('sends the deed share to the jackpot when nobody owns the landmark', () => {
    const { ledger, game } = setup();
    finish(ledger, game, { 'a.near': 0, 'b.near': 1 }, 5, 1);
    const { split } = game.result!;
    expect(ledger.jackpot).toBe(split.jackpot + split.deed);
    expect(game.result!.deedOwner).toBeNull();
  });

  it('can\'t pay out twice', () => {
    const { ledger, game } = setup();
    finish(ledger, game, { 'a.near': 0, 'b.near': 1 }, 0, 1);
    const money = { ...ledger.balances };
    payRoom(ledger, game);
    expect(ledger.balances).toEqual(money);
  });
});

describe('jackpot', () => {
  it('pays 80% to a dig on the exact pixel, and keeps 20% for the next one', () => {
    const { ledger, game } = setup();
    ledger.jackpot = 50000;
    finish(ledger, game, { 'a.near': 0, 'b.near': 1 }, 0);
    const { jackpot, deed } = game.result!.split;
    const before = 50000 + jackpot + deed;
    expect(game.result!.jackpotWin).toEqual({ account: 'a.near', amount: Math.floor(before * 0.8) });
    expect(ledger.jackpot).toBe(before - Math.floor(before * 0.8));
  });

  it('caps a win at 100 times the pot, so tiny rounds can\'t farm a big jackpot', () => {
    const { ledger, game } = setup(['a.near', 'b.near'], { fee: 1 });
    ledger.jackpot = 1_000_000;
    finish(ledger, game, { 'a.near': 0, 'b.near': 1 }, 0);
    expect(game.result!.jackpotWin!.amount).toBe(2 * RULES.jackpotCapPots);
  });

  it('goes to the earlier of two digs on the pixel', () => {
    const { ledger, game } = setup();
    ledger.jackpot = 1000;
    startGame(game, game.host, rng);
    const l = game.landmarks[0];
    placeDig(game, 'a.near', l);
    advance(game, 40, rng);
    placeDig(game, 'b.near', l);
    finishAt(game, { x: l.x, y: l.y, landmarkId: 0 });
    payRoom(ledger, game);
    expect(game.result!.jackpotWin!.account).toBe('a.near');
  });

  it('pays nothing one pixel away', () => {
    const { ledger, game } = setup();
    finish(ledger, game, { 'a.near': 0, 'b.near': 1 }, 0, 1);
    expect(game.result!.jackpotWin).toBeNull();
  });
});

describe('deeds', () => {
  const kind = deedKinds('snowy')[0];
  const id = deedId('snowy', kind);

  it('is one deed per kind per map', () => {
    expect(deedKinds('snowy')).toContain(kind);
    expect(deedKinds('snowy')).toHaveLength(12);
  });

  it('costs 20 NEAR to mint, which goes to the project and not the jackpot', () => {
    const ledger = newLedger(NOW);
    fund(ledger, ['a.near', 'b.near']);
    expect(RULES.deedMintPrice).toBe(20000);
    mintDeed(ledger, 'a.near', id);
    expect(ledger.treasury).toBe(20000);
    expect(ledger.jackpot).toBe(0);
    expect(balanceOf(ledger, 'a.near')).toBe(30000);
    expect(deedOf(ledger, id).owner).toBe('a.near');
    expect(() => mintDeed(ledger, 'b.near', id)).toThrow(/already/);
  });

  it('can\'t be bought before it\'s minted', () => {
    const ledger = newLedger(NOW);
    fund(ledger, ['a.near']);
    expect(() => buyDeed(ledger, 'a.near', id)).toThrow(/minted/);
  });

  it('can\'t be bought from an owner until they list it, and a sale pays the seller', () => {
    const ledger = newLedger(NOW);
    fund(ledger, ['a.near', 'b.near']);
    mintDeed(ledger, 'a.near', id);
    expect(deedOf(ledger, id).price).toBeNull();
    expect(() => buyDeed(ledger, 'b.near', id)).toThrow(/for sale/);
    expect(() => listDeed(ledger, 'b.near', id, 3000)).toThrow(/own/);
    expect(() => listDeed(ledger, 'a.near', id, 0)).toThrow(GameError);
    listDeed(ledger, 'a.near', id, 7000);
    buyDeed(ledger, 'b.near', id);
    expect(balanceOf(ledger, 'a.near')).toBe(50000 - RULES.deedMintPrice + 7000);
    expect(balanceOf(ledger, 'b.near')).toBe(50000 - 7000);
    expect(deedOf(ledger, id)).toMatchObject({ owner: 'b.near', price: null });
  });

  it('can be taken off the market', () => {
    const ledger = newLedger(NOW);
    fund(ledger, ['a.near', 'b.near']);
    mintDeed(ledger, 'a.near', id);
    listDeed(ledger, 'a.near', id, 3000);
    listDeed(ledger, 'a.near', id, null);
    expect(() => buyDeed(ledger, 'b.near', id)).toThrow(/for sale/);
  });

  it('won\'t let you buy your own, or pay a price you didn\'t agree to', () => {
    const ledger = newLedger(NOW);
    fund(ledger, ['a.near', 'b.near']);
    mintDeed(ledger, 'a.near', id);
    expect(() => buyDeed(ledger, 'a.near', id)).toThrow(/already/);
    listDeed(ledger, 'a.near', id, 4000);
    listDeed(ledger, 'a.near', id, 9000);
    expect(() => buyDeed(ledger, 'b.near', id, 4000)).toThrow(/price/);
    expect(balanceOf(ledger, 'b.near')).toBe(50000);
    buyDeed(ledger, 'b.near', id, 9000);
    expect(deedOf(ledger, id).owner).toBe('b.near');
  });

  it('charges nothing if the buyer can\'t afford it', () => {
    const ledger = newLedger(NOW);
    ledger.wallets['a.near'] = 10;
    deposit(ledger, 'a.near', 10);
    expect(() => mintDeed(ledger, 'a.near', id)).toThrow(GameError);
    expect(deedOf(ledger, id).owner).toBeNull();
    expect(ledger.treasury).toBe(0);
  });

  it('gives every deed a chance, adding up to 1 across a map', () => {
    for (const mapId of MAP_IDS) {
      const total = deedKinds(mapId).reduce((sum, k) => sum + deedChance(mapId, k), 0);
      expect(total).toBeCloseTo(1, 8);
    }
  });
});

describe('season', () => {
  it('gives points only for rounds with at least 3 digs, scaled by the pot', () => {
    const three = setup();
    finish(three.ledger, three.game, { 'a.near': 0, 'b.near': 1, 'c.near': 2 }, 0, 1);
    const [first, second, third] = three.game.result!.ranking;
    expect(three.ledger.season.points[first.account]).toBe(300);
    expect(three.ledger.season.points[second.account]).toBe(90);
    expect(three.ledger.season.points[third.account]).toBe(30);

    const two = setup();
    finish(two.ledger, two.game, { 'a.near': 0, 'b.near': 1 }, 0, 1);
    expect(two.ledger.season.points).toEqual({});
  });

  it('pays the top three 60, 30 and 10 percent, then starts a new season', () => {
    const ledger = newLedger(NOW);
    ledger.wallets.seed = 10000;
    deposit(ledger, 'seed', 10000);
    ledger.balances.seed = 0;
    ledger.season.pool = 10000;
    ledger.season.points = { a: 30, b: 20, c: 10, d: 5 };
    closeSeason(ledger, NOW + 5);
    expect(balanceOf(ledger, 'a')).toBe(6000);
    expect(balanceOf(ledger, 'b')).toBe(3000);
    expect(balanceOf(ledger, 'c')).toBe(1000);
    expect(balanceOf(ledger, 'd')).toBe(0);
    expect(ledger.season.pool).toBe(0);
    expect(ledger.season.number).toBe(2);
    expect(ledger.season.points).toEqual({});
    expect(ledger.season.endsAt).toBe(NOW + 5 + RULES.seasonLengthSec * 1000);
    expect(ledger.season.lastWinners[0]).toEqual({ account: 'a', prize: 6000 });
  });

  it('rolls unclaimed prizes into the next season', () => {
    const ledger = newLedger(NOW);
    ledger.season.pool = 10000;
    ledger.season.points = { a: 30 };
    closeSeason(ledger, NOW);
    expect(ledger.season.pool).toBe(4000);
  });

  it('ranks by points', () => {
    const ledger = newLedger(NOW);
    ledger.season.points = { a: 1, b: 5 };
    expect(seasonRanking(ledger).map((r) => r.account)).toEqual(['b', 'a']);
  });
});

it('never creates or loses a coin through hundreds of random rounds', () => {
  const r = seededRng(99);
  const ledger = newLedger(NOW);
  const people = Array.from({ length: 12 }, (_, i) => `p${i}.near`);
  fund(ledger, people, 200000);
  const start = totalMoney(ledger);
  const games: Game[] = [];

  for (let n = 0; n < 400; n++) {
    const host = people[r(people.length)];
    const mapId = MAP_IDS[r(3)];
    const live = games.filter((g) => g.host === host && g.stage !== 'finished' && g.stage !== 'refunded');
    if (live.length >= RULES.maxOpenRoomsPerHost) continue;
    const game = openRoom(ledger, games, String(n), {
      name: 'R', host, mapId, fee: 1 + r(5000), durationSec: 100, hostCutBps: r(2001), minPlayers: 2 + r(3), maxPlayers: 8 + r(10), countdownSec: 0,
    });
    games.push(game);
    const joinCount = r(9);
    for (let i = 0; i < joinCount; i++) {
      const p = people[r(people.length)];
      try { joinRoom(ledger, game, p); } catch (e) { expect(e).toBeInstanceOf(GameError); }
    }
    if (game.players.length && r(4) === 0) leaveRoom(ledger, game, game.players[0]);
    if (game.stage === 'waiting' && game.players.length >= game.minPlayers && r(5) > 0) {
      startGame(game, host, r);
      const { landmarks } = game;
      for (const p of game.players) if (r(5) > 0) placeDig(game, p, landmarks[r(landmarks.length)]);
      advance(game, 100, r);
    } else {
      advance(game, RULES.waitingDeadlineSec, r);
      if (game.stage === 'live') advance(game, 100, r);
    }
    payRoom(ledger, game);
    if (r(10) === 0) {
      const kinds = deedKinds(mapId);
      const id = deedId(mapId, kinds[r(kinds.length)]);
      const buyer = people[r(people.length)];
      try { mintDeed(ledger, buyer, id); listDeed(ledger, buyer, id, 1 + r(3000)); } catch (e) { expect(e).toBeInstanceOf(GameError); }
    }
    if (r(40) === 0) closeSeason(ledger, NOW);
    expect(totalMoney(ledger)).toBe(start);
  }
  expect(games.filter((g) => g.stage === 'finished').length).toBeGreaterThan(50);
  expect(ledger.held).toBe(0);
});
