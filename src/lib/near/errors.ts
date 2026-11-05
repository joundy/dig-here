// What a player sees when something goes wrong. The contract's own panics are already written for them.

/** True for messages that mean the key is gone, as when a guest was swept after going idle. */
export function isMissingKey(raw: string): boolean {
  return /AccessKeyNotFound|UNKNOWN_ACCESS_KEY|InvalidAccessKeyError|does not exist while viewing|has no key|Can't complete the action because access key/i.test(raw);
}

export function isOutOfAllowance(raw: string): boolean {
  return /NotEnoughAllowance/.test(raw);
}

export function panicMessage(raw: string): string | null {
  const found = raw.match(/Smart contract panicked: (.+)/);
  if (!found) return null;
  const text = found[1].split(/"[,}]|\\n/)[0].trim().replace(/"+$/, '');
  return text || null;
}

export function plainError(raw: string): string {
  const panic = panicMessage(raw);
  if (panic) return panic;
  if (/Exceeded the prepaid gas|GasExceeded|GasLimitExceeded/i.test(raw)) return 'That took more digging than expected. Nothing was spent, so try again.';
  if (isOutOfAllowance(raw) || /NotEnoughBalance|LackBalanceForState/.test(raw)) return "This account is out of coins for moves. Connect a wallet, or come back as a new guest.";
  if (isMissingKey(raw)) return 'Your guest pass has expired after a long nap. Try that again and you get a new one.';
  if (/DepositWithFunctionCall|Deposit is not allowed/i.test(raw)) return 'Guests can\'t do that. Connect a wallet for it.';
  if (/InvalidNonce|InvalidTxError|Expired/i.test(raw)) return 'That move got tangled up. Nothing was spent, so try again.';
  if (/rejected|cancel/i.test(raw)) return 'You turned that down in your wallet.';
  if (/Failed to fetch|NetworkError|Load failed|TimeoutError|aborted|BUSY|RPC answered/i.test(raw)) return "Can't reach the island right now. Check your connection and try again.";
  return 'Something went wrong on the way there. Your coins are safe, so try again.';
}
