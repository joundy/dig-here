import assert from 'node:assert/strict';
import { test } from 'node:test';
import { openDb } from './db.ts';
import { App } from './http.ts';
import { addHistoryRoutes, deedActivity, roomEvents } from './history.ts';
import { eventsOfTransaction, Indexer, storeEvents } from './indexer.ts';
import { etagOf } from './live.ts';

const CONTRACT = 'v1.test';
const log = (event: string, data: object) => `EVENT_JSON:${JSON.stringify({ standard: 'dig-here', version: '1.0.0', event, data })}`;
const receipt = (id: string, height: number, logs: string[], status: object = { SuccessValue: '' }, executor = CONTRACT) => ({
  execution_outcome: { id, index: 0, block_height: height, block_timestamp: height * 1e6, outcome: { executor_id: executor, logs, status } },
});
const tx = (hash: string, receipts: object[]) => ({ transaction: { hash }, receipts });

test('only our contract\'s successful receipts count', () => {
  const events = eventsOfTransaction(
    tx('T', [
      receipt('a', 10, [log('joined', { room_id: 1, account: 'p', players: 1 }), 'plain log']),
      receipt('b', 11, [log('joined', { room_id: 1, account: 'q', players: 2 })], { Failure: {} }),
      receipt('c', 11, [log('joined', { room_id: 1, account: 'r', players: 2 })], { SuccessValue: '' }, 'other.test'),
    ]),
    CONTRACT,
  );
  assert.equal(events.length, 1);
  assert.equal(events[0].data.account, 'p');
  assert.equal(events[0].room_id, 1);
});

function seededDb() {
  const db = openDb(':memory:');
  const all = eventsOfTransaction(
    tx('T', [
      receipt('a', 10, [log('room_created', { room_id: 5, name: 'R', host: 'h', map: 'snowy' })]),
      receipt('b', 12, [log('joined', { room_id: 5, account: 'p', players: 1 })]),
      receipt('c', 14, [log('dig', { room_id: 5, account: 'p', x: 1, y: 2, clue_index: 0, dug_at_ms: 99 })]),
      receipt('d', 16, [
        log('finished', { room_id: 5, host: 'h', players: ['p'], fee: 10, pot: 10, winner: 'p', treasure: { x: 1, y: 2, landmark_id: 0 }, ranking: [{ account: 'p', score: 500 }], ended_ms: 123 }),
        log('balance', { changes: [{ account: 'p', delta: '9000000000000000000000', balance: '9000000000000000000000', reason: 'prize' }] }),
      ]),
    ]),
    CONTRACT,
  );
  return { db, all };
}

test('rereading the same events adds nothing', () => {
  const { db, all } = seededDb();
  assert.equal(storeEvents(db, all), 5);
  assert.equal(storeEvents(db, all), 0);
  assert.deepEqual(roomEvents(db, 5).map((e) => e.event), ['room_created', 'joined', 'dig', 'finished', 'balance']);
  assert.equal(roomEvents(db, 5)[3].data.winner, 'p');
});

test('the history routes answer from stored events', async () => {
  const { db, all } = seededDb();
  storeEvents(db, all);
  const app = new App();
  addHistoryRoutes(app, db, { height: 16 } as Indexer);
  const server = await app.listen(0);
  const port = (server.address() as { port: number }).port;
  try {
    const get = async (path: string) => (await fetch(`http://localhost:${port}${path}`)).json() as Promise<any>;
    const { games } = await get('/api/finished-games?limit=5');
    assert.equal(games.length, 1);
    assert.equal(games[0].name, 'R');
    assert.equal(games[0].digs, 1);
    assert.equal((await get('/api/finished-games?before=5')).games.length, 0);

    const proof = await get('/api/games/5/proof');
    assert.equal(proof.complete, true);
    assert.equal(proof.events.length, 5);
    assert.equal((await fetch(`http://localhost:${port}/api/games/99/proof`)).status, 404);

    const history = await get('/api/players/p/history');
    assert.equal(history.games[0].place, 1);
    assert.equal(history.games[0].credited, '9000000000000000000000');
    assert.equal((await fetch(`http://localhost:${port}/api/nope`)).status, 404);
  } finally {
    server.close();
  }
});

test('the etag ignores the clock but not the game', () => {
  const base = { version: 3, now_ms: 1, commitments_left: 5, missed_reveals: 0, jackpot: 0, season: { number: 1 } };
  assert.equal(etagOf(base), etagOf({ ...base, now_ms: 999 }));
  assert.notEqual(etagOf(base), etagOf({ ...base, version: 4 }));
  assert.notEqual(etagOf(base), etagOf({ ...base, commitments_left: 6 }));
});

const MARKET = 'market.test';
const marketLog = (event: string, data: object) => `EVENT_JSON:${JSON.stringify({ standard: 'dig-here-market', version: '1.0.0', event, data })}`;
const nep171 = (event: string, data: object) => `EVENT_JSON:${JSON.stringify({ standard: 'nep171', version: '1.0.0', event, data: [data] })}`;
const PRICE = '1000000000000000000000000';

