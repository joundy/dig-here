import assert from 'node:assert/strict';
import { connect, type AddressInfo } from 'node:net';
import { test } from 'node:test';
import { App } from './http.ts';

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
