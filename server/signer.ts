import { actions, baseDecode, baseEncode, createTransaction, KeyPair, KeyPairSigner, type Action } from 'near-api-js';
import { addBurn } from './burn.ts';
import { log, sleep } from './log.ts';
import { fastnearCooling, finalBlock, read, RpcError, sendRaw, viewAccessKey } from './rpc.ts';
import { TGAS } from './units.ts';

export type TxResult = { hash: string; ok: boolean; failure?: string; value: any; logs: string[]; burnt: bigint };
export type SendOptions = {
  wait?: 'INCLUDED' | 'EXECUTED_OPTIMISTIC' | 'FINAL';
  /** A send can vanish on testnet. How long one attempt waits before checking the hash. */
  patienceMs?: number;
  /** How long to keep watching and rebroadcasting these bytes before calling them lost. */
  giveUpMs?: number;
  /** False where a late first copy landing after a second would do harm, such as commitments that take an index. */
  resign?: boolean;
};

export class LostTransaction extends Error {}

function failureText(failure: any): string {
  const exec = failure?.ActionError?.kind?.FunctionCallError?.ExecutionError;
  if (exec) return String(exec).replace(/^Smart contract panicked: /, '');
  return JSON.stringify(failure);
}

function parseOutcome(hash: string, r: any): TxResult {
  const receipts = r.receipts_outcome ?? [];
  const burnt = receipts.reduce((sum: bigint, o: any) => sum + BigInt(o.outcome.tokens_burnt ?? 0), BigInt(r.transaction_outcome?.outcome?.tokens_burnt ?? 0));
  const logs = receipts.flatMap((o: any) => o.outcome.logs ?? []);
  const status = r.status ?? {};
  if (status.Failure) return { hash, ok: false, failure: failureText(status.Failure), value: null, logs, burnt };
  let value: any = null;
  if (typeof status.SuccessValue === 'string' && status.SuccessValue) {
    const text = Buffer.from(status.SuccessValue, 'base64').toString();
    try {
      value = JSON.parse(text);
    } catch {
      value = text;
    }
  }
  return { hash, ok: true, value, logs, burnt };
}

const isExecuted = (r: any) => r?.status && (r.status.SuccessValue !== undefined || r.status.Failure !== undefined || r.status.SuccessReceiptId !== undefined);

async function checkByHash(hash: string, sender: string, wait: string): Promise<any | null> {
  try {
    const r = await read('tx', { tx_hash: hash, sender_account_id: sender, wait_until: wait }, 4000);
    return isExecuted(r) ? r : null;
  } catch {
    return null;
  }
}

/** Best effort, down a second path. Its answer doesn't matter, because the hash check decides what happened. */
async function rebroadcast(signedB64: string): Promise<void> {
  try {
    await sendRaw('send_tx', { signed_tx_base64: signedB64, wait_until: 'NONE' }, 3000, true);
  } catch {
    // Watching the hash covers this too.
  }
}

/**
 * Tries to get one signed transaction onto the chain, watching the hash rather than trusting the response. Sending
 * the same bytes again through the same node did nothing in testing (it remembers them), so the second try goes
 * through dRPC. If that's lost too, the caller signs a new transaction.
 */
async function deliver(signedB64: string, hash: string, sender: string, opts: SendOptions): Promise<any> {
  const wait = opts.wait ?? 'EXECUTED_OPTIMISTIC';
  const patience = opts.patienceMs ?? (wait === 'FINAL' ? 15_000 : 8000);
  const giveUpAt = Date.now() + (opts.giveUpMs ?? patience + 5000);
  for (let attempt = 0; attempt === 0 || Date.now() < giveUpAt; attempt++) {
    try {
      // dRPC ends free requests at about 2 s, so it can only take a send that doesn't wait for the result.
      const direct = attempt === 0 && !fastnearCooling();
      if (!direct && (attempt === 0 || attempt % 3 === 1)) void rebroadcast(signedB64);
      const r = direct ? await sendRaw('send_tx', { signed_tx_base64: signedB64, wait_until: wait }, patience) : null;
      if (r && isExecuted(r)) return r;
    } catch (e) {
      const err = e as RpcError;
      if (!err.transient) {
        // An earlier copy may have landed, and then these same bytes come back as a bad nonce.
        if (attempt > 0) {
          const landed = await checkByHash(hash, sender, wait);
          if (landed) return landed;
        }
        throw err;
      }
    }
    const landed = await checkByHash(hash, sender, wait);
    if (landed) return landed;
    await sleep(700);
  }
  throw new LostTransaction(`transaction ${hash} did not land`);
}

