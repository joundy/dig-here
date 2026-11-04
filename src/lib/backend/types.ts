import type { Game, Point } from '../game/types';

/**
 * Everything the UI needs from "the chain". The dummy implements it in memory; a NEAR
 * version implements the same shape with a wallet and contract calls, and the UI stays put.
 */
export interface GameBackend {
  readonly account: string;
  readonly games: Game[];
  balanceOf(account: string): number;
  /** Resolves to the new game's id. */
  createGame(input: { name: string; fee: number; durationSec: number; hostCutBps: number }): Promise<string>;
  /** Pays the entry fee and locks in the current account's dig. */
  dig(gameId: string, spot: Point): Promise<void>;
}
