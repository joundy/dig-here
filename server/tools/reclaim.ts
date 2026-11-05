// Takes coins back from throwaway test accounts: re-creates a deleted name, withdraws, deletes.
//   node server/tools/reclaim.ts <full account id>...
import { actions } from 'near-api-js';
import { deriveKeyPair } from '../keys.ts';
import { viewAccount, viewFunction } from '../rpc.ts';
import { NearAccount } from '../signer.ts';
import { near, toNear } from '../units.ts';
import { c, config, team } from './lib.ts';

async function reclaim(id: string): Promise<void> {
  const key = deriveKeyPair(config.keySeed, `test:${id}`);
  const record: any = await viewFunction(c, 'get_account', { id });
  const game = BigInt(record?.balance ?? 0);
  const exists = await viewAccount(id);
  if (!exists && game === 0n) {
    console.log(id, 'nothing to reclaim');
    return;
  }
  if (!exists) {
    const r = await team.root.send(id, [actions.createAccount(), actions.transfer(near('0.02')), actions.addFullAccessKey(key.getPublicKey())]);
    if (!r.ok) {
      console.log(id, 'create failed', r.failure);
      return;
    }
  }
  const account = new NearAccount(id, 'test', [key]);
  if (game > 0n) {
    const w = await account.call(c, 'withdraw', { amount: game.toString() }, 10, 1n, { wait: 'FINAL' });
    console.log(id, 'withdrew', toNear(game), w.ok ? 'ok' : w.failure);
  }
  const d = await account.send(id, [actions.deleteAccount(config.rootAccount)], { wait: 'FINAL' });
  console.log(id, 'deleted', d.ok ? 'ok' : d.failure);
}

for (const id of process.argv.slice(2)) await reclaim(id).catch((e) => console.log(id, 'failed', e.message));
