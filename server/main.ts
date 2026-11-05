import { addLiveRoutes } from './api-live.ts';
import { startBurnLog, burnReport } from './burn.ts';
import { BOT_JOIN_LIMITS } from './bot-brain.ts';
import { Bots } from './bots.ts';
import { loadConfig } from './config.ts';
import { openDb } from './db.ts';
import { addHistoryRoutes } from './history.ts';
import { App, clientIp, ipBucket, sendJson } from './http.ts';
import { Indexer } from './indexer.ts';
import { Demand, LiveState } from './live.ts';
import { errorText, log, sleep } from './log.ts';
import { Oracle, oracleStats } from './oracle.ts';
import { finalBlock, rpcStats } from './rpc.ts';
import { staticHandler } from './static.ts';
import { prepareRunner, rootAndOracle } from './team.ts';
import { toNear } from './units.ts';

// A background task's bad moment shouldn't stop the board and the oracle for everyone.
process.on('unhandledRejection', (e) => log('main', `unhandled rejection: ${errorText(e)}`));

const config = loadConfig();
const demand = new Demand(config.demandWindowSec * 1000);
const state = new LiveState(config.contract, demand, config.marketContract);
const app = new App();
const team = rootAndOracle(config);
const db = openDb(config.dbPath);

let rootBalance = 0n;
let bots: Bots | null = null;
let lastBlock = 0;

async function refreshHealth(): Promise<void> {
  try {
    rootBalance = await team.funding.rootBalance();
    lastBlock = (await finalBlock(0)).height;
  } catch (e) {
    log('health', `refresh failed: ${errorText(e)}`);
  }
}

app.route('GET', /^\/api\/health$/, (req, res) => {
  const current = state.current;
  const fresh = current !== null && Date.now() - current.frame.fetched_ms < 15_000;
  sendJson(req, res, fresh ? 200 : 503, {
    ok: fresh,
    contract: config.contract,
    market: config.marketContract,
    oracle_pool: current?.frame.live.commitments_left ?? null,
    root_balance: rootBalance.toString(),
    last_state_ms: current?.frame.fetched_ms ?? null,
    bots_enabled: config.botsEnabled,
    bot_join_limits: BOT_JOIN_LIMITS,
    last_block: lastBlock,
    oracle_enabled: config.oracleEnabled,
    sse_clients: demand.sseClients,
    demand_active: demand.active(),
    missed_reveals: current?.frame.live.missed_reveals ?? null,
    indexer_height: indexer.height,
    indexer_error: indexer.lastError,
    bots_spent: bots ? toNear(bots.spent()) : null,
    oracle_stats: oracleStats,
    rpc: rpcStats,
    burn: burnReport(),
  });
});
addLiveRoutes(app, state, { maxClients: config.sseMaxClients, maxPerIp: config.sseMaxPerIp, ipOf: (req) => ipBucket(clientIp(req, config.trustCfIp)) });
const indexer = new Indexer(config, db);
addHistoryRoutes(app, db, indexer);

app.fallback(staticHandler(config.distDir));

// Listening first means a second copy dies on the busy port before its oracle can fight the first.
await app.listen(config.port);
log('main', `listening on ${config.port}`, { contract: config.contract, oracle: config.oracleEnabled, bots: config.botsEnabled });

void state.run();
void refreshHealth();
setInterval(() => void refreshHealth(), 30_000).unref();
startBurnLog();

/** One bad RPC moment at boot shouldn't take the board and everything else down with it. */
async function untilItWorks(label: string, start: () => Promise<void>): Promise<void> {
  for (;;) {
    try {
      await start();
      return log('main', `${label} running`);
    } catch (e) {
      log('main', `${label} failed to start, retrying: ${errorText(e)}`);
      await sleep(5000);
    }
  }
}

if (config.oracleEnabled) {
  void untilItWorks('oracle', async () => {
    const runner = await prepareRunner(config, team);
    new Oracle(config, team.oracle, runner, state, team.funding).start();
  });
}
if (config.indexerEnabled) void indexer.run();
if (config.botsEnabled) {
  void untilItWorks('bots', async () => {
    const engine = new Bots(config, db, state, team.funding, team.root);
    await engine.start();
    bots = engine;
  });
}
