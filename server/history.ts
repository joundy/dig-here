import type { Db } from './db.ts';
import { sendJson, type App } from './http.ts';
import type { Indexer } from './indexer.ts';

const MAX_LIMIT = 100;

const eventRow = (r: any) => ({
  event: r.event,
  standard: r.standard,
  block_height: r.block_height,
  block_ms: r.block_ms,
  tx_hash: r.tx_hash,
  receipt_id: r.receipt_id,
  data: JSON.parse(r.data),
});

export function roomEvents(db: Db, roomId: number) {
  const rows = db.prepare('SELECT * FROM events WHERE room_id = ? ORDER BY block_height, outcome_index, log_index, seq').all(roomId);
  return rows.map(eventRow);
}

/** The same fields as the contract's get_recent_finished, plus whatever the events add. */
function gameSummary(db: Db, roomId: number) {
  const created = db.prepare("SELECT data FROM events WHERE room_id = ? AND event = 'room_created' LIMIT 1").get(roomId) as { data: string } | undefined;
  const end = db.prepare("SELECT * FROM events WHERE room_id = ? AND event IN ('finished', 'refunded') ORDER BY seq DESC LIMIT 1").get(roomId) as any;
  if (!end) return null;
  const c = created ? JSON.parse(created.data) : {};
  const e = JSON.parse(end.data);
  const digs = (db.prepare("SELECT COUNT(*) n FROM events WHERE room_id = ? AND event = 'dig'").get(roomId) as { n: number }).n;
  return {
    room_id: roomId,
    name: c.name ?? null,
    host: e.host,
    map: c.map ?? e.map ?? null,
    fee: e.fee,
    pot: e.pot,
    players: e.players.length,
    digs,
    status: end.event,
    ended_ms: e.ended_ms,
    refund_reason: e.reason ?? null,
    treasure: e.treasure ?? null,
    winner: e.winner ?? null,
    block_height: end.block_height,
    receipt_id: end.receipt_id,
  };
}

function playerGame(db: Db, account: string, roomId: number) {
  const summary = gameSummary(db, roomId);
  if (!summary) return null;
  const end = db.prepare("SELECT data FROM events WHERE room_id = ? AND event IN ('finished', 'refunded') ORDER BY seq DESC LIMIT 1").get(roomId) as { data: string };
  const data = JSON.parse(end.data);
  const place = (data.ranking ?? []).findIndex((r: any) => r.account === account);
  const myDig = db.prepare("SELECT data FROM events WHERE room_id = ? AND event = 'dig' AND json_extract(data, '$.account') = ? LIMIT 1").get(roomId, account) as { data: string } | undefined;
  const balance = db.prepare("SELECT data FROM events WHERE receipt_id = ? AND event = 'balance' LIMIT 1").get(summary.receipt_id) as { data: string } | undefined;
  const credited = balance
    ? JSON.parse(balance.data).changes.filter((c: any) => c.account === account).reduce((sum: bigint, c: any) => sum + BigInt(c.delta), 0n)
    : 0n;
  return {
    ...summary,
    is_host: data.host === account,
    played: data.players.includes(account),
    place: place >= 0 ? place + 1 : null,
    result: place >= 0 ? data.ranking[place] : null,
    dig: myDig ? JSON.parse(myDig.data) : null,
    credited: credited.toString(),
  };
}

function limitOf(url: URL, fallback: number): number {
  const n = Number(url.searchParams.get('limit') ?? fallback);
  return Number.isFinite(n) && n > 0 ? Math.min(Math.floor(n), MAX_LIMIT) : fallback;
}

export function addHistoryRoutes(app: App, db: Db, indexer: Indexer): void {
  app.route('GET', /^\/api\/finished-games$/, (req, res, _p, url) => {
    const before = Number(url.searchParams.get('before') ?? Number.MAX_SAFE_INTEGER);
    const rows = db.prepare('SELECT room_id FROM games WHERE room_id < ? ORDER BY room_id DESC LIMIT ?').all(before, limitOf(url, 30)) as Array<{ room_id: number }>;
    sendJson(req, res, 200, { games: rows.map((r) => gameSummary(db, r.room_id)).filter(Boolean), indexed_to: indexer.height });
  });

  app.route('GET', /^\/api\/games\/(\d+)\/proof$/, (req, res, params) => {
    const roomId = Number(params[0]);
    const events = roomEvents(db, roomId);
    if (!events.length) return sendJson(req, res, 404, { error: 'No record of this game yet.', indexed_to: indexer.height });
    const has = (name: string) => events.some((e) => e.event === name);
    sendJson(req, res, 200, {
      room_id: roomId,
      // Open rooms have a partial proof, which is still worth showing.
      complete: has('room_created') && (has('finished') || has('refunded')),
      indexed_to: indexer.height,
      events,
    });
  });

  app.route('GET', /^\/api\/players\/([^/]+)\/history$/, (req, res, params, url) => {
    const account = params[0];
    const before = Number(url.searchParams.get('before') ?? Number.MAX_SAFE_INTEGER);
    const rows = db.prepare('SELECT room_id FROM player_games WHERE account = ? AND room_id < ? ORDER BY room_id DESC LIMIT ?').all(account, before, limitOf(url, 30)) as Array<{ room_id: number }>;
    sendJson(req, res, 200, { account, games: rows.map((r) => playerGame(db, account, r.room_id)).filter(Boolean), indexed_to: indexer.height });
  });
}
