import type { IncomingMessage, Server, ServerResponse } from 'node:http';
import { createServer } from 'node:http';
import { isIPv6 } from 'node:net';
import { gzipSync } from 'node:zlib';
import { errorText, log } from './log.ts';

export type Handler = (req: IncomingMessage, res: ServerResponse, params: string[], url: URL) => void | Promise<void>;
type Route = { method: string; pattern: RegExp; handler: Handler };

const GZIP_FROM_BYTES = 512;

/**
 * On every response. `same-origin-allow-popups` because a wallet's sign-in window answers through `window.opener`.
 * HID, USB and Bluetooth stay allowed for the Ledger wallet.
 */
export const BASE_HEADERS: Record<string, string> = {
  'x-content-type-options': 'nosniff',
  'x-frame-options': 'DENY',
  'referrer-policy': 'strict-origin-when-cross-origin',
  'cross-origin-opener-policy': 'same-origin-allow-popups',
  'strict-transport-security': 'max-age=31536000',
  'permissions-policy': 'camera=(), microphone=(), geolocation=(), payment=()',
};

export function clientIp(req: IncomingMessage, trustCf: boolean): string {
  const forwarded = req.headers['cf-connecting-ip'];
  if (trustCf && typeof forwarded === 'string' && forwarded) return forwarded;
  return req.socket.remoteAddress ?? 'unknown';
}

/** Someone with one IPv6 connection usually holds a whole /64, so a limit on exact addresses wouldn't limit them. */
export function ipBucket(ip: string): string {
  const mapped = ip.match(/^::ffff:(\d+\.\d+\.\d+\.\d+)$/i);
  if (mapped) return mapped[1];
  if (!isIPv6(ip)) return ip;
  const [head, tail = ''] = ip.split('%')[0].split('::');
  const left = head ? head.split(':') : [];
  const right = tail ? tail.split(':') : [];
  const groups = ip.includes('::') ? [...left, ...Array(8 - left.length - right.length).fill('0'), ...right] : left;
  return `${groups.slice(0, 4).map((g) => parseInt(g, 16).toString(16)).join(':')}::/64`;
}

export function sendJson(req: IncomingMessage, res: ServerResponse, status: number, body: unknown): void {
  const json = Buffer.from(JSON.stringify(body));
  const headers: Record<string, string> = { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' };
  if (json.length >= GZIP_FROM_BYTES && acceptsGzip(req)) {
    res.writeHead(status, { ...headers, 'content-encoding': 'gzip', vary: 'accept-encoding' });
    res.end(gzipSync(json));
  } else {
    res.writeHead(status, headers);
    res.end(json);
  }
}

export function acceptsGzip(req: IncomingMessage): boolean {
  return /\bgzip\b/.test(String(req.headers['accept-encoding'] ?? ''));
}

export async function readJsonBody(req: IncomingMessage, limit = 2048): Promise<any> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    if (size > limit) throw new Error('body too large');
    chunks.push(chunk);
  }
  return JSON.parse(Buffer.concat(chunks).toString() || '{}');
}

export class App {
  #routes: Route[] = [];
  #fallback: Handler | null = null;

  route(method: string, pattern: RegExp, handler: Handler): void {
    this.#routes.push({ method, pattern, handler });
  }

  fallback(handler: Handler): void {
    this.#fallback = handler;
  }

  listen(port: number): Promise<Server> {
    const server = createServer((req, res) => this.#handle(req, res));
    // Longer than the proxy's idle timeout, or the proxy reuses a socket just as this side closes it.
    server.keepAliveTimeout = 75_000;
    server.headersTimeout = 80_000;
    return new Promise((resolve, reject) => {
      server.once('error', reject);
      server.listen(port, () => resolve(server));
    });
  }

  async #handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
    for (const [name, value] of Object.entries(BASE_HEADERS)) res.setHeader(name, value);
    let url: URL;
    try {
      url = new URL(req.url ?? '/', 'http://local');
    } catch {
      return sendJson(req, res, 400, { error: 'That address could not be read.' });
    }
    try {
      for (const route of this.#routes) {
        if (route.method !== req.method) continue;
        const m = url.pathname.match(route.pattern);
        if (!m) continue;
        let params: string[];
        try {
          params = m.slice(1).map(decodeURIComponent);
        } catch {
          return sendJson(req, res, 400, { error: 'That address could not be read.' });
        }
        return await route.handler(req, res, params, url);
      }
      if (url.pathname.startsWith('/api/')) return sendJson(req, res, 404, { error: 'No such API path.' });
      if (this.#fallback) return await this.#fallback(req, res, [], url);
      sendJson(req, res, 404, { error: 'Not found.' });
    } catch (e) {
      log('http', `${req.method} ${url.pathname} failed: ${errorText(e)}`);
      if (!res.headersSent) sendJson(req, res, 500, { error: 'Something went wrong on our side.' });
      else res.destroy();
    }
  }
}
