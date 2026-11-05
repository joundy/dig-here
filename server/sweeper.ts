import { actions } from 'near-api-js';
import type { Config } from './config.ts';
import type { Db } from './db.ts';
import { sweepKeyFor } from './guests.ts';
import type { LiveState } from './live.ts';
import { errorText, log } from './log.ts';
import { viewAccessKey, viewAccount, viewFunction } from './rpc.ts';
import { NearAccount } from './signer.ts';
import { near, toNear } from './units.ts';

const SWEEP_EVERY_MS = 600_000;
const MAX_PER_RUN = 10;
const DELETE_GAS_RESERVE = near('0.002');

export type SweepResult = { account_id: string; game_coins: string; wallet_coins: string };

export class Sweeper {
  readonly #config: Config;
  readonly #db: Db;
  readonly #state: LiveState;
  readonly #indexerFresh: () => boolean;

  constructor(config: Config, db: Db, state: LiveState, indexerFresh: () => boolean) {
    this.#config = config;
    this.#db = db;
    this.#state = state;
    this.#indexerFresh = indexerFresh;
  }

  start(): void {
    setInterval(() => void this.sweepIdle().catch((e) => log('sweeper', `run failed: ${errorText(e)}`)), SWEEP_EVERY_MS).unref();
  }

  /** A guest's room holds its coins until it ends, and a deleted account can't collect them. */
  #busyAccounts(): Set<string> {
    const busy = new Set<string>();
    for (const room of this.#state.current?.frame.live.rooms ?? []) {
      busy.add(room.host);
      for (const player of room.players) busy.add(player);
    }
    return busy;
  }

  idleGuests(nowMs = Date.now()): string[] {
    const cutoff = nowMs - this.#config.guestIdleHours * 3_600_000;
    const rows = this.#db.prepare(`
      SELECT g.account_id FROM guests g LEFT JOIN player_activity a ON a.account = g.account_id
      WHERE g.swept_ms IS NULL AND g.created_ok = 1 AND g.created_ms < ? AND COALESCE(a.last_ms, 0) < ?
      ORDER BY g.created_ms LIMIT ?`).all(cutoff, cutoff, MAX_PER_RUN * 3) as Array<{ account_id: string }>;
    const busy = this.#busyAccounts();
    return rows.map((r) => r.account_id).filter((id) => !busy.has(id)).slice(0, MAX_PER_RUN);
  }

  async sweepIdle(): Promise<void> {
    if (!this.#state.current) return;
    // A guest's activity comes from the indexer, so while it's behind an active guest looks idle.
    if (!this.#indexerFresh()) return log('sweeper', 'indexer is behind, skipping this run');
    for (const id of this.idleGuests()) {
      try {
        const result = await this.sweep(id);
        if (result) log('sweeper', `reclaimed ${id}`, result);
      } catch (e) {
        log('sweeper', `${id}: ${errorText(e)}`);
      }
    }
  }

  /**
   * Withdraw, wait for final, send the coins home, then delete in a separate transaction, as the research says:
   * NEAR's docs warn against delete in place of transfer, and a refund to a deleted account is burned.
   */
  async sweep(accountId: string): Promise<SweepResult | null> {
    const { contract, rootAccount } = this.#config;
    const key = sweepKeyFor(this.#config, accountId);
    const onChain = await viewAccount(accountId);
    if (!onChain || !(await viewAccessKey(accountId, key.getPublicKey().toString(), 'final'))) {
      this.#markSwept(accountId);
      return null;
    }
    if (this.#busyAccounts().has(accountId)) return null;
    const nfts = await viewFunction<any[]>(contract, 'get_nfts', { from: 0, limit: 36 });
    // An NFT on a deleted account could never be sold or moved again, so its owner stays.
    if (nfts.some((n) => n.owner === accountId)) return null;

    const signer = new NearAccount(accountId, 'sweeper', [key]);
    const record = await viewFunction<any>(contract, 'get_account', { id: accountId });
    const gameCoins = BigInt(record?.balance ?? 0);
    if (gameCoins > 0n) {
      const withdrawn = await signer.call(contract, 'withdraw', { amount: gameCoins.toString() }, 10, 1n, { wait: 'FINAL' });
      if (!withdrawn.ok || withdrawn.value === false) throw new Error(`withdraw failed: ${withdrawn.failure ?? 'transfer refused'}`);
    }
    const wallet = BigInt((await viewAccount(accountId))?.amount ?? 0);
    if (wallet > DELETE_GAS_RESERVE) {
      const sent = await signer.transfer(rootAccount, wallet - DELETE_GAS_RESERVE, { wait: 'FINAL' });
      if (!sent.ok) throw new Error(`transfer failed: ${sent.failure}`);
    }
    const deleted = await signer.send(accountId, [actions.deleteAccount(rootAccount)], { wait: 'FINAL' });
    if (!deleted.ok) throw new Error(`delete failed: ${deleted.failure}`);
    this.#markSwept(accountId);
    return { account_id: accountId, game_coins: toNear(gameCoins), wallet_coins: toNear(wallet) };
  }

  #markSwept(accountId: string): void {
    this.#db.prepare('UPDATE guests SET swept_ms = ? WHERE account_id = ?').run(Date.now(), accountId);
  }
}
