// Everything here is testnet. A mainnet build would change this file and nothing else.
export const CONTRACT = 'v1.dighere.testnet';
export const BOT_SUFFIX = '.bots.dighere.testnet';

// FastNEAR first. dRPC ends every free request at about 2 s, so it only backs up reads, never sends.
export const SEND_URL = 'https://test.rpc.fastnear.com';
export const READ_URLS = [SEND_URL, 'https://near-testnet.drpc.org'];
export const READ_HOSTS = READ_URLS.map((url) => new URL(url).host);

// Ordinary nodes had already forgotten a 5-day-old transaction on 2026-11-05. These two served one from 2021,
// and allow browsers. near.org takes over 3 s and rations hard, so it's the last resort.
export const ARCHIVE_URLS = ['https://archival-rpc.testnet.fastnear.com', 'https://archival-rpc.testnet.near.org'];
export const ARCHIVE_HOSTS = ARCHIVE_URLS.map((url) => new URL(url).host);

// Help for someone with no testnet wallet yet. The plan's "no guest accounts" section says what was tried, and when.
export const WALLET_URL = 'https://wallet.meteorwallet.app';
export const WALLET_LIST_URL = 'https://wallet.near.org';
export const FAUCET_URL = 'https://docs.near.org/getting-started/faucet';

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

/** The methods a browser key may call. `buy_nft` needs 1 yocto, which a function-call key can't attach. */
export const GAME_METHODS = ['join', 'leave', 'start', 'dig', 'create_room', 'mint_nft', 'list_nft', 'poke'];

/** The visible dig window closes this long before the contract's own end, because a dig takes 1.4 to 2.6 s to run. */
export const DIG_CLOSE_MS = 2500;

/** Testnet fee choices in the host form, in milliNEAR. */
export const FEE_CHOICES = [10, 50, 100, 250];
