// Bare JSON-RPC over fetch: a player who only watches should never have to download a signing library.
import { CONTRACT, READ_URLS, SEND_URL } from './config';

export class RpcError extends Error {
  /** `settled` means the network answered and meant it. Anything else, another endpoint may do better. */
  constructor(message: string, readonly code: string, readonly data?: unknown, readonly settled = false) {
    super(message);
  }
}

type Finality = 'optimistic' | 'final';

async function post(url: string, method: string, params: unknown, timeoutMs: number, signal?: AbortSignal): Promise<any> {
  const timeout = AbortSignal.timeout(timeoutMs);
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ jsonrpc: '2.0', id: 'dig-here', method, params }),
    signal: signal ? AbortSignal.any([signal, timeout]) : timeout,
  });
  // 429 is normal weather on the shared endpoints, so it has to read as "try elsewhere".
  if (res.status === 429 || res.status >= 500) throw new RpcError(`RPC answered ${res.status}`, 'BUSY');
  const body = await res.json();
  if (body.error) {
    const data = body.error.data;
    const code = body.error.cause?.name ?? body.error.name ?? 'RPC_ERROR';
    // Rate limits and free-plan cut-offs from any provider arrive here too, in their own shapes.
    const settled = body.error.name === 'HANDLER_ERROR' && code !== 'TIMEOUT_ERROR' && code !== 'INTERNAL_ERROR';
    throw new RpcError(typeof data === 'string' ? data : (body.error.message ?? 'RPC error'), code, data, settled);
  }
  return body.result;
}

/** After a refusal, the next few calls go to the other endpoint. Knocking again only prolongs the limit. */
const COOL_DOWN_MS = 10_000;
let primaryCoolUntil = 0;

const isRefusal = (e: unknown) => e instanceof TypeError || (e instanceof RpcError && e.code === 'BUSY');

/** Tries each read endpoint in turn. An answer that means something (like "no such key") is final. */
async function read(method: string, params: unknown, timeoutMs = 3000): Promise<any> {
  const urls = Date.now() < primaryCoolUntil ? [...READ_URLS].reverse() : READ_URLS;
  let last: unknown;
  for (const url of urls) {
    try {
      return await post(url, method, params, timeoutMs);
    } catch (e) {
      if (e instanceof RpcError && e.settled) throw e;
      if (url === SEND_URL && isRefusal(e)) primaryCoolUntil = Date.now() + COOL_DOWN_MS;
      last = e;
    }
  }
  throw last;
}

function encodeArgs(args: unknown): string {
  return btoa(String.fromCharCode(...new TextEncoder().encode(JSON.stringify(args))));
}

export async function view<T>(method: string, args: unknown = {}, finality: Finality = 'optimistic'): Promise<T> {
  const result = await read('query', { request_type: 'call_function', finality, account_id: CONTRACT, method_name: method, args_base64: encodeArgs(args) }, 4000);
  if (result.error) throw new RpcError(String(result.error), 'VIEW_FAILED');
  return JSON.parse(new TextDecoder().decode(Uint8Array.from(result.result))) as T;
}

export type AccountView = { amount: string; locked: string; storage_usage: number };

export async function viewAccount(id: string): Promise<AccountView | null> {
  try {
    const result = await read('query', { request_type: 'view_account', finality: 'optimistic', account_id: id });
    return result.error ? null : result;
  } catch (e) {
    if (e instanceof RpcError && e.code === 'UNKNOWN_ACCOUNT') return null;
    throw e;
  }
}

export type AccessKeyView = { nonce: number; block_hash: string };

/** Null when the key isn't on the account, which is what a swept guest looks like. */
export async function viewAccessKey(id: string, publicKey: string): Promise<AccessKeyView | null> {
  try {
    const result = await read('query', { request_type: 'view_access_key', finality: 'optimistic', account_id: id, public_key: publicKey });
    return result.error ? null : result;
  } catch (e) {
    if (e instanceof RpcError && (e.code === 'UNKNOWN_ACCESS_KEY' || e.code === 'UNKNOWN_ACCOUNT')) return null;
    throw e;
  }
}

export type BlockHeader = { height: number; hash: string; prev_hash: string; random_value: string; timestamp: number; timestamp_nanosec: string };

export async function blockAt(height: number): Promise<BlockHeader> {
  const result = await read('block', { block_id: height });
  return result.header;
}

const BACKUP_SEND_URL = READ_URLS[1];

/**
 * A refused request arrives with no CORS headers, so it looks like a network failure. If the main endpoint
 * refuses, the backup only hands the bytes over (its free plan stops answering at 2 s, too soon to wait for
 * a result) and the caller finds out how it went by looking the hash up. The same bytes can't run twice.
 */
export async function sendTx(signedBase64: string, signal: AbortSignal): Promise<any> {
  try {
    return await post(SEND_URL, 'send_tx', { signed_tx_base64: signedBase64, wait_until: 'EXECUTED_OPTIMISTIC' }, 30_000, signal);
  } catch (e) {
    if (!isRefusal(e) || signal.aborted) throw e;
    primaryCoolUntil = Date.now() + COOL_DOWN_MS;
    return post(BACKUP_SEND_URL, 'send_tx', { signed_tx_base64: signedBase64, wait_until: 'NONE' }, 2500, signal);
  }
}

/** Null while the network hasn't heard of the transaction, or hasn't finished running it. */
export async function txStatus(hash: string, sender: string): Promise<any | null> {
  try {
    return await read('tx', { tx_hash: hash, sender_account_id: sender, wait_until: 'NONE' });
  } catch (e) {
    if (e instanceof RpcError && (e.code === 'UNKNOWN_TRANSACTION' || e.code === 'TIMEOUT_ERROR')) return null;
    throw e;
  }
}