/** One key is one nonce sequence, so one lane sends one transaction at a time and a lost send delays only itself. */
class Lane {
  readonly signer: KeyPairSigner;
  readonly publicKey: ReturnType<KeyPair['getPublicKey']>;
  nonce: bigint | null = null;
  pending = 0;
  #tail: Promise<unknown> = Promise.resolve();

  constructor(keyPair: KeyPair) {
    this.signer = new KeyPairSigner(keyPair);
    this.publicKey = keyPair.getPublicKey();
  }

  queue<T>(job: () => Promise<T>): Promise<T> {
    this.pending++;
    const run = this.#tail.then(job, job).finally(() => this.pending--);
    this.#tail = run.catch(() => {});
    return run;
  }

  async nextNonce(accountId: string): Promise<bigint> {
    if (this.nonce === null) {
      const key = await viewAccessKey(accountId, this.publicKey.toString());
      if (!key) throw new Error(`no access key for ${accountId} on this lane`);
      this.nonce = BigInt(key.nonce);
    }
    this.nonce += 1n;
    return this.nonce;
  }
}

export class NearAccount {
  readonly id: string;
  readonly role: string;
  #lanes: Lane[];

  constructor(id: string, role: string, keyPairs: KeyPair[]) {
    if (!keyPairs.length) throw new Error(`${id} needs a key`);
    this.id = id;
    this.role = role;
    this.#lanes = keyPairs.map((k) => new Lane(k));
  }

  /** Function-call keys added later become extra lanes, while the first key stays for account-level work. */
  setLanes(keyPairs: KeyPair[]): void {
    this.#lanes = keyPairs.map((k) => new Lane(k));
  }

  get laneCount(): number {
    return this.#lanes.length;
  }

  /** Lanes are chosen least busy first, so concurrent sends take separate nonce sequences. */
  send(receiver: string, acts: Action[], opts: SendOptions = {}): Promise<TxResult> {
    const lane = this.#lanes.reduce((a, b) => (b.pending < a.pending ? b : a));
    return lane.queue(() => this.#execute(lane, receiver, acts, opts));
  }

  call(contract: string, method: string, args: unknown, tgas: number, deposit = 0n, opts: SendOptions = {}): Promise<TxResult> {
    return this.send(contract, [actions.functionCall(method, args as object, BigInt(tgas) * TGAS, deposit)], opts);
  }

  transfer(to: string, amount: bigint, opts: SendOptions = {}): Promise<TxResult> {
    return this.send(to, [actions.transfer(amount)], opts);
  }

  async #execute(lane: Lane, receiver: string, acts: Action[], opts: SendOptions): Promise<TxResult> {
    let staleNonces = 0;
    let stuck = 0;
    const earlier: string[] = [];
    for (let lost = 0; ; ) {
      // A lost transaction keeps its nonce used up locally, so the next one is higher and kills it if it ever turns up.
      const nonce = await lane.nextNonce(this.id);
      const block = await finalBlock(20_000);
      const tx = createTransaction(this.id, lane.publicKey, receiver, nonce, acts, baseDecode(block.hash));
      const { txHash, signedTransaction } = await lane.signer.signTransaction(tx);
      const hash = baseEncode(txHash);
      const bytes = Buffer.from(signedTransaction.encode()).toString('base64');
      try {
        const outcome = await deliver(bytes, hash, this.id, opts);
        const result = parseOutcome(hash, outcome);
        addBurn(this.role, result.burnt);
        if (!result.ok && earlier.length) {
          // The copy we gave up on can land after all, and then this one fails only because it's a repeat.
          for (const old of earlier) {
            const late = await checkByHash(old, this.id, 'EXECUTED_OPTIMISTIC');
            if (late) return parseOutcome(old, late);
          }
        }
        return result;
      } catch (e) {
        if (e instanceof LostTransaction && opts.resign !== false && ++lost <= 3) {
          earlier.push(hash);
          log('signer', `${this.id}: send lost, signing again`, { hash, lost });
          continue;
        }
        lane.nonce = null;
        // Testnet shards do stall for a while. Refused outright, so nothing was sent.
        if (e instanceof RpcError && /ShardStuck/.test(JSON.stringify(e.data ?? '')) && ++stuck <= 4) {
          log('signer', `${this.id}: a shard is stuck, waiting`, { receiver });
          await sleep(4000);
          continue;
        }
        // A stale view of the nonce: nothing was sent, so signing again can't pay twice.
        if (e instanceof RpcError && /InvalidNonce/.test(JSON.stringify(e.data ?? '') + e.message) && ++staleNonces <= 4) {
          log('signer', `${this.id}: stale nonce, signing again`);
          continue;
        }
        throw e;
      }
    }
  }
}
