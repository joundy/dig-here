import { log } from './log.ts';

const FASTNEAR = process.env.RPC_PRIMARY ?? 'https://test.rpc.fastnear.com';
const DRPC = process.env.RPC_FALLBACK ?? 'https://near-testnet.drpc.org';
const COOL_OFF_MS = 10_000;

export class RpcError extends Error {
  kind: 'http' | 'timeout' | 'network' | 'rpc';
  /** The node's error cause, such as UNKNOWN_TRANSACTION or INVALID_TRANSACTION. */
  cause_name?: string;
  status?: number;
  data?: unknown;

  constructor(kind: RpcError['kind'], message: string, extra: Partial<RpcError> = {}) {
    super(message);
    this.kind = kind;
    Object.assign(this, extra);
  }

  /** The network or a rate limit failed us, rather than the node answering with a verdict. */
  get transient(): boolean {
    return this.kind !== 'rpc' || this.cause_name === 'TIMEOUT_ERROR' || /timeout|rate limit/i.test(this.message);
  }
}

let fastnearCoolUntil = 0;

export const rpcStats = { fastnear: 0, drpc: 0, rate_limited: 0, failovers: 0 };

async function post(url: string, method: string, params: unknown, timeoutMs: number): Promise<any> {
  let res: Response;
  try {
    // fetch asks for gzip by itself, which matters: view results are JSON arrays of bytes, three times their size.
    res = await fetch(url, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ jsonrpc: '2.0', id: 'dig-here', method, params }),
      signal: AbortSignal.timeout(timeoutMs),
    });
  } catch (e) {
    const name = (e as Error).name;
    const kind = name === 'TimeoutError' || name === 'AbortError' ? 'timeout' : 'network';
    throw new RpcError(kind, `${method}: ${kind} after ${timeoutMs} ms`);
  }
  const text = await res.text();
  // FastNEAR answers a limit with a JSON error as well as with 429, and hammering it only extends the limit.
  if (res.status === 429 || (url === FASTNEAR && /rate limit/i.test(text.slice(0, 500)))) {
    rpcStats.rate_limited++;
    if (url === FASTNEAR) fastnearCoolUntil = Date.now() + COOL_OFF_MS;
  }
  let json: any;
  try {
    json = JSON.parse(text);
  } catch {
    throw new RpcError('http', `${method}: HTTP ${res.status}`, { status: res.status });
  }
  if (!res.ok && !json?.error) throw new RpcError('http', `${method}: HTTP ${res.status}`, { status: res.status });
  if (json.error) {
    const cause = json.error.cause?.name ?? json.error.name;
    const message = typeof json.error.data === 'string' ? json.error.data : json.error.message ?? cause;
    throw new RpcError('rpc', `${method}: ${message}`, { cause_name: cause, data: json.error.data, status: res.status });
  }
  return json.result;
}

export const fastnearCooling = () => Date.now() < fastnearCoolUntil;

/** Reads fail over to dRPC, which caps every free request at about 2 s and so can't carry long sends. */
export async function read(method: string, params: unknown, timeoutMs = 6000): Promise<any> {
  if (Date.now() >= fastnearCoolUntil) {
    try {
      rpcStats.fastnear++;
      return await post(FASTNEAR, method, params, timeoutMs);
    } catch (e) {
      if (!(e instanceof RpcError) || !e.transient) throw e;
      rpcStats.failovers++;
      if (!fastnearCooling()) log('rpc', `FastNEAR read failed, trying dRPC: ${e.message}`);
    }
  }
  rpcStats.drpc++;
  return post(DRPC, method, params, Math.min(timeoutMs, 4000));
}

/** Sends start at FastNEAR, and `viaFallback` is for when it's refusing or a send there got lost. */
export async function sendRaw(method: string, params: unknown, timeoutMs: number, viaFallback = false): Promise<any> {
  return post(viaFallback ? DRPC : FASTNEAR, method, params, timeoutMs);
}

export async function viewFunction<T = any>(
  contract: string,
  method: string,
  args: unknown = {},
  finality: 'optimistic' | 'final' = 'optimistic',
): Promise<T> {
  const result = await read('query', {
    request_type: 'call_function',
    finality,
    account_id: contract,
    method_name: method,
    args_base64: Buffer.from(JSON.stringify(args)).toString('base64'),
  });
  if (result.error) throw new RpcError('rpc', `${method}: ${result.error}`, { cause_name: 'CONTRACT_ERROR' });
  return JSON.parse(Buffer.from(result.result).toString());
}

export async function viewAccount(id: string, finality: 'optimistic' | 'final' = 'final'): Promise<{ amount: string; locked: string; storage_usage: number } | null> {
  try {
    const r = await read('query', { request_type: 'view_account', finality, account_id: id });
    return r.error ? null : r;
  } catch (e) {
    if (e instanceof RpcError && e.cause_name === 'UNKNOWN_ACCOUNT') return null;
    throw e;
  }
}

export async function viewAccessKey(id: string, publicKey: string, finality: 'optimistic' | 'final' = 'optimistic'): Promise<{ nonce: number; permission: unknown } | null> {
  try {
    const r = await read('query', { request_type: 'view_access_key', finality, account_id: id, public_key: publicKey });
    return r.error ? null : r;
  } catch (e) {
    if (e instanceof RpcError && (e.cause_name === 'UNKNOWN_ACCESS_KEY' || e.cause_name === 'UNKNOWN_ACCOUNT')) return null;
    throw e;
  }
}

export async function listAccessKeys(id: string): Promise<string[]> {
  const r = await read('query', { request_type: 'view_access_key_list', finality: 'optimistic', account_id: id });
  return (r.keys ?? []).map((k: { public_key: string }) => k.public_key);
}

let cachedBlock = { hash: '', height: 0, at: 0 };

/** Final, and at most a few seconds old. Used both for signing and for "is this lock irreversible yet". */
export async function finalBlock(maxAgeMs = 800): Promise<{ hash: string; height: number }> {
  if (Date.now() - cachedBlock.at <= maxAgeMs) return cachedBlock;
  const b = await read('block', { finality: 'final' });
  cachedBlock = { hash: b.header.hash, height: b.header.height, at: Date.now() };
  return cachedBlock;
}
