import type { Deed, HostRecord, Season } from '../game/economy';
import type { Game, NewGameInput, Point } from '../game/types';
import type { RoundProof } from '../verifyChain';

/** How the player is known. `none` means watching: nothing has asked for an account yet. */
export type Identity =
  | { kind: 'none' }
  | { kind: 'guest'; accountId: string }
  | { kind: 'wallet'; accountId: string }
  | { kind: 'playtest'; accountId: string };

/** Prices and choices that differ between the dummy and the chain. */
export type Prices = {
  hostBond: number;
  mintPrice: number;
  /** Fixed entry fees for the host form, or null for a free number. */
  feeChoices: readonly number[] | null;
  /** The board's "at most this fee" filters. */
  feeFilters: readonly number[];
  /** Quick amounts in the wallet dialog, in milliNEAR. */
  walletAmounts: readonly number[];
};

/** The rooms bots will fill, in the units the contract uses. Above these, a host waits for real players. */
export type BotLimits = { maxFee: number; maxHostCutBps: number };

/** The dummy's test controls. Null on a real backend, which hides them. */
export interface PlaytestControls {
  speed: number;
  readonly playableAccounts: readonly string[];
  switchAccount(account: string): void;
  fillRoom(gameId: string): void;
  startNow(gameId: string): void;
  skipToNextClue(gameId: string): void;
  endNow(gameId: string): void;
  forceJackpot(gameId: string): void;
  endSeason(): void;
  reset(): void;
}

/**
 * Everything the UI needs from "the chain". The dummy implements it in memory; the NEAR
 * version implements the same shape with a wallet and contract calls, and the UI stays put.
 */
export interface GameBackend {
  /** Empty while the player is only watching. */
  readonly account: string;
  readonly identity: Identity;
  readonly games: Game[];
  readonly jackpot: number;
  readonly season: Season;
  readonly prices: Prices;
  /** Null when there are no bots, or nobody has said what they'll join. */
  readonly botLimits: BotLimits | null;
  /** The first read of the world has come back. */
  readonly ready: boolean;
  /** Seconds before the end at which the dig button closes, on the visible clock. */
  readonly lastDigSec: number;
  readonly playtest: PlaytestControls | null;
  /** Coins here are play coins on a test network, so the screens must say so. */
  readonly testnet: boolean;
  /** Reading straight from the chain, because the backend went quiet. */
  readonly offline: boolean;
  /** The "how do you want to play" question, while it's waiting for an answer. */
  readonly accountPrompt: AccountPrompt | null;
  /** The clock the rules run on. Screens must not count down from the local clock. */
  nowMs(): number;
  /** Asks once how to play, if nobody has said yet. Rejects with an empty message if they back out. */
  ensureAccount(): Promise<void>;
  /** Fetches a room's details, if they aren't here yet. Resolves whether or not it exists. */
  loadGame(id: string): Promise<void>;
  /** Everything needed to recheck a round, or null if nobody has it. Throws if nodes can't be reached to say. */
  proofOf(id: string): Promise<RoundProof | null>;
  refreshBalances(): void;
  connectWallet(): Promise<void>;
  /** Leaves the wallet and goes back to watching, or to the guest this browser had. */
  disconnectWallet(): Promise<void>;
  /** Null unless the player's wallet can do it. */
  readonly canTransferDeeds: boolean;
  transferDeed(id: string, to: string): Promise<void>;

  /** Coins outside the game. */
  walletOf(account: string): number;
  /** Deposited coins, free to spend or withdraw. */
  balanceOf(account: string): number;
  hostRecord(account: string): HostRecord;
  deedOf(id: string): Deed;
  seasonRanking(): { account: string; points: number }[];

  deposit(amount: number): Promise<void>;
  withdraw(amount: number): Promise<void>;
  /** Locks the hosting bond and resolves to the new game's id. */
  createGame(input: Omit<NewGameInput, 'host'>): Promise<string>;
  /** Locks the entry fee. */
  join(gameId: string): Promise<void>;
  /** Before the start only. The fee comes back. */
  leave(gameId: string): Promise<void>;
  /** Host only, once the minimum is reached. */
  start(gameId: string): Promise<void>;
  /** A roll is locked and its clue is seconds away, and until it lands the contract turns digs away. */
  clueArriving(gameId: string): boolean;
  /** `seenClue` is how many clues the player could see, so a new clue can't quietly cost them bonus. */
  dig(gameId: string, spot: Point, seenClue: number): Promise<void>;
  /** The first owner pays the project the mint price. */
  mintDeed(id: string): Promise<void>;
  /** Buys a listed NFT from its owner. `seenPrice` is the price the buyer agreed to. */
  buyDeed(id: string, seenPrice: number): Promise<void>;
  /** A null price takes it off the market. */
  listDeed(id: string, price: number | null): Promise<void>;
}

export type AccountPrompt = {
  chooseGuest(): void;
  chooseWallet(): void;
  cancel(): void;
};
