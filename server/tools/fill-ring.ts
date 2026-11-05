// Pushes cheap rounds through the contract until its ring of 30 has dropped the oldest rooms, so the proof
// test can cover rooms the contract has deleted. Also a load test: every room here runs on the live oracle.
//   node server/tools/fill-ring.ts <batches>
import { sleep } from '../log.ts';
import type { NearAccount } from '../signer.ts';
import { near } from '../units.ts';
import { c, removeAccount, throwaway, room } from './lib.ts';

const BATCHES = Number(process.argv[2] ?? 2);
const tag = `wf${Date.now().toString(36).slice(-4)}`;
const accounts: NearAccount[] = [];
for (const n of ['a', 'b', 'c', 'd']) accounts.push(await throwaway(`${tag}-${n}`, '0.55'));
const ids: number[] = [];

async function round(host: NearAccount, other: NearAccount, i: number): Promise<void> {
  const made = await host.call(c, 'create_room', { name: `Ring ${i}`, map: ['tropical', 'snowy', 'desert'][i % 3], fee: 1, duration_sec: 60, host_cut_bps: 0, min_players: 2, max_players: 2, countdown_sec: 0 }, 60, near('0.11'));
  if (!made.ok) return console.log('create', made.failure);
  ids.push(made.value);
  const a = await host.call(c, 'join', { room_id: made.value }, 10);
  const b = await other.call(c, 'join', { room_id: made.value }, 10, near('0.01'));
  if (!a.ok || !b.ok) console.log('join', a.failure, b.failure);
  // A full room starts by itself after 5 seconds, through the oracle. No digs, so it ends in a too-few-digs refund.
}

try {
  for (let batch = 0; batch < BATCHES; batch++) {
    const work: Promise<void>[] = [];
    for (let h = 0; h < accounts.length; h++) for (let r = 0; r < 3; r++) work.push(round(accounts[h], accounts[(h + 1) % accounts.length], batch * 12 + h * 3 + r));
    await Promise.all(work);
    console.log('batch', batch, 'opened', ids.length);
    for (;;) {
      const states: any[] = await Promise.all(ids.map((id) => room(id).catch(() => ({ status: 'gone' }))));
      const open = states.filter((s) => s.status === 'waiting' || s.status === 'live').length;
      if (!open) break;
      await sleep(5000);
    }
    console.log('batch', batch, 'all ended');
  }
  const ended: any[] = await Promise.all(ids.map((id) => room(id).catch(() => null)));
  const gaps = ended.filter(Boolean).flatMap((r) => r.rolls.filter((x: any) => x.reveal_ms).map((x: any) => x.reveal_ms - x.due_ms)).sort((a, b) => a - b);
  console.log('ids', ids.join(','));
  console.log('rooms', ended.filter(Boolean).map((r) => `${r.status}/${r.result?.refund_reason}`).reduce((m: any, k: string) => ((m[k] = (m[k] ?? 0) + 1), m), {}));
  console.log('due to revealed, ms', { n: gaps.length, p50: gaps[gaps.length >> 1], p90: gaps[Math.floor(gaps.length * 0.9)], max: gaps.at(-1) });
} finally {
  for (const a of accounts) await removeAccount(a).catch((e) => console.log('cleanup', a.id, e.message));
}
