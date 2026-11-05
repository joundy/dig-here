# Dig Here market

`market.dighere.testnet` sells the NFTs of `v1.dighere.testnet` through NEP-178 approvals. There's no owner and no admin method. Gas figures below were measured in the sandbox.

Prices here are **yoctoNEAR strings**, unlike the game contract's milliNEAR numbers. 1 milliNEAR is 10^21 yocto.

## What the frontend sends

Every one of these needs a wallet signature, because each attaches a deposit, so a limited key can't call them.

| Action | Receiver | Method and exact JSON args | Gas | Attached |
|---|---|---|---|---|
| List, or re-list at a new price | `v1.dighere.testnet` | `nft_approve` `{"token_id":"snowy:penguin","account_id":"market.dighere.testnet","msg":"{\"price\":\"1000000000000000000000000\"}"}` | 30 Tgas | `1000000000000000000000` yocto (0.001 NEAR). The unused part comes straight back |
| Buy | `market.dighere.testnet` | `buy` `{"token_id":"snowy:penguin"}` | 60 Tgas | The listing's `price`, exactly. Anything above it is refunded |
| Change price | `market.dighere.testnet` | `update_price` `{"token_id":"snowy:penguin","price":"2000000000000000000000000"}` | 10 Tgas | `1` yocto |
| Take off market | `market.dighere.testnet` | `delist` `{"token_id":"snowy:penguin"}` | 10 Tgas for the seller, 30 Tgas for anyone else | `1` yocto |
| Mint (game contract) | `v1.dighere.testnet` | `mint_nft` `{"token_id":"snowy:penguin"}` | 30 Tgas | At least `1` yocto. Anything attached goes to the game balance, then `mint_price` comes out of it |

`msg` is a **string holding JSON**, as NEP-178 defines it. A sale pays the seller's **wallet**, not their game balance.

**`buy` answers with what happened**: the transaction's value is `true` once sold, or `false` once the transfer failed and the coins went back. A failed sale is still a successful transaction, so read the value, or look for `nft_sold`.

Taking an NFT off the market leaves the game contract's approval in place, which is harmless because the market only moves a token it has a listing for. A full clean-up is `v1.nft_revoke({token_id, account_id})` with 1 yocto, and it's optional.

## Reading

`get_listing({"token_id":"snowy:penguin"})` returns a listing or `null`. `get_listings({"from":0,"limit":36})` returns an array, with all 36 at most.

```
{ "token_id": "snowy:penguin",
  "seller": "alice.testnet",
  "price": "1000000000000000000000000",   // yocto string
  "approval_id": 3,
  "in_progress": false }                  // true for the moment a buy is on its way: don't offer Buy
```

**Is a listing still good?** Good means `listing.seller == nft.owner`, from the game's `get_nfts`. When an NFT moves or its approval is revoked, the game tells the market and the listing goes within a block or two. That's best effort, because a transfer must never fail over a notice, so always make this comparison before offering Buy. A buy on a stale listing costs nothing: the buyer is refunded in full and the listing is removed.

The backend does this comparison for you. `GET /api/state` gains a `market` field next to `live`:

```
{ version, fetched_ms, live,
  market: {
    contract: "market.dighere.testnet",
    version: "<changes whenever listings or owners change>",
    listings: [{ token_id, seller, price, approval_id, in_progress, stale }],   // don't offer Buy when stale is true
    nfts: [/* exactly get_nfts: token_id, map, kind, owner, earned, landings */]
  } }
```

`market` is `null` until its first read, and an SSE `state` event is also sent when `market.version` changes, even if `version` didn't. Direct-RPC fallback: read `get_listings` and `get_nfts` yourself and compare.

### Activity, from the backend

`GET /api/market-activity?limit=30&before=<seq>` and `GET /api/nfts/snowy:penguin/activity?limit=30&before=<seq>`, newest first:

```
{ activity: [{ seq, kind, token_id, seller, buyer, price, block_ms, tx_hash }], indexed_to }
```

`kind` is `minted`, `listed`, `price_changed`, `delisted`, `sold`, `sale_failed` or `transferred`. `price` is a yocto string or null, for old game-contract sales too. Unused fields are null.

