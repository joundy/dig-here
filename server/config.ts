import { existsSync, readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { near } from './units.ts';

export const PROJECT_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');

export function parseEnv(text: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const line of text.split('\n')) {
    const m = line.match(/^\s*(?:export\s+)?([A-Z0-9_]+)\s*=\s*(.*?)\s*$/);
    if (m) out[m[1]] = m[2].replace(/^(['"])(.*)\1$/, '$2');
  }
  return out;
}

function loadEnvFile(): void {
  const path = process.env.ENV_FILE ?? resolve(PROJECT_ROOT, '.kamal/secrets-testnet.env');
  if (!existsSync(path)) return;
  // Real environment wins, so a deploy's values can't be overridden by a stray file.
  for (const [k, v] of Object.entries(parseEnv(readFileSync(path, 'utf8')))) process.env[k] ??= v;
}

function required(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`${name} is not set`);
  return value;
}

const flag = (name: string, fallback: boolean) => {
  const v = process.env[name];
  return v === undefined ? fallback : v === '1' || v === 'true';
};
const num = (name: string, fallback: number) => Number(process.env[name] ?? fallback);
const coins = (name: string, fallback: string) => near(process.env[name] ?? fallback);

export type Config = ReturnType<typeof loadConfig>;

export function loadConfig() {
  loadEnvFile();
  const root = process.env.NEAR_ROOT_ACCOUNT ?? 'dighere.testnet';
  return {
    port: num('PORT', 8787),
    contract: process.env.NEAR_CONTRACT ?? `v1.${root}`,
    marketContract: process.env.NEAR_MARKET ?? `market.${root}`,
    rootAccount: root,
    rootKey: required('NEAR_ROOT_PRIVATE_KEY'),
    oracleAccount: process.env.NEAR_ORACLE_ACCOUNT ?? `oracle.${root}`,
    oracleKey: required('NEAR_ORACLE_PRIVATE_KEY'),
    oracleSecret: required('ORACLE_SECRET'),
    keySeed: required('BACKEND_KEY_SEED'),
    dbPath: process.env.DB_PATH ?? resolve(PROJECT_ROOT, 'server/data/dig-here.sqlite'),
    distDir: process.env.DIST_DIR ?? resolve(PROJECT_ROOT, 'dist'),
    mapDataDir: process.env.MAP_DATA_DIR ?? resolve(PROJECT_ROOT, 'contract/data'),

    oracleEnabled: flag('ORACLE_ENABLED', true),
    runnerAccount: process.env.RUNNER_ACCOUNT ?? `warden.${root}`,
    oracleLanes: num('ORACLE_LANES', 10),
    /** On for mainnet: holds each link until its lock is final, about 2 s more per roll. See the backend notes. */
    oracleRevealFinal: flag('ORACLE_REVEAL_FINAL', false),
    poolTarget: num('ORACLE_POOL_TARGET', 50),
    poolBatch: num('ORACLE_POOL_BATCH', 30),

    /** The root stops paying each role at its own floor, lowest for the oracle, so bots run out first. */
    rootFloors: {
      oracle: coins('ROOT_FLOOR_ORACLE_NEAR', '1'),
      bots: coins('ROOT_FLOOR_BOTS_NEAR', '10'),
    },

    /** Every state change writes a frame of up to 247 KB to each stream. */
    sseMaxClients: num('SSE_MAX_CLIENTS', 500),
    /** High enough for a room of people behind one router. Anyone over it falls back to polling `/api/state`. */
    sseMaxPerIp: num('SSE_MAX_PER_IP', 20),
    /** Only safe when every request really arrives through Cloudflare. Otherwise a client can forge the header. */
    trustCfIp: flag('TRUST_CF_CONNECTING_IP', false),

    botsEnabled: flag('BOTS_ENABLED', false),
    demandWindowSec: num('DEMAND_WINDOW_SEC', 300),
    botsParent: process.env.BOTS_PARENT ?? `bots.${root}`,
    botCount: num('BOT_COUNT', 8),
    botsBudget: coins('BOTS_BUDGET_NEAR', '8'),
    botNftMints: num('BOT_NFT_MINTS', 3),
    /** How often one bot buys another's NFT, so the market shows real sales. The coins stay among the bots. */
    botTradeEverySec: num('BOT_TRADE_EVERY_SEC', 1200),
    botMaxBuy: coins('BOT_MAX_BUY_NEAR', '1'),
    /** A bot room stays open this long for a visitor to join. This is what sets rounds per hour, and so the burn rate. */
    botHoldMinSec: num('BOT_HOLD_MIN_SEC', 60),
    botHoldMaxSec: num('BOT_HOLD_MAX_SEC', 300),

    indexerEnabled: flag('INDEXER_ENABLED', true),
    txApi: process.env.TX_API ?? 'https://tx.test.fastnear.com',
  };
}
