// Is a signer's shard what decides whether sends vanish? Sends harmless pokes from accounts on different shards.
import { sleep } from '../log.ts';
import type { NearAccount } from '../signer.ts';
import { c, removeAccount, team, throwaway } from './lib.ts';

const COUNT = Number(process.argv[2] ?? 12);
const near = await throwaway('warden-probe', '0.1'); // 'w' sorts into the contract's own shard
const far = await throwaway('rt-probe', '0.1'); // 'r' sorts into the shard the oracle is on
const mid = await throwaway('go-probe', '0.1'); // 'go' sorts into the shard wallets named g- are next to

async function probe(label: string, account: NearAccount, n: number) {
  const times: number[] = [];
  let lost = 0;
  for (let i = 0; i < n; i++) {
    const t = Date.now();
    try {
      // giveUpMs 0: count a send as lost the first time it isn't answered, instead of recovering it here.
      await account.call(c, 'poke', { room_id: 1 }, 30, 0n, { giveUpMs: 0, resign: false });
      times.push(Date.now() - t);
    } catch (e) {
      lost++;
      console.log(`${label}: ${(e as Error).message.slice(0, 80)}`);
    }
    await sleep(1200);
  }
  times.sort((a, b) => a - b);
  console.log(label, { sent: n, lost, p50: times[times.length >> 1], max: times.at(-1) });
}

await Promise.all([probe('same shard as contract', near, COUNT), probe('oracle shard', far, COUNT), probe('g- shard', mid, COUNT), probe('oracle itself', team.oracle, COUNT)]);
for (const a of [near, far, mid]) await removeAccount(a);
