// Due to locked and due to revealed, from the indexed events, for rooms in a range. Chain time, so nothing local skews it.
//   node server/tools/reveal-times.ts <first room> [last room]
import { DatabaseSync } from 'node:sqlite';
import { config } from './lib.ts';

const from = Number(process.argv[2] ?? 0);
const to = Number(process.argv[3] ?? 1e9);
const db = new DatabaseSync(config.dbPath, { readOnly: true });
const rows = (event: string) => db.prepare('SELECT room_id, data FROM events WHERE event = ? AND room_id BETWEEN ? AND ?').all(event, from, to) as any[];
const locks = new Map(rows('locked').map((r) => [`${r.room_id}:${JSON.parse(r.data).step}`, JSON.parse(r.data)]));
const lock: number[] = [];
const reveal: number[] = [];
for (const r of rows('revealed')) {
  const data = JSON.parse(r.data);
  const l = locks.get(`${r.room_id}:${data.step}`);
  if (!l) continue;
  lock.push(l.lock_ms - l.due_ms);
  reveal.push(data.reveal_ms - l.due_ms);
}
const summary = (a: number[]) => {
  a.sort((x, y) => x - y);
  return { n: a.length, min: a[0], p50: a[a.length >> 1], p90: a[Math.floor(a.length * 0.9)], max: a.at(-1) };
};
console.log({ rooms: [from, to], due_to_locked_ms: summary(lock), due_to_revealed_ms: summary(reveal) });
