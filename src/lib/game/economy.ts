// Where all the money sits and how it moves. Rooms only count players: this file holds the coins.
import { createGame, isOpen, joinGame, leaveGame } from './engine';
import { RULES } from './rules';
import { GameError } from './types';
import { LANDMARKS_PER_MAP, MAP_DEFS } from './map';
import type { Game, Kind, Landmark, MapId, NewGameInput } from './types';

/** One deed per kind of landmark per map, like the Snowy Penguin. */
export type DeedId = `${MapId}:${Kind}`;

export type Deed = {
  owner: string | null;
  /** What the owner is asking. Null means it isn't listed. */
  price: number | null;
  earned: number;
  landings: number;
  /** Someone's purchase is on its way, so it can't be bought or changed for a moment. */
  saleInProgress?: boolean;
};

/** One line of an NFT's history. `from` and `to` are whoever it left and whoever it reached. */
export type DeedEvent = {
  kind: 'minted' | 'listed' | 'price' | 'delisted' | 'sold' | 'failed' | 'sent' | 'landed';
  id: string;
  /** Milliseconds since the epoch. */
  at: number;
  from: string | null;
  to: string | null;
  /** What it sold or was listed for, or what the owner earned when the treasure landed by it. */
  price: number | null;
  /** The transaction, where the chain has one. */
  tx?: string;
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
  /** What the project has earned, from minting. */
  treasury: number;
  jackpot: number;
  deeds: Record<string, Deed>;
  /** Newest first, and only as long as the market needs it. */
  deedLog: DeedEvent[];
  /** When things are happening, set by whoever runs the ledger. These rules never read a clock of their own. */
  clockMs: number;
  hosts: Record<string, HostRecord>;
  season: Season;
};

export function newLedger(now: number): Ledger {
  return {
    wallets: {},
    balances: {},
    held: 0,
    treasury: 0,
    jackpot: 0,
    deeds: {},
    deedLog: [],
    clockMs: now,
    hosts: {},
    season: { number: 1, endsAt: now + RULES.seasonLengthSec * 1000, pool: 0, points: {}, lastWinners: [] },
  };
}

