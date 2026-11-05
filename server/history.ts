import type { Db } from './db.ts';
import { sendJson, type App } from './http.ts';
import type { Indexer } from './indexer.ts';

const MAX_LIMIT = 100;
/** NEAR's own longest account name, and our longest token id is far shorter. */
const MAX_NAME = 64;

/** A page marker, which is only ever a positive whole number. Anything else means from the start. */
function beforeOf(url: URL): number {
  const n = Number(url.searchParams.get('before'));
  return Number.isSafeInteger(n) && n > 0 ? n : Number.MAX_SAFE_INTEGER;
}

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
  // Balance rows name no room, but the receipt that settled it wrote them, and they show who was actually paid.
  const rows = db.prepare(`SELECT * FROM events WHERE room_id = ?
    OR (event = 'balance' AND receipt_id IN (SELECT receipt_id FROM events WHERE room_id = ?))
    ORDER BY block_height, outcome_index, log_index, seq`).all(roomId, roomId);
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

const YOCTO_PER_MILLI = 10n ** 21n;
/** The game contract priced in milliNEAR before the market took over selling. Everything here is a yocto string. */
const yoctoOf = (price: unknown) => (typeof price === 'number' ? (BigInt(price) * YOCTO_PER_MILLI).toString() : typeof price === 'string' ? price : null);

const ACTIVITY_EVENTS = ['nft_minted', 'nft_listed', 'nft_price_changed', 'nft_delisted', 'nft_sold', 'nft_sale_failed', 'nft_listing_cancelled', 'nft_transfer'];
const TOKEN_OF = `CASE WHEN event = 'nft_transfer' THEN json_extract(data, '$[0].token_ids[0]') ELSE json_extract(data, '$.token_id') END`;
// A sale's own token move is the sale. Showing it twice would read as two things happening.
const ACTIVITY_WHERE = `event IN (${ACTIVITY_EVENTS.map((e) => `'${e}'`).join(', ')})
  AND NOT (event = 'nft_transfer' AND tx_hash IN (SELECT tx_hash FROM events WHERE event = 'nft_sold'))`;

/** One row for the market's activity list, whichever contract and standard it came from. */
export function activityRow(r: any) {
  const d = JSON.parse(r.data);
  const base = { seq: r.seq, block_ms: r.block_ms, block_height: r.block_height, tx_hash: r.tx_hash };
  const row = (kind: string, token_id: string, seller: string | null, buyer: string | null, price: unknown) => ({ ...base, kind, token_id, seller, buyer, price: yoctoOf(price) });
  switch (r.event) {
    case 'nft_minted':
      return row('minted', d.token_id, null, d.owner, d.price);
    case 'nft_listed':
      // The old game contract said a delisting this way, with no price.
      if (r.standard === 'dig-here' && d.price === null) return row('delisted', d.token_id, d.owner, null, null);
      return row('listed', d.token_id, d.seller ?? d.owner, null, d.price);
    case 'nft_price_changed':
      return row('price_changed', d.token_id, d.seller, null, d.price);
    case 'nft_delisted':
      return row('delisted', d.token_id, d.seller, null, null);
    case 'nft_listing_cancelled':
      return row('delisted', d.token_id, null, null, null);
    case 'nft_sold':
      return row('sold', d.token_id, d.seller, d.buyer, d.price);
    case 'nft_sale_failed':
      return row('sale_failed', d.token_id, d.seller, d.buyer, d.refund);
    default:
      return row('transferred', d[0].token_ids[0], d[0].old_owner_id, d[0].new_owner_id, null);
  }
}

/** `seq` only says when the indexer stored a row, and it reads transactions in no fixed order, so time comes from the block. */
function activity(db: Db, url: URL, filter: string, ...params: Array<string | number>) {
  const before = beforeOf(url);
  const paged = before < Number.MAX_SAFE_INTEGER;
  const page = paged ? 'AND (block_height, seq) < (SELECT block_height, seq FROM events WHERE seq = ?)' : '';
  const rows = db.prepare(`SELECT * FROM events WHERE ${ACTIVITY_WHERE} ${page} ${filter} ORDER BY block_height DESC, seq DESC LIMIT ?`).all(...(paged ? [before] : []), ...params, limitOf(url, 30));
  return rows.map(activityRow);
}

const TRADER_FILTER = `AND ? IN (json_extract(data, '$.seller'), json_extract(data, '$.buyer'), json_extract(data, '$.owner'),
  json_extract(data, '$[0].old_owner_id'), json_extract(data, '$[0].new_owner_id'))`;

/** Why a round's deed share went where it did: how the NFT reached its owner, up to the settlement. */
export function deedActivity(db: Db, events: Array<{ event: string; block_height: number; data: any }>) {
  const finished = events.find((e) => e.event === 'finished');
  const token = finished?.data.deed?.token_id;
  if (!token) return [];
  const rows = db.prepare(`SELECT * FROM events WHERE ${ACTIVITY_WHERE} AND ${TOKEN_OF} = ? AND block_height <= ? ORDER BY block_height, seq`).all(token, finished!.block_height);
  return rows.map(activityRow);
}

function limitOf(url: URL, fallback: number): number {
  const n = Number(url.searchParams.get('limit') ?? fallback);
  return Number.isFinite(n) && n > 0 ? Math.min(Math.floor(n), MAX_LIMIT) : fallback;
}

export function addHistoryRoutes(app: App, db: Db, indexer: Indexer): void {
  app.route('GET', /^\/api\/finished-games$/, (req, res, _p, url) => {
    const rows = db.prepare('SELECT room_id FROM games WHERE room_id < ? ORDER BY room_id DESC LIMIT ?').all(beforeOf(url), limitOf(url, 30)) as Array<{ room_id: number }>;
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
      deed_activity: deedActivity(db, events),
    });
  });

  app.route('GET', /^\/api\/players\/([^/]+)\/history$/, (req, res, params, url) => {
    const account = params[0];
    if (account.length > MAX_NAME) return sendJson(req, res, 400, { error: 'That is not an account name.' });
    const rows = db.prepare('SELECT room_id FROM player_games WHERE account = ? AND room_id < ? ORDER BY room_id DESC LIMIT ?').all(account, beforeOf(url), limitOf(url, 30)) as Array<{ room_id: number }>;
    sendJson(req, res, 200, {
      account,
      games: rows.map((r) => playerGame(db, account, r.room_id)).filter(Boolean),
      trades: activity(db, new URL(url.pathname, url), TRADER_FILTER, account),
      indexed_to: indexer.height,
    });
  });

  app.route('GET', /^\/api\/market-activity$/, (req, res, _p, url) => {
    sendJson(req, res, 200, { activity: activity(db, url, ''), indexed_to: indexer.height });
  });

  app.route('GET', /^\/api\/nfts\/([^/]+)\/activity$/, (req, res, params, url) => {
    if (params[0].length > MAX_NAME) return sendJson(req, res, 400, { error: 'That is not an NFT.' });
    sendJson(req, res, 200, { activity: activity(db, url, `AND ${TOKEN_OF} = ?`, params[0]), indexed_to: indexer.height });
  });
}
