# NFT market contract and full user audit

The user's instruction (2026-11-06): build a dedicated marketplace contract. Fully explore the current game, act like a normal user, and fix anything odd or not best practice. No shortcuts. Don't ask the user.

Hard rules and machine limits in `docs/plans/2026-11-06-testnet-design.md` still apply: testnet only, Docker through `docker/near`, at most 2 agents, one browser at a time under `systemd-run --user --scope -p MemoryMax=3G -p CPUQuota=300%`, `--maxWorkers=2`, never touch other apps or domains, no keys in logs or commits, no `git push`.

## Standing decisions
- Wallet only, no guests. Bots testnet only.
- One NFT per kind per map (36). First owner mints. Production mint price 20 NEAR, testnet 0.5.
- The user wants fairness and RNG highlighted in the README. Keep it accurate.

## Part 1: market contract

`market.dighere.testnet`, a new crate `contract-market/`. Standard NEAR pattern: the NFT lives in `v1.dighere.testnet`, and the market sells it through NEP-178 approvals.

```
new(nft_contract)                       no owner, no admin methods
nft_on_approve(token_id, owner_id, approval_id, msg)
    only from nft_contract. msg = {"price":"<yocto>"}. A re-approval replaces the listing.
buy(token_id)                           payable, at least the price. Excess refunded
update_price(token_id, price)           exactly 1 yocto, seller only
delist(token_id)                        exactly 1 yocto, seller. Anyone, if the listing is stale
get_listing(token_id), get_listings(from, limit)   prices as yocto strings
```

Requirements:
- `buy`: mark the listing in progress before any promise, so it can't be bought twice. Call `nft_transfer` with the stored `approval_id`, then a private callback that doesn't panic: on success pay the seller and refund any excess; on failure refund the buyer in full and remove a stale listing. Test every failure path, including a deleted seller or buyer, and no gas left.
- Listings are bounded by the 36 NFTs, and only `nft_contract` is accepted, so storage is bounded and comes from a reserve. Check the reserve is enough.
- A listing whose owner changed through `nft_transfer` is stale: views mark or hide it, and anyone can remove it.
- NEP-297 events: `nft_listed`, `nft_price_changed`, `nft_delisted`, `nft_sold`, with the standard they follow.
- Wasm size and gas measured. Sandbox tests with the real game contract and market together.

## Part 2: game contract upgrade (in place on v1, balances kept)
- `mint_nft` needs at least 1 yocto, so a limited key can't call it. Anything attached still goes to the balance.
- Retire `list_nft` and `buy_nft` from the game contract. `get_nfts` drops the old price, and old listings stop existing.
- A market buyer must be able to receive an NFT and earn on it with no prior game record. Today a receiver must already have one. Fix without letting anyone grow storage for free, and without ever stranding a share.
- Closeness range: 40% of real rounds scored 0 for everyone with a 48-pixel limit. Re-run the simulation on today's maps, choose a better value, and change the Rust, TS and vectors together. Verify must keep working for rounds played under the old value, so make the value a stored or clearly versioned fact, not a guess.
- Verify no Borsh layout changes unless a proper migration is written and tested in the sandbox against the live wasm. Never lose balances.

## Part 3: backend and frontend
- Backend: bots list and buy through the market within budget. Indexer also reads the market's events, so history and proofs cover sales. Live state includes listings.
- Limited key: remove `mint_nft`, `list_nft`, `buy_nft` from the allowed methods. Keys already issued lose them because the contract refuses.
- Frontend: listing is `nft_approve` to the market, with wallet approval. Buy is `market.buy` with the price attached. Sellers are paid to their wallet. Say this plainly.
- For sale shows your own listings, marked "Your listing", with Change price and Take off market.
- Redesign the NFT market page: it must feel like a modern collectible marketplace within our pixel style. Big art, clear price, activity, owned state. Test at 360×640 and desktop.

## Part 4: act like a normal user
Go through the whole live site as a stranger, on phone and desktop, including first load, tutorial, connect, top up, join, dig, results, verify, host, NFT, season, wallet dialog, errors, slow network, reload, two tabs. Note everything odd, confusing, ugly, slow or broken, and fix it. Review code against best practice too. Keep a log in `docs/research/user-audit.md` of what was found and fixed. Known items to include: lone host waiting 36 seconds on the default countdown, disconnect leaving the limited key, season list containing deleted accounts, and faucet help when faucets refuse.

## Part 5: finish
All tests, deploy, live check, README and notes updated, `main` updated. Report honestly what ran and what a human must try.

## Status
- [x] Part 1: `market.dighere.testnet` is live. See `contract-market/README.md`
- [x] Part 2: `v1` upgraded in place, balances kept. Closeness numbers are in `docs/research/closeness-range.md`
- [x] Part 3: the backend half is done and committed, but not yet deployed
- [x] Part 4: `docs/research/user-audit.md`. Committed, waiting on the deploy and a live recheck
- [ ] Part 5
