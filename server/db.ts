import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { DatabaseSync } from 'node:sqlite';

export type Db = DatabaseSync;

/** Events can all be rebuilt from the chain. Guests and the coin ledger can't, so back those up if they ever matter. */
export function openDb(path: string): Db {
  if (path !== ':memory:') mkdirSync(dirname(path), { recursive: true });
  const db = new DatabaseSync(path);
  db.exec(`
    PRAGMA journal_mode = WAL;
    PRAGMA synchronous = NORMAL;
    PRAGMA busy_timeout = 2000;

    CREATE TABLE IF NOT EXISTS cursor(id INTEGER PRIMARY KEY CHECK(id = 1), height INTEGER NOT NULL);
    CREATE TABLE IF NOT EXISTS indexed_txs(hash TEXT PRIMARY KEY) WITHOUT ROWID;
    CREATE TABLE IF NOT EXISTS events(
      seq INTEGER PRIMARY KEY AUTOINCREMENT,
      receipt_id TEXT NOT NULL, log_index INTEGER NOT NULL, outcome_index INTEGER NOT NULL DEFAULT 0,
      block_height INTEGER NOT NULL, block_ms INTEGER, tx_hash TEXT NOT NULL,
      standard TEXT NOT NULL, event TEXT NOT NULL, room_id INTEGER, data TEXT NOT NULL,
      UNIQUE(receipt_id, log_index));
    CREATE INDEX IF NOT EXISTS events_by_room ON events(room_id, block_height, seq);
    CREATE INDEX IF NOT EXISTS events_by_kind ON events(event, block_height);
    CREATE TABLE IF NOT EXISTS games(room_id INTEGER PRIMARY KEY, status TEXT NOT NULL, ended_ms INTEGER NOT NULL, block_height INTEGER NOT NULL);
    CREATE TABLE IF NOT EXISTS player_games(account TEXT NOT NULL, room_id INTEGER NOT NULL, PRIMARY KEY(account, room_id));
    CREATE TABLE IF NOT EXISTS player_activity(account TEXT PRIMARY KEY, last_ms INTEGER NOT NULL);

    CREATE TABLE IF NOT EXISTS guests(
      public_key TEXT PRIMARY KEY, account_id TEXT NOT NULL, ip_hash TEXT NOT NULL, created_ms INTEGER NOT NULL,
      created_ok INTEGER NOT NULL DEFAULT 0, credit_ok INTEGER NOT NULL DEFAULT 0, swept_ms INTEGER);
    CREATE INDEX IF NOT EXISTS guests_by_ip ON guests(ip_hash, created_ms);

    CREATE TABLE IF NOT EXISTS ledger(id INTEGER PRIMARY KEY AUTOINCREMENT, at_ms INTEGER NOT NULL, kind TEXT NOT NULL, account TEXT NOT NULL, yocto TEXT NOT NULL);
  `);
  return db;
}

/** Everything sent from the root for one purpose, so a hard budget survives a restart. */
export function ledgerTotal(db: Db, kind: string): bigint {
  const rows = db.prepare('SELECT yocto FROM ledger WHERE kind = ?').all(kind) as Array<{ yocto: string }>;
  return rows.reduce((sum, r) => sum + BigInt(r.yocto), 0n);
}

export function ledgerAdd(db: Db, kind: string, account: string, yocto: bigint): void {
  db.prepare('INSERT INTO ledger(at_ms, kind, account, yocto) VALUES (?, ?, ?, ?)').run(Date.now(), kind, account, yocto.toString());
}
