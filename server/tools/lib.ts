import { actions } from 'near-api-js';
import { deriveKeyPair } from '../keys.ts';
import { loadConfig } from '../config.ts';
import { viewAccount, viewFunction } from '../rpc.ts';
import { NearAccount } from '../signer.ts';
import { rootAndOracle } from '../team.ts';
import { near, toNear } from '../units.ts';

export const config = loadConfig();
export const team = rootAndOracle(config);
export const c = config.contract;

export function room(id: number) {
  return viewFunction(c, 'get_room', { id });
}

/** A throwaway account under the root. Its key comes from the seed, so a crashed test can't strand its coins. */
export async function throwaway(name: string, coins: string): Promise<NearAccount> {
  const id = `${name}.${config.rootAccount}`;
  const keyPair = deriveKeyPair(config.keySeed, `test:${id}`);
  const r = await team.root.send(id, [actions.createAccount(), actions.transfer(near(coins)), actions.addFullAccessKey(keyPair.getPublicKey())]);
  if (!r.ok) throw new Error(`create ${id}: ${r.failure}`);
  return new NearAccount(id, 'test', [keyPair]);
}

/** Takes back the game balance, then gives the coins to the root by deleting the account. */
export async function removeAccount(account: NearAccount): Promise<void> {
  const record: any = await viewFunction(c, 'get_account', { id: account.id });
  if (record && BigInt(record.balance) > 0n) {
    const w = await account.call(c, 'withdraw', { amount: record.balance }, 10, 1n, { wait: 'FINAL' });
    if (!w.ok) console.log(`withdraw ${account.id}: ${w.failure}`);
  }
  const d = await account.send(account.id, [actions.deleteAccount(config.rootAccount)], { wait: 'FINAL' });
  if (!d.ok) console.log(`delete ${account.id}: ${d.failure}`);
}

export async function balances(ids: string[]): Promise<Record<string, string>> {
  const out: Record<string, string> = {};
  for (const id of ids) out[id] = toNear((await viewAccount(id))?.amount ?? '0');
  return out;
}

/** Each roll's due, lock and reveal, as the chain recorded them. */
export function rollTimings(r: any) {
  return r.rolls.map((x: any) => ({
    step: x.step,
    due_to_lock_ms: x.lock_ms - x.due_ms,
    lock_to_reveal_ms: x.reveal_ms ? x.reveal_ms - x.lock_ms : null,
    due_to_revealed_ms: x.reveal_ms ? x.reveal_ms - x.due_ms : null,
  }));
}
