// Where all the money sits and how it moves. Rooms only count players: this file holds the coins.
import { createGame, isOpen, joinGame, leaveGame } from './engine';
import { RULES } from './rules';
import { GameError } from './types';
import type { Game, MapId, NewGameInput } from './types';

export type DeedId = `${MapId}:${number}`;

export type Deed = {
  owner: string | null;
  /** Null means not for sale. */
  price: number | null;
  earned: number;
  landings: number;
};

export type HostRecord = { finished: number; expired: number };

export type Season = {
  number: number;
  /** Milliseconds since the epoch. */
  endsAt: number;
  pool: number;
  points: Record<string, number>;
  lastWinners: { account: string; prize: number }[];
};

export type Ledger = {
  /** Coins outside the game, standing in for each player's NEAR wallet. */
  wallets: Record<string, number>;
  /** Coins deposited and free to spend or withdraw. */
  balances: Record<string, number>;
  /** Fees and bonds locked in open rooms. */
  held: number;
  jackpot: number;
  deeds: Record<string, Deed>;
  hosts: Record<string, HostRecord>;
  season: Season;
};

export function newLedger(now: number): Ledger {
  return {
    wallets: {},
    balances: {},
    held: 0,
    jackpot: 0,
    deeds: {},
    hosts: {},
    season: { number: 1, endsAt: now + RULES.seasonLengthSec * 1000, pool: 0, points: {}, lastWinners: [] },
  };
}

/** Everything that exists. No flow may ever change this except by adding to a wallet. */
export function totalMoney(ledger: Ledger): number {
  const sum = (values: Record<string, number>) => Object.values(values).reduce((a, b) => a + b, 0);
  return sum(ledger.wallets) + sum(ledger.balances) + ledger.held + ledger.jackpot + ledger.season.pool;
}

export function balanceOf(ledger: Ledger, account: string): number {
  return ledger.balances[account] ?? 0;
}

export function walletOf(ledger: Ledger, account: string): number {
  return ledger.wallets[account] ?? 0;
}

function credit(ledger: Ledger, account: string, amount: number): void {
  ledger.balances[account] = balanceOf(ledger, account) + amount;
}

function spend(ledger: Ledger, account: string, amount: number): void {
  if (balanceOf(ledger, account) < amount) throw new GameError('Not enough coins in your balance.');
  ledger.balances[account] -= amount;
}

export function deposit(ledger: Ledger, account: string, amount: number): void {
  if (!Number.isInteger(amount) || amount <= 0) throw new GameError('Enter an amount above 0.');
  if (walletOf(ledger, account) < amount) throw new GameError('Your wallet doesn\'t have that much.');
  ledger.wallets[account] -= amount;
  credit(ledger, account, amount);
}

/** Only free coins can leave. Coins locked in a room stay there until the room ends. */
export function withdraw(ledger: Ledger, account: string, amount: number): void {
  if (!Number.isInteger(amount) || amount <= 0) throw new GameError('Enter an amount above 0.');
  spend(ledger, account, amount);
  ledger.wallets[account] = walletOf(ledger, account) + amount;
}

export function hostRecord(ledger: Ledger, account: string): HostRecord {
  return ledger.hosts[account] ?? { finished: 0, expired: 0 };
}

/** Opens a room and locks the host's bond. */
export function openRoom(ledger: Ledger, games: Game[], id: string, input: NewGameInput): Game {
  const open = games.filter((g) => g.host === input.host && isOpen(g)).length;
  if (open >= RULES.maxOpenRoomsPerHost) throw new GameError(`You can host at most ${RULES.maxOpenRoomsPerHost} open games at once.`);
  const game = createGame(id, input);
  spend(ledger, input.host, RULES.hostBond);
  ledger.held += RULES.hostBond;
  return game;
}

export function joinRoom(ledger: Ledger, game: Game, account: string): void {
  if (balanceOf(ledger, account) < game.fee) throw new GameError('Not enough coins in your balance.');
  joinGame(game, account);
  spend(ledger, account, game.fee);
  ledger.held += game.fee;
}

export function leaveRoom(ledger: Ledger, game: Game, account: string): void {
  leaveGame(game, account);
  ledger.held -= game.fee;
  credit(ledger, account, game.fee);
}

function record(ledger: Ledger, host: string, field: keyof HostRecord): void {
  ledger.hosts[host] = hostRecord(ledger, host);
  ledger.hosts[host][field]++;
}

export function deedId(mapId: MapId, landmarkId: number): DeedId {
  return `${mapId}:${landmarkId}`;
}

export function deedOf(ledger: Ledger, id: string): Deed {
  return ledger.deeds[id] ?? { owner: null, price: null, earned: 0, landings: 0 };
}

