import assert from 'node:assert/strict';
import { afterEach, test } from 'node:test';
import { sendRaw } from './rpc.ts';

const realFetch = globalThis.fetch;
const realKey = process.env.FASTNEAR_API_KEY;

afterEach(() => {
  globalThis.fetch = realFetch;
  if (realKey === undefined) delete process.env.FASTNEAR_API_KEY;
  else process.env.FASTNEAR_API_KEY = realKey;
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
  await sendRaw('status', [], 1000, false);
  await sendRaw('status', [], 1000, true);
  assert.match(seen[0].url, /fastnear/);
  assert.equal(seen[0].auth, 'Bearer test-key');
  assert.doesNotMatch(seen[1].url, /fastnear/);
  assert.equal(seen[1].auth, null);
});

test('works with no key set', async () => {
  delete process.env.FASTNEAR_API_KEY;
  const seen = capture();
  await sendRaw('status', [], 1000, false);
  assert.equal(seen[0].auth, null);
});
