import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { digButton } from '../digButton';
import { botLimitNote, botLimitsFrom, buyDeposit, defaultsWithin, isTestnetAccount, spendable, topUpPlan } from '../near/choices';
import { plainError } from '../near/errors';
import { displayName } from '../near/rooms';

const YOCTO = 10n ** 21n;

describe('what a wallet attaches to a buy', () => {
  it('is 1 yocto when the balance covers the price', () => {
    expect(buyDeposit(100, 100)).toBe('1');
    expect(buyDeposit(100, 250)).toBe('1');
  });

  it('adds what the balance is short of', () => {
    expect(BigInt(buyDeposit(100, 30))).toBe(70n * YOCTO + 1n);
  });

  it("adds a record's cost when there may be no record yet, since that comes out of the credit", () => {
    expect(BigInt(buyDeposit(100, 0))).toBe(102n * YOCTO + 1n);
  });
});

describe('what a first join asks a wallet for', () => {
  it('covers the fee and the setup, and offers more only out of what the wallet can spare', () => {
    const plan = topUpPlan(50, 0, 10_000, 2, 50);
    expect(plan.short).toBe(52);
    expect(plan.choices.map((c) => [c.extra, c.total, c.left])).toEqual([[0, 52, 9948], [250, 302, 9698], [1000, 1052, 8948]]);
    expect(plan.choices[plan.picked].extra).toBe(250);
  });

  it('never drains the wallet: bigger choices vanish first', () => {
    expect(topUpPlan(50, 0, 401, 2, 50).choices.map((c) => c.extra)).toEqual([0]);
    expect(topUpPlan(50, 0, 402, 2, 50).choices.map((c) => c.extra)).toEqual([0, 250]);
    for (const wallet of [0, 60, 80, 500, 3000, 100_000]) {
      for (const choice of topUpPlan(50, 0, wallet, 2, 50).choices) expect(choice.left).toBeGreaterThanOrEqual(20);
    }
  });

  it('offers nothing when the wallet can\'t pay and still have gas left', () => {
    expect(topUpPlan(50, 0, 71, 2, 50).choices).toEqual([]);
    expect(topUpPlan(50, 0, 72, 2, 50).choices.map((c) => c.total)).toEqual([52]);
  });

  it('only asks for what the balance is short of', () => {
    expect(topUpPlan(100, 70, 5000, 0, 100).short).toBe(30);
  });

  it('counts what storage holds back as not spendable', () => {
    expect(spendable({ amount: String(1000n * YOCTO), storage_usage: 700 })).toBe(1000);
    expect(spendable({ amount: String(1000n * YOCTO), storage_usage: 1770 })).toBe(990);
    expect(spendable({ amount: '0', storage_usage: 5000 })).toBe(0);
  });

  it('knows a testnet account from a mainnet one', () => {
    expect(isTestnetAccount('me.testnet')).toBe(true);
    expect(isTestnetAccount('a.b.testnet')).toBe(true);
    expect(isTestnetAccount('me.near')).toBe(false);
    expect(isTestnetAccount('a'.repeat(64))).toBe(true);
    expect(isTestnetAccount('testnet.near')).toBe(false);
  });
});

describe('the host form and bots', () => {
  const limits = { maxFee: 50, maxHostCutBps: 1000 };

  it('reads the limits, and stays quiet if there are no bots or it can not read them', () => {
    expect(botLimitsFrom({ bots_enabled: true, bot_join_limits: { max_fee_milli: 50, max_host_cut_bps: 1000 } })).toEqual(limits);
    expect(botLimitsFrom({ bots_enabled: false, bot_join_limits: { max_fee_milli: 50, max_host_cut_bps: 1000 } })).toBeNull();
    expect(botLimitsFrom({ bots_enabled: true })).toBeNull();
    expect(botLimitsFrom({ bots_enabled: true, bot_join_limits: { max_fee_milli: '50' } })).toBeNull();
  });

  it('says one plain line only above the limits', () => {
    const line = "Bots only join rooms up to 0.05 NEAR with a 10% cut, so you'd wait for real players.";
    expect(botLimitNote(limits, 50, 1000)).toBeNull();
    expect(botLimitNote(limits, 10, 500)).toBeNull();
    expect(botLimitNote(limits, 100, 500)).toBe(line);
    expect(botLimitNote(limits, 50, 1100)).toBe(line);
    expect(botLimitNote(null, 250, 2000)).toBeNull();
  });

  it('starts inside the limits', () => {
    expect(defaultsWithin(limits, [10, 50, 100, 250], 50, 5)).toEqual({ fee: 50, cutPercent: 5 });
    expect(defaultsWithin({ maxFee: 20, maxHostCutBps: 300 }, [10, 50, 100, 250], 50, 5)).toEqual({ fee: 10, cutPercent: 3 });
    expect(defaultsWithin(null, [10, 50], 50, 5)).toEqual({ fee: 50, cutPercent: 5 });
  });
});

