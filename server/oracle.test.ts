import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { test } from 'node:test';
import { chainFor, secretFor } from './commitments.ts';
import { nextStep, POKE_LEAD_MS } from './oracle-plan.ts';

const sha = (hex: string) => createHash('sha256').update(Buffer.from(hex, 'hex')).digest('hex');

test('each link hashes to the one before it and up to the tip', () => {
  const { tip, links } = chainFor('secret', 7);
  assert.equal(sha(links[0]), tip);
  assert.equal(sha(links[1]), links[0]);
  assert.equal(sha(links[2]), links[1]);
  assert.equal(sha(links[3]), links[2]);
  assert.equal(links[3], secretFor('secret', 7).toString('hex'));
});

test('the same index always gives the same chain, and others differ', () => {
  assert.deepEqual(chainFor('secret', 7), chainFor('secret', 7));
  assert.notEqual(chainFor('secret', 7).tip, chainFor('secret', 8).tip);
  assert.notEqual(chainFor('secret', 7).tip, chainFor('other', 7).tip);
});

const live = (over: object) => ({ status: 'live', digs: [{}, {}], ends_at_ms: 1_000_000, reveal_deadline_ms: 900_000, next_due_ms: 780_000, locked: false, lock_height: null, next_step: 1, tip_index: 3, ...over });
const waiting = (over: object) => ({ status: 'waiting', start_at_ms: null, deadline_ms: 900_000, ...over });

test('a waiting room is left alone until it is due', () => {
  assert.equal(nextStep(waiting({}), 100_000, null), null);
  assert.deepEqual(nextStep(waiting({ start_at_ms: 100_000 }), 100_000 - POKE_LEAD_MS, null), { type: 'poke' });
  assert.deepEqual(nextStep(waiting({}), 899_000, null), { type: 'poke' });
});

test('a live roll is locked when due, and revealed only once the lock is final', () => {
  assert.equal(nextStep(live({}), 700_000, null), null);
  assert.deepEqual(nextStep(live({}), 780_000, null), { type: 'poke' });
  const locked = live({ locked: true, lock_height: 500, next_step: 2 });
  assert.deepEqual(nextStep(locked, 780_000, null), { type: 'wait-final' });
  assert.deepEqual(nextStep(locked, 780_000, 499), { type: 'wait-final' });
  assert.deepEqual(nextStep(locked, 780_000, 500), { type: 'reveal', step: 2, tip_index: 3 });
});

test('an overdue reveal or a round without enough digs gets refunded', () => {
  assert.deepEqual(nextStep(live({ locked: true, lock_height: 500 }), 900_000, 600), { type: 'poke' });
  assert.deepEqual(nextStep(live({ digs: [{}] }), 1_000_000, null), { type: 'poke' });
});
