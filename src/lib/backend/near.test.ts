import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { digButton } from '../digButton';
import { botLimitNote, botLimitsFrom, defaultsWithin, isTestnetAccount, spendable, topUpPlan } from '../near/choices';
import { activityOf, deedsFrom, milliCeil } from '../near/deeds';
import { plainError } from '../near/errors';
import { displayName } from '../near/rooms';

const YOCTO = 10n ** 21n;

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

describe('reading the market', () => {
  const listing = (over: object = {}) => ({ token_id: 't:a', seller: 'a.testnet', price: String(1500n * YOCTO), approval_id: 1, in_progress: false, ...over });
  const nfts = [{ token_id: 't:a', owner: 'a.testnet', earned: 2, landings: 1 }, { token_id: 't:b', owner: null, earned: 0, landings: 0 }];

  it('rounds a price up, so a screen never shows less than the real one', () => {
    expect(milliCeil(String(1500n * YOCTO))).toBe(1500);
    expect(milliCeil(String(1500n * YOCTO + 1n))).toBe(1501);
  });

  it('joins a listing to its NFT', () => {
    const { deeds, yocto } = deedsFrom(nfts, [listing()]);
    expect(deeds['t:a']).toEqual({ owner: 'a.testnet', price: 1500, earned: 2, landings: 1, saleInProgress: false });
    expect(deeds['t:b'].price).toBeNull();
    expect(yocto.get('t:a')).toBe(String(1500n * YOCTO));
  });

  it("ignores a listing whose seller doesn't own the NFT any more, or that the backend calls stale", () => {
    expect(deedsFrom(nfts, [listing({ seller: 'old.testnet' })]).deeds['t:a'].price).toBeNull();
    expect(deedsFrom(nfts, [listing({ stale: true })]).deeds['t:a'].price).toBeNull();
    expect(deedsFrom(nfts, [listing({ token_id: 't:missing' })]).yocto.size).toBe(0);
  });

  it('carries a sale in progress', () => {
    expect(deedsFrom(nfts, [listing({ in_progress: true })]).deeds['t:a'].saleInProgress).toBe(true);
  });

  it('reads an activity line, and skips a kind it has never heard of', () => {
    const row = { seq: 1, kind: 'sold' as const, token_id: 't:a', seller: 's', buyer: 'b', price: String(2n * YOCTO), block_ms: 5, tx_hash: 'h' };
    expect(activityOf(row)).toEqual([{ kind: 'sold', id: 't:a', at: 5, from: 's', to: 'b', price: 2, tx: 'h' }]);
    expect(activityOf({ ...row, kind: 'price_changed', price: null, tx_hash: null })).toEqual([{ kind: 'price', id: 't:a', at: 5, from: 's', to: 'b', price: null, tx: undefined }]);
    expect(activityOf({ ...row, kind: 'teleported' as never })).toEqual([]);
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
  let walletAnswer: unknown = SUCCESS;
  /** What each contract's views answer, by `contract.method`. */
  let views: Record<string, unknown> = {};
  const CHAIN = 'v1.dighere.testnet';
  const MARKET = 'market.dighere.testnet';
  const logsOf = (...events: object[]) => ({ ...SUCCESS, receipts_outcome: [{ outcome: { logs: events.map((e) => `EVENT_JSON:${JSON.stringify(e)}`) } }] });
  const nft = (owner: string | null, id = 'snowy:penguin') => ({ token_id: id, map: 'snowy', kind: 'penguin', owner, earned: 3, landings: 1 });
  const listing = (seller: string, price = 1000n * YOCTO, id = 'snowy:penguin') => ({ token_id: id, seller, price: price.toString(), approval_id: 1, in_progress: false });
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
          return walletAnswer;
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
    walletAnswer = SUCCESS;
    views = {};
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
    vi.stubGlobal('fetch', vi.fn(async (_url: string, init?: { body?: string }) => {
      const params = init?.body ? JSON.parse(init.body).params : null;
      const answer = params?.method_name ? views[`${params.account_id}.${params.method_name}`] ?? null : null;
      return new Response(JSON.stringify({ jsonrpc: '2.0', result: { amount: '0', storage_usage: 100, result: [...new TextEncoder().encode(JSON.stringify(answer))] } }));
    }));
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
    vi.doUnmock('../near/wallet');
    vi.doUnmock('../near/signer');
  });

  it('buys through the market with the exact price attached, and never through a browser key', async () => {
    const price = 1500n * YOCTO + 7n;
    views[`${CHAIN}.get_nfts`] = [nft('seller.testnet')];
    views[`${MARKET}.get_listings`] = [listing('seller.testnet', price)];
    const backend = await load(WALLET, WITH_KEY);
    walletAnswer = logsOf({ standard: 'dig-here-market', event: 'nft_sold', data: {} });
    await backend.buyDeed('snowy:penguin', 1501);
    expect(keySends).toEqual([]);
    expect(walletCalls).toHaveLength(1);
    const [account, method, args, gas, deposit, receiver] = walletCalls[0];
    expect([account, method, receiver]).toEqual(['me.testnet', 'buy', MARKET]);
    expect(args).toEqual({ token_id: 'snowy:penguin' });
    expect(gas).toBe(60);
    expect(deposit).toBe(price.toString());
    expect(backend.deedOf('snowy:penguin')).toMatchObject({ owner: 'me.testnet', price: null });
  });

  it("doesn't open the wallet for a listing that went stale, whatever the page last showed", async () => {
    views[`${CHAIN}.get_nfts`] = [nft('new-owner.testnet')];
    views[`${MARKET}.get_listings`] = [listing('old-owner.testnet')];
    const backend = await load(WALLET);
    await vi.advanceTimersByTimeAsync(0);
    await expect(backend.buyDeed('snowy:penguin', 1000)).rejects.toThrow('That listing has just ended, so nothing was spent.');
    expect(walletCalls).toEqual([]);
    expect(backend.deedOf('snowy:penguin').price).toBeNull();
  });

  it('stops a buy when the price moved, or a sale is already on its way', async () => {
    views[`${CHAIN}.get_nfts`] = [nft('seller.testnet')];
    views[`${MARKET}.get_listings`] = [listing('seller.testnet', 2000n * YOCTO)];
    const backend = await load(WALLET);
    await expect(backend.buyDeed('snowy:penguin', 1000)).rejects.toThrow('The price just changed to 2 NEAR, so nothing was spent. Check it and try again.');
    views[`${MARKET}.get_listings`] = [{ ...listing('seller.testnet'), in_progress: true }];
    await expect(backend.buyDeed('snowy:penguin', 1000)).rejects.toThrow("Someone else's purchase is on its way. Try again in a moment.");
    expect(walletCalls).toEqual([]);
  });

  it('says the coins came back when the sale fell through on the chain', async () => {
    views[`${CHAIN}.get_nfts`] = [nft('seller.testnet')];
    views[`${MARKET}.get_listings`] = [listing('seller.testnet')];
    const backend = await load(WALLET);
    walletAnswer = logsOf({ standard: 'dig-here-market', event: 'nft_sale_failed', data: {} });
    await expect(backend.buyDeed('snowy:penguin', 1000)).rejects.toThrow('All your coins came back to your wallet.');
  });

  it("checks the chain when a wallet doesn't hand back the logs", async () => {
    views[`${CHAIN}.get_nfts`] = [nft('seller.testnet')];
    views[`${MARKET}.get_listings`] = [listing('seller.testnet')];
    const backend = await load(WALLET);
    const buying = backend.buyDeed('snowy:penguin', 1000);
    await vi.advanceTimersByTimeAsync(0);
    views[`${CHAIN}.get_nfts`] = [nft('me.testnet')];
    views[`${MARKET}.get_listings`] = [];
    await vi.advanceTimersByTimeAsync(1000);
    await buying;
    expect(backend.deedOf('snowy:penguin').owner).toBe('me.testnet');
  });

  it('owns up when neither the logs nor the chain show the sale', async () => {
    views[`${CHAIN}.get_nfts`] = [nft('seller.testnet')];
    views[`${MARKET}.get_listings`] = [listing('seller.testnet')];
    const backend = await load(WALLET);
    const buying = expect(backend.buyDeed('snowy:penguin', 1000)).rejects.toThrow("The sale didn't go through.");
    await vi.advanceTimersByTimeAsync(10_000);
    await buying;
  });

  it('passes on a contract refusal in plain words, and a wallet that said no', async () => {
    views[`${CHAIN}.get_nfts`] = [nft('seller.testnet')];
    views[`${MARKET}.get_listings`] = [listing('seller.testnet')];
    const backend = await load(WALLET);
    walletThrows = new Error('User rejected the request');
    await expect(backend.buyDeed('snowy:penguin', 1000)).rejects.toThrow("Your wallet said no, so nothing happened. Try again when you're ready.");
    walletThrows = null;
    walletAnswer = { ...SUCCESS, status: { Failure: { ActionError: { kind: { FunctionCallError: { ExecutionError: 'Smart contract panicked: Attach at least the price.' } } } } } };
    await expect(backend.buyDeed('snowy:penguin', 1000)).rejects.toThrow('The price went up just now, so nothing was spent.');
  });

  it("lists with nft_approve on the game contract, the market as the approved account, and the price in msg", async () => {
    views[`${CHAIN}.get_nfts`] = [nft('me.testnet')];
    const backend = await load(WALLET, WITH_KEY);
    await backend.listDeed('snowy:penguin', 1250);
    expect(keySends).toEqual([]);
    const [, method, args, gas, deposit, receiver] = walletCalls[0];
    expect([method, receiver, gas]).toEqual(['nft_approve', CHAIN, 30]);
    expect(args).toEqual({ token_id: 'snowy:penguin', account_id: MARKET, msg: JSON.stringify({ price: (1250n * YOCTO).toString() }) });
    expect(deposit).toBe(YOCTO.toString());
    expect(backend.deedOf('snowy:penguin').price).toBe(1250);
  });

  it('changes a price and takes a listing down through the market, with a yocto each', async () => {
    views[`${CHAIN}.get_nfts`] = [nft('me.testnet')];
    views[`${MARKET}.get_listings`] = [listing('me.testnet')];
    const backend = await load(WALLET, WITH_KEY);
    await backend.changeDeedPrice('snowy:penguin', 2000);
    await backend.delistDeed('snowy:penguin');
    expect(keySends).toEqual([]);
    expect(walletCalls.map(([, method, args, gas, deposit, receiver]) => [method, args, gas, deposit, receiver])).toEqual([
      ['update_price', { token_id: 'snowy:penguin', price: (2000n * YOCTO).toString() }, 10, '1', MARKET],
      ['delist', { token_id: 'snowy:penguin' }, 10, '1', MARKET],
    ]);
  });

  it('shows our own move until a read catches up, then trusts the reads again', async () => {
    views[`${CHAIN}.get_nfts`] = [nft('me.testnet')];
    const backend = await load(WALLET);
    await backend.listDeed('snowy:penguin', 1250);
    await vi.advanceTimersByTimeAsync(0);
    expect(backend.deedOf('snowy:penguin').price).toBe(1250);
    views[`${MARKET}.get_listings`] = [listing('me.testnet', 1250n * YOCTO)];
    await vi.advanceTimersByTimeAsync(2000);
    views[`${MARKET}.get_listings`] = [];
    backend.reloadDeeds();
    await vi.advanceTimersByTimeAsync(0);
    expect(backend.deedOf('snowy:penguin').price).toBeNull();
  });

  it('mints through the wallet with one yocto when the balance covers it, and never through a browser key', async () => {
    const backend = await load(WALLET, WITH_KEY);
    await backend.mintDeed('snowy:penguin');
    expect(keySends).toEqual([]);
    const [, method, args, , deposit, receiver] = walletCalls[0];
    expect([method, deposit, receiver]).toEqual(['mint_nft', '1', CHAIN]);
    expect(args).toEqual({ token_id: 'snowy:penguin' });
    expect(backend.deedOf('snowy:penguin').owner).toBe('me.testnet');
  });

  it('adds a top-up to a mint when the balance is short', async () => {
    const backend = await load(WALLET, WITH_KEY);
    await backend.mintDeed('snowy:penguin', 300);
    expect(walletCalls[0][4]).toBe((300n * YOCTO).toString());
  });

  it('reads who owns what, and what they ask, from a frame the backend sends', async () => {
    const backend = await load(null);
    expect(backend.deedsReady).toBe(false);
    sources[0].emit({ ...frame(null, 1), market: { contract: MARKET, version: 'a', nfts: [nft('a.testnet'), nft('b.testnet', 'snowy:seal')], listings: [listing('a.testnet'), { ...listing('b.testnet', 1000n * YOCTO, 'snowy:seal'), stale: true }] } });
    expect(backend.deedsReady).toBe(true);
    expect(backend.deedOf('snowy:penguin')).toMatchObject({ owner: 'a.testnet', price: 1000 });
    expect(backend.deedOf('snowy:seal')).toMatchObject({ owner: 'b.testnet', price: null });
  });

  it('shows owners with no prices, and says so, when only the market is out of reach', async () => {
    views[`${CHAIN}.get_nfts`] = [nft('a.testnet')];
    const backend = await load(null);
    vi.mocked(fetch).mockImplementation(async (_url: unknown, init?: { body?: unknown }) => {
      const params = init?.body ? JSON.parse(String(init.body)).params : null;
      if (params?.account_id === MARKET) return new Response(JSON.stringify({ jsonrpc: '2.0', error: { name: 'HANDLER_ERROR', cause: { name: 'UNKNOWN_ACCOUNT' }, data: 'no such account' } }));
      return new Response(JSON.stringify({ jsonrpc: '2.0', result: { amount: '0', storage_usage: 100, result: [...new TextEncoder().encode(JSON.stringify(views[`${params?.account_id}.${params?.method_name}`] ?? null))] } }));
    });
    backend.reloadDeeds();
    await vi.advanceTimersByTimeAsync(0);
    expect(backend.deedsReady).toBe(true);
    expect(backend.deedOf('snowy:penguin').owner).toBe('a.testnet');
    expect(backend.deedsError).toMatch(/Can't read the market's prices/);
  });

  it("stays not ready when nothing can be read, and says it'll try again", async () => {
    const backend = await load(null);
    vi.mocked(fetch).mockRejectedValue(new TypeError('Failed to fetch'));
    backend.reloadDeeds();
    await vi.advanceTimersByTimeAsync(0);
    expect(backend.deedsReady).toBe(false);
    expect(backend.deedsError).toMatch(/Can't reach the market/);
  });

  it('knows what the market is holding, and claims it through the wallet', async () => {
    views[`${MARKET}.get_unclaimed`] = (2500n * YOCTO).toString();
    const backend = await load(WALLET);
    await vi.advanceTimersByTimeAsync(0);
    expect(backend.marketClaim).toBe(2500);
    await backend.claimFromMarket();
    expect(walletCalls[0].slice(1)).toEqual(['claim_unclaimed', {}, 30, '1', MARKET]);
    expect(backend.marketClaim).toBe(0);
  });

  it('reads an old market again when the page asks, without being asked by a redraw', async () => {
    views[`${CHAIN}.get_nfts`] = [nft('a.testnet')];
    const backend = await load(null);
    void backend.deedsReady;
    await vi.advanceTimersByTimeAsync(0);
    expect(backend.deedOf('snowy:penguin').owner).toBe('a.testnet');
    views[`${CHAIN}.get_nfts`] = [nft('b.testnet')];
    backend.refreshDeeds();
    await vi.advanceTimersByTimeAsync(0);
    expect(backend.deedOf('snowy:penguin').owner).toBe('a.testnet');
    await vi.advanceTimersByTimeAsync(21_000);
    backend.refreshDeeds();
    await vi.advanceTimersByTimeAsync(0);
    expect(backend.deedOf('snowy:penguin').owner).toBe('b.testnet');
  });

  it("doesn't call a wallet empty before anyone has read it", async () => {
    const backend = await load(WALLET);
    expect(backend.walletKnown).toBe(false);
    await vi.advanceTimersByTimeAsync(0);
    expect(backend.walletKnown).toBe(true);
    await backend.disconnectWallet();
    expect(backend.walletKnown).toBe(false);
  });

  it('has nothing to say about sales until the backend answers', async () => {
    const backend = await load(null);
    expect(backend.deedNews).toBeNull();
    expect(backend.deedHistory('snowy:penguin')).toBeNull();
    await vi.advanceTimersByTimeAsync(0);
    expect(backend.deedNews).toBeNull();
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

  it("keeps every NFT move off the browser's key", async () => {
    const { GAME_METHODS } = await import('../near/config');
    for (const method of ['mint_nft', 'list_nft', 'buy_nft', 'nft_approve', 'nft_transfer']) expect(GAME_METHODS).not.toContain(method);
    expect(GAME_METHODS).toEqual(expect.arrayContaining(['join', 'leave', 'start', 'dig', 'create_room', 'poke']));
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
