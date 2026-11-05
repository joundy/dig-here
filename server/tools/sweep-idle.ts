// Sweeps idle guests now rather than waiting for the server's timer. The running server is not touched.
//   node server/tools/sweep-idle.ts <idle hours>
import { openDb } from '../db.ts';
import { Sweeper } from '../sweeper.ts';
import { config } from './lib.ts';

const hours = Number(process.argv[2] ?? config.guestIdleHours);
const { live }: any = await (await fetch('http://localhost:8787/api/state')).json();
const state: any = { current: { frame: { live } } };
const sweeper = new Sweeper({ ...config, guestIdleHours: hours }, openDb(config.dbPath), state);
const idle = sweeper.idleGuests();
console.log('idle guests', idle);
for (const id of idle) console.log(await sweeper.sweep(id).catch((e) => `${id}: ${e.message}`));