function marketHistory() {
  return [
    tx('MINT', [receipt('m1', 100, [log('nft_minted', { token_id: 'snowy:penguin', owner: 'alice', price: 500, treasury: 't', treasury_received: '1', storage_cost: '1' })])]),
    // The old game contract's own listing and sale, priced in milliNEAR.
    tx('OLDLIST', [receipt('o1', 101, [log('nft_listed', { token_id: 'snowy:penguin', owner: 'alice', price: 700 })])]),
    tx('OLDOFF', [receipt('o2', 102, [log('nft_listed', { token_id: 'snowy:penguin', owner: 'alice', price: null })])]),
    tx('OLDSALE', [receipt('o3', 103, [log('nft_sold', { token_id: 'tropical:cow', seller: 'zed', buyer: 'yan', price: 900 }), nep171('nft_transfer', { old_owner_id: 'zed', new_owner_id: 'yan', token_ids: ['tropical:cow'] })])]),
    tx('LIST', [
      receipt('l1', 110, []),
      receipt('l2', 111, [marketLog('nft_listed', { token_id: 'snowy:penguin', seller: 'alice', price: PRICE, approval_id: 1, replaced: false })], { SuccessValue: '' }, MARKET),
    ]),
    tx('CHANGE', [receipt('c1', 112, [marketLog('nft_price_changed', { token_id: 'snowy:penguin', seller: 'alice', old_price: PRICE, price: '2' })], { SuccessValue: '' }, MARKET)]),
    tx('BUY', [
      receipt('b1', 120, [], { SuccessValue: '' }, MARKET),
      receipt('b2', 121, [nep171('nft_transfer', { old_owner_id: 'alice', new_owner_id: 'bob', token_ids: ['snowy:penguin'], authorized_id: MARKET })]),
      receipt('b3', 122, [marketLog('nft_sold', { token_id: 'snowy:penguin', seller: 'alice', buyer: 'bob', price: '2', paid: '3', approval_id: 1 })], { SuccessValue: '' }, MARKET),
    ]),
    tx('FAILED', [
      receipt('f1', 130, [marketLog('nft_delisted', { token_id: 'desert:well', seller: 'carol', by: 'dan', reason: 'transfer_failed' }), marketLog('nft_sale_failed', { token_id: 'desert:well', seller: 'carol', buyer: 'dan', refund: '5' })], { SuccessValue: '' }, MARKET),
    ]),
    tx('GIVE', [receipt('g1', 140, [nep171('nft_transfer', { old_owner_id: 'bob', new_owner_id: 'carol', token_ids: ['snowy:penguin'] })])]),
    tx('ROOM', [
      receipt('r1', 150, [log('finished', { room_id: 9, host: 'h', players: ['p'], fee: 1, pot: 1, winner: 'p', treasure: { x: 1, y: 2, landmark_id: 0 }, ranking: [], ended_ms: 5, deed: { token_id: 'snowy:penguin', owner: 'carol', paid: 1, earned: 1, landings: 1 } })]),
    ]),
    tx('LATER', [receipt('z1', 160, [marketLog('nft_listed', { token_id: 'snowy:penguin', seller: 'carol', price: '9', approval_id: 2, replaced: false })], { SuccessValue: '' }, MARKET)]),
  ];
}

test('the market\'s events are read along with the game\'s, and only theirs', () => {
  const [, , , , list] = marketHistory();
  const both = eventsOfTransaction(list, [CONTRACT, MARKET]);
  assert.deepEqual(both.map((e) => e.standard), ['dig-here-market']);
  assert.equal(eventsOfTransaction(list, CONTRACT).length, 0);
  const failed = eventsOfTransaction(tx('T', [receipt('x', 1, [marketLog('nft_sold', { token_id: 'a' })], { Failure: {} }, MARKET)]), [CONTRACT, MARKET]);
  assert.equal(failed.length, 0, 'a failed receipt never happened');
});

