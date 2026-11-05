import type { IncomingMessage, ServerResponse } from 'node:http';
import { acceptsGzip, type App, sendJson } from './http.ts';
import type { LiveState } from './live.ts';

const HEARTBEAT_MS = 15_000;
// A browser that stops reading shouldn't hold megabytes of frames in this process.
const MAX_BUFFERED_BYTES = 4 * 1024 * 1024;

export type LiveLimits = { maxClients: number; maxPerIp: number; ipOf: (req: IncomingMessage) => string };
const DEFAULT_LIMITS: LiveLimits = { maxClients: 500, maxPerIp: 20, ipOf: (req) => req.socket.remoteAddress ?? 'unknown' };

function serveState(state: LiveState, req: IncomingMessage, res: ServerResponse): void {
  state.demand.touch();
  const current = state.current;
  if (!current) return sendJson(req, res, 503, { error: 'The game state is still loading.' });
  const headers: Record<string, string> = { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-cache', etag: current.etag, vary: 'accept-encoding' };
  if (req.headers['if-none-match'] === current.etag) {
    res.writeHead(304, headers);
    return void res.end();
  }
  if (acceptsGzip(req)) {
    res.writeHead(200, { ...headers, 'content-encoding': 'gzip', 'content-length': String(current.gzip.length) });
    return void res.end(current.gzip);
  }
  res.writeHead(200, { ...headers, 'content-length': String(current.json.length) });
  res.end(current.json);
}

const frameOf = (json: Buffer) => Buffer.concat([Buffer.from('event: state\ndata: '), json, Buffer.from('\n\n')]);

export function addLiveRoutes(app: App, state: LiveState, limits: LiveLimits = DEFAULT_LIMITS): void {
  const clients = new Set<ServerResponse>();
  const perIp = new Map<string, number>();

  state.onChange((_frame, encoded) => {
    if (!clients.size) return;
    const bytes = frameOf(encoded.json);
    for (const client of clients) {
      if (client.writableLength > MAX_BUFFERED_BYTES) client.destroy();
      else client.write(bytes);
    }
  });

  setInterval(() => {
    for (const client of clients) client.write(': heartbeat\n\n');
  }, HEARTBEAT_MS).unref();

  app.route('GET', /^\/api\/state$/, (req, res) => serveState(state, req, res));

  app.route('GET', /^\/api\/live$/, (req, res) => {
    const ip = limits.ipOf(req);
    // The browser's feed handles a refusal by polling `/api/state`, which costs no RPC reads either.
    if (clients.size >= limits.maxClients || (perIp.get(ip) ?? 0) >= limits.maxPerIp) return sendJson(req, res, 503, { error: 'Too many live connections.' });
    perIp.set(ip, (perIp.get(ip) ?? 0) + 1);
    res.writeHead(200, {
      'content-type': 'text/event-stream; charset=utf-8',
      // no-transform keeps intermediaries from buffering the stream to compress it.
      'cache-control': 'no-cache, no-transform',
      connection: 'keep-alive',
      'x-accel-buffering': 'no',
    });
    res.flushHeaders();
    state.demand.sseClients++;
    state.demand.touch();
    clients.add(res);
    if (state.current) res.write(frameOf(state.current.json));
    res.on('close', () => {
      clients.delete(res);
      const left = (perIp.get(ip) ?? 1) - 1;
      if (left > 0) perIp.set(ip, left);
      else perIp.delete(ip);
      state.demand.sseClients--;
      state.demand.touch();
    });
  });
}
