// Bare JSON-RPC over fetch: a player who only watches should never have to download a signing library.
import { ARCHIVE_URLS, CONTRACT, READ_URLS, SEND_URL } from './config';
import type { BlockRead, ChainReader, TxLookup } from '../verifyChain';
import type { ChainRoom } from './rooms';

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
const readUrls = () => (Date.now() < primaryCoolUntil ? [...READ_URLS].reverse() : READ_URLS);

function noteRefusal(url: string, e: unknown) {
  if (url === SEND_URL && isRefusal(e)) primaryCoolUntil = Date.now() + COOL_DOWN_MS;
}

/** Bursts are what get refused, and a board full of cards asking after their hosts would be one. */
const MAX_READS = 4;
let reading = 0;
const waiting: (() => void)[] = [];

async function inTurn<T>(work: () => Promise<T>): Promise<T> {
  if (reading >= MAX_READS) await new Promise<void>((resolve) => waiting.push(resolve));
  reading++;
  try {
    return await work();
  } finally {
    reading--;
    waiting.shift()?.();
  }
}

/** Tries each read endpoint in turn. An answer that means something (like "no such key") is final. */
function read(method: string, params: unknown, timeoutMs = 3000): Promise<any> {
  return inTurn(async () => {
    let last: unknown;
    for (const url of readUrls()) {
      try {
        return await post(url, method, params, timeoutMs);
      } catch (e) {
        if (e instanceof RpcError && e.settled) throw e;
        noteRefusal(url, e);
        last = e;
      }
    }
    throw last;
  });
}

function encodeArgs(args: unknown): string {
  return btoa(String.fromCharCode(...new TextEncoder().encode(JSON.stringify(args))));
}

const viewParams = (method: string, args: unknown, finality: Finality) => ({ request_type: 'call_function', finality, account_id: CONTRACT, method_name: method, args_base64: encodeArgs(args) });

function viewAnswer<T>(result: any): T {
  if (result.error) throw new RpcError(String(result.error), 'VIEW_FAILED');
  return JSON.parse(new TextDecoder().decode(Uint8Array.from(result.result))) as T;
}

export async function view<T>(method: string, args: unknown = {}, finality: Finality = 'optimistic'): Promise<T> {
  return viewAnswer<T>(await read('query', viewParams(method, args, finality), 4000));
}

/** The same view from one named node, for comparing nodes rather than getting past a busy one. */
async function viewAt<T>(url: string, method: string, args: unknown): Promise<T> {
  return viewAnswer<T>(await post(url, 'query', viewParams(method, args, 'optimistic'), 4000));
}

/** What a contract says when a room has left its ring, or never was. */
export const isGoneRoom = (e: unknown) => e instanceof RpcError && e.code === 'VIEW_FAILED' && /No such room/.test(e.message);

export type AccountView = { amount: string; locked: string; storage_usage: number; code_hash: string };

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

const ARCHIVE_TIMEOUT_MS = 6000;
/** Measured 2026-11-05 on FastNEAR's archive: 4 of 24 refused at 2.4 a second, 11 of 24 at 4 a second. */
const ARCHIVE_GAP_MS = 700;
/** Ordinary nodes took 5 a second without complaint, and a round is 15 to 40 lookups. */
const RECENT_GAP_MS = 120;
const ARCHIVE_RETRY_MS = 1500;

const pause = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

/**
 * Ordinary nodes first, then archival ones, which keep everything: if one of those hasn't heard of it, it never
 * was. Null means nobody could say. Once an ordinary node has pruned one thing from a round it has pruned the
 * rest, so `memory` stops further asking.
 */
async function readOld(method: string, params: unknown, unknownCode: string, memory: { old: boolean }, sleep: (ms: number) => Promise<void>): Promise<{ result: any } | 'gone' | null> {
  if (!memory.old) {
    for (const url of readUrls()) {
      try {
        return { result: await post(url, method, params, 4000) };
      } catch (e) {
        if (e instanceof RpcError && e.code === unknownCode) {
          memory.old = true;
          break;
        }
        noteRefusal(url, e);
      }
    }
  }
  for (const url of ARCHIVE_URLS) {
    for (const again of [true, false]) {
      try {
        return { result: await post(url, method, params, ARCHIVE_TIMEOUT_MS) };
      } catch (e) {
        if (e instanceof RpcError && e.code === unknownCode) return 'gone';
        if (!again || !isRefusal(e)) break;
        await sleep(ARCHIVE_RETRY_MS);
      }
    }
  }
  return null;
}

/** One per verification: what it learns about how old a round is shouldn't outlive the round. */
export function chainReader(sleep: (ms: number) => Promise<void> = pause): ChainReader {
  const memory = { old: false };
  let asked = false;
  const look = async (method: string, params: unknown, unknownCode: string) => {
    if (asked) await sleep(memory.old ? ARCHIVE_GAP_MS : RECENT_GAP_MS);
    asked = true;
    return readOld(method, params, unknownCode, memory, sleep);
  };
  return {
    async tx(hash, sender): Promise<TxLookup> {
      const answer = await look('tx', { tx_hash: hash, sender_account_id: sender, wait_until: 'NONE' }, 'UNKNOWN_TRANSACTION');
      if (answer === 'gone') return { gone: true };
      return answer ? { found: answer.result } : { unreachable: true };
    },
    async block(height): Promise<BlockRead | 'gone' | null> {
      const answer = await look('block', { block_id: height }, 'UNKNOWN_BLOCK');
      if (answer === 'gone') return 'gone';
      return answer ? answer.result.header : null;
    },
    roomOnEachNode: (id) => Promise.all(READ_URLS.map((url) => viewAt<ChainRoom>(url, 'get_room', { id }).catch(() => null))),
    codeHash: async () => (await viewAccount(CONTRACT))?.code_hash ?? null,
  };
}

const BACKUP_SEND_URL = READ_URLS[1];

/**
 * A refused request arrives with no CORS headers, so it looks like a network failure. If the main endpoint
 * refuses, the backup only hands the bytes over (its free plan stops answering at 2 s, too soon to wait for
 * a result) and the caller finds out how it went by looking the hash up. The same bytes can't run twice.
 */
export async function sendTx(signedBase64: string, signal: AbortSignal): Promise<any> {
  const backup = () => post(BACKUP_SEND_URL, 'send_tx', { signed_tx_base64: signedBase64, wait_until: 'NONE' }, 2500, signal);
  if (Date.now() < primaryCoolUntil) return backup();
  try {
    return await post(SEND_URL, 'send_tx', { signed_tx_base64: signedBase64, wait_until: 'EXECUTED_OPTIMISTIC' }, 30_000, signal);
  } catch (e) {
    if (!isRefusal(e) || signal.aborted) throw e;
    primaryCoolUntil = Date.now() + COOL_DOWN_MS;
    return backup();
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
