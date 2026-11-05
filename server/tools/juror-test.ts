// A lone juror: a new account hosts a room with bots enabled on the backend, and we time how long until it has players.
//   node server/tools/juror-test.ts [--join]    --join joins a bot's waiting room instead of hosting
import { sleep } from '../log.ts';
import { viewFunction } from '../rpc.ts';
import { c, removeAccount, throwaway } from './lib.ts';

const t0 = Date.now();
const juror = await throwaway(`juror${Date.now().toString(36)}`, '0.4');
const funded = await juror.call(c, 'deposit', {}, 10, 300n * 10n ** 21n);
if (!funded.ok) throw new Error(funded.failure);
console.log('account ready', juror.id, Date.now() - t0, 'ms');

let id: number;
if (process.argv.includes('--join')) {
  const { live }: any = await (await fetch('http://localhost:8787/api/state')).json();
  const room = live.rooms.find((r: any) => r.status === 'waiting' && r.players.length < r.max_players && !r.start_at_ms);
  if (!room) throw new Error('no waiting room to join');
  id = room.room_id;
  console.log('joining waiting bot room', id, room.name, room.map, 'fee', room.fee, 'players', room.players.length, 'min', room.min_players, 'max', room.max_players);
} else {
  const made = await juror.call(c, 'create_room', { name: 'Juror test', map: 'tropical', fee: 10, duration_sec: 60, host_cut_bps: 0, min_players: 3, max_players: 5, countdown_sec: 30 }, 60);
  if (!made.ok) throw new Error(made.failure);
  id = made.value;
  console.log('hosted room', id);
}
const joined = await juror.call(c, 'join', { room_id: id }, 10);
if (!joined.ok) throw new Error(joined.failure);
const t1 = Date.now();
console.log('joined at', t1 - t0, 'ms');
let last = 0;
let dug = false;
for (;;) {
  const { live }: any = await (await fetch('http://localhost:8787/api/state')).json();
  const room = live.rooms.find((r: any) => r.room_id === id);
  if (!room) break;
  if (room.players.length !== last) {
    last = room.players.length;
    console.log(`+${((Date.now() - t1) / 1000).toFixed(1)} s: ${last} players`, room.players.map((p: string) => p.split('.')[0]).join(', '), room.status, room.max_players);
  }
  if (room.status === 'live' && !dug) {
    dug = true;
    console.log(`round started +${((Date.now() - t1) / 1000).toFixed(1)} s after the join landed (chain: ${room.started_ms})`);
    const lm = await viewFunction<any>(c, 'get_room', { id });
    const r = await juror.call(c, 'dig', { room_id: id, x: lm.landmarks[0].x, y: lm.landmarks[0].y, seen_clue: lm.clues.length }, 5);
    console.log('juror dug', r.ok, r.failure ?? '', `started +${((Date.now() - t1) / 1000).toFixed(1)} s`);
  }
  await sleep(1000);
}
const end: any = await viewFunction(c, 'get_room', { id });
console.log('ended', end.status, end.result?.refund_reason, 'digs', end.digs.length, 'winner', end.result?.winner);
console.log('timings', end.rolls.map((x: any) => ({ step: x.step, due_to_lock: x.lock_ms - x.due_ms, due_to_reveal: x.reveal_ms ? x.reveal_ms - x.due_ms : null })));
await removeAccount(juror);
