// What a player sees when something goes wrong. The contract's own panics are already written for them.

/** True for messages that mean the game's key is gone from the account. */
export function isMissingKey(raw: string): boolean {
  return /AccessKeyNotFound|UNKNOWN_ACCESS_KEY|InvalidAccessKeyError|does not exist while viewing|has no key|Can't complete the action because access key/i.test(raw);
}

export function isOutOfAllowance(raw: string): boolean {
  return /NotEnoughAllowance/.test(raw);
}

/** The wallet's own session is gone, as when its storage was cleared. Only signing in again fixes that. */
export function isSignedOut(raw: string): boolean {
  return /No wallet selected|No accounts found|No signed-in account/i.test(raw);
}

export function panicMessage(raw: string): string | null {
  const found = raw.match(/Smart contract panicked: (.+)/);
  if (!found) return null;
  const text = found[1].split(/"[,}]|\\n/)[0].trim().replace(/"+$/, '');
  return text || null;
}

export const NO_COINS = 'Your wallet is out of testnet coins. Grab some free ones from the faucet, then try again.';

/** The market and the NFT standard say these to developers. A player gets what it means for them. */
const MARKET_WORDS: [RegExp, string][] = [
  [/^Attach at least the price/, 'The price went up just now, so nothing was spent. Check it and try again.'],
  [/^Attach at least \d+ Tgas/, 'That took more digging than expected. Nothing was spent, so try again.'],
  [/^This NFT isn't for sale/, 'That listing has just ended, so nothing was spent.'],
  [/^Only the seller can change the price/, "You don't own this listing any more."],
  [/must be token owner|Unauthorized|Sender not approved/i, "You don't own this NFT any more."],
  [/^Token not found/i, "That NFT hasn't been minted yet."],
  [/msg must be/, "That price didn't work. Try a plain number, like 1.5."],
];

export function plainError(raw: string): string {
  const panic = panicMessage(raw);
  if (panic) return MARKET_WORDS.find(([pattern]) => pattern.test(panic))?.[1] ?? panic;
  const wrong = raw.match(/WrongNetwork: (\S+)/);
  if (wrong) return `${wrong[1]} isn't a testnet account. This game runs on NEAR testnet, so switch your wallet to testnet and pick an account ending in .testnet.`;
  if (/NoWallets/.test(raw)) return "Couldn't load the list of wallets. Check your connection and try again.";
  if (/Exceeded the prepaid gas|GasExceeded|GasLimitExceeded/i.test(raw)) return 'That took more digging than expected. Nothing was spent, so try again.';
  if (isOutOfAllowance(raw)) return "Your game key has run out of moves. Try again, and your wallet will ask you to approve it.";
  if (/NotEnoughBalance|LackBalanceForState|insufficient|not enough (balance|near|funds)/i.test(raw)) return NO_COINS;
  if (isSignedOut(raw)) return 'Your wallet has signed out of the game. Connect it again to carry on.';
  if (isMissingKey(raw)) return "The game's key isn't on your account any more. Disconnect, then connect your wallet again.";
  if (/DepositWithFunctionCall|Deposit is not allowed/i.test(raw)) return 'That needs an approval from your wallet. Try again.';
  if (/InvalidNonce|InvalidTxError|Expired/i.test(raw)) return 'That move got tangled up. Nothing was spent, so try again.';
  if (/refused to allow the popup|pop-?up/i.test(raw)) return 'Your browser blocked the wallet window. Allow pop-ups for this site, then try again.';
  if (/closed|didn't complete|cancel|Failed to sign in/i.test(raw)) return 'The wallet window closed before it finished. Nothing happened, so try again when you\'re ready.';
  if (/reject|declin|denied/i.test(raw)) return 'Your wallet said no, so nothing happened. Try again when you\'re ready.';
  if (/Failed to fetch|NetworkError|Load failed|TimeoutError|aborted|BUSY|RPC answered/i.test(raw)) return "Can't reach the island right now. Check your connection and try again.";
  // Worth finding in a report: the player only gets the line below.
  console.warn('Unrecognised error:', raw);
  return 'Something went wrong on the way there. Your coins are safe, so try again.';
}
