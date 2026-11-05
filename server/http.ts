import type { IncomingMessage, Server, ServerResponse } from 'node:http';
import { createServer } from 'node:http';
import { gzipSync } from 'node:zlib';
import { errorText, log } from './log.ts';

export type Handler = (req: IncomingMessage, res: ServerResponse, params: string[], url: URL) => void | Promise<void>;
type Route = { method: string; pattern: RegExp; handler: Handler };

const GZIP_FROM_BYTES = 512;

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
    const url = new URL(req.url ?? '/', 'http://local');
    try {
      for (const route of this.#routes) {
        if (route.method !== req.method) continue;
        const m = url.pathname.match(route.pattern);
        if (m) return await route.handler(req, res, m.slice(1).map(decodeURIComponent), url);
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