test('activity covers every kind of move, in one price unit, newest first', async () => {
  const db = openDb(':memory:');
  storeEvents(db, marketHistory().flatMap((t) => eventsOfTransaction(t, [CONTRACT, MARKET])));
  const app = new App();
  addHistoryRoutes(app, db, { height: 200 } as Indexer);
  const server = await app.listen(0);
  const port = (server.address() as { port: number }).port;
  try {
    const get = async (path: string) => (await fetch(`http://localhost:${port}${path}`)).json() as Promise<any>;
    const { activity, indexed_to } = await get('/api/nfts/snowy:penguin/activity');
    assert.equal(indexed_to, 200);
    assert.deepEqual(activity.map((a: any) => a.kind), ['listed', 'transferred', 'sold', 'price_changed', 'listed', 'delisted', 'listed', 'minted']);
    const of = (kind: string) => activity.find((a: any) => a.kind === kind);
    assert.deepEqual([of('sold').seller, of('sold').buyer, of('sold').price], ['alice', 'bob', '2']);
    assert.equal(of('minted').price, '500000000000000000000000', 'the old contract\'s milliNEAR comes out in yocto');
    assert.deepEqual([of('transferred').seller, of('transferred').buyer, of('transferred').price], ['bob', 'carol', null]);
    assert.ok(activity.every((a: any) => a.tx_hash && a.token_id === 'snowy:penguin'));

    const encoded = await get('/api/nfts/snowy%3Apenguin/activity?limit=2');
    assert.equal(encoded.activity.length, 2);
    const older = await get(`/api/nfts/snowy:penguin/activity?before=${encoded.activity[1].seq}`);
    assert.equal(older.activity[0].kind, 'sold');

    const all = await get('/api/market-activity?limit=100');
    const oldSale = all.activity.find((a: any) => a.token_id === 'tropical:cow');
    assert.deepEqual([oldSale.kind, oldSale.price], ['sold', '900000000000000000000000']);
    assert.equal(all.activity.filter((a: any) => a.token_id === 'tropical:cow').length, 1, 'a sale\'s token move isn\'t a second row');
    assert.deepEqual(all.activity.filter((a: any) => a.token_id === 'desert:well').map((a: any) => a.kind).sort(), ['delisted', 'sale_failed']);

    const history = await get('/api/players/bob/history');
    assert.deepEqual(history.trades.map((t: any) => t.kind), ['transferred', 'sold']);

    const proof = await get('/api/games/9/proof');
    const deed = proof.deed_activity;
    assert.deepEqual(deed.map((a: any) => a.kind), ['minted', 'listed', 'delisted', 'listed', 'price_changed', 'sold', 'transferred'], 'how the owner came to hold it, and nothing after');
  } finally {
    server.close();
  }
});

test('deed activity is empty for a room with no deed', () => {
  const db = openDb(':memory:');
  assert.deepEqual(deedActivity(db, [{ event: 'refunded', block_height: 1, data: {} }]), []);
});

test('each contract has its own cursor, and the game keeps the one it had', async () => {
  const db = openDb(':memory:');
  db.prepare('INSERT INTO cursor(id, height) VALUES (1, 5000)').run();
  const asked: Array<{ account_id: string; from: number }> = [];
  const known = marketHistory();
  const server = (await import('node:http')).createServer(async (req, res) => {
    const chunks: Buffer[] = [];
    for await (const c of req) chunks.push(c as Buffer);
    const body = JSON.parse(Buffer.concat(chunks).toString());
    res.writeHead(200, { 'content-type': 'application/json' });
    if (req.url === '/v0/account') {
      asked.push({ account_id: body.account_id, from: body.from_tx_block_height });
      const rows = body.account_id === MARKET && !body.resume_token ? [{ transaction_hash: 'LIST', tx_block_height: 7000, tx_block_timestamp: '1000000' }] : [];
      return void res.end(JSON.stringify({ account_txs: rows, resume_token: rows.length ? 'more' : undefined }));
    }
    res.end(JSON.stringify({ transactions: body.tx_hashes.map((h: string) => known.find((t) => t.transaction.hash === h)) }));
  });
  await new Promise<void>((resolve) => server.listen(0, resolve));
  try {
    const port = (server.address() as { port: number }).port;
    const config: any = { contract: CONTRACT, marketContract: MARKET, txApi: `http://localhost:${port}` };
    const indexer = new Indexer(config, db);
    assert.equal(indexer.height, 5000);
    await indexer.syncOnce();
    assert.deepEqual(asked.filter((a) => !a.account_id.includes('resume')).map((a) => [a.account_id, a.from]).slice(0, 2), [[CONTRACT, 4700], [MARKET, 0]], 'a new market starts from the beginning, not from the game\'s place');
    assert.equal(roomEvents(db, 0).length, 0);
    const stored = db.prepare("SELECT COUNT(*) n FROM events WHERE standard = 'dig-here-market'").get() as { n: number };
    assert.equal(stored.n, 1);
    // A transaction the game's reader already finished, from before it knew about the market, isn't done for the market.
    assert.ok(db.prepare('SELECT 1 FROM indexed_txs WHERE hash = ?').get(`${MARKET}:LIST`));
    assert.equal(db.prepare('SELECT 1 FROM indexed_txs WHERE hash = ?').get('LIST'), undefined);
    // Restarting reads the same places.
    const again = new Indexer(config, db);
    assert.equal(again.height, 5000);
    asked.length = 0;
    await again.syncOnce();
    assert.deepEqual(asked.slice(0, 2).map((a) => [a.account_id, a.from]), [[CONTRACT, 4700], [MARKET, 6700]]);
  } finally {
    server.close();
  }
});

test('the etag moves with the market too', () => {
  const base = { version: 3, now_ms: 1, commitments_left: 5, missed_reveals: 0, jackpot: 0, season: { number: 1 } };
  assert.notEqual(etagOf(base, 'a'), etagOf(base, 'b'));
  assert.equal(etagOf(base, 'a'), etagOf({ ...base, now_ms: 9 }, 'a'));
});
