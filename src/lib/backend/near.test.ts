import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { digButton } from '../digButton';
import { botLimitNote, botLimitsFrom, buyDeposit, defaultsWithin } from '../near/choices';
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
    storage.set('dig-here-near-session', JSON.stringify(session));
    for (const [k, v] of Object.entries(extra)) storage.set(k, v);
    vi.resetModules();
    vi.doMock('../near/wallet', () => ({
      callWithDeposit: async (...args: any[]) => {
        walletCalls.push(args);
        return SUCCESS;
      },
    }));
    vi.doMock('../near/signer', () => ({
      KeySender: class {
        async send(call: any) {
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
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({ jsonrpc: '2.0', result: { amount: '0', result: [...new TextEncoder().encode('null')] } }))));
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
    vi.doUnmock('../near/wallet');
    vi.doUnmock('../near/signer');
  });

  it('sends a wallet buy through the wallet with the yocto, even when a browser key is there', async () => {
    const backend = await load({ kind: 'wallet', accountId: 'me.testnet' }, { 'access_key::plugin::testnet::me.testnet': JSON.stringify({ privateKey: 'ed25519:x' }) });
    await backend.buyDeed('snowy:penguin', 100);
    expect(keySends).toEqual([]);
    expect(walletCalls).toHaveLength(1);
    const [account, method, args, , deposit] = walletCalls[0];
    expect(account).toBe('me.testnet');
    expect(method).toBe('buy_nft');
    expect(args).toEqual({ token_id: 'snowy:penguin', seen_price: 100 });
    expect(BigInt(deposit) % YOCTO).toBe(1n);
  });

  it('turns a guest away from buying with the wallet line, sending nothing', async () => {
    const backend = await load({ kind: 'guest', accountId: 'g.testnet', publicKey: 'p', secretKey: 'ed25519:x' });
    await expect(backend.buyDeed('snowy:penguin', 100)).rejects.toThrow('Connect a wallet to buy this.');
    expect(keySends).toEqual([]);
    expect(walletCalls).toEqual([]);
  });

  it('still lets a guest list, through their key', async () => {
    const backend = await load({ kind: 'guest', accountId: 'g.testnet', publicKey: 'p', secretKey: 'ed25519:x' });
    await backend.listDeed('snowy:penguin', 100);
    expect(keySends.map((c) => c.method)).toEqual(['list_nft']);
  });

  it("doesn't offer buying to the browser's key at all", async () => {
    const { GAME_METHODS } = await import('../near/config');
    expect(GAME_METHODS).not.toContain('buy_nft');
    expect(GAME_METHODS).toEqual(expect.arrayContaining(['mint_nft', 'list_nft', 'dig']));
  });

  it('knows a clue is arriving from the lock to the reveal, and sends no dig meanwhile', async () => {
    const backend = await load({ kind: 'guest', accountId: 'me.testnet', publicKey: 'p', secretKey: 'ed25519:x' });
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
    const backend = await load({ kind: 'guest', accountId: 'me.testnet', publicKey: 'p', secretKey: 'ed25519:x' });
    sources[0].emit(frame({}, 1));
    keyAnswer = { ...SUCCESS, status: { Failure: { ActionError: { kind: { FunctionCallError: { ExecutionError: 'Smart contract panicked: A new clue is arriving. Try again in a moment.' } } } } } };
    await expect(backend.dig('5', { x: 1, y: 1 }, 1)).rejects.toThrow('A new clue is arriving. Try again in a moment.');
    expect(backend.clueArriving('5')).toBe(true);
    expect(backend.games.find((g) => g.id === '5')!.digs).toEqual([]);
    await vi.advanceTimersByTimeAsync(6000);
    expect(backend.clueArriving('5')).toBe(false);
  });
});
