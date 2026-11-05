import { readFile, stat } from 'node:fs/promises';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { extname, join, normalize, sep } from 'node:path';
import { gzipSync } from 'node:zlib';
import { acceptsGzip } from './http.ts';

const TYPES: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.json': 'application/json; charset=utf-8',
  '.png': 'image/png',
  '.webp': 'image/webp',
  '.jpg': 'image/jpeg',
  '.ico': 'image/x-icon',
  '.woff2': 'font/woff2',
  '.woff': 'font/woff',
  '.mp3': 'audio/mpeg',
  '.ogg': 'audio/ogg',
  '.wav': 'audio/wav',
  '.wasm': 'application/wasm',
  '.txt': 'text/plain; charset=utf-8',
};
const COMPRESSIBLE = new Set(['.html', '.js', '.css', '.svg', '.json', '.txt']);

type Cached = { mtimeMs: number; raw: Buffer; gzip: Buffer | null; etag: string };

export function staticHandler(root: string) {
  const cache = new Map<string, Cached>();

  async function load(path: string): Promise<Cached | null> {
    let info;
    try {
      info = await stat(path);
    } catch {
      return null;
    }
    if (!info.isFile()) return null;
    const hit = cache.get(path);
    if (hit && hit.mtimeMs === info.mtimeMs) return hit;
    const raw = await readFile(path);
    const entry: Cached = {
      mtimeMs: info.mtimeMs,
      raw,
      gzip: COMPRESSIBLE.has(extname(path)) ? gzipSync(raw) : null,
      etag: `"${info.size.toString(16)}-${Math.floor(info.mtimeMs).toString(16)}"`,
    };
    cache.set(path, entry);
    return entry;
  }

  return async function serve(req: IncomingMessage, res: ServerResponse, _p: string[], url: URL): Promise<void> {
    if (req.method !== 'GET' && req.method !== 'HEAD') {
      res.writeHead(405);
      return void res.end();
    }
    const clean = normalize(decodeURIComponent(url.pathname)).replace(/^([/\\])+/, '');
    const path = join(root, clean);
    if (path !== root && !path.startsWith(root + sep)) {
      res.writeHead(403);
      return void res.end();
    }
    const isAsset = url.pathname.startsWith('/assets/');
    let file = await load(path);
    let served = path;
    // A missing hashed asset should 404, not hand a script the HTML page. Anything else is a client-side route.
    if (!file && !isAsset) {
      served = join(root, 'index.html');
      file = await load(served);
    }
    if (!file) {
      res.writeHead(404, { 'content-type': 'text/plain' });
      return void res.end('Not found');
    }
    const headers: Record<string, string> = {
      'content-type': TYPES[extname(served)] ?? 'application/octet-stream',
      // Same policy as deploy/nginx.conf: hashed names last forever, everything else revalidates.
      'cache-control': isAsset ? 'public, max-age=31536000, immutable' : 'no-cache',
      etag: file.etag,
      vary: 'accept-encoding',
    };
    if (req.headers['if-none-match'] === file.etag) {
      res.writeHead(304, headers);
      return void res.end();
    }
    const useGzip = file.gzip && acceptsGzip(req);
    const body = useGzip ? file.gzip! : file.raw;
    if (useGzip) headers['content-encoding'] = 'gzip';
    headers['content-length'] = String(body.length);
    res.writeHead(200, headers);
    res.end(req.method === 'HEAD' ? undefined : body);
  };
}
