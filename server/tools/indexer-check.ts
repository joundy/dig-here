// The running indexer has been stopped and restarted many times. If it really catches up, a rebuild from zero must
// find exactly the rows it already has, apart from what's newer than the check's starting block.
import { openDb } from '../db.ts';
import { Indexer } from '../indexer.ts';
import { sleep } from '../log.ts';
import { config } from './lib.ts';

const live = openDb(config.dbPath);
const fresh = openDb(':memory:');
const indexer = new Indexer(config, fresh);
for (;;) {
  try {
    await indexer.syncOnce();
    break;
  } catch (e) {
    console.log((e as Error).message, 'waiting');
    await sleep(15_000);
  }
}
const keys = (db: typeof live, upTo: number) =>
  new Set((db.prepare('SELECT receipt_id, log_index FROM events WHERE block_height <= ?').all(upTo) as any[]).map((r) => `${r.receipt_id}:${r.log_index}`));
await sleep(12_000);
const cut = (live.prepare('SELECT height FROM cursor WHERE id = 1').get() as { height: number }).height - 40;
const a = keys(live, cut);
const b = keys(fresh, cut);
const missingFromLive = [...b].filter((k) => !a.has(k)).length;
const missingFromFresh = [...a].filter((k) => !b.has(k)).length;
console.log({ upToBlock: cut, liveRows: a.size, rebuiltRows: b.size, missingFromLive, missingFromFresh });
process.exit(missingFromLive + missingFromFresh ? 1 : 0);
