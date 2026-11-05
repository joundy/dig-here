import assert from 'node:assert/strict';
import { connect, type AddressInfo } from 'node:net';
import { test } from 'node:test';
import { App, clientIp, ipBucket } from './http.ts';

function raw(port: number, request: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const socket = connect(port, '127.0.0.1', () => socket.write(request));
    let text = '';
    socket.on('data', (d) => {
      text += d;
      socket.destroy();
      resolve(text);
    });
    socket.on('error', reject);
    setTimeout(() => {
      socket.destroy();
      resolve(text);
    }, 1500);
  });
}

test('a URL that cannot be parsed gets an answer and no unhandled rejection', async () => {
  const rejections: unknown[] = [];
  const note = (e: unknown) => rejections.push(e);
  process.on('unhandledRejection', note);
  const server = await new App().listen(0);
  const reply = await raw((server.address() as AddressInfo).port, 'GET // HTTP/1.1\r\nHost: x\r\nConnection: close\r\n\r\n');
  server.close();
  process.off('unhandledRejection', note);
  assert.match(reply, /^HTTP\/1\.1 400/);
  assert.equal(rejections.length, 0);
});

test('a bad percent escape in a path is the client\'s mistake, not a server failure', async () => {
  const app = new App();
  app.route('GET', /^\/api\/games\/(.+)$/, (_req, res) => void res.end('no'));
  const server = await app.listen(0);
  const reply = await raw((server.address() as AddressInfo).port, 'GET /api/games/%E0%A4%A HTTP/1.1\r\nHost: x\r\nConnection: close\r\n\r\n');
  server.close();
  assert.match(reply, /^HTTP\/1\.1 400/);
});

test('the Cloudflare header only counts when the deploy says traffic really comes through Cloudflare', () => {
  const req: any = { headers: { 'cf-connecting-ip': '1.2.3.4' }, socket: { remoteAddress: '10.0.0.9' } };
  assert.equal(clientIp(req, false), '10.0.0.9');
  assert.equal(clientIp(req, true), '1.2.3.4');
  assert.equal(clientIp({ headers: {}, socket: { remoteAddress: '10.0.0.9' } } as any, true), '10.0.0.9');
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
