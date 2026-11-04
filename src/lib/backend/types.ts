import type { Deed, HostRecord, Season } from '../game/economy';
import type { Game, NewGameInput, Point } from '../game/types';

/**
 * Everything the UI needs from "the chain". The dummy implements it in memory; a NEAR
 * version implements the same shape with a wallet and contract calls, and the UI stays put.
 */
export interface GameBackend {
  readonly account: string;
  readonly games: Game[];
  readonly jackpot: number;
  readonly season: Season;
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
  /** `seenClue` is how many clues the player could see, so a new clue can't quietly cost them bonus. */
  dig(gameId: string, spot: Point, seenClue: number): Promise<void>;
  /** `seenPrice` is the price the buyer agreed to. */
  buyDeed(id: string, seenPrice: number): Promise<void>;
  /** A null price takes it off the market. */
  listDeed(id: string, price: number | null): Promise<void>;
}
