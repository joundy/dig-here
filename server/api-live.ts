import type { IncomingMessage, ServerResponse } from 'node:http';
import { acceptsGzip, type App, sendJson } from './http.ts';
import type { LiveState } from './live.ts';

const HEARTBEAT_MS = 15_000;
// A browser that stops reading shouldn't hold megabytes of frames in this process.
const MAX_BUFFERED_BYTES = 4 * 1024 * 1024;
const MAX_CLIENTS = 3000;

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

export function addLiveRoutes(app: App, state: LiveState): void {
  const clients = new Set<ServerResponse>();

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
    if (clients.size >= MAX_CLIENTS) return sendJson(req, res, 503, { error: 'Too many live connections.' });
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
    state.wake();
    clients.add(res);
    if (state.current) res.write(frameOf(state.current.json));
    req.on('close', () => {
      clients.delete(res);
      state.demand.sseClients--;
      state.demand.touch();
    });
  });
}