/** Moves a finished or refunded room's money. Safe to call once the round is over. */
export function payRoom(ledger: Ledger, game: Game): void {
  if (game.paid || isOpen(game) || !game.result) return;
  game.paid = true;
  const { result } = game;
  ledger.held -= RULES.hostBond;

  if (game.stage === 'refunded') {
    ledger.held -= game.fee * game.players.length;
    for (const player of game.players) credit(ledger, player, game.fee);
    if (result.refundReason === 'expired') {
      const penalty = Math.floor((RULES.hostBond * RULES.expiredBondPenaltyBps) / 10000);
      ledger.jackpot += penalty;
      credit(ledger, game.host, RULES.hostBond - penalty);
      record(ledger, game.host, 'expired');
    } else {
      credit(ledger, game.host, RULES.hostBond);
    }
    return;
  }

  const { split, pot, treasure } = result;
  ledger.held -= pot;
  credit(ledger, game.host, RULES.hostBond);
  credit(ledger, game.host, split.hostCut);
  credit(ledger, result.winner!, split.prize);
  ledger.season.pool += split.season;
  ledger.jackpot += split.jackpot;
  record(ledger, game.host, 'finished');

  // The deed share goes to the owner of wherever the treasure landed, or the jackpot if nobody owns it.
  const id = deedId(game.mapId, treasure!.landmarkId);
  const deed = deedOf(ledger, id);
  deed.landings++;
  if (deed.owner) {
    credit(ledger, deed.owner, split.deed);
    deed.earned += split.deed;
    result.deedOwner = deed.owner;
  } else {
    ledger.jackpot += split.deed;
  }
  ledger.deeds[id] = deed;

  // Exact pixel wins the jackpot. Earliest dig first, so it can't be taken by copying.
  const hit = [...game.digs].sort((a, b) => a.dugAt - b.dugAt).find((d) => d.x === treasure!.x && d.y === treasure!.y);
  if (hit) {
    const amount = Math.min(Math.floor((ledger.jackpot * RULES.jackpotPayBps) / 10000), pot * RULES.jackpotCapPots);
    ledger.jackpot -= amount;
    credit(ledger, hit.account, amount);
    result.jackpotWin = { account: hit.account, amount };
  }

  // Points scale with the pot, so tiny rounds earn almost nothing.
  if (result.ranking.length >= RULES.seasonMinDigs) {
    RULES.seasonPointsPerNear.forEach((perNear, place) => {
      const dig = result.ranking[place];
      if (!dig) return;
      const points = Math.floor((pot * perNear) / 1000);
      result.seasonPoints[dig.account] = points;
      ledger.season.points[dig.account] = (ledger.season.points[dig.account] ?? 0) + points;
    });
  }
}

export function buyDeed(ledger: Ledger, account: string, id: string): void {
  const deed = deedOf(ledger, id);
  if (deed.owner === account) throw new GameError('You already own this deed.');
  if (deed.owner === null) {
    spend(ledger, account, RULES.deedFirstPrice);
    ledger.jackpot += RULES.deedFirstPrice;
  } else {
    if (deed.price === null) throw new GameError('This deed isn\'t for sale.');
    spend(ledger, account, deed.price);
    credit(ledger, deed.owner, deed.price);
  }
  deed.owner = account;
  deed.price = null;
  ledger.deeds[id] = deed;
}

/** Puts a deed up for sale, or takes it off with a null price. */
export function listDeed(ledger: Ledger, account: string, id: string, price: number | null): void {
  const deed = deedOf(ledger, id);
  if (deed.owner !== account) throw new GameError('You don\'t own this deed.');
  if (price !== null && (!Number.isInteger(price) || price <= 0)) throw new GameError('Set a price above 0.');
  deed.price = price;
}

export function seasonRanking(ledger: Ledger): { account: string; points: number }[] {
  return Object.entries(ledger.season.points)
    .map(([account, points]) => ({ account, points }))
    .sort((a, b) => b.points - a.points || a.account.localeCompare(b.account));
}

/** Pays the top three and starts the next season. Any unclaimed share rolls over. */
export function closeSeason(ledger: Ledger, now: number): void {
  const { season } = ledger;
  const ranking = seasonRanking(ledger);
  const startingPool = season.pool;
  const lastWinners: Season['lastWinners'] = [];
  RULES.seasonPrizeBps.forEach((bps, place) => {
    const entry = ranking[place];
    if (!entry) return;
    const prize = Math.floor((startingPool * bps) / 10000);
    credit(ledger, entry.account, prize);
    season.pool -= prize;
    lastWinners.push({ account: entry.account, prize });
  });
  season.number++;
  season.endsAt = now + RULES.seasonLengthSec * 1000;
  season.points = {};
  season.lastWinners = lastWinners;
}