describe('the dig button', () => {
  const base = { busy: false, tooLate: false, clueComing: false, bonus: '×1.5' };
  it('waits for a clue, then opens by itself', () => {
    expect(digButton({ ...base, clueComing: true })).toEqual({ label: 'New clue coming…', disabled: true });
    expect(digButton(base)).toEqual({ label: 'Dig here at ×1.5', disabled: false });
  });
  it('still says what matters more', () => {
    expect(digButton({ ...base, busy: true, clueComing: true }).label).toBe('Digging…');
    expect(digButton({ ...base, tooLate: true, clueComing: true }).label).toBe('Too late!');
  });
  it("passes on the contract's own sentence for a refused dig", () => {
    expect(plainError('Smart contract panicked: A new clue is arriving. Try again in a moment.')).toBe('A new clue is arriving. Try again in a moment.');
  });
});

it('strips what makes a room name read as something else', () => {
  expect(displayName('Lunch‮gnirts\n')).toBe('Lunchgnirts');
  expect(displayName('🌴 Niño 🪙')).toBe('🌴 Niño 🪙');
});

// The real backend class, with the browser and the network stubbed at their edges.
describe('the backend', () => {
  const SUCCESS = { status: { SuccessValue: '' }, transaction_outcome: { outcome: { status: {} } }, receipts_outcome: [], final_execution_status: 'FINAL' };
  let keyAnswer: unknown = SUCCESS;
  const walletCalls: any[][] = [];
  const keySends: any[] = [];
  let sources: { emit: (data: unknown) => void }[] = [];
  const storage = new Map<string, string>();
  const WALLET = { kind: 'wallet', accountId: 'me.testnet' };
  const KEY_NAME = 'access_key::plugin::testnet::me.testnet';
  const WITH_KEY = { [KEY_NAME]: JSON.stringify({ privateKey: 'ed25519:x' }) };
  let keyThrows: Error | null = null;
  let walletThrows: Error | null = null;
  let walletModuleLoads = 0;
  let signIn: () => Promise<{ accountId: string; keyAdded: boolean }> = async () => ({ accountId: 'me.testnet', keyAdded: true });

  function frame(room: Partial<Record<string, unknown>> | null, version: number) {
    return {
      version, fetched_ms: 1000,
      live: {
        version, now_ms: 1000, jackpot: 0, commitments_left: 1, missed_reveals: 0, max_open_rooms: 30,
        season: { number: 1, ends_at_ms: 2000, pool: 0, top: [], last_winners: [] },
        rooms: room ? [{
          room_id: 5, version, name: 'Room', host: 'h.testnet', map: 'tropical', fee: 10, pot: 20, duration_sec: 60, host_cut_bps: 0, min_players: 2, max_players: 3, countdown_sec: 0,
          status: 'live', created_ms: 0, deadline_ms: 9e12, start_at_ms: null, started_ms: 0, ends_at_ms: 60_000, tip_index: 0, next_step: 1, next_due_ms: 18_000, reveal_deadline_ms: 138_000, locked: false, lock_height: null,
          players: ['me.testnet', 'h.testnet'], digs: [], clues: [{ level: 'yolo' }], candidates: [0], landmarks: [], ...room,
        }] : [],
      },
    };
  }

  async function load(session: unknown, extra: Record<string, string> = {}) {
    storage.clear();
    if (session) storage.set('dig-here-near-session', JSON.stringify(session));
    for (const [k, v] of Object.entries(extra)) storage.set(k, v);
    vi.resetModules();
    vi.doMock('../near/wallet', () => {
      walletModuleLoads++;
      return {
        callWithDeposit: async (...args: any[]) => {
          if (walletThrows) throw walletThrows;
          walletCalls.push(args);
          return SUCCESS;
        },
        connectWallet: () => signIn(),
        disconnectWallet: async (id: string) => { storage.delete(`access_key::plugin::testnet::${id}`); },
      };
    });
    vi.doMock('../near/signer', () => ({
      KeySender: class {
        async send(call: any) {
          if (keyThrows) throw keyThrows;
          keySends.push(call);
          return keyAnswer;
        }
      },
      newKeyPair: () => ({ publicKey: 'k', secretKey: 's' }),
    }));
    const { backend } = await import('./near.svelte');
    return backend;
  }

  beforeEach(() => {
    walletCalls.length = 0;
    keySends.length = 0;
    keyAnswer = SUCCESS;
    keyThrows = walletThrows = null;
    walletModuleLoads = 0;
    signIn = async () => ({ accountId: 'me.testnet', keyAdded: true });
    sources = [];
    vi.stubGlobal('localStorage', { getItem: (k: string) => storage.get(k) ?? null, setItem: (k: string, v: string) => storage.set(k, v), removeItem: (k: string) => storage.delete(k) });
    vi.stubGlobal('document', { hidden: false, addEventListener: () => {} });
    vi.stubGlobal('EventSource', class {
      readyState = 1;
      constructor() { sources.push(this as never); }
      emit(data: unknown) { this.#listener?.({ data: JSON.stringify(data) }); }
      #listener?: (e: { data: string }) => void;
      addEventListener(_type: string, listener: (e: { data: string }) => void) { this.#listener = listener; }
      close() {}
    });
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({ jsonrpc: '2.0', result: { amount: '0', storage_usage: 100, result: [...new TextEncoder().encode('null')] } }))));
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
    vi.doUnmock('../near/wallet');
    vi.doUnmock('../near/signer');
  });

  it('sends a wallet buy through the wallet with the yocto, even when a browser key is there', async () => {
    const backend = await load(WALLET, WITH_KEY);
    await backend.buyDeed('snowy:penguin', 100);
    expect(keySends).toEqual([]);
    expect(walletCalls).toHaveLength(1);
    const [account, method, args, , deposit] = walletCalls[0];
    expect(account).toBe('me.testnet');
    expect(method).toBe('buy_nft');
    expect(args).toEqual({ token_id: 'snowy:penguin', seen_price: 100 });
    expect(BigInt(deposit) % YOCTO).toBe(1n);
  });

  it('lists through the browser key, with no popup', async () => {
    const backend = await load(WALLET, WITH_KEY);
    await backend.listDeed('snowy:penguin', 100);
    expect(keySends.map((c) => c.method)).toEqual(['list_nft']);
    expect(walletCalls).toEqual([]);
  });

  it('clears everything a returning guest left behind, and goes back to watching', async () => {
    const backend = await load({ kind: 'guest', accountId: 'g-1.guests.dighere.testnet', publicKey: 'p', secretKey: 'ed25519:x' }, {
      'dig-here-near-guest': JSON.stringify({ kind: 'guest', accountId: 'g-1.guests.dighere.testnet', secretKey: 'ed25519:x' }),
      'dig-here-near-choice': 'true',
    });
    expect(backend.identity).toEqual({ kind: 'none' });
    expect([...storage.keys()]).toEqual([]);
  });

  it('resumes a wallet session silently, without loading any wallet code', async () => {
    const backend = await load(WALLET, WITH_KEY);
    expect(backend.identity).toEqual({ kind: 'wallet', accountId: 'me.testnet' });
    expect(backend.accountPrompt).toBeNull();
    expect(walletModuleLoads).toBe(0);
  });

  it('asks a watcher to connect, and carries on once the wallet says yes', async () => {
    const backend = await load(null);
    const asked = backend.ensureAccount();
    backend.accountPrompt!.connect();
    await vi.advanceTimersByTimeAsync(0);
    await asked;
    expect(backend.identity).toEqual({ kind: 'wallet', accountId: 'me.testnet' });
    expect(backend.accountPrompt).toBeNull();
  });

  it('keeps the dialog open with a friendly line when the wallet says no', async () => {
    const backend = await load(null);
    signIn = async () => { throw 'User rejected'; };
    const asked = backend.ensureAccount();
    backend.accountPrompt!.connect();
    await vi.advanceTimersByTimeAsync(0);
    expect(backend.accountPrompt!.error).toBe("Your wallet said no, so nothing happened. Try again when you're ready.");
    expect(backend.accountPrompt!.busy).toBe(false);
    backend.accountPrompt!.cancel();
    await expect(asked).rejects.toThrow('');
    expect(backend.identity).toEqual({ kind: 'none' });
  });

  it("says so when the wallet connects but skips the game's key", async () => {
    const backend = await load(null);
    signIn = async () => ({ accountId: 'me.testnet', keyAdded: false });
    const asked = backend.ensureAccount();
    backend.accountPrompt!.connect();
    await vi.advanceTimersByTimeAsync(0);
    expect(backend.accountPrompt!.noKey).toBe(true);
    backend.accountPrompt!.carryOn();
    await asked;
    expect(backend.identity.kind).toBe('wallet');
  });

  it('sends a join with coins attached through the wallet, even with a browser key', async () => {
    const backend = await load(WALLET, WITH_KEY);
    await backend.join('5', 102);
    expect(keySends).toEqual([]);
    const [, method, args, , deposit] = walletCalls[0];
    expect(method).toBe('join');
    expect(args).toEqual({ room_id: 5 });
    expect(BigInt(deposit)).toBe(102n * YOCTO);
  });

  it('joins silently when the balance covers it', async () => {
    const backend = await load(WALLET, WITH_KEY);
    await backend.join('5');
    expect(keySends.map((c) => c.method)).toEqual(['join']);
    expect(walletCalls).toEqual([]);
  });

  it('falls back to the wallet when the key has run out of allowance', async () => {
    const backend = await load(WALLET, WITH_KEY);
    keyThrows = new Error('{"InvalidTxError":{"InvalidAccessKeyError":{"NotEnoughAllowance":{}}}}');
    await backend.join('5');
    expect(walletCalls.map((c) => c[1])).toEqual(['join']);
    expect(BigInt(walletCalls[0][4])).toBe(0n);
  });

  it('forgets the session when the wallet has forgotten this site', async () => {
    const backend = await load(WALLET);
    walletThrows = new Error('No wallet selected');
    await expect(backend.join('5')).rejects.toThrow('Your wallet has signed out of the game. Connect it again to carry on.');
    expect(backend.identity).toEqual({ kind: 'none' });
    expect(storage.get('dig-here-near-session')).toBeUndefined();
  });

  it('forgets the session and the key on disconnect, even if the wallet never answers', async () => {
    const backend = await load(WALLET, WITH_KEY);
    await backend.disconnectWallet();
    expect(backend.identity).toEqual({ kind: 'none' });
    expect(storage.get('dig-here-near-session')).toBeUndefined();
    expect(storage.get(KEY_NAME)).toBeUndefined();
  });

  it("doesn't pop up a wallet to nudge a late room when there's no browser key", async () => {
    const backend = await load(WALLET);
    sources[0].emit(frame({ status: 'live', ends_at_ms: 500, players: ['me.testnet', 'h.testnet'] }, 1));
    await vi.advanceTimersByTimeAsync(30_000);
    expect(backend.games.length).toBeGreaterThan(0);
    expect(walletCalls).toEqual([]);
  });

  it("doesn't offer buying to the browser's key at all", async () => {
    const { GAME_METHODS } = await import('../near/config');
    expect(GAME_METHODS).not.toContain('buy_nft');
    expect(GAME_METHODS).toEqual(expect.arrayContaining(['mint_nft', 'list_nft', 'dig']));
  });

  it('knows a clue is arriving from the lock to the reveal, and sends no dig meanwhile', async () => {
    const backend = await load(WALLET, WITH_KEY);
    sources[0].emit(frame({}, 1));
    expect(backend.clueArriving('5')).toBe(false);

    sources[0].emit(frame({ locked: true, lock_height: 9 }, 2));
    expect(backend.clueArriving('5')).toBe(true);
    await expect(backend.dig('5', { x: 1, y: 1 }, 1)).rejects.toThrow('A new clue is arriving. Try again in a moment.');
    expect(keySends).toEqual([]);

    sources[0].emit(frame({ locked: false, next_step: 2, clues: [{ level: 'yolo' }, { level: 'category', category: 'tree' }] }, 3));
    expect(backend.clueArriving('5')).toBe(false);
    await backend.dig('5', { x: 1, y: 1 }, 2);
    expect(keySends.map((c) => c.method)).toEqual(['dig']);
  });

  it('takes a dig refused by the contract as word of a clue, and lets go if no lock shows up', async () => {
    const backend = await load(WALLET, WITH_KEY);
    sources[0].emit(frame({}, 1));
    keyAnswer = { ...SUCCESS, status: { Failure: { ActionError: { kind: { FunctionCallError: { ExecutionError: 'Smart contract panicked: A new clue is arriving. Try again in a moment.' } } } } } };
    await expect(backend.dig('5', { x: 1, y: 1 }, 1)).rejects.toThrow('A new clue is arriving. Try again in a moment.');
    expect(backend.clueArriving('5')).toBe(true);
    expect(backend.games.find((g) => g.id === '5')!.digs).toEqual([]);
    await vi.advanceTimersByTimeAsync(6000);
    expect(backend.clueArriving('5')).toBe(false);
  });
});
