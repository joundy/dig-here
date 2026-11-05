// The stand-in has to keep up with the real interface, or the playtest stops being a test of anything.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ALL_DEEDS } from '../market';

describe('the market on the dummy', () => {
  let ID = '';

  async function fresh() {
    vi.resetModules();
    const { backend } = await import('./dummy.svelte');
    backend.reset();
    // Bots mint at random while seeding, so each test takes one they left.
    ID = ALL_DEEDS.find((row) => backend.deedOf(row.id).owner === null)!.id;
    return backend;
  }

  async function settled<T>(move: Promise<T>): Promise<T> {
    const watched = move.then((value) => ({ value }), (error: unknown) => ({ error }));
    await vi.advanceTimersByTimeAsync(2000);
    const result = await watched;
    if ('error' in result) throw result.error;
    return result.value;
  }

  beforeEach(() => {
    const storage = new Map<string, string>();
    vi.stubGlobal('localStorage', { getItem: (k: string) => storage.get(k) ?? null, setItem: (k: string, v: string) => storage.set(k, v), removeItem: (k: string) => storage.delete(k) });
    vi.useFakeTimers();
    // Random as ever, except that it never comes up low enough for a bot to buy something out from under a test.
    const real = Math.random;
    vi.spyOn(Math, 'random').mockImplementation(() => 0.01 + real() * 0.99);
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  async function withNft() {
    const backend = await fresh();
    await settled(backend.deposit(40_000));
    await settled(backend.mintDeed(ID));
    return backend;
  }

  it('reports itself ready, with nothing to apologise for', async () => {
    const backend = await fresh();
    expect(backend.deedsReady).toBe(true);
    expect(backend.deedsError).toBe('');
    expect(backend.deedNews).toEqual(expect.any(Array));
    expect(backend.marketClaim).toBe(0);
  });

  it('mints from the balance, lists, changes the price and delists, and writes it all down', async () => {
    const backend = await withNft();
    const me = backend.account;
    expect(backend.deedOf(ID).owner).toBe(me);
    await settled(backend.listDeed(ID, 3000));
    expect(backend.deedOf(ID).price).toBe(3000);
    await settled(backend.changeDeedPrice(ID, 4000));
    expect(backend.deedOf(ID).price).toBe(4000);
    await settled(backend.delistDeed(ID));
    expect(backend.deedOf(ID).price).toBeNull();
    expect(backend.deedHistory(ID)!.map((e) => e.kind).slice(0, 4)).toEqual(['delisted', 'price', 'listed', 'minted']);
  });

  it('pays a sale wallet to wallet, and leaves both game balances alone', async () => {
    const backend = await withNft();
    const [seller, buyer] = backend.playtest!.playableAccounts;
    await settled(backend.listDeed(ID, 3000));
    const sellerWallet = backend.walletOf(seller);
    const sellerBalance = backend.balanceOf(seller);
    backend.playtest!.switchAccount(buyer);
    const buyerWallet = backend.walletOf(buyer);
    await settled(backend.buyDeed(ID, 3000));
    expect(backend.deedOf(ID)).toMatchObject({ owner: buyer, price: null });
    expect(backend.walletOf(buyer)).toBe(buyerWallet - 3000);
    expect(backend.walletOf(seller)).toBe(sellerWallet + 3000);
    expect(backend.balanceOf(seller)).toBe(sellerBalance);
    expect(backend.deedNews![0]).toMatchObject({ kind: 'sold', id: ID, from: seller, to: buyer, price: 3000 });
  });

  it('refuses a price that moved, and a listing that has gone', async () => {
    const backend = await withNft();
    const [, buyer] = backend.playtest!.playableAccounts;
    await settled(backend.listDeed(ID, 3000));
    await settled(backend.changeDeedPrice(ID, 5000));
    backend.playtest!.switchAccount(buyer);
    await expect(settled(backend.buyDeed(ID, 3000))).rejects.toThrow(/price just changed/);
    backend.playtest!.switchAccount(backend.playtest!.playableAccounts[0]);
    await settled(backend.delistDeed(ID));
    backend.playtest!.switchAccount(buyer);
    await expect(settled(backend.buyDeed(ID, 5000))).rejects.toThrow(/for sale/);
  });

  it('ends the listing when an NFT is sent on', async () => {
    const backend = await withNft();
    await settled(backend.listDeed(ID, 3000));
    await settled(backend.transferDeed(ID, 'friend.near'));
    expect(backend.deedOf(ID)).toMatchObject({ owner: 'friend.near', price: null });
  });
});
