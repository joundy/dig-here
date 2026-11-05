import { randomBytes } from 'node:crypto';
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
  '.webmanifest': 'application/manifest+json',
};
const COMPRESSIBLE = new Set(['.html', '.js', '.css', '.svg', '.json', '.txt', '.webmanifest']);

/** `vite.config.ts` writes this into the built page. The server swaps it for a fresh value on every request. */
export const NONCE_PLACEHOLDER = '__CSP_NONCE__';

/**
 * NEAR Connect runs each wallet's code in a sandboxed `srcdoc` iframe, and those inherit this policy, so it has to
 * leave room for them: the wallet list passes them the nonce, Meteor's and Nightly's bundles contain `new Function`,
 * and every wallet talks to its own servers. What it still stops is what matters here: a script that got into the
 * page some other way can't run, and nobody can frame the page to trick a player into a move their game key signs
 * with no popup. Cloudflare injects its analytics beacon, which isn't ours and gets no nonce.
 */
export function contentSecurityPolicy(nonce: string): string {
  return [
    "default-src 'self'",
    `script-src 'self' 'nonce-${nonce}' 'unsafe-eval' 'wasm-unsafe-eval' https://static.cloudflareinsights.com`,
    "style-src 'self' 'unsafe-inline' https:",
    "img-src 'self' data: blob: https:",
    "font-src 'self' data: https:",
    "connect-src 'self' https: wss:",
    "frame-src 'self' https: blob: data:",
    "media-src 'self' data: blob:",
    "worker-src 'self' blob:",
    "manifest-src 'self'",
    "object-src 'none'",
    "base-uri 'none'",
    "form-action 'self'",
    "frame-ancestors 'none'",
  ].join('; ');
}

type Cached = { mtimeMs: number; raw: Buffer; gzip: Buffer | null; etag: string };

/** Nonce and policy are per response, so the page can't be cached or answered with a 304. It's about 2 KB. */
function serveHtml(req: IncomingMessage, res: ServerResponse, raw: Buffer): void {
  const nonce = randomBytes(16).toString('base64');
  const page = Buffer.from(raw.toString('utf8').replaceAll(NONCE_PLACEHOLDER, nonce));
  const useGzip = acceptsGzip(req);
  const body = useGzip ? gzipSync(page) : page;
  res.writeHead(200, {
    'content-type': TYPES['.html'],
    'cache-control': 'no-cache',
    vary: 'accept-encoding',
    'content-security-policy': contentSecurityPolicy(nonce),
    'content-length': String(body.length),
    ...(useGzip ? { 'content-encoding': 'gzip' } : {}),
  });
  res.end(req.method === 'HEAD' ? undefined : body);
}

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
    let decoded: string;
    try {
      decoded = decodeURIComponent(url.pathname);
    } catch {
      res.writeHead(400, { 'content-type': 'text/plain' });
      return void res.end('Bad address');
    }
    const clean = normalize(decoded).replace(/^([/\\])+/, '');
    const path = join(root, clean);
    if (path !== root && !path.startsWith(root + sep)) {
      res.writeHead(403);
      return void res.end();
    }
    const isAsset = url.pathname.startsWith('/assets/');
    let file = await load(path);
    let served = path;
    // A missing file should 404, not hand a script or a crawler the HTML page. Routes live in the hash, so
    // anything else is only an old or mistyped link, which might as well land on the game.
    if (!file && !isAsset && !extname(clean)) {
      served = join(root, 'index.html');
      file = await load(served);
    }
    if (!file) {
      res.writeHead(404, { 'content-type': 'text/plain' });
      return void res.end('Not found');
    }
    if (extname(served) === '.html') return serveHtml(req, res, file.raw);
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
