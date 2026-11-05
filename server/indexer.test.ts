import assert from 'node:assert/strict';
import { test } from 'node:test';
import { openDb } from './db.ts';
import { App } from './http.ts';
import { addHistoryRoutes, roomEvents } from './history.ts';
import { eventsOfTransaction, type Indexer, storeEvents } from './indexer.ts';
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
  assert.deepEqual(roomEvents(db, 5).map((e) => e.event), ['room_created', 'joined', 'dig', 'finished']);
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
    assert.equal(proof.events.length, 4);
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
