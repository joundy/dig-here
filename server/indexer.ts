import type { Config } from './config.ts';
import type { Db } from './db.ts';
import { errorText, log, sleep } from './log.ts';
import { fastnearAuth } from './rpc.ts';

const LOOP_MS = 5000;
const RATE_LIMIT_WAIT_MS = 15_000;
// Receipts land a few blocks after their transaction, so a recent transaction may still be growing.
const SETTLED_AFTER_MS = 30_000;
const OVERLAP_BLOCKS = 300;
const HASHES_PER_CALL = 20;

export type ParsedEvent = {
  receipt_id: string;
  log_index: number;
  outcome_index: number;
  block_height: number;
  block_ms: number;
  tx_hash: string;
  standard: string;
  event: string;
  room_id: number | null;
  data: any;
};

/** Pulls our contracts' events out of one transaction. A failed receipt's logs never happened. */
export function eventsOfTransaction(tx: any, contracts: string | string[]): ParsedEvent[] {
  const ours = new Set(typeof contracts === 'string' ? [contracts] : contracts);
  const out: ParsedEvent[] = [];
  const hash = tx.transaction?.hash ?? tx.execution_outcome?.id;
  for (const entry of tx.receipts ?? []) {
    const exec = entry.execution_outcome;
    const outcome = exec?.outcome;
    if (!outcome || !ours.has(outcome.executor_id) || 'Failure' in (outcome.status ?? {})) continue;
    (outcome.logs ?? []).forEach((line: string, log_index: number) => {
      if (!line.startsWith('EVENT_JSON:')) return;
      let parsed: any;
      try {
        parsed = JSON.parse(line.slice('EVENT_JSON:'.length));
      } catch {
        return;
      }
      const data = parsed.data;
      const single = Array.isArray(data) ? data[0] : data;
      out.push({
        receipt_id: exec.id,
        log_index,
        outcome_index: exec.index ?? 0,
        block_height: exec.block_height,
        block_ms: Math.floor(Number(exec.block_timestamp) / 1e6),
        tx_hash: hash,
        standard: parsed.standard,
        event: parsed.event,
        room_id: typeof single?.room_id === 'number' ? single.room_id : null,
        data,
      });
    });
  }
  return out;
}

/** Returns how many rows were new, since a reread of the overlap repeats most of them. */
export function storeEvents(db: Db, events: ParsedEvent[]): number {
  let added = 0;
  const insert = db.prepare(`INSERT OR IGNORE INTO events(receipt_id, log_index, outcome_index, block_height, block_ms, tx_hash, standard, event, room_id, data)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`);
  const game = db.prepare('INSERT OR REPLACE INTO games(room_id, status, ended_ms, block_height) VALUES (?, ?, ?, ?)');
  const player = db.prepare('INSERT OR IGNORE INTO player_games(account, room_id) VALUES (?, ?)');
  db.exec('BEGIN');
  try {
    for (const e of events) {
      added += Number(insert.run(e.receipt_id, e.log_index, e.outcome_index, e.block_height, e.block_ms, e.tx_hash, e.standard, e.event, e.room_id, JSON.stringify(e.data)).changes);
      if (e.event === 'finished' || e.event === 'refunded') {
        game.run(e.room_id, e.event, e.data.ended_ms, e.block_height);
        for (const account of new Set<string>([...e.data.players, e.data.host])) player.run(account, e.room_id);
      }
    }
    db.exec('COMMIT');
  } catch (e) {
    db.exec('ROLLBACK');
    throw e;
  }
  return added;
}

export class Indexer {
  readonly #config: Config;
  readonly #db: Db;
  readonly #accounts: string[];
  readonly #heights = new Map<string, number>();
  lastError: string | null = null;

