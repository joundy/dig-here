import assert from 'node:assert/strict';
import { after, test } from 'node:test';
import { get, type ClientRequest } from 'node:http';
import type { AddressInfo } from 'node:net';
import { methodOf, sleepMs, startStubRpc, viewResult } from './stub-rpc.ts';

const stub = await startStubRpc(async (call) => {
  await sleepMs(60);
  if (methodOf(call) === 'live_state') return viewResult({ version: 1, now_ms: Date.now(), jackpot: 0, commitments_left: 50, missed_reveals: 0, season: { number: 1 }, rooms: [] });
  throw new Error(`UNEXPECTED_${methodOf(call)}`);
});
process.env.RPC_PRIMARY = stub.url;
process.env.RPC_FALLBACK = stub.url;

const { addLiveRoutes } = await import('./api-live.ts');
const { App } = await import('./http.ts');
const { Demand, LiveState } = await import('./live.ts');

const liveReads = () => stub.calls.filter((c) => methodOf(c) === 'live_state').length;
after(() => stub.server.close());

async function setUp(limits?: object) {
  const app = new App();
  const demand = new Demand(1000);
  const state = new LiveState('game.test', demand);
  addLiveRoutes(app, state, limits as any);
  const server = await app.listen(0);
  void state.run();
  while (!state.current) await sleepMs(10);
  return { state, demand, server, base: `http://127.0.0.1:${(server.address() as AddressInfo).port}` };
}

/** Opens the stream and calls back with the status once headers arrive. */
function open(base: string, headers: Record<string, string> = {}): Promise<{ status: number; request: ClientRequest }> {
  return new Promise((resolve, reject) => {
    const request = get(`${base}/api/live`, { headers, agent: false }, (res) => {
      res.on('error', () => {});
      resolve({ status: res.statusCode!, request });
    });
    request.on('error', reject);
  });
}

test('a reconnect storm leaves the poller on its one read a second', async () => {
  const { server, base } = await setUp();
  const seconds = 3;
  const startReads = liveReads();
  const stopAt = Date.now() + seconds * 1000;
  let connections = 0;
  const reconnecter = async () => {
    while (Date.now() < stopAt) {
      const { request } = await open(base);
      connections++;
      request.destroy();
      await sleepMs(1);
    }
  };
  await Promise.all(Array.from({ length: 8 }, reconnecter));
  const reads = liveReads() - startReads;
  server.closeAllConnections();
  server.close();
  assert.ok(connections > 200, `only managed ${connections} connections`);
  assert.ok(reads <= seconds + 1, `${connections} connections caused ${reads} reads in ${seconds} s`);
});

test('holding many streams open costs no reads either', async () => {
  const { server, base } = await setUp();
  const startReads = liveReads();
  const held = await Promise.all(Array.from({ length: 100 }, () => open(base)));
  await sleepMs(2000);
  const reads = liveReads() - startReads;
  held.forEach((h) => h.request.destroy());
  server.closeAllConnections();
  server.close();
  assert.ok(reads <= 3, `${reads} reads in 2 s`);
});

test('nobody watching means a slow poll, and an arrival is noticed within a second without asking for a read', async () => {
  const { demand, server, base } = await setUp();
  demand.lastSeenMs = 0;
  await sleepMs(1100);
  const quiet = liveReads();
  await sleepMs(2500);
  assert.ok(liveReads() - quiet <= 1, `${liveReads() - quiet} reads in 2.5 idle seconds`);
  const { request } = await open(base);
  const arrived = liveReads();
  await sleepMs(1300);
  assert.ok(liveReads() > arrived, 'the arrival should bring the fast poll back');
  request.destroy();
  server.closeAllConnections();
  server.close();
});

test('there can only ever be one poller', async () => {
  const { state, server } = await setUp();
  await assert.rejects(state.run(), /one poller/);
  server.close();
});

test('the oracle can hurry a read, but not faster than the limit', async () => {
  const { state, server } = await setUp();
  const startReads = liveReads();
  const stopAt = Date.now() + 2000;
  while (Date.now() < stopAt) {
    state.wake();
    await sleepMs(5);
  }
  const reads = liveReads() - startReads;
  server.close();
  assert.ok(reads >= 2 && reads <= 5, `${reads} reads in 2 s of waking`);
});

test('live streams are capped overall and per address, and a closed one frees its place', async () => {
  const ipOf = (req: any) => String(req.headers['x-test-ip']);
  const { demand, server, base } = await setUp({ maxClients: 5, maxPerIp: 2, ipOf });
  const a1 = await open(base, { 'x-test-ip': 'a' });
  const a2 = await open(base, { 'x-test-ip': 'a' });
  const a3 = await open(base, { 'x-test-ip': 'a' });
  assert.deepEqual([a1.status, a2.status, a3.status], [200, 200, 503]);

  const others = await Promise.all(['b', 'c', 'd'].map((ip) => open(base, { 'x-test-ip': ip })));
  assert.deepEqual(others.map((o) => o.status), [200, 200, 200]);
  assert.equal(demand.sseClients, 5);
  const e = await open(base, { 'x-test-ip': 'e' });
  assert.equal(e.status, 503, 'over the total');
  assert.equal(demand.sseClients, 5);

  a1.request.destroy();
  await sleepMs(50);
  assert.equal(demand.sseClients, 4);
  const again = await open(base, { 'x-test-ip': 'a' });
  assert.equal(again.status, 200);

  [a2, a3, e, again, ...others].forEach((c) => c.request.destroy());
  server.closeAllConnections();
  server.close();
});
