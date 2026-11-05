import { KeyPair } from 'near-api-js';
import type { Config } from './config.ts';
import { ensureAccount, ensureLaneKeys, Funding } from './funding.ts';
import { deriveKeyPair } from './keys.ts';
import { NearAccount } from './signer.ts';
import { near } from './units.ts';

export const RUNNER_METHODS = ['poke', 'reveal'];

export type Team = { root: NearAccount; oracle: NearAccount; funding: Funding };

export function rootAndOracle(config: Config): Team {
  const root = new NearAccount(config.rootAccount, 'root', [KeyPair.fromString(config.rootKey as any)]);
  const oracle = new NearAccount(config.oracleAccount, 'oracle', [KeyPair.fromString(config.oracleKey as any)]);
  return { root, oracle, funding: new Funding(root, config.rootFloors) };
}

/**
 * Anyone may poke and reveal, and `oracle.` sits on a shard where sends vanish in spells (measured, see the backend
 * notes). So these go from an account on the contract's own shard, with function-call lanes that can't move coins.
 */
export async function prepareRunner(config: Config, team: Team): Promise<NearAccount> {
  const fullKey = deriveKeyPair(config.keySeed, `${config.runnerAccount}:full`);
  await ensureAccount(team.root, config.runnerAccount, near('0.5'), [fullKey]);
  const runner = new NearAccount(config.runnerAccount, 'oracle', [fullKey]);
  const lanes = Array.from({ length: config.oracleLanes }, (_, i) => deriveKeyPair(config.keySeed, `${config.runnerAccount}:lane:${i}`));
  await ensureLaneKeys(runner, lanes, config.contract, RUNNER_METHODS);
  runner.setLanes(lanes);
  return runner;
}

/** A parent account pays directly for its children, so it needs full-access lanes, and those can't be limited. */
export async function prepareParent(config: Config, team: Team, parentId: string, role: string, lanes: number, startingCoins: string): Promise<NearAccount> {
  const keys = Array.from({ length: lanes }, (_, i) => deriveKeyPair(config.keySeed, `${parentId}:lane:${i}`));
  await ensureAccount(team.root, parentId, near(startingCoins), keys.slice(0, 1));
  const parent = new NearAccount(parentId, role, keys.slice(0, 1));
  await ensureLaneKeys(parent, keys);
  parent.setLanes(keys);
  return parent;
}
