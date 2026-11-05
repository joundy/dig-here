import { actions, type KeyPair } from 'near-api-js';
import { log } from './log.ts';
import { listAccessKeys, viewAccount } from './rpc.ts';
import type { NearAccount } from './signer.ts';
import { toNear } from './units.ts';

export type Floors = { oracle: bigint; guests: bigint; bots: bigint };

export function availableBalance(account: { amount: string; storage_usage: number } | null): bigint {
  if (!account) return 0n;
  // 770 bytes are free of storage staking, and below that nothing is locked.
  const locked = BigInt(Math.max(0, account.storage_usage - 770)) * 10n ** 19n;
  return BigInt(account.amount) - locked;
}

/** The root pays for everything, so every coin it sends passes through this floor check. */
export class Funding {
  readonly root: NearAccount;
  readonly floors: Floors;

  constructor(root: NearAccount, floors: Floors) {
    this.root = root;
    this.floors = floors;
  }

  async rootBalance(): Promise<bigint> {
    return availableBalance(await viewAccount(this.root.id));
  }

  async rootCanSpend(amount: bigint, role: keyof Floors): Promise<boolean> {
    return (await this.rootBalance()) - amount >= this.floors[role];
  }

  /** Sends only if the account is under `below`. Returns the amount sent, or 0 when it wasn't needed or allowed. */
  async topUp(to: string, below: bigint, amount: bigint, role: keyof Floors): Promise<bigint> {
    const balance = availableBalance(await viewAccount(to));
    if (balance >= below) return 0n;
    if (!(await this.rootCanSpend(amount, role))) {
      log('funding', `root is near the ${role} floor, not topping up ${to}`);
      return 0n;
    }
    const result = await this.root.transfer(to, amount);
    if (!result.ok) throw new Error(`top-up of ${to} failed: ${result.failure}`);
    log('funding', `root sent ${toNear(amount)} NEAR to ${to}`, { was: toNear(balance), hash: result.hash });
    return amount;
  }
}

/** Creates `id` under its parent if it doesn't exist, with the given full-access keys. Safe to call on every start. */
export async function ensureAccount(parent: NearAccount, id: string, amount: bigint, keys: KeyPair[]): Promise<boolean> {
  if (await viewAccount(id, 'optimistic')) return false;
  const result = await parent.send(id, [
    actions.createAccount(),
    actions.transfer(amount),
    ...keys.map((k) => actions.addFullAccessKey(k.getPublicKey())),
  ]);
  if (!result.ok) throw new Error(`could not create ${id}: ${result.failure}`);
  log('funding', `created ${id} with ${toNear(amount)} NEAR`, { hash: result.hash });
  return true;
}

/** Adds any lane key the account doesn't have yet. `methods` makes them function-call keys that can't move coins. */
export async function ensureLaneKeys(account: NearAccount, keys: KeyPair[], contract?: string, methods?: string[]): Promise<void> {
  const have = new Set(await listAccessKeys(account.id));
  const missing = keys.filter((k) => !have.has(k.getPublicKey().toString()));
  if (!missing.length) return;
  const result = await account.send(
    account.id,
    missing.map((k) => (methods && contract ? actions.addFunctionCallAccessKey(k.getPublicKey(), contract, methods) : actions.addFullAccessKey(k.getPublicKey()))),
  );
  if (!result.ok) throw new Error(`could not add lane keys to ${account.id}: ${result.failure}`);
  log('funding', `added ${missing.length} lane keys to ${account.id}`, { hash: result.hash });
}

