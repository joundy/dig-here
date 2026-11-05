// Loaded only when someone clicks "Connect NEAR wallet", or needs their wallet for a top-up.
import { NearConnector } from '@hot-labs/near-connect';
import { createAccessKeyPlugin } from 'function-call-key-plugin';
import { KeyPair } from 'near-api-js';
import type { KeyPairString } from 'near-api-js';
import { isTestnetAccount } from './choices';
import { CONTRACT, GAME_METHODS, SEND_URL } from './config';
import { viewAccessKey } from './rpc';
import { forgetWalletKey, walletKey } from './session';

const providers = { testnet: [SEND_URL] };
/** The wallet waits for its add-key transaction, but reads can lag it by a block or two. */
const KEY_CHECKS = 8;
const KEY_CHECK_GAP_MS = 1000;

let connector: Promise<NearConnector> | null = null;

function getConnector(): Promise<NearConnector> {
  connector ??= (async () => {
    const near = new NearConnector({
      network: 'testnet',
      providers,
      // A wallet that can't add a key would ask for an approval on every dig, which would kill the game.
      features: { signInWithFunctionCallKey: true },
    });
    await near.use(createAccessKeyPlugin({ network: 'testnet', providers, signIn: { contractId: CONTRACT, methodNames: GAME_METHODS } }));
    return near;
  })();
  return connector;
}

async function keyIsOnChain(accountId: string): Promise<boolean> {
  const stored = walletKey(accountId);
  if (!stored) return false;
  const publicKey = KeyPair.fromString(stored.secretKey as KeyPairString).getPublicKey().toString();
  for (let check = 0; check < KEY_CHECKS; check++) {
    if (check) await new Promise((resolve) => setTimeout(resolve, KEY_CHECK_GAP_MS));
    if (await viewAccessKey(accountId, publicKey).catch(() => null)) return true;
  }
  return false;
}

/** `keyAdded` is false when the wallet signed in but skipped the game's key, so every move would ask for an approval. */
export async function connectWallet(): Promise<{ accountId: string; keyAdded: boolean }> {
  const near = await getConnector();
  // The list comes from a file on GitHub and an empty one is what a failed download looks like.
  if (!near.availableWallets.length) throw new Error('NoWallets');
  const wallet = await near.connect();
  const accounts = await wallet.getAccounts();
  const accountId = accounts[0]?.accountId;
  if (!accountId) throw new Error('rejected: no account came back');
  if (!isTestnetAccount(accountId)) {
    await near.disconnect(wallet).catch(() => undefined);
    forgetWalletKey(accountId);
    throw new Error(`WrongNetwork: ${accountId}`);
  }
  return { accountId, keyAdded: await keyIsOnChain(accountId) };
}

export async function disconnectWallet(accountId: string): Promise<void> {
  const near = await getConnector();
  await near.disconnect().catch(() => undefined);
  forgetWalletKey(accountId);
}

/** A call the wallet has to approve, because it attaches coins or because the game's own key can't make it. */
export async function callWithDeposit(accountId: string, method: string, args: object, gasTgas: number, depositYocto: string): Promise<any> {
  const near = await getConnector();
  const { wallet } = await near.getConnectedWallet();
  return wallet.signAndSendTransaction({
    signerId: accountId,
    receiverId: CONTRACT,
    actions: [{ type: 'FunctionCall', params: { methodName: method, args, gas: `${BigInt(gasTgas) * 1_000_000_000_000n}`, deposit: depositYocto } }],
  });
}