`GET /api/players/:id/history` gains `trades`, in this same shape.

## Rules

- `buy` refuses, returning everything attached, when: there's no listing, a sale is in progress, the buyer is the seller, too little is attached, or too little gas is attached.
- A failed transfer refunds the buyer in full and removes the listing.
- If the seller's account no longer exists when the sale pays out, the buyer has the NFT and the coins go to `get_unclaimed({"account_id":...})` for the buyer. `claim_unclaimed()` with exactly 1 yocto and 30 Tgas sends them to the wallet. The same happens to any refund that couldn't reach a deleted buyer. A record there costs its own storage, taken from the amount.
- While `in_progress` is true, `nft_on_approve`, `update_price` and `delist` all refuse.

## Events

NEP-297 logs: `EVENT_JSON:{"standard":"dig-here-market","version":"1.0.0","event":<name>,"data":{...}}`. There's no NEP for market events, so this is our own standard in NEP-297's format. The token's own move is also logged by the game contract as NEP-171 `nft_transfer`.

| Event | `data` |
|---|---|
| `nft_listed` | `token_id, seller, price, approval_id, replaced` |
| `nft_price_changed` | `token_id, seller, old_price, price` |
| `nft_delisted` | `token_id, seller, by, reason` (`seller`, `stale` or `transfer_failed`) |
| `nft_sold` | `token_id, seller, buyer, price, paid, approval_id` |
| `nft_sale_failed` | `token_id, seller, buyer, refund` |
| `unclaimed_added` | `account, amount, stored, reason` (`seller_gone` or `buyer_gone`) |
| `unclaimed_claimed` | `account, amount` |

`nft_delisted` with reason `stale` comes from the game's notice, or from anyone's `delist` that found the listing had gone stale. `by` is who removed it, which for a notice is the NFT contract.

## Every method

| Method | Who | Notes |
|---|---|---|
| `new({ nft_contract })` | The account itself, once | No other config. The contract has no owner |
| `nft_on_approve({ token_id, owner_id, approval_id, msg })` | `nft_contract` only | `msg` is `{"price":"<yocto>"}`, above 0. A re-approval replaces the listing. A panic here leaves the approval with no listing, which is harmless |
| `buy({ token_id })` payable, returns bool | Anyone but the seller, with at least 38 Tgas | See below |
| `update_price({ token_id, price })` exactly 1 yocto | The seller | |
| `delist({ token_id })` returns bool | The seller, with exactly 1 yocto. Anyone else, with 0 or 1 yocto and at least 15 Tgas | From anyone else it asks the NFT contract, and removes the listing only if the owner changed, or the token's gone, or the approval isn't this listing's. `true` when removed. An answer it can't read leaves the listing |
| `nft_on_approval_ended({ token_id, owner_id, approval_id })` | `nft_contract` only | The game's notice. Ignored unless it matches the listing, so a newer listing survives an old notice |
| `claim_unclaimed()` exactly 1 yocto | Whoever has coins waiting | Restored if the transfer fails |
| `get_listing`, `get_listings`, `get_nft_contract`, `get_unclaimed`, `get_totals` | Views | `get_totals`: `{ listings, in_progress, held_for_sales, unclaimed }`, the last two yocto strings |

## How a sale runs

1. `buy` checks everything, then writes `in_progress` before any promise, so a listing can't be sold twice. The buyer and everything they attached are stored in the listing.
2. It calls the NFT contract's `nft_transfer` with the stored `approval_id` and 1 yocto from the reserve.
3. A private callback, which never panics, removes the listing and looks at the result:
   - **The transfer worked:** logs `nft_sold`, pays the seller's wallet the price, refunds any excess to the buyer, and answers `true`.
   - **It failed, for any reason:** logs `nft_delisted` and `nft_sale_failed`, refunds the buyer every yocto, and answers `false`.
4. A second private callback watches each payment. One that bounced off a deleted account is parked under `get_unclaimed`, because the coins may not have landed back yet, so sending them on from there could fail.

