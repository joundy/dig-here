// Sends get lost on testnet in spells (research section 5), and a timeout doesn't say whether the
// transaction landed. So: wait 8 s, look the hash up, and only then sign again with a new nonce.
import { RpcError } from './rpc';
import { isDone } from './outcome';

export const STOP_WAITING_MS = 8000;
const CHECKS = 4;
const CHECK_GAP_MS = 1500;
const BUSY_RETRY_MS = 700;
const ATTEMPTS = 3;

export type Signed = { hash: string; base64: string; nonce: bigint };

export type SendDeps = {
  /** The next nonce to use, always above anything this session has signed. */
  nextNonce(fresh: boolean): Promise<bigint>;
  sign(nonce: bigint): Promise<Signed>;
  send(base64: string, signal: AbortSignal): Promise<any>;
  /** The transaction as the network knows it, or null if it doesn't. */
  status(hash: string): Promise<any | null>;
  sleep?(ms: number): Promise<void>;
};

type Delivery = { done: any } | { lost: true } | { staleNonce: true };

const pause = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

function isStaleNonce(e: unknown): boolean {
  return JSON.stringify((e as RpcError)?.data ?? '').includes('InvalidNonce') || String((e as Error)?.message).includes('InvalidNonce');
}

async function deliver(deps: SendDeps, signed: Signed, sleep: (ms: number) => Promise<void>): Promise<Delivery> {
  const stop = new AbortController();
  const timer = setTimeout(() => stop.abort(), STOP_WAITING_MS);
  try {
    while (!stop.signal.aborted) {
      try {
        const raw = await deps.send(signed.base64, stop.signal);
        // The network accepted it but stopped waiting before it ran. Treat that as a lookup, not a loss.
        return isDone(raw) ? { done: raw } : { lost: true };
      } catch (e) {
        if (stop.signal.aborted) return { lost: true };
        if (isStaleNonce(e)) return { staleNonce: true };
        const code = (e as RpcError).code;
        if (code === 'TIMEOUT_ERROR' || code === 'REQUEST_ROUTED') return { lost: true };
        // Refused by the endpoint or the network dropped: the same signed bytes are safe to send again.
        if (code === 'BUSY' || e instanceof TypeError) {
          await sleep(BUSY_RETRY_MS);
          continue;
        }
        throw e;
      }
    }
    return { lost: true };
  } finally {
    clearTimeout(timer);
  }
}

/** `onSlow` fires once the player has waited long enough to deserve a word about it. */
export async function sendReliably(deps: SendDeps, onSlow?: () => void): Promise<any> {
  const sleep = deps.sleep ?? pause;
  let fresh = false;
  for (let attempt = 0; attempt < ATTEMPTS; attempt++) {
    const nonce = await deps.nextNonce(fresh);
    const signed = await deps.sign(nonce);
    const delivery = await deliver(deps, signed, sleep);
    if ('done' in delivery) return delivery.done;
    if ('staleNonce' in delivery) {
      // Refused before it could run, so signing again can't double anything.
      fresh = true;
      continue;
    }

    onSlow?.();
    for (let check = 0; check < CHECKS; check++) {
      const raw = await deps.status(signed.hash).catch(() => null);
      if (raw && isDone(raw)) return raw;
      await sleep(CHECK_GAP_MS);
    }
    fresh = true;
  }
  throw new RpcError('The network lost this move three times.', 'LOST');
}