  constructor(config: Config, db: Db) {
    this.#config = config;
    this.#db = db;
    this.#accounts = [config.contract, ...(config.marketContract ? [config.marketContract] : [])];
    // The game contract's progress lived in `cursor` before there was a second contract.
    const old = db.prepare('SELECT height FROM cursor WHERE id = 1').get() as { height: number } | undefined;
    if (old) this.#heights.set(config.contract, old.height);
    for (const row of db.prepare('SELECT account, height FROM account_cursors').all() as Array<{ account: string; height: number }>) this.#heights.set(row.account, row.height);
  }

  /** How far the game contract is read, which is what a round's history depends on. */
  get height(): number {
    return this.#heights.get(this.#config.contract) ?? 0;
  }

  async run(): Promise<never> {
    for (;;) {
      try {
        await this.syncOnce();
        this.lastError = null;
        await sleep(LOOP_MS);
      } catch (e) {
        this.lastError = errorText(e);
        log('indexer', `sync failed: ${this.lastError}`);
        await sleep(/429/.test(this.lastError) ? RATE_LIMIT_WAIT_MS : LOOP_MS);
      }
    }
  }

  async #post(path: string, body: unknown): Promise<any> {
    const res = await fetch(`${this.#config.txApi}${path}`, {
      method: 'POST',
      // TX_API can point elsewhere in tests, and the key is only for FastNEAR.
      headers: { 'content-type': 'application/json', ...(this.#config.txApi.includes('.fastnear.com') ? fastnearAuth() : {}) },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(20_000),
    });
    if (!res.ok) throw new Error(`${path}: HTTP ${res.status}`);
    return res.json();
  }

  async syncOnce(): Promise<number> {
    let stored = 0;
    for (const account of this.#accounts) stored += await this.#syncAccount(account);
    return stored;
  }

  /**
   * Rereading the overlap is harmless because the event key makes every row unique. A listing or a sale touches both
   * contracts, so each read keeps both contracts' events. The "done" marks are per contract, because a transaction this
   * read before it knew about the market still holds market events to collect.
   */
  async #syncAccount(account: string): Promise<number> {
    const db = this.#db;
    let stored = 0;
    let resume: string | undefined;
    const markOf = (hash: string) => (account === this.#config.contract ? hash : `${account}:${hash}`);
    const known = db.prepare('SELECT 1 FROM indexed_txs WHERE hash = ?');
    const mark = db.prepare('INSERT OR IGNORE INTO indexed_txs(hash) VALUES (?)');
    const start = this.#heights.get(account) ?? 0;
    let highest = start;
    do {
      const page = await this.#post('/v0/account', {
        account_id: account,
        is_real_receiver: true,
        from_tx_block_height: Math.max(0, start - OVERLAP_BLOCKS),
        desc: false,
        limit: 200,
        ...(resume ? { resume_token: resume } : {}),
      });
      const rows = (page.account_txs ?? []) as Array<{ transaction_hash: string; tx_block_height: number; tx_block_timestamp: string }>;
      const fresh = rows.filter((r) => !known.get(markOf(r.transaction_hash)));
      for (let i = 0; i < fresh.length; i += HASHES_PER_CALL) {
        const batch = fresh.slice(i, i + HASHES_PER_CALL);
        const { transactions } = await this.#post('/v0/transactions', { tx_hashes: batch.map((r) => r.transaction_hash) });
        const events = (transactions ?? []).flatMap((tx: any) => eventsOfTransaction(tx, this.#accounts));
        stored += storeEvents(db, events);
        const now = Date.now();
        for (const r of batch) {
          if (now - Number(r.tx_block_timestamp) / 1e6 > SETTLED_AFTER_MS) mark.run(markOf(r.transaction_hash));
        }
      }
      for (const r of rows) highest = Math.max(highest, r.tx_block_height);
      resume = rows.length ? page.resume_token : undefined;
    } while (resume);
    if (highest !== start) {
      db.prepare('INSERT INTO account_cursors(account, height) VALUES (?, ?) ON CONFLICT(account) DO UPDATE SET height = excluded.height').run(account, highest);
      this.#heights.set(account, highest);
    }
    if (stored) log('indexer', `stored ${stored} events from ${account} up to block ${highest}`);
    return stored;
  }
}