| What goes wrong | What happens | Tested with |
|---|---|---|
| No listing, too little attached, buyer is seller, too little gas, a sale already running | Refused at once, everything attached returns, nothing changes | Real game |
| Two buyers at once | One sale, the others are refused and keep their coins | Real game |
| The owner moved the NFT, or revoked or replaced the approval, and the notice didn't get there | The transfer fails: full refund, listing removed | Real game |
| The transfer panics, or burns all its gas | Full refund, listing removed, at the minimum gas `buy` accepts | Stand-in |
| The seller's account is gone | The buyer has the NFT and can claim the price | Real game |
| The buyer's account is gone | A sold NFT stays theirs, the seller is paid, and the excess waits. A failed sale's whole amount waits. Claimable if the account returns: tested | Real game |
| Both accounts are gone | The price waits for the buyer | Real game |
| The amount can't pay for its own record | It stays in the reserve, and storage doesn't grow | Real game |

## Gas

Measured in the sandbox with the real game contract. "Worst" is 64-character names and 36 listings in the market, at exactly the minimum gas.

| Call | Burned in all (Tgas) | Worst single receipt |
|---|---|---|
| `nft_approve` with `msg`, first | 4.68, worst 5.32 | Game 2.53, market 1.38 |
| `nft_approve` with `msg`, replacing | 4.75 | Game 2.60 |
| `buy`, sold | 12.90, worst 15.72 | Market 3.37, game 3.77 |
| `buy`, transfer fails, refunded | 8.91 | Market 2.15 |
| `buy`, transfer fails, buyer gone, worst | 11.32 | Market 2.75 |
| `buy`, seller gone | 13.67 | Market 2.72 |
| `update_price` | 1.70 | Market 1.38 |
| `delist` by the seller | 1.67 | Market 1.36 |
| `delist` of a stale listing, by anyone | 5.91 | Market 2.05 |
| `claim_unclaimed` | 4.36 | Market 2.09 |
| Game's `nft_transfer`, with a notice | 6.08 | Game 3.92, market 1.40 |

What's reserved, against those burns: `buy` keeps 5 Tgas for itself, gives `nft_transfer` 15, and gives the callback 18, of which each payment's callback gets 5. So `buy` refuses under 38 Tgas. A stand-in transfer burning its whole 15 Tgas still refunded, at exactly 38.

The wasm is 169 KB.

## Storage

The account's balance holds its storage, and sellers pay nothing here. Listings are bounded by the 36 NFTs, and only `nft_contract` can add one, whose token ids are fixed. So:

| | Bytes | NEAR |
|---|---|---|
| Code | 169,105 | 1.691 |
| Empty state | 270 | 0.003 |
| 36 listings, 64-character names | 3,953 | 0.040 |
| The same 36 in flight at once, 85 bytes each. The buyers' attached coins are there too | 3,060 | 0.031 |
| **The reserve above the code** | | **0.12** at most 0.074 of it used |

`the_reserve_covers_every_listing_and_the_worst_gas_fits` funds a market with just this and lists all 36 at the longest names, then sells them all. Each sale also spends 1 yocto of the reserve on the transfer, which each `update_price` and `delist` gives back. A parked refund pays for its own record, so it can't grow storage for free.

If the reserve ever ran short, new listings would fail. No listing, sale or refund already under way depends on it, because they only remove storage.

## Build and test

Only through the capped toolbox. This crate shares `../contract/target`, which saves gigabytes.

```
cd contract && ../docker/near cargo near build non-reproducible-wasm --no-abi
cd contract-market && ../docker/near cargo near build non-reproducible-wasm --no-abi
cd contract-market/mock-nft && ../../docker/near cargo near build non-reproducible-wasm --no-abi --out-dir ../../contract/target/near-mock
cd contract-market && ../docker/near cargo test --test sandbox -- --test-threads=1 --nocapture
```

`mock-nft` is a stand-in NFT contract whose transfer can panic, burn all its gas or wait for a release, and which is never deployed.

## Trust

No method lets anyone move a listing, a price or a coin except as above, and the contract has no owner. On testnet the deployer keeps a full-access key to `market.dighere.testnet`, as with `v1`, so a person could still redeploy. Before mainnet, delete it.

Market events don't go through the game's Verify screen, since no round depends on them. The backend's `/api/games/:id/proof` adds `deed_activity`: how the round's NFT reached the owner who was paid, up to the settlement.
