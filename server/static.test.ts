import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { App } from './http.ts';
import { contentSecurityPolicy, staticHandler } from './static.ts';

async function withSite(check: (base: string) => Promise<void>) {
  const root = mkdtempSync(join(tmpdir(), 'dig-static-'));
  mkdirSync(join(root, 'assets'));
  writeFileSync(join(root, 'index.html'), '<script nonce="__CSP_NONCE__" src="/assets/a.js"></script><meta nonce="__CSP_NONCE__">');
  writeFileSync(join(root, 'assets/a.js'), 'x'.repeat(2000));
  writeFileSync(join(root, 'robots.txt'), 'User-agent: *');
  const app = new App();
  app.fallback(staticHandler(root));
  const server = await app.listen(0);
  try {
    await check(`http://127.0.0.1:${(server.address() as AddressInfo).port}`);
  } finally {
    server.close();
    server.closeAllConnections();
    rmSync(root, { recursive: true });
  }
}

test('the page gets a fresh nonce on every request, the same one in its policy and its tags', async () => {
  await withSite(async (base) => {
    const first = await fetch(base);
    const second = await fetch(base);
    const nonceOf = (res: Response) => res.headers.get('content-security-policy')!.match(/'nonce-([^']+)'/)![1];
    const a = nonceOf(first);
    assert.notEqual(a, nonceOf(second));
    const page = await first.text();
    assert.equal(page.split(`nonce="${a}"`).length, 3);
    assert.ok(!page.includes('__CSP_NONCE__'));
    assert.equal(first.headers.get('etag'), null);
  });
});

test('every response says what a browser may do with it, an API answer too', async () => {
  await withSite(async (base) => {
    for (const path of ['/', '/assets/a.js', '/api/nothing', '/missing.png']) {
      const res = await fetch(base + path);
      assert.equal(res.headers.get('x-content-type-options'), 'nosniff', path);
      assert.equal(res.headers.get('cross-origin-opener-policy'), 'same-origin-allow-popups', path);
      assert.equal(res.headers.get('x-frame-options'), 'DENY', path);
    }
  });
});

test('a missing file is a 404 and not the page, and a hashed asset is cached for good', async () => {
  await withSite(async (base) => {
    assert.equal((await fetch(`${base}/favicon.ico`)).status, 404);
    assert.equal((await fetch(`${base}/assets/gone.js`)).status, 404);
    assert.equal((await fetch(`${base}/robots.txt`)).status, 200);
    assert.equal((await fetch(`${base}/old/link`)).status, 200);
    const asset = await fetch(`${base}/assets/a.js`);
    assert.match(asset.headers.get('cache-control')!, /immutable/);
    const again = await fetch(`${base}/assets/a.js`, { headers: { 'if-none-match': asset.headers.get('etag')! } });
    assert.equal(again.status, 304);
  });
});

test('an address that does not decode is refused, not a server error', async () => {
  await withSite(async (base) => {
    assert.equal((await fetch(`${base}/%E0%A4%A`)).status, 400);
  });
});

test('the policy leaves wallets able to run and stops the page being framed', () => {
  const policy = contentSecurityPolicy('abc');
  assert.match(policy, /script-src [^;]*'nonce-abc'/);
  assert.match(policy, /connect-src [^;]*https: wss:/);
  assert.match(policy, /frame-ancestors 'none'/);
  assert.doesNotMatch(policy, /script-src [^;]*'unsafe-inline'/);
});
