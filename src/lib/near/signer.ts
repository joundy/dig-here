// The only file that pulls in near-api-js, so someone who only watches never downloads it.
import { actions, createTransaction, KeyPair, KeyPairSigner, baseDecode, baseEncode } from 'near-api-js';
import type { KeyPairString } from 'near-api-js';
import { CONTRACT } from './config';
import { sendReliably } from './send';
import { sendTx, txStatus, viewAccessKey, RpcError } from './rpc';

export type Call = { method: string; args: object; gasTgas: number };

const TGAS = 1_000_000_000_000n;
/** Well inside the network's validity period for a block hash. */
const BLOCK_HASH_MS = 10 * 60 * 1000;

export function newKeyPair(): { publicKey: string; secretKey: string } {
  const pair = KeyPair.fromRandom('ed25519');
  return { publicKey: pair.getPublicKey().toString(), secretKey: pair.toString() };
}

function toBase64(bytes: Uint8Array): string {
  let text = '';
  for (let i = 0; i < bytes.length; i += 0x8000) text += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(text);
}

/** Signs and sends with a key this browser holds. One at a time per key, so nonces can't collide. */
export class KeySender {
  #pair: KeyPair;
  #signer: KeyPairSigner;
  #publicKey: string;
  #lastNonce = 0n;
  #blockHash = '';
  #blockHashAt = 0;
  #queue: Promise<unknown> = Promise.resolve();

  constructor(readonly accountId: string, secretKey: string) {
    this.#pair = KeyPair.fromString(secretKey as KeyPairString);
    this.#signer = new KeyPairSigner(this.#pair);
    this.#publicKey = this.#pair.getPublicKey().toString();
  }

  get publicKey() {
    return this.#publicKey;
  }

  send(call: Call, onSlow?: () => void): Promise<any> {
    const run = this.#queue.then(() => this.#send(call, onSlow));
    this.#queue = run.catch(() => undefined);
    return run;
  }

  /** Reads the key's nonce. Throws if the key is gone. Never lowers the nonce: an unseen send may still land. */
  async prepare() {
    const key = await viewAccessKey(this.accountId, this.#publicKey);
    if (!key) throw new RpcError('UNKNOWN_ACCESS_KEY', 'UNKNOWN_ACCESS_KEY');
    this.#blockHash = key.block_hash;
    this.#blockHashAt = Date.now();
    const chain = BigInt(key.nonce);
    if (chain > this.#lastNonce) this.#lastNonce = chain;
  }

  async #send(call: Call, onSlow?: () => void) {
    return sendReliably({
      nextNonce: async (fresh) => {
        // A read shaved off every dig matters more than the odd refused nonce, which sends it back here.
        if (fresh || !this.#lastNonce || Date.now() - this.#blockHashAt > BLOCK_HASH_MS) await this.prepare();
        return ++this.#lastNonce;
      },
      sign: async (nonce) => {
        const tx = createTransaction(
          this.accountId,
          this.#pair.getPublicKey(),
          CONTRACT,
          nonce,
          [actions.functionCall(call.method, call.args, BigInt(call.gasTgas) * TGAS, 0n)],
          baseDecode(this.#blockHash),
        );
        const { txHash, signedTransaction } = await this.#signer.signTransaction(tx);
        return { hash: baseEncode(txHash), base64: toBase64(signedTransaction.encode()), nonce };
      },
      send: sendTx,
      status: (hash) => txStatus(hash, this.accountId),
    }, onSlow);
  }
}
