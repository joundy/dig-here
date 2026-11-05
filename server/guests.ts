import { createHash } from 'node:crypto';
import type { IncomingMessage } from 'node:http';
import { isIPv6 } from 'node:net';
import { actions, PublicKey } from 'near-api-js';
import type { Config } from './config.ts';
import type { Db } from './db.ts';
import type { Funding } from './funding.ts';
import { availableBalance } from './funding.ts';
import { type Handler, readJsonBody, sendJson } from './http.ts';
import { deriveKeyPair, hmacHex } from './keys.ts';
import { errorText, log } from './log.ts';
import { viewAccessKey, viewAccount, viewFunction } from './rpc.ts';
import type { NearAccount, TxResult } from './signer.ts';
import { near } from './units.ts';

// No `buy_nft`: it needs a yocto, which this key can't attach, because a stolen key could otherwise pay a thief.
export const GUEST_METHODS = ['join', 'leave', 'start', 'dig', 'create_room', 'mint_nft', 'list_nft', 'poke'];
const CREDIT_TGAS = 10;
// Account creation burns a fixed amount and some spare keeps one guest from failing while a top-up lands.
const CREATION_MARGIN = near('0.02');
const FUNDER_LOW = near('1');
const FUNDER_TOP_UP = near('2');
// A read for every new guest would add a quarter second to a wait a juror can feel.
const FUNDS_CHECK_MS = 15_000;
// With the funder short, this is what stops every new request adding a read.
const LOW_FUNDS_RECHECK_MS = 1000;
// A retry sends coins again if the last try looked lost, so each key gets a few an hour.
const MAX_ATTEMPTS_PER_HOUR = 4;
const HOUR_MS = 3_600_000;

export class GuestError extends Error {
  status: number;
  constructor(status: number, message: string) {
    super(message);
    this.status = status;
  }
}

export function sweepKeyFor(config: Config, accountId: string) {
  return deriveKeyPair(config.keySeed, `sweep:${accountId}`);
}

/** Keyed, so nobody can search for a public key whose guest name collides with someone else's. */
export function guestName(config: Config, publicKey: string): string {
  return `g-${hmacHex(config.keySeed, `guest-name:${publicKey}`).slice(0, 8)}.${config.guestsParent}`;
}

export function clientIp(req: IncomingMessage, trustCf: boolean): string {
  const forwarded = req.headers['cf-connecting-ip'];
  if (trustCf && typeof forwarded === 'string' && forwarded) return forwarded;
  return req.socket.remoteAddress ?? 'unknown';
}

/** Someone with one IPv6 connection usually holds a whole /64, so a limit on exact addresses wouldn't limit them. */
export function ipBucket(ip: string): string {
  const mapped = ip.match(/^::ffff:(\d+\.\d+\.\d+\.\d+)$/i);
  if (mapped) return mapped[1];
  if (!isIPv6(ip)) return ip;
  const [head, tail = ''] = ip.split('%')[0].split('::');
  const left = head ? head.split(':') : [];
  const right = tail ? tail.split(':') : [];
  const groups = ip.includes('::') ? [...left, ...Array(8 - left.length - right.length).fill('0'), ...right] : left;
  return `${groups.slice(0, 4).map((g) => parseInt(g, 16).toString(16)).join(':')}::/64`;
}

export function originAllowed(config: Pick<Config, 'allowedOrigins' | 'allowLocalOrigins'>, origin: string | undefined, host: string | undefined): boolean {
  if (!origin) return false;
  let parsed: URL;
  try {
    parsed = new URL(origin);
  } catch {
    return false;
  }
  if (host && parsed.host === host) return true;
  if (config.allowedOrigins.includes(origin)) return true;
  return config.allowLocalOrigins && (parsed.hostname === 'localhost' || parsed.hostname === '127.0.0.1');
}

