import assert from 'node:assert/strict';
import { after, test } from 'node:test';
import { get } from 'node:http';
import type { AddressInfo } from 'node:net';
import { methodOf, sleepMs, startStubRpc, viewResult } from './stub-rpc.ts';

let listings: any[] = [];
let nfts: any[] = [];
let marketUp = true;
const stub = await startStubRpc(async (call) => {
  const method = methodOf(call);
  if (method === 'live_state') return viewResult({ version: 1, now_ms: Date.now(), jackpot: 0, commitments_left: 50, missed_reveals: 0, season: { number: 1 }, rooms: [] });
  if (method === 'get_listings') {
    if (!marketUp) throw new Error('UNKNOWN_ACCOUNT');
    return viewResult(listings);
  }
  if (method === 'get_nfts') return viewResult(nfts);
  throw new Error(`UNEXPECTED_${method}`);
});
process.env.RPC_PRIMARY = stub.url;
process.env.RPC_FALLBACK = stub.url;

const { addLiveRoutes } = await import('./api-live.ts');
const { App } = await import('./http.ts');
const { Demand, LiveState, marketFrame } = await import('./live.ts');
after(() => stub.server.close());

const listing = (token_id: string, seller: string, over: object = {}) => ({ token_id, seller, price: '100', approval_id: 1, in_progress: false, ...over });

test('a listing whose seller no longer owns the NFT is marked stale', () => {
  const nfts = [{ token_id: 'a', owner: 'alice' }, { token_id: 'b', owner: 'bob' }, { token_id: 'c', owner: 'bob' }];
  const frame = marketFrame('m', [listing('a', 'alice'), listing('b', 'alice'), listing('c', 'alice', { in_progress: true })], nfts);
  assert.deepEqual(frame.listings.map((l) => l.stale), [false, true, false], 'a sale in flight is about to move it, which isn\'t staleness');
  assert.equal(frame.contract, 'm');
  assert.deepEqual(frame.nfts, nfts);
  assert.equal(frame.version, marketFrame('m', [listing('a', 'alice'), listing('b', 'alice'), listing('c', 'alice', { in_progress: true })], nfts).version);
  assert.notEqual(frame.version, marketFrame('m', [listing('a', 'alice')], nfts).version);
  assert.notEqual(frame.version, marketFrame('m', [listing('a', 'alice'), listing('b', 'alice'), listing('c', 'alice', { in_progress: true })], [nfts[0]]).version);
});

test('listings reach /api/state and SSE, even when no room changed, and a market failure leaves the game alone', async () => {
  const app = new App();
  const demand = new Demand(60_000);
  demand.touch();
  const state = new LiveState('game.test', demand, 'market.test');
  addLiveRoutes(app, state);
  const server = await app.listen(0);
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  listings = [listing('a', 'alice')];
  nfts = [{ token_id: 'a', owner: 'alice' }];
  void state.run();
  while (!state.current?.frame.market) await sleepMs(20);

  const body = (await (await fetch(`${base}/api/state`)).json()) as any;
  assert.equal(body.version, 1);
  assert.equal(body.market.contract, 'market.test');
  assert.deepEqual(body.market.listings, [{ ...listing('a', 'alice'), stale: false }]);
  const etag = (await fetch(`${base}/api/state`)).headers.get('etag')!;

  const frames: any[] = [];
  const request = get(`${base}/api/live`, { agent: false }, (res) => {
    let text = '';
    res.on('data', (chunk) => {
      text += chunk;
      const parts = text.split('\n\n');
      text = parts.pop()!;
      for (const part of parts) if (part.startsWith('event: state')) frames.push(JSON.parse(part.split('data: ')[1]));
    });
    res.on('error', () => {});
  });
  request.on('error', () => {});
  while (!frames.length) await sleepMs(20);

  // The owner moved it, and the game's version didn't change at all.
  nfts = [{ token_id: 'a', owner: 'bob' }];
  while (frames.length < 2) await sleepMs(50);
  assert.equal(frames[1].version, 1);
  assert.equal(frames[1].market.listings[0].stale, true);
  assert.notEqual((await fetch(`${base}/api/state`)).headers.get('etag'), etag);

  marketUp = false;
  await sleepMs(3500);
  assert.equal(state.lastError, null, 'the market failing is no error of the game\'s');
  assert.equal(state.current!.frame.market!.listings[0].stale, true, 'and the last good listings stay');
  assert.ok(Date.now() - state.current!.frame.fetched_ms < 2500, 'and the board keeps reading');
  request.destroy();
  server.closeAllConnections();
  server.close();
});

test('no market configured means no market reads', async () => {
  const reads = stub.calls.filter((c) => methodOf(c) === 'get_listings').length;
  const demand = new Demand(60_000);
  demand.touch();
  const state = new LiveState('game.test', demand);
  void state.run();
  await sleepMs(300);
  assert.equal(state.current?.frame.market, null);
  assert.equal(stub.calls.filter((c) => methodOf(c) === 'get_listings').length, reads);
});
