// Turns the game contract's NFTs and the market contract's listings into what the screens call a deed.
import type { Deed, DeedEvent } from '../game/economy';

export type NftRow = { token_id: string; owner: string | null; earned: number; landings: number };

export type ListingRow = {
  token_id: string;
  seller: string;
  /** Yocto, unlike the game contract's milli. */
  price: string;
  approval_id: number;
  in_progress: boolean;
  /** Only in the backend's frames. Straight from a node, it has to be worked out. */
  stale?: boolean;
};

export type MarketFrame = { contract: string; version: string; listings: ListingRow[]; nfts: NftRow[] };

export type ActivityRow = {
  seq: number;
  kind: 'minted' | 'listed' | 'price_changed' | 'delisted' | 'sold' | 'sale_failed' | 'transferred';
  token_id: string;
  seller: string | null;
  buyer: string | null;
  price: string | null;
  block_ms: number;
  tx_hash: string | null;
};

const YOCTO_PER_MILLI = 10n ** 21n;

/** Rounds up: a price under the real one on screen would be a small lie. Buying attaches the exact yocto anyway. */
export function milliCeil(yocto: string): number {
  return Number((BigInt(yocto) + YOCTO_PER_MILLI - 1n) / YOCTO_PER_MILLI);
}

/**
 * A listing only counts while its seller still owns the NFT. When an NFT moves, the game tells the market on a best
 * effort, so a listing can outlive the sale of its seller for a block or two, or for good if that notice was lost.
 */
export function deedsFrom(nfts: NftRow[], listings: ListingRow[]): { deeds: Record<string, Deed>; yocto: Map<string, string> } {
  const deeds: Record<string, Deed> = {};
  const yocto = new Map<string, string>();
  for (const nft of nfts) deeds[nft.token_id] = { owner: nft.owner, price: null, earned: nft.earned, landings: nft.landings };
  for (const listing of listings) {
    const deed = deeds[listing.token_id];
    if (!deed || listing.stale || deed.owner !== listing.seller) continue;
    deed.price = milliCeil(listing.price);
    deed.saleInProgress = listing.in_progress;
    yocto.set(listing.token_id, listing.price);
  }
  return { deeds, yocto };
}

const KINDS: Record<ActivityRow['kind'], DeedEvent['kind']> = {
  minted: 'minted',
  listed: 'listed',
  price_changed: 'price',
  delisted: 'delisted',
  sold: 'sold',
  sale_failed: 'failed',
  transferred: 'sent',
};

/** An empty list for a line this version of the page doesn't understand, so a new kind can't break an old tab. */
export function activityOf(row: ActivityRow): DeedEvent[] {
  const kind = KINDS[row.kind];
  if (!kind) return [];
  return [{
    kind,
    id: row.token_id,
    at: row.block_ms,
    from: row.seller,
    to: row.buyer,
    price: row.price === null ? null : milliCeil(row.price),
    tx: row.tx_hash ?? undefined,
  }];
}
