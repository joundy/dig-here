// Everything here is testnet. A mainnet build would change this file and nothing else.
export const CONTRACT = 'v1.dighere.testnet';
export const BOT_SUFFIX = '.bots.dighere.testnet';
export const GUEST_SUFFIX = '.guests.dighere.testnet';

// FastNEAR first. dRPC ends every free request at about 2 s, so it only backs up reads, never sends.
export const SEND_URL = 'https://test.rpc.fastnear.com';
export const READ_URLS = [SEND_URL, 'https://near-testnet.drpc.org'];

const EXPLORER = 'https://testnet.nearblocks.io';
export const explorer = {
  account: (id: string) => `${EXPLORER}/address/${id}`,
  tx: (hash: string) => `${EXPLORER}/txns/${hash}`,
  block: (hash: string) => `${EXPLORER}/blocks/${hash}`,
};

/** Gas is bought at 10x its burn price up front, so these stay near the measured worst cases in the gas doc. */
export const GAS_TGAS = {
  dig: 5,
  join: 10,
  leave: 10,
  start: 10,
  list_nft: 10,
  deposit: 10,
  withdraw: 10,
  poke: 30,
  mint_nft: 30,
  buy_nft: 30,
  nft_transfer: 30,
  create_room: 60,
} as const;

/** The methods a browser key may call, the same list a guest's key allows. */
export const GAME_METHODS = ['join', 'leave', 'start', 'dig', 'create_room', 'mint_nft', 'list_nft', 'buy_nft', 'poke'];

/** The visible dig window closes this long before the contract's own end, because a dig takes 1.4 to 2.6 s to run. */
export const DIG_CLOSE_MS = 2500;

/** Testnet fee choices in the host form, in milliNEAR. */
export const FEE_CHOICES = [10, 50, 100, 250];
