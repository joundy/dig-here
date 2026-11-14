import assert from 'node:assert/strict';
import { afterEach, test } from 'node:test';
import { broadcastElsewhere, read, rpcStats, sendRaw } from './rpc.ts';

const realFetch = globalThis.fetch;
const realKey = process.env.FASTNEAR_API_KEY;
const realQuicknode = process.env.QUICKNODE_RPC_URL;
const QUICKNODE = 'https://example.quiknode.pro/secret-token/';

afterEach(() => {
  globalThis.fetch = realFetch;
  if (realKey === undefined) delete process.env.FASTNEAR_API_KEY;
  else process.env.FASTNEAR_API_KEY = realKey;
  if (realQuicknode === undefined) delete process.env.QUICKNODE_RPC_URL;
  else process.env.QUICKNODE_RPC_URL = realQuicknode;
});

function capture(): { url: string; auth: string | null }[] {
  const seen: { url: string; auth: string | null }[] = [];
  globalThis.fetch = (async (url: string, init: RequestInit) => {
    seen.push({ url: String(url), auth: new Headers(init.headers).get('authorization') });
    return new Response(JSON.stringify({ jsonrpc: '2.0', id: 'dig-here', result: 'ok' }));
  }) as typeof fetch;
  return seen;
}

test('sends the key to FastNEAR, and never to the fallback provider', async () => {
  process.env.FASTNEAR_API_KEY = 'test-key';
  const seen = capture();
  process.env.QUICKNODE_RPC_URL = QUICKNODE;
  await sendRaw('status', [], 1000);
  await broadcastElsewhere('c2lnbmVk', 1000);
  assert.match(seen[0].url, /fastnear/);
  assert.equal(seen[0].auth, 'Bearer test-key');
  assert.deepEqual(seen.slice(1).map((s) => s.auth), [null, null]);
  assert.ok(seen.slice(1).every((s) => !/fastnear/.test(s.url)));
});

/** FastNEAR refuses, which is how a rejected key looks. Every other provider answers normally. */
function fastnearRefuses(): string[] {
  const urls: string[] = [];
  globalThis.fetch = (async (url: string) => {
    urls.push(String(url));
    if (/fastnear/.test(String(url))) return new Response('Invalid API key', { status: 403 });
    return new Response(JSON.stringify({ jsonrpc: '2.0', id: 'dig-here', result: 'ok' }));
  }) as typeof fetch;
  return urls;
}

test('reads go to QuickNode when FastNEAR refuses, before dRPC', async () => {
  process.env.QUICKNODE_RPC_URL = QUICKNODE;
  const urls = fastnearRefuses();
  const before = rpcStats.quicknode;
  assert.equal(await read('status', []), 'ok');
  assert.deepEqual(urls.map((u) => (u === QUICKNODE ? 'quicknode' : /fastnear/.test(u) ? 'fastnear' : 'drpc')), ['fastnear', 'quicknode']);
  assert.equal(rpcStats.quicknode, before + 1);
});

test('reads still reach dRPC with no QuickNode set', async () => {
  delete process.env.QUICKNODE_RPC_URL;
  const urls = fastnearRefuses();
  assert.equal(await read('status', []), 'ok');
  assert.match(urls[1], /drpc/);
});

test('a broadcast goes to both backups, without waiting on the result', async () => {
  process.env.QUICKNODE_RPC_URL = QUICKNODE;
  const bodies: { url: string; params: any }[] = [];
  globalThis.fetch = (async (url: string, init: RequestInit) => {
    bodies.push({ url: String(url), params: JSON.parse(String(init.body)).params });
    return new Response(JSON.stringify({ jsonrpc: '2.0', id: 'dig-here', result: 'ok' }));
  }) as typeof fetch;
  await broadcastElsewhere('c2lnbmVk', 1000);
  assert.deepEqual(bodies.map((b) => b.url === QUICKNODE), [true, false]);
  assert.ok(bodies.every((b) => b.params.wait_until === 'NONE' && b.params.signed_tx_base64 === 'c2lnbmVk'));
});

test('one backup failing does not fail the broadcast', async () => {
  process.env.QUICKNODE_RPC_URL = QUICKNODE;
  globalThis.fetch = (async (url: string) => {
    if (String(url) === QUICKNODE) return new Response('nope', { status: 401 });
    return new Response(JSON.stringify({ jsonrpc: '2.0', id: 'dig-here', result: 'ok' }));
  }) as typeof fetch;
  await broadcastElsewhere('c2lnbmVk', 1000);
});

test('works with no key set', async () => {
  delete process.env.FASTNEAR_API_KEY;
  const seen = capture();
  await sendRaw('status', [], 1000, false);
  assert.equal(seen[0].auth, null);
});
