// Who this browser plays as. A guest's key lives here, and it can't take coins out of the game.
export type GuestSession = { kind: 'guest'; accountId: string; secretKey: string; publicKey: string };
export type WalletSession = { kind: 'wallet'; accountId: string };
export type Session = GuestSession | WalletSession;

const SESSION_KEY = 'dig-here-near-session';
const GUEST_KEY = 'dig-here-near-guest';
const CHOICE_KEY = 'dig-here-near-choice';

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

export const loadSession = () => loadJson<Session>(SESSION_KEY);
export const saveSession = (session: Session | null) => saveJson(SESSION_KEY, session);

/** Kept apart from the session, so connecting a wallet and later leaving it returns to the same guest. */
export const loadGuest = () => loadJson<GuestSession>(GUEST_KEY);
export const saveGuest = (guest: GuestSession | null) => saveJson(GUEST_KEY, guest);

/** They said guest once. A swept guest then gets a new one without being asked again, even after a reload. */
export const guestWasChosen = () => loadJson<boolean>(CHOICE_KEY) === true;
export const rememberGuestChoice = () => saveJson(CHOICE_KEY, true);

/** The function-call key the wallet plugin stored at sign-in. Using it means digs never ask the wallet. */
export function walletKey(accountId: string): { secretKey: string } | null {
  const stored = loadJson<{ privateKey?: string }>(`access_key::plugin::testnet::${accountId}`);
  return stored?.privateKey ? { secretKey: stored.privateKey } : null;
}