function parseEd25519(value: unknown): string | null {
  if (typeof value !== 'string' || !value.startsWith('ed25519:') || value.length > 64) return null;
  try {
    return PublicKey.fromString(value).toString();
  } catch {
    return null;
  }
}

type Result = { account_id: string; created: boolean };
type Reservation = { accountId: string; needCreate: boolean; needCredit: boolean; isRetry: boolean; undo: () => void };

export class Guests {
  readonly #config: Config;
  readonly #db: Db;
  readonly #funder: NearAccount;
  readonly #funding: Funding;
  // The same key arriving twice at once must become one account, not two racing creations.
  readonly #inFlight = new Map<string, Promise<Result>>();
  #lastTopUp = 0;
  #funderSpare = 0n;
  #funderCheckedMs = 0;
  #funderHeld = 0n;
  #funderRead: Promise<void> | null = null;

  constructor(config: Config, db: Db, funder: NearAccount, funding: Funding) {
    this.#config = config;
    this.#db = db;
    this.#funder = funder;
    this.#funding = funding;
  }

  /** Each guest costs about this much, nearly all of it reclaimable by the sweeper. */
  get #costPerGuest(): bigint {
    return this.#config.guestGas + this.#config.guestCredit + CREATION_MARGIN;
  }

  request(publicKey: string, ipHash: string): Promise<Result> {
    const running = this.#inFlight.get(publicKey);
    if (running) return running;
    let reserved: Reservation | Result;
    try {
      reserved = this.#reserve(publicKey, ipHash);
    } catch (e) {
      return Promise.reject(e);
    }
    if ('account_id' in reserved) return Promise.resolve(reserved);
    const work = this.#create(publicKey, reserved).finally(() => this.#inFlight.delete(publicKey));
    this.#inFlight.set(publicKey, work);
    return work;
  }

  /**
   * Checks the limits and takes the slot in one go, with no await anywhere in here. Requests can only interleave at
   * an await, so a burst can't all read the same count: each one sees the row the one before it wrote.
   */
  #reserve(publicKey: string, ipHash: string): Reservation | Result {
    const db = this.#db;
    const row = db.prepare('SELECT * FROM guests WHERE public_key = ?').get(publicKey) as any;
    const accountId = row?.account_id ?? guestName(this.#config, publicKey);
    if (row && !row.swept_ms && row.created_ok && row.credit_ok) return { account_id: accountId, created: false };
    if (this.#inFlight.size >= this.#config.guestMaxInFlight) throw new GuestError(503, 'A lot of guests are arriving at once. Try again in a moment.');

    const now = Date.now();
    if (row && !row.swept_ms) {
      const attempts = now - row.last_attempt_ms < HOUR_MS ? row.attempts : 0;
      if (attempts >= MAX_ATTEMPTS_PER_HOUR) throw new GuestError(429, "This guest account isn't coming together. Try again in an hour, or connect a wallet.");
      db.prepare('UPDATE guests SET attempts = ?, last_attempt_ms = ? WHERE public_key = ?').run(attempts + 1, now, publicKey);
      return {
        accountId,
        needCreate: !row.created_ok,
        needCredit: !row.credit_ok,
        isRetry: true,
        undo: () => db.prepare('UPDATE guests SET attempts = ?, last_attempt_ms = ? WHERE public_key = ?').run(row.attempts, row.last_attempt_ms, publicKey),
      };
    }

    this.#checkLimits(ipHash);
    if (row) {
      db.prepare('UPDATE guests SET swept_ms = NULL, created_ok = 0, credit_ok = 0, created_ms = ?, ip_hash = ?, attempts = 1, last_attempt_ms = ? WHERE public_key = ?').run(now, ipHash, now, publicKey);
      return {
        accountId,
        needCreate: true,
        needCredit: true,
        isRetry: false,
        undo: () => db.prepare('UPDATE guests SET swept_ms = ?, created_ok = ?, credit_ok = ?, created_ms = ?, ip_hash = ?, attempts = ?, last_attempt_ms = ? WHERE public_key = ?').run(row.swept_ms, row.created_ok, row.credit_ok, row.created_ms, row.ip_hash, row.attempts, row.last_attempt_ms, publicKey),
      };
    }
    db.prepare('INSERT INTO guests(public_key, account_id, ip_hash, created_ms, attempts, last_attempt_ms) VALUES (?, ?, ?, ?, 1, ?)').run(publicKey, accountId, ipHash, now, now);
    return { accountId, needCreate: true, needCredit: true, isRetry: false, undo: () => db.prepare('DELETE FROM guests WHERE public_key = ?').run(publicKey) };
  }

  async #create(publicKey: string, reserved: Reservation): Promise<Result> {
    const db = this.#db;
    const { accountId } = reserved;
    const now = Date.now();
    try {
      await this.#holdFunds();
    } catch (e) {
      // Nothing was sent, so running out of coins shouldn't use up anyone's allowance.
      reserved.undo();
      throw e;
    }
    // Two lanes, so neither waits for the other. A credit can land first because the contract's
    // record is only a name, and the coins sit waiting for the account to appear.
    const [created, credited] = await Promise.all([
      reserved.needCreate ? this.#createAccount(accountId, publicKey) : Promise.resolve(true),
      reserved.needCredit ? this.#credit(accountId, reserved.isRetry) : Promise.resolve(true),
    ]).finally(() => (this.#funderHeld -= this.#costPerGuest));
    if (created) db.prepare('UPDATE guests SET created_ok = 1 WHERE public_key = ?').run(publicKey);
    if (credited) db.prepare('UPDATE guests SET credit_ok = 1 WHERE public_key = ?').run(publicKey);
    if (!created || !credited) throw new GuestError(503, 'The guest account needs another moment. Try again.');

    await this.#waitForKey(accountId, publicKey);
    log('guests', `created ${accountId}`, { ms: Date.now() - now });
    void this.#topUpFunder();
    return { account_id: accountId, created: true };
  }

  #checkLimits(ipHash: string): void {
    const db = this.#db;
    const count = (sql: string, ...args: any[]) => (db.prepare(sql).get(...args) as { n: number }).n;
    const hourAgo = Date.now() - 3_600_000;
    if (count('SELECT COUNT(*) n FROM guests WHERE ip_hash = ? AND created_ms > ?', ipHash, hourAgo) >= this.#config.guestsPerIpPerHour) {
      throw new GuestError(429, 'Too many guest accounts from here. Try again in an hour, or connect a wallet.');
    }
    if (count('SELECT COUNT(*) n FROM guests WHERE created_ms > ?', Date.now() - 86_400_000) >= this.#config.guestDailyCap) {
      throw new GuestError(429, "Today's guest accounts have run out. Try tomorrow, or connect a wallet.");
    }
  }

  /** A running total, so guests being made at the same moment add up against what the funder really holds. */
  async #holdFunds(): Promise<void> {
    const cost = this.#costPerGuest;
    const age = Date.now() - this.#funderCheckedMs;
    if (age >= FUNDS_CHECK_MS || (this.#funderSpare < cost && age >= LOW_FUNDS_RECHECK_MS)) await this.#readFunder();
    if (this.#funderSpare < cost && (await this.#topUpFunder())) await this.#readFunder();
    if (this.#funderSpare < cost) throw new GuestError(503, 'Guest accounts are paused while the game refills its test coins. Connect a wallet, or try later.');
    this.#funderSpare -= cost;
    this.#funderHeld += cost;
  }

  /**
   * Everyone waiting shares one read. Coins held for guests still being made come off whether or not the read saw
   * them leave, which can only make this cautious for a moment.
   */
  #readFunder(): Promise<void> {
    this.#funderRead ??= viewAccount(this.#funder.id, 'optimistic')
      .then((account) => {
        this.#funderSpare = availableBalance(account) - this.#funderHeld;
        this.#funderCheckedMs = Date.now();
      })
      .finally(() => (this.#funderRead = null));
    return this.#funderRead;
  }

  /** Whether a top-up was tried, which is the only thing that would make another read worthwhile. */
  async #topUpFunder(): Promise<boolean> {
    if (Date.now() - this.#lastTopUp < 5000) return false;
    this.#lastTopUp = Date.now();
    try {
      await this.#funding.topUp(this.#funder.id, FUNDER_LOW, FUNDER_TOP_UP, 'guests');
    } catch (e) {
      log('guests', `funder top-up failed: ${errorText(e)}`);
    }
    return true;
  }

  async #createAccount(accountId: string, publicKey: string): Promise<boolean> {
    const browser = PublicKey.fromString(publicKey);
    const sweep = sweepKeyFor(this.#config, accountId).getPublicKey();
    const send: Promise<TxResult> = this.#funder.send(accountId, [
      actions.createAccount(),
      actions.transfer(this.#config.guestGas),
      actions.addFunctionCallAccessKey(browser, this.#config.contract, GUEST_METHODS),
      actions.addFullAccessKey(sweep),
    ], { patienceMs: 6000 });
    try {
      const result = await send;
      if (result.ok) return true;
      // A previous try may have landed. If the browser's key is on it, it's already done.
      if (/AccountAlreadyExists/.test(result.failure ?? '') && (await viewAccessKey(accountId, publicKey))) return true;
      log('guests', `create ${accountId} failed: ${result.failure}`);
    } catch (e) {
      log('guests', `create ${accountId} failed: ${errorText(e)}`);
    }
    return false;
  }

  async #credit(accountId: string, isRetry: boolean): Promise<boolean> {
    try {
      // A credit that looked lost can have landed, and a second one would pay again.
      if (isRetry) {
        const record = await viewFunction<{ balance: string } | null>(this.#config.contract, 'get_account', { id: accountId });
        if (record && BigInt(record.balance) > 0n) return true;
      }
      const result = await this.#funder.call(this.#config.contract, 'deposit_for', { account_id: accountId }, CREDIT_TGAS, this.#config.guestCredit, { patienceMs: 6000, resign: false });
      if (result.ok) return true;
      log('guests', `credit ${accountId} failed: ${result.failure}`);
    } catch (e) {
      log('guests', `credit ${accountId} failed: ${errorText(e)}`);
    }
    return false;
  }

  /** The browser signs with this key straight away, so its first nonce read has to find the key. */
  async #waitForKey(accountId: string, publicKey: string): Promise<void> {
    for (let i = 0; i < 12; i++) {
      if (await viewAccessKey(accountId, publicKey)) return;
      await new Promise((r) => setTimeout(r, 250));
    }
    log('guests', `${accountId}: key not visible after waiting`);
  }

  handle: Handler = async (req, res) => {
      if (!originAllowed(this.#config, req.headers.origin, req.headers.host)) {
        return sendJson(req, res, 403, { error: 'Guest accounts can only be requested from the game itself.' });
      }
      let body: any;
      try {
        body = await readJsonBody(req);
      } catch {
        return sendJson(req, res, 400, { error: 'That request could not be read.' });
      }
      const publicKey = parseEd25519(body?.public_key);
      if (!publicKey) return sendJson(req, res, 400, { error: 'public_key must be an ed25519 key.' });
      const ipHash = createHash('sha256').update(this.#config.keySeed + ipBucket(clientIp(req, this.#config.trustCfIp))).digest('hex').slice(0, 24);
      try {
        const result = await this.request(publicKey, ipHash);
        sendJson(req, res, 200, result);
      } catch (e) {
        const status = e instanceof GuestError ? e.status : 503;
        if (!(e instanceof GuestError)) log('guests', `request failed: ${errorText(e)}`);
        sendJson(req, res, status, { error: e instanceof GuestError ? e.message : 'Guest accounts are unavailable right now. Try again soon.' });
      }
  };
}

