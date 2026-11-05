import { describe, expect, it } from 'vitest';
import type { Deed } from './game/economy';
import { ALL_DEEDS, canAfford, DEFAULT_SORT, inTab, islandStats, marketRows, parseDeedId, parsePrice, SORTS, tabCounts } from './market';

const NOBODY: Deed = { owner: null, price: null, earned: 0, landings: 0 };
const reader = (deeds: Record<string, Partial<Deed>>) => (id: string): Deed => ({ ...NOBODY, ...deeds[id] });

const world = reader({
  'snowy:penguin': { owner: 'a', price: 3000, earned: 5, landings: 2 },
  'snowy:seal': { owner: 'me', price: 1000, earned: 9, landings: 1 },
  'desert:camel': { owner: 'me' },
  'desert:skull': { owner: 'b', price: 2000 },
  'tropical:hut': { owner: 'b', earned: 50, landings: 7 },
});

describe('what each tab holds', () => {
  it('has 36 NFTs, 12 to an island', () => {
    expect(ALL_DEEDS).toHaveLength(36);
    expect(ALL_DEEDS.filter((row) => row.map === 'snowy')).toHaveLength(12);
  });

  it('counts a tab by what the reader can see', () => {
    expect(tabCounts('me', world)).toEqual({ sale: 3, mint: 31, all: 36, mine: 2 });
    expect(tabCounts('', world).mine).toBe(0);
  });

  it('keeps the player\'s own listing in For sale', () => {
    const sale = marketRows('sale', 'all', 'cheap', 'me', world);
    expect(sale.map((row) => row.id)).toEqual(['snowy:seal', 'desert:skull', 'snowy:penguin']);
  });

  it('never counts an unminted NFT as anyone\'s, even with no one signed in', () => {
    expect(inTab('mine', NOBODY, '')).toBe(false);
    expect(inTab('mint', NOBODY, '')).toBe(true);
    expect(inTab('sale', { ...NOBODY, price: 5 }, '')).toBe(false);
  });

  it('filters by island', () => {
    expect(marketRows('sale', 'desert', 'cheap', 'me', world).map((row) => row.id)).toEqual(['desert:skull']);
    expect(marketRows('mine', 'desert', 'island', 'me', world).map((row) => row.id)).toEqual(['desert:camel']);
    expect(marketRows('mint', 'snowy', 'island', 'me', world)).toHaveLength(10);
  });
});

describe('sorting', () => {
  const ids = (sort: Parameters<typeof marketRows>[2]) => marketRows('all', 'all', sort, 'me', world).map((row) => row.id);

  it('puts unlisted NFTs after every listed one, cheapest or dearest first', () => {
    expect(ids('cheap').slice(0, 3)).toEqual(['snowy:seal', 'desert:skull', 'snowy:penguin']);
    expect(ids('dear').slice(0, 3)).toEqual(['snowy:penguin', 'desert:skull', 'snowy:seal']);
    expect(ids('cheap')).toHaveLength(36);
  });

  it('sorts by what it has earned and where the treasure has landed', () => {
    expect(ids('earned').slice(0, 3)).toEqual(['tropical:hut', 'snowy:seal', 'snowy:penguin']);
    expect(ids('landings').slice(0, 3)).toEqual(['tropical:hut', 'snowy:penguin', 'snowy:seal']);
  });

  it('breaks ties the same way every time', () => {
    expect(ids('chance')).toEqual(ids('chance'));
    expect(ids('island')).toEqual(ALL_DEEDS.map((row) => row.id));
  });

  it('starts each tab on a sort that tab offers', () => {
    for (const [tab, sort] of Object.entries(DEFAULT_SORT)) {
      expect(SORTS.find((option) => option.id === sort)!.tabs).toContain(tab);
    }
  });
});

describe('an island as a collection', () => {
  it('adds up what is minted, the cheapest way in, and the earnings', () => {
    expect(islandStats('snowy', world)).toEqual({ total: 12, minted: 2, forSale: 2, floor: 1000, earned: 14, landings: 3 });
    expect(islandStats('tropical', reader({})).floor).toBeNull();
  });
});

describe('a typed price', () => {
  it('reads what people type', () => {
    expect(parsePrice('1.5')).toEqual({ milli: 1500 });
    expect(parsePrice(' 2 ')).toEqual({ milli: 2000 });
    expect(parsePrice('0,25')).toEqual({ milli: 250 });
    expect(parsePrice('.5')).toEqual({ milli: 500 });
    expect(parsePrice('0.001')).toEqual({ milli: 1 });
    expect(parsePrice('1.255')).toEqual({ milli: 1255 });
  });

  it('says what is wrong with the rest', () => {
    expect(parsePrice('')).toEqual({ error: 'Set a price in NEAR.' });
    expect(parsePrice('0')).toEqual({ error: 'Set a price above 0.' });
    expect(parsePrice('abc')).toEqual({ error: 'A price is just a number, like 1.5.' });
    expect(parsePrice('-1')).toEqual({ error: 'A price is just a number, like 1.5.' });
    expect(parsePrice('1e3')).toEqual({ error: 'A price is just a number, like 1.5.' });
    expect(parsePrice('0.0004')).toEqual({ error: 'The lowest price is 0.001 NEAR.' });
    expect(parsePrice('1.2345')).toEqual({ error: 'Prices stop at 3 decimals, like 1.255.' });
    expect(parsePrice('9999999')).toEqual({ error: 'That price is out of this world. Try something lower.' });
  });
});

describe('whether a wallet can pay', () => {
  it('counts what the network holds back for gas', () => {
    expect(canAfford(1000, 60, 1060)).toEqual({ ok: true });
    expect(canAfford(1000, 60, 1059)).toEqual({ ok: false, short: 1 });
    expect(canAfford(1000, 60, 0)).toEqual({ ok: false, short: 1060 });
  });
});

it('finds an NFT by id, and nothing for anything else', () => {
  expect(parseDeedId('snowy:penguin')).toMatchObject({ map: 'snowy', kind: 'penguin' });
  expect(parseDeedId('snowy:camel')).toBeNull();
  expect(parseDeedId('nonsense')).toBeNull();
});
