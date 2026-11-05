import assert from 'node:assert/strict';
import { after, before, test } from 'node:test';
import type { AddressInfo } from 'node:net';
import { methodOf, sleepMs, startStubRpc, viewResult } from './stub-rpc.ts';

const NEAR = 10n ** 24n;
const rpcState = { funderHas: 100n * NEAR, creditLanded: false };
const stub = await startStubRpc(async (call) => {
  const method = methodOf(call);
  if (method === 'view_account') {
    await sleepMs(150);
    return { amount: rpcState.funderHas.toString(), locked: '0', storage_usage: 200 };
  }
  if (method === 'view_access_key') return { nonce: 1, permission: 'FullAccess' };
  if (method === 'get_account') return viewResult(rpcState.creditLanded ? { account_id: 'x', balance: '600000000000000000000000', season_points: 0 } : null);
  throw new Error(`UNEXPECTED_${method}`);
});
// rpc.ts reads these once, on import. No test here can reach a real node.
process.env.RPC_PRIMARY = stub.url;
process.env.RPC_FALLBACK = stub.url;

const { openDb } = await import('./db.ts');
const { GuestError, Guests, ipBucket } = await import('./guests.ts');
const { App } = await import('./http.ts');
const { deriveKeyPair } = await import('./keys.ts');

const keyOf = (label: string) => deriveKeyPair('test-keys', label).getPublicKey().toString();

type Sent = { to: string; method?: string };

function fakeFunder(behave: Partial<{ ok: boolean; delayMs: number }> = {}) {
  const sent: Sent[] = [];
  let running = 0;
  const tally = { sent, peak: 0 };
  const go = async (entry: Sent) => {
    sent.push(entry);
    // What a real funder would lose, so a read after a send sees the coins gone. 0.1 + 0.02 to create, 0.5 to credit.
    rpcState.funderHas -= entry.method ? NEAR / 2n : (NEAR * 12n) / 100n;
    running++;
    tally.peak = Math.max(tally.peak, running);
    await sleepMs(behave.delayMs ?? 30);
    running--;
    return { hash: 'h', ok: behave.ok ?? true, failure: behave.ok === false ? 'refused' : undefined, value: null, logs: [], burnt: 0n };
  };
  return { id: 'guests.test', tally, send: (to: string) => go({ to }), call: (_c: string, method: string, args: any) => go({ to: args.account_id, method }) };
}

const baseConfig = {
  guestsParent: 'guests.test', keySeed: 's', contract: 'game.test', guestGas: NEAR / 10n, guestCredit: NEAR / 2n,
  guestsPerIpPerHour: 3, guestDailyCap: 25, guestMaxInFlight: 10, trustCfIp: false, allowedOrigins: ['https://game.test'], allowLocalOrigins: false,
};

function build(config: object = {}, funder = fakeFunder()) {
  const db = openDb(':memory:');
  const topUps = { n: 0 };
  const funding = { topUp: async () => { topUps.n++; return 0n; } };
  const guests = new Guests({ ...baseConfig, ...config } as any, db, funder as any, funding as any);
  return { db, guests, funder, topUps, rows: () => (db.prepare('SELECT COUNT(*) n FROM guests').get() as { n: number }).n };
}

async function serve(guests: any) {
  const app = new App();
  app.route('POST', /^\/api\/guest-accounts$/, guests.handle);
  const server = await app.listen(0);
  return { server, url: `http://127.0.0.1:${(server.address() as AddressInfo).port}/api/guest-accounts` };
}

const post = (url: string, key: string, headers: Record<string, string> = {}) =>
  fetch(url, { method: 'POST', headers: { 'content-type': 'application/json', origin: 'https://game.test', ...headers }, body: JSON.stringify({ public_key: key }) }).then((r) => r.status);

const countOf = (statuses: number[], status: number) => statuses.filter((s) => s === status).length;

before(() => {
  rpcState.funderHas = 100n * NEAR;
  rpcState.creditLanded = false;
});
after(() => stub.server.close());

test('200 requests at once from one IP create at most the limit', async () => {
  const { guests, funder, rows } = build({ guestMaxInFlight: 200 });
  const { server, url } = await serve(guests);
  const statuses = await Promise.all(Array.from({ length: 200 }, (_, i) => post(url, keyOf(`burst-${i}`))));
  server.close();
  assert.equal(countOf(statuses, 200), 3, `statuses: ${statuses.join(',')}`);
  assert.equal(countOf(statuses, 429), 197);
  assert.equal(rows(), 3);
  assert.equal(funder.tally.sent.filter((s) => s.method === 'deposit_for').length, 3, 'coins sent');
});

test('the daily cap holds against a burst from many addresses', async () => {
  const { guests, funder, rows } = build({ trustCfIp: true, guestMaxInFlight: 200 });
  const { server, url } = await serve(guests);
  const statuses = await Promise.all(Array.from({ length: 200 }, (_, i) => post(url, keyOf(`ips-${i}`), { 'cf-connecting-ip': `10.0.${i}.1` })));
  server.close();
  assert.equal(countOf(statuses, 200), 25);
  assert.equal(rows(), 25);
  assert.equal(funder.tally.sent.filter((s) => s.method === 'deposit_for').length, 25);
});

