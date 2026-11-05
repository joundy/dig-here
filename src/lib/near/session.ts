// Who this browser plays as. The only thing kept here is a name: the wallet holds the account, and the plugin keeps
// the game's function-call key. That key can't withdraw, but whoever holds it can spend the game balance through the
// game (security review, finding 1), so it's no safer than the page it's on.
export type WalletSession = { kind: 'wallet'; accountId: string };
export type Session = WalletSession;

const SESSION_KEY = 'dig-here-near-session';
// Left by the guest accounts this game used to make. The accounts are gone, so their keys are of no use to anyone.
const OLD_GUEST_KEYS = ['dig-here-near-guest', 'dig-here-near-choice'];
const walletKeyName = (accountId: string) => `access_key::plugin::testnet::${accountId}`;

function loadJson<T>(key: string): T | null {
  try {
    const saved = localStorage.getItem(key);
    return saved ? (JSON.parse(saved) as T) : null;
  } catch {
    return null;
  }
}

function saveJson(key: string, value: unknown) {
  try {
    if (value === null) localStorage.removeItem(key);
    else localStorage.setItem(key, JSON.stringify(value));
  } catch {
    // Private browsing can refuse storage. Then the session lasts until the tab closes.
  }
}

/** A returning guest's session and key go here too, so a browser never holds on to them. */
export function loadSession(): Session | null {
  for (const key of OLD_GUEST_KEYS) saveJson(key, null);
  const saved = loadJson<{ kind?: string; accountId?: string }>(SESSION_KEY);
  if (saved?.kind === 'wallet' && saved.accountId) return { kind: 'wallet', accountId: saved.accountId };
  if (saved) saveJson(SESSION_KEY, null);
  return null;
}

export const saveSession = (session: Session | null) => saveJson(SESSION_KEY, session);

/** The function-call key the wallet plugin stored at sign-in. Using it means digs never ask the wallet. */
export function walletKey(accountId: string): { secretKey: string } | null {
  const stored = loadJson<{ privateKey?: string }>(walletKeyName(accountId));
  return stored?.privateKey ? { secretKey: stored.privateKey } : null;
}

/** The plugin clears this on a clean sign-out, but a wallet that fails to answer mustn't leave a spending key behind. */
export const forgetWalletKey = (accountId: string) => saveJson(walletKeyName(accountId), null);
