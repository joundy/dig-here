// Drives one whole round on testnet against the running backend's oracle, then cleans up.
//   node server/tools/round-test.ts                 clue, treasure and payout
//   node server/tools/round-test.ts --restart       restarts the backend in the middle of the round
//   node server/tools/round-test.ts --missed        the oracle must be off: pokes a missed-reveal refund
import { execFileSync } from 'node:child_process';
import { sleep } from '../log.ts';
import { viewFunction } from '../rpc.ts';
import { near, toNear } from '../units.ts';
import { balances, c, config, removeAccount, rollTimings, room, team, throwaway } from './lib.ts';

const restart = process.argv.includes('--restart');
const missed = process.argv.includes('--missed');
const tag = `rt${Date.now().toString(36).slice(-5)}`;
const before = await balances([config.rootAccount, config.oracleAccount]);
console.log('before', before);

const [host, a, b] = await Promise.all([throwaway(`${tag}-h`, '0.3'), throwaway(`${tag}-a`, '0.2'), throwaway(`${tag}-b`, '0.2')]);
const players = [host, a, b];
console.log('accounts', players.map((p) => p.id));

async function must(label: string, p: ReturnType<typeof host.call>) {
  const r = await p;
  if (!r.ok) throw new Error(`${label}: ${r.failure}`);
  console.log(label, r.hash, `${toNear(r.burnt, 5)} NEAR burned`);
  return r;
}

async function waitForPool() {
  for (let i = 0; i < 60; i++) {
    if ((await viewFunction<number>(c, 'commitments_left')) > 0) return;
    console.log('waiting for the oracle to stock the pool');
    await sleep(3000);
  }
  throw new Error('pool stayed empty');
}

try {
  await waitForPool();
  const created = await must('create_room', host.call(c, 'create_room', {
    name: `Test ${tag}`, map: 'desert', fee: 10, duration_sec: 60, host_cut_bps: 500, min_players: 2, max_players: 4, countdown_sec: 0,
  }, 60, near('0.15')));
  const id = created.value as number;
  console.log('room', id);
  await Promise.all(players.map((p) => must(`join ${p.id}`, p.call(c, 'join', { room_id: id }, 10, near('0.02')))));
  await must('start', host.call(c, 'start', { room_id: id }, 10));
  const startedAt = Date.now();

  const first: any = await room(id);
  const spot = (i: number) => first.landmarks[i];
  const digNow = async (p: typeof host, i: number) => {
    for (let attempt = 0; attempt < 5; attempt++) {
      const current: any = await room(id);
      const r = await p.call(c, 'dig', { room_id: id, x: spot(i).x, y: spot(i).y, seen_clue: current.clues.length }, 5);
      if (r.ok) return console.log(`dig ${p.id}`, r.hash, 'clue', current.clues.length);
      console.log(`dig ${p.id} refused: ${r.failure}`);
      await sleep(800);
    }
  };
  if (missed) {
    await digNow(host, 0);
    await digNow(a, 1);
    const live: any = await room(id);
    const dueMs = live.next_due_ms;
    console.log('oracle should be off. first roll due', dueMs, 'deadline', live.reveal_deadline_ms);
    // Lock it ourselves first, as anyone may, to show a locked roll with no reveal refunds too.
    while ((await viewFunction<number>(c, 'get_now_ms')) < dueMs) await sleep(1000);
    await must('poke (lock)', host.call(c, 'poke', { room_id: id }, 30));
    while ((await viewFunction<number>(c, 'get_now_ms')) < live.reveal_deadline_ms + 500) await sleep(2000);
    const refunded = await must('poke (refund)', host.call(c, 'poke', { room_id: id }, 30));
    console.log('poke returned', refunded.value);
    const end: any = await room(id);
    console.log('status', end.status, 'reason', end.result?.refund_reason, 'missed_reveals', await viewFunction(c, 'missed_reveals'));
    for (const p of players) console.log(p.id, await viewFunction(c, 'get_account', { id: p.id }));
    console.log('after refund (coins back in game balances), measured from the first dig');
  } else {
    await digNow(host, 0);
    if (restart) {
      await sleep(20_000);
      console.log(`restarting backend at +${Date.now() - startedAt} ms`);
      execFileSync('server/run-local.sh', ['stop']);
      await sleep(4000);
      execFileSync('server/run-local.sh', [], { stdio: 'inherit' });
    } else {
      await sleep(22_000);
    }
    await digNow(a, 1);
    await sleep(12_000);
    await digNow(b, 2);
    let end: any;
    for (;;) {
      end = await room(id);
      if (end.status === 'finished' || end.status === 'refunded') break;
      await sleep(1500);
    }
    console.log('status', end.status, 'clues', end.clues);
    console.log('timings', rollTimings(end));
    console.log('result', { treasure: end.result.treasure, winner: end.result.winner, split: end.result.split, reason: end.result.refund_reason, pot: end.result.pot });
    console.log('ranking', end.result.ranking.map((x: any) => [x.account, x.distance, x.score]));
    for (const p of players) console.log(p.id, (await viewFunction<any>(c, 'get_account', { id: p.id })).balance);
    console.log('wall clock from start to finished', Date.now() - startedAt, 'ms');
  }
} finally {
  await sleep(4000);
  for (const p of players) await removeAccount(p).catch((e) => console.log('cleanup', p.id, e.message));
  const after = await balances([config.rootAccount, config.oracleAccount]);
  console.log('after', after);
  console.log('root net', Number(after[config.rootAccount]) - Number(before[config.rootAccount]), 'oracle net', Number(after[config.oracleAccount]) - Number(before[config.oracleAccount]));
}