/** Everything that exists. No flow may ever change this except by adding to a wallet. */
export function totalMoney(ledger: Ledger): number {
  const sum = (values: Record<string, number>) => Object.values(values).reduce((a, b) => a + b, 0);
  return sum(ledger.wallets) + sum(ledger.balances) + ledger.held + ledger.treasury + ledger.jackpot + ledger.season.pool;
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
export function openRoom(ledger: Ledger, games: Game[], id: string, input: NewGameInput, landmarks: Landmark[]): Game {
  const open = games.filter((g) => g.host === input.host && isOpen(g)).length;
  if (open >= RULES.maxOpenRoomsPerHost) throw new GameError(`You can host at most ${RULES.maxOpenRoomsPerHost} open games at once.`);
  const game = createGame(id, input, landmarks);
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

export function deedId(mapId: MapId, kind: Kind): DeedId {
  return `${mapId}:${kind}`;
}

/** The kinds of landmark on a map, each of which is one deed. */
export function deedKinds(mapId: MapId): Kind[] {
  return Object.keys(MAP_DEFS[mapId].roster) as Kind[];
}

/** How many of this kind stand on the map. Their positions change, but the number doesn't. */
export function deedCount(mapId: MapId, kind: Kind): number {
  return MAP_DEFS[mapId].roster[kind] ?? 0;
}

/** Roughly the chance the treasure lands by this kind, since every landmark has about the same odds. For the screen only: it's a fraction. */
export function deedChance(mapId: MapId, kind: Kind): number {
  return deedCount(mapId, kind) / LANDMARKS_PER_MAP;
}

export function deedOf(ledger: Ledger, id: string): Deed {
  return ledger.deeds[id] ?? { owner: null, price: null, earned: 0, landings: 0 };
}

const DEED_LOG_KEPT = 200;

function logDeed(ledger: Ledger, event: Omit<DeedEvent, 'at'>): void {
  ledger.deedLog.unshift({ ...event, at: ledger.clockMs });
  ledger.deedLog.length = Math.min(ledger.deedLog.length, DEED_LOG_KEPT);
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

  // The deed share goes to the owner of the kind of landmark the treasure landed by, or the jackpot if nobody owns it.
  const id = deedId(game.mapId, game.landmarks[treasure!.landmarkId].kind);
  const deed = deedOf(ledger, id);
  deed.landings++;
  if (deed.owner) {
    credit(ledger, deed.owner, split.deed);
    deed.earned += split.deed;
    result.deedOwner = deed.owner;
    logDeed(ledger, { kind: 'landed', id, from: null, to: deed.owner, price: split.deed });
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

/** The first owner brings an NFT into being, and pays the project for it. */
export function mintDeed(ledger: Ledger, account: string, id: string): void {
  const deed = deedOf(ledger, id);
  if (deed.owner !== null) throw new GameError('This NFT has already been minted.');
  spend(ledger, account, RULES.deedMintPrice);
  ledger.treasury += RULES.deedMintPrice;
  deed.owner = account;
  ledger.deeds[id] = deed;
  logDeed(ledger, { kind: 'minted', id, from: null, to: account, price: RULES.deedMintPrice });
}

/**
 * Buys a listed NFT from its owner, wallet to wallet: the game balance isn't involved at either end. `seenPrice` is
 * the price the buyer agreed to, so an owner raising it while the purchase is on its way can't cost them more.
 */
export function buyDeed(ledger: Ledger, account: string, id: string, seenPrice?: number): void {
  const deed = deedOf(ledger, id);
  if (deed.owner === null) throw new GameError('This NFT hasn\'t been minted yet.');
  if (deed.owner === account) throw new GameError('You already own this NFT.');
  if (deed.price === null) throw new GameError('This NFT isn\'t for sale.');
  if (seenPrice !== undefined && seenPrice !== deed.price) throw new GameError('The price just changed. Check it and try again.');
  if (walletOf(ledger, account) < deed.price) throw new GameError('Your wallet doesn\'t have that much.');
  ledger.wallets[account] -= deed.price;
  ledger.wallets[deed.owner] = walletOf(ledger, deed.owner) + deed.price;
  logDeed(ledger, { kind: 'sold', id, from: deed.owner, to: account, price: deed.price });
  deed.owner = account;
  deed.price = null;
}

/** Lists a deed for sale at a price, or takes it off the market with null. */
export function listDeed(ledger: Ledger, account: string, id: string, price: number | null): void {
  const deed = deedOf(ledger, id);
  if (deed.owner !== account) throw new GameError('You don\'t own this NFT.');
  if (price !== null && (!Number.isInteger(price) || price <= 0)) throw new GameError('Set a price above 0.');
  const kind = price === null ? 'delisted' : deed.price === null ? 'listed' : 'price';
  if (price === null && deed.price === null) return;
  deed.price = price;
  logDeed(ledger, { kind, id, from: account, to: null, price });
}

/** Sends a deed to someone for nothing. Any listing ends with it. */
export function sendDeed(ledger: Ledger, account: string, id: string, to: string): void {
  const deed = deedOf(ledger, id);
  if (deed.owner !== account) throw new GameError('You don\'t own this NFT.');
  if (!to || to === account) throw new GameError('Enter someone else\'s account.');
  deed.owner = to;
  deed.price = null;
  logDeed(ledger, { kind: 'sent', id, from: account, to, price: null });
}

/** Equal points go by account name, compared byte by byte: a locale-aware order depends on the browser's language, and Rust's wouldn't match. */
export function seasonRanking(ledger: Ledger): { account: string; points: number }[] {
  return Object.entries(ledger.season.points)
    .map(([account, points]) => ({ account, points }))
    .sort((a, b) => b.points - a.points || (a.account < b.account ? -1 : a.account > b.account ? 1 : 0));
}

/**
 * Pays the top three and starts the next season. Any unclaimed share rolls over. Accounts ending in
 * `excludedSuffix` (testnet bots) can't take a prize, and whoever ranks below them moves up.
 */
export function closeSeason(ledger: Ledger, now: number, excludedSuffix = ''): void {
  const { season } = ledger;
  const ranking = seasonRanking(ledger).filter((entry) => !excludedSuffix || !entry.account.endsWith(excludedSuffix));
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
