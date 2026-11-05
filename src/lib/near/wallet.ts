// Loaded only when someone clicks "Connect NEAR wallet", or needs their wallet for a top-up.
import { NearConnector } from '@hot-labs/near-connect';
import { createAccessKeyPlugin } from 'function-call-key-plugin';
import { CONTRACT, GAME_METHODS, SEND_URL } from './config';

const providers = { testnet: [SEND_URL] };
let connector: NearConnector | null = null;

async function getConnector(): Promise<NearConnector> {
  if (connector) return connector;
  connector = new NearConnector({
    network: 'testnet',
    providers,
    // A wallet that can't add a key would ask for an approval on every dig, which would kill the game.
    features: { signInWithFunctionCallKey: true },
  });
  await connector.use(createAccessKeyPlugin({ network: 'testnet', providers, signIn: { contractId: CONTRACT, methodNames: GAME_METHODS } }));
  return connector;
}

export async function connectWallet(): Promise<string> {
  const near = await getConnector();
  const wallet = await near.connect();
  const accounts = await wallet.getAccounts();
  const accountId = accounts[0]?.accountId;
  if (!accountId) throw new Error('rejected: no account came back');
  return accountId;
}

export async function disconnectWallet(): Promise<void> {
  const near = await getConnector();
  await near.disconnect().catch(() => undefined);
}

/** A call that attaches coins, so the wallet has to approve it. */
export async function callWithDeposit(accountId: string, method: string, args: object, gasTgas: number, depositYocto: string): Promise<any> {
  const near = await getConnector();
  const { wallet } = await near.getConnectedWallet();
  return wallet.signAndSendTransaction({
    signerId: accountId,
    receiverId: CONTRACT,
    actions: [{ type: 'FunctionCall', params: { methodName: method, args, gas: `${BigInt(gasTgas) * 1_000_000_000_000n}`, deposit: depositYocto } }],
  });
}
