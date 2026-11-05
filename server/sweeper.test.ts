import assert from 'node:assert/strict';
import { test } from 'node:test';
import { openDb } from './db.ts';
import { Sweeper } from './sweeper.ts';

function sweeperWith(indexerFresh: () => boolean) {
  const db = openDb(':memory:');
  const old = Date.now() - 48 * 3_600_000;
  db.prepare('INSERT INTO guests(public_key, account_id, ip_hash, created_ms, created_ok, credit_ok) VALUES (?, ?, ?, ?, 1, 1)').run('k', 'g-old.guests.test', 'ip', old);
  const state: any = { current: { frame: { live: { rooms: [] } } } };
  const swept: string[] = [];
  const sweeper = new Sweeper({ guestIdleHours: 12 } as any, db, state, indexerFresh);
  sweeper.sweep = async (id: string) => {
    swept.push(id);
    return null;
  };
  return { sweeper, swept };
}

test('no guest is swept on the indexer\'s word while the indexer is behind', async () => {
  const { sweeper, swept } = sweeperWith(() => false);
  await sweeper.sweepIdle();
  assert.deepEqual(swept, []);
});

test('with the indexer current, an idle guest is swept', async () => {
  const { sweeper, swept } = sweeperWith(() => true);
  await sweeper.sweepIdle();
  assert.deepEqual(swept, ['g-old.guests.test']);
});
