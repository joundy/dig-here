// What the market page shows and offers, kept away from the screen so a test can hold it down.
import { deedChance, deedId, deedKinds } from './game/economy';
import type { Deed } from './game/economy';
import { MAP_IDS } from './game/map';
import type { Kind, MapId } from './game/types';

export type MarketTab = 'sale' | 'mint' | 'all' | 'mine';
export type MarketSort = 'island' | 'cheap' | 'dear' | 'chance' | 'earned' | 'landings';
export type DeedRow = { map: MapId; kind: Kind; id: string };
export type ReadDeed = (id: string) => Deed;

export const ALL_DEEDS: DeedRow[] = MAP_IDS.flatMap((map) => deedKinds(map).map((kind) => ({ map, kind, id: deedId(map, kind) })));

export const parseDeedId = (id: string): DeedRow | null => ALL_DEEDS.find((row) => row.id === id) ?? null;

export const SORTS: { id: MarketSort; label: string; tabs: readonly MarketTab[] }[] = [
  { id: 'cheap', label: 'Cheapest first', tabs: ['sale', 'all', 'mine'] },
  { id: 'dear', label: 'Dearest first', tabs: ['sale', 'all', 'mine'] },
  { id: 'chance', label: 'Best chance', tabs: ['sale', 'mint', 'all', 'mine'] },
  { id: 'earned', label: 'Most earned', tabs: ['sale', 'all', 'mine'] },
  { id: 'landings', label: 'Most landings', tabs: ['sale', 'mint', 'all', 'mine'] },
  { id: 'island', label: 'By island', tabs: ['sale', 'mint', 'all', 'mine'] },
];

/** Where a tab starts: shoppers want the bargain, everyone else the whole collection in order. */
export const DEFAULT_SORT: Record<MarketTab, MarketSort> = { sale: 'cheap', mint: 'island', all: 'island', mine: 'island' };

export function inTab(tab: MarketTab, deed: Deed, me: string): boolean {
  if (tab === 'all') return true;
  if (tab === 'mine') return !!me && deed.owner === me;
  if (tab === 'mint') return deed.owner === null;
  return deed.owner !== null && deed.price !== null;
}

export function marketRows(tab: MarketTab, map: MapId | 'all', sort: MarketSort, me: string, read: ReadDeed): DeedRow[] {
  const rows = ALL_DEEDS.filter((row) => (map === 'all' || row.map === map) && inTab(tab, read(row.id), me));
  const price = (row: DeedRow, missing: number) => read(row.id).price ?? missing;
  const byIsland = (a: DeedRow, b: DeedRow) => ALL_DEEDS.indexOf(a) - ALL_DEEDS.indexOf(b);
  const order: Record<MarketSort, (a: DeedRow, b: DeedRow) => number> = {
    island: () => 0,
    // Nothing to compare on an unlisted NFT, so those go last either way.
    cheap: (a, b) => price(a, Infinity) - price(b, Infinity),
    dear: (a, b) => price(b, -Infinity) - price(a, -Infinity),
    chance: (a, b) => deedChance(b.map, b.kind) - deedChance(a.map, a.kind),
    earned: (a, b) => read(b.id).earned - read(a.id).earned,
    landings: (a, b) => read(b.id).landings - read(a.id).landings,
  };
  // Infinity minus Infinity is NaN, which a sort treats as anything it likes.
  return rows.sort((a, b) => (order[sort](a, b) || 0) || byIsland(a, b));
}

export function tabCounts(me: string, read: ReadDeed): Record<MarketTab, number> {
  const counts: Record<MarketTab, number> = { sale: 0, mint: 0, all: 0, mine: 0 };
  for (const row of ALL_DEEDS) {
    const deed = read(row.id);
    for (const tab of ['sale', 'mint', 'all', 'mine'] as const) if (inTab(tab, deed, me)) counts[tab]++;
  }
  return counts;
}

export type IslandStats = { total: number; minted: number; forSale: number; floor: number | null; earned: number; landings: number };

/** A map's NFTs as one collection: how much of it has been found, and the cheapest way in. */
export function islandStats(map: MapId, read: ReadDeed): IslandStats {
  const stats: IslandStats = { total: 0, minted: 0, forSale: 0, floor: null, earned: 0, landings: 0 };
  for (const row of ALL_DEEDS) {
    if (row.map !== map) continue;
    const deed = read(row.id);
    stats.total++;
    stats.earned += deed.earned;
    stats.landings += deed.landings;
    if (deed.owner !== null) stats.minted++;
    if (deed.owner !== null && deed.price !== null) {
      stats.forSale++;
      stats.floor = stats.floor === null ? deed.price : Math.min(stats.floor, deed.price);
    }
  }
  return stats;
}

const MILLI_PER_NEAR = 1000;
const MAX_PRICE_NEAR = 1_000_000;

/** A typed price in NEAR, as whole milliNEAR, or the sentence that says what's wrong with it. */
export function parsePrice(text: string): { milli: number } | { error: string } {
  const clean = text.trim().replace(',', '.');
  if (!clean) return { error: 'Set a price in NEAR.' };
  if (!/^\d*\.?\d*$/.test(clean) || clean === '.') return { error: 'A price is just a number, like 1.5.' };
  const value = Number(clean);
  if (value <= 0) return { error: 'Set a price above 0.' };
  if (value > MAX_PRICE_NEAR) return { error: 'That price is out of this world. Try something lower.' };
  const milli = Math.round(value * MILLI_PER_NEAR);
  if (milli < 1) return { error: 'The lowest price is 0.001 NEAR.' };
  if (Math.abs(milli - value * MILLI_PER_NEAR) > 1e-6) return { error: 'Prices stop at 3 decimals, like 1.255.' };
  return { milli };
}

/**
 * What a wallet needs on top of a move's coins for the network to accept it. A transaction reserves its gas at
 * 10 times the burn price up front: about 1 milliNEAR per Tgas, nearly all of it refunded.
 */
export const gasReserve = (gasTgas: number): number => gasTgas;

export type Afford = { ok: true } | { ok: false; short: number };

/** Null wallet means nobody has read it yet, and that must not read as "you have nothing". */
export function canAfford(cost: number, gasTgas: number, wallet: number): Afford {
  const short = cost + gasReserve(gasTgas) - wallet;
  return short <= 0 ? { ok: true } : { ok: false, short };
}
