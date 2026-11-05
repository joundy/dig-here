import type { Deed, DeedEvent, HostRecord, Season } from '../game/economy';
import type { Game, NewGameInput, Point } from '../game/types';
import type { RoundProof } from '../verifyChain';

/** How the player is known. `none` means watching: nothing has asked for an account yet. */
export type Identity =
  | { kind: 'none' }
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
  /** Neither the backend nor the chain has answered for a while, so what's on screen is out of date. */
  readonly lost: boolean;
  /** Asks a watcher to connect a wallet, while it's waiting for an answer. */
  readonly accountPrompt: AccountPrompt | null;
  /** The clock the rules run on. Screens must not count down from the local clock. */
  nowMs(): number;
  /** Asks a watcher to connect a wallet. Rejects with an empty message if they back out. */
  ensureAccount(): Promise<void>;
  /** Fetches a room's details, if they aren't here yet. Resolves whether or not it exists. */
  loadGame(id: string): Promise<void>;
  /** Everything needed to recheck a round, or null if nobody has it. Throws if nodes can't be reached to say. */
  proofOf(id: string): Promise<RoundProof | null>;
  refreshBalances(): void;
  /** Leaves the wallet and goes back to watching. The game's key stays on the account unless `removeGameKey` ran first. */
  disconnectWallet(): Promise<void>;
  /** This browser holds the game's limited key, so moves can go through with no popup. */
  readonly hasGameKey: boolean;
  /** Asks the wallet to take the game's limited key off the account. False if there's no key here to remove. */
  removeGameKey(): Promise<boolean>;
  /** True once an account has been looked up and doesn't exist any more. False while nobody can say. */
  accountGone(account: string): boolean;
  /** Whether this wallet can ask the public faucet contract for coins right now. */
  readonly canAskFaucet: boolean;
  /** Asks the public faucet contract for coins, through the wallet. */
  askFaucet(): Promise<void>;
  /** False until the first read of who owns what has come back, or if it never has. */
  readonly deedsReady: boolean;
  /** Why the market can't be read right now, in words for the player. Empty when all is well. */
  readonly deedsError: string;
  /** Tries the market's reads again now. */
  reloadDeeds(): void;
  /** For a screen showing the market: reads whatever has got old. `openId` is an NFT whose history is on screen. */
  refreshDeeds(openId?: string): void;
  /** The market's latest news, newest first. Null if nobody can say, which isn't the same as nothing having happened. */
  readonly deedNews: DeedEvent[] | null;
  /** One NFT's history, newest first. Null if nobody can say. */
  deedHistory(id: string): DeedEvent[] | null;
  /** Coins the market is holding for this player, because paying them out once failed. */
  readonly marketClaim: number;
  /** Sends what the market is holding to the player's wallet. */
  claimFromMarket(): Promise<void>;
  /** Null unless the player's wallet can do it. */
  readonly canTransferDeeds: boolean;
  /** Ends any listing, since the market can't sell what its seller gave away. */
  transferDeed(id: string, to: string): Promise<void>;

  /** A first credit pays for the player's record out of itself, so this is what that adds, if they still need one. */
  readonly setupCost: number;

  /** The player's wallet has been read at least once, so a 0 from `walletOf` means 0. */
  readonly walletKnown: boolean;
  /** Coins outside the game. */
  walletOf(account: string): number;
  /** Deposited coins, free to spend or withdraw. */
  balanceOf(account: string): number;
  hostRecord(account: string): HostRecord;
  deedOf(id: string): Deed;
  seasonRanking(): { account: string; points: number }[];

  deposit(amount: number): Promise<void>;
  withdraw(amount: number): Promise<void>;
  /** Locks the hosting bond and resolves to the new game's id. `attach` comes from the wallet, for a balance that's short. */
  createGame(input: Omit<NewGameInput, 'host'>, attach?: number): Promise<string>;
  /** Locks the entry fee. `attach` comes from the wallet, and anything over the fee stays in the game balance. */
  join(gameId: string, attach?: number): Promise<void>;
  /** Before the start only. The fee comes back. */
  leave(gameId: string): Promise<void>;
  /** Host only, once the minimum is reached. */
  start(gameId: string): Promise<void>;
  /** A roll is locked and its clue is seconds away, and until it lands the contract turns digs away. */
  clueArriving(gameId: string): boolean;
  /** `seenClue` is how many clues the player could see, so a new clue can't quietly cost them bonus. */
  dig(gameId: string, spot: Point, seenClue: number): Promise<void>;
  /** The first owner pays the project the mint price out of the game balance. `attach` comes from the wallet, for a balance that's short. */
  mintDeed(id: string, attach?: number): Promise<void>;
  /** Buys a listed NFT from its owner's listing, paid from the wallet with the seller paid to theirs. `seenPrice` is the price the buyer agreed to. */
  buyDeed(id: string, seenPrice: number): Promise<void>;
  /** Puts an NFT the player owns on the market. */
  listDeed(id: string, price: number): Promise<void>;
  /** A new price for the player's own listing. */
  changeDeedPrice(id: string, price: number): Promise<void>;
  /** Takes the player's own listing off the market. The NFT stays theirs. */
  delistDeed(id: string): Promise<void>;
}

export type AccountPrompt = {
  /** Why the last try failed, in words for the player. */
  error: string;
  /** The wallet's own windows are up. A modal dialog would block them, so this one steps aside. */
  busy: boolean;
  /** Signed in, but the wallet skipped the game's key, so every move would ask for an approval. */
  noKey: boolean;
  connect(): void;
  /** Keep this wallet, popups and all. */
  carryOn(): void;
  /** Sign out of the wallet that skipped the key, and choose again. */
  chooseAgain(): void;
  cancel(): void;
};