test('only so many guests are made at once, however the limits are dodged', async () => {
  const { guests, funder } = build({ trustCfIp: true, guestDailyCap: 1000, guestMaxInFlight: 10 });
  const { server, url } = await serve(guests);
  const statuses = await Promise.all(Array.from({ length: 200 }, (_, i) => post(url, keyOf(`cap-${i}`), { 'cf-connecting-ip': `10.1.${i}.1` })));
  server.close();
  assert.equal(countOf(statuses, 200), 10, `statuses: ${statuses.join(',')}`);
  assert.equal(countOf(statuses, 503), 190);
  assert.ok(funder.tally.peak <= 20, `${funder.tally.peak} sends at once for 10 guests`);
});

test('a refused request costs nothing: the slot goes back when no coins were available', async () => {
  rpcState.funderHas = 0n;
  const { guests, funder, rows } = build();
  await assert.rejects(guests.request(keyOf('poor'), 'ip'), (e: any) => e.status === 503);
  assert.equal(rows(), 0, 'no row left behind to eat the IP allowance');
  assert.equal(funder.tally.sent.length, 0);
  rpcState.funderHas = 100n * NEAR;
  await sleepMs(1100);
  assert.equal((await guests.request(keyOf('poor'), 'ip')).created, true);
});

test('simultaneous guests add up against the coins the funder holds', async () => {
  // Each costs 0.62 NEAR here, so 2 NEAR pays for 3 of them.
  rpcState.funderHas = 2n * NEAR;
  const { guests, funder } = build({ guestMaxInFlight: 50, guestDailyCap: 1000 });
  const results = await Promise.allSettled(Array.from({ length: 12 }, (_, i) => guests.request(keyOf(`funds-${i}`), `ip-${i}`)));
  rpcState.funderHas = 100n * NEAR;
  assert.equal(results.filter((r) => r.status === 'fulfilled').length, 3);
  assert.equal(funder.tally.sent.filter((s) => s.method === 'deposit_for').length, 3);
});

test('200 at once with the same key make one guest', async () => {
  const { guests, funder, rows } = build();
  const { server, url } = await serve(guests);
  const key = keyOf('same');
  const statuses = await Promise.all(Array.from({ length: 200 }, () => post(url, key)));
  server.close();
  assert.ok(statuses.every((s) => s === 200));
  assert.equal(rows(), 1);
  assert.equal(funder.tally.sent.filter((s) => s.method === 'deposit_for').length, 1);
});

test('retrying a failed guest is limited too', async () => {
  const funder = fakeFunder({ ok: false, delayMs: 1 });
  const { guests } = build({}, funder);
  const key = keyOf('stuck');
  const statuses: number[] = [];
  for (let i = 0; i < 12; i++) await guests.request(key, 'ip').then(() => statuses.push(200), (e: any) => statuses.push(e.status));
  const coinSends = funder.tally.sent.filter((s) => s.method === 'deposit_for').length;
  assert.equal(coinSends, 4, `sent coins ${coinSends} times for ${statuses.join(',')}`);
  assert.equal(countOf(statuses, 429), 8);
});

test('a retry after the credit landed unseen does not pay twice', async () => {
  let failCredit = true;
  const funder = fakeFunder();
  const realCall = funder.call;
  funder.call = (contract: string, method: string, args: any) => {
    if (failCredit) {
      funder.tally.sent.push({ to: args.account_id, method });
      return Promise.reject(new Error('lost, but it landed anyway')) as any;
    }
    return realCall(contract, method, args);
  };
  const { guests } = build({}, funder);
  const key = keyOf('landed');
  await assert.rejects(guests.request(key, 'ip'), (e: GuestError) => e.status === 503);
  failCredit = false;
  rpcState.creditLanded = true;
  const result = await guests.request(key, 'ip');
  rpcState.creditLanded = false;
  assert.equal(result.created, true);
  assert.equal(funder.tally.sent.filter((s) => s.method === 'deposit_for').length, 1);
});

test('one IPv6 network counts as one address', () => {
  assert.equal(ipBucket('2001:db8:1:2:aaaa:bbbb:cccc:dddd'), ipBucket('2001:db8:1:2:1111::2'));
  assert.equal(ipBucket('2001:db8:1:2::'), ipBucket('2001:0db8:0001:0002:0:0:0:9'));
  assert.notEqual(ipBucket('2001:db8:1:2::1'), ipBucket('2001:db8:1:3::1'));
  assert.equal(ipBucket('::ffff:1.2.3.4'), '1.2.3.4');
  assert.equal(ipBucket('1.2.3.4'), '1.2.3.4');
  assert.notEqual(ipBucket('1.2.3.4'), ipBucket('1.2.3.5'));
  assert.equal(ipBucket('not an address'), 'not an address');
});
