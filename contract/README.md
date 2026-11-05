# Dig Here contract

Every rule, roll and coin of the game. Spec: `docs/plans/2026-11-06-testnet-design.md`. Measured costs: `docs/research/contract-gas-and-storage.md`. Deployed on testnet at `v1.dighere.testnet`.

The same rules are in TypeScript in `src/lib/game/`, and `tests/vectors.json` holds the two to the same answers.

## Number formats in JSON

| What | JSON type | Example |
|---|---|---|
| Game balances and anything else in yoctoNEAR | **string** (U128) | `"balance": "1500000000000000000000000"` |
| Fees, prices, pots, shares, jackpot, pools, points | number, whole **milliNEAR** (points have no unit) | `"fee": 100` is 0.1 NEAR |
| Times | number, ms since the epoch | `"dug_at_ms": 1790000089000` |
| Room IDs, tip indexes, block heights | number | `"room_id": 7` |
| Seeds, hashes, links, tips | string, 64 lowercase hex characters | |
| Account names | string | |

All numbers stay under 2^53, so plain JS numbers are safe. 1 milliNEAR is 10^21 yoctoNEAR. Field names are `snake_case`.

Failures are panics with a readable sentence in the error, and they return anything attached.

## Calling it

Identify players with their predecessor. Payable methods put whatever's attached into the caller's game balance first, then take the cost from the balance. So a wallet can top up once with one approval, and a function-call key then pays silently with nothing attached. `mint_nft` is the exception: it needs at least a yocto, so only a real wallet signature can spend a balance on an NFT.

The first credit to an account pays for its record out of that credit, at the exact measured cost. A deposit smaller than that fails.

Attach gas per the table below. Gas is bought at 10× its burn price and the rest refunded later, so don't attach more than the table says from a low-balance account.

| Method | Attach (Tgas) |
|---|---|
| `dig` | 5 |
| `join`, `leave`, `start`, `deposit`, `deposit_for` | 10 |
| `withdraw` (fails below 10) | 10 |
| `poke` | 30 |
| `reveal` | 30 |
| `add_commitments` | 30 for 50 tips |
| `create_room` | 60 |
| `mint_nft`, `nft_transfer` | 30 |
| `nft_approve` with a market `msg` | 30, and see `../contract-market/README.md` |
| `close_season` | 30 |

## Init

```
new({ config: { oracle, treasury, mint_price, host_bond, season_length_sec, prize_excluded_suffix } })
```

Only the contract's own account can call it. There's no admin method afterwards. Testnet values: `mint_price` 500, `host_bond` 100, `season_length_sec` 86400, `prize_excluded_suffix` `".bots.dighere.testnet"`.

## Methods that change state

### Coins

| Method | Notes |
|---|---|
| `deposit()` payable | Needs something attached |
| `deposit_for({ account_id })` payable | Credits someone else. The game no longer calls it, since guest accounts went away, but it's part of the deployed code. Their record, if new, is paid out of the amount |
| `withdraw({ amount })` exactly 1 yocto | `amount` is a yocto string. Deducts first. Returns `true`, or `false` after restoring the balance if the transfer failed. Needs a full-access key, because a function-call key can't attach the yocto. Needs at least 10 Tgas |

### Rooms

| Method | Notes |
|---|---|
| `create_room({ name, map, fee, duration_sec, host_cut_bps, min_players, max_players, countdown_sec })` payable, returns `room_id` | `map` is `tropical`, `snowy` or `desert`. `name` at most 40 bytes after trimming. `fee` from 1 to 100,000,000,000. `duration_sec` is 60, 180, 300 or 600. `countdown_sec` is 0, 30, 60 or 120. `host_cut_bps` at most 2000. Players from 2 to 30. `name` can't hold control characters or bidi overrides, so it can't read as something else. At most 3 open rooms per host, and **at most 30 open rooms in total**. Takes `host_bond` from the balance. Fails kindly when the commitment pool is empty |
| `join({ room_id })` payable | Fails once the round is due to start, even if nobody has called `poke` yet |
| `leave({ room_id })` | Fee back to the balance. Before the start only. Leaving a full room ends the short full-room timer: the countdown runs again from its start, or the timer stops if the room has no countdown or falls below the minimum |
| `start({ room_id })` | Host only, at the minimum |
| `dig({ room_id, x, y, seen_clue })` | `x`, `y` are whole pixels on land. `seen_clue` is **how many clues the player could see** (1 at the start), so a dig racing a new clue fails and they can decide again. Refused while a roll is locked and unrevealed, with `A new clue is arriving. Try again in a moment.` See below |

The host isn't a player unless they also join.

### Rolls

| Method | Notes |
|---|---|
| `poke({ room_id })` anyone, returns a string | Does the first thing due, and nothing otherwise: `"started"`, `"locked"`, `"refunded"` or `"none"`. It never fails on a known room |
| `reveal({ room_id, link })` anyone | Needs the right preimage, in a later block than the lock, and before the deadline. On step 4 this also settles the room |
| `add_commitments({ tips, first_index })` oracle only, returns the number now in the pool | At most 100 tips a call and 200 waiting. Each is `H(H(H(H(s))))`. A tip's index is its place in upload order, starting at `commitments_next_index()`. `first_index` is optional, and when given it must equal that index, so a late copy of an upload fails instead of shifting every later tip |

What `poke` does, in this order:

1. Waiting, and `start_at_ms` has passed: start. `"started"`
2. Waiting, `deadline_ms` has passed: start if at the minimum (`"started"`), otherwise refund with `expired` (`"refunded"`).
3. Live, `ends_at_ms` has passed with fewer than 2 digs: refund with `too-few-digs`. `"refunded"`
4. Live, `reveal_deadline_ms` of the next roll has passed, locked or not: refund with `missed-reveal`, returning the whole bond. `"refunded"`
5. Live, `next_due_ms` has passed and the next roll isn't locked: lock it. `"locked"`

The spec lists 4 and 5 the other way round, but its "locked or not" only makes sense if an overdue roll refunds rather than locks. This order does that.

Steps: 1, 2, 3 reveal clues 2, 3, 4, and 4 rolls the treasure. Clues are due at 30%, 60% and 85% of the round, the treasure at the end. Each reveal deadline is 120 seconds after that roll was due. Bonuses follow clues actually revealed, not the clock.

**No digging between a lock and its reveal.** The oracle holds every link, so once a lock fixes the seed it can compute the next clue. Without this rule it could hold the reveal back and dig on the old clue's bonus, knowing what nobody else knows. So `dig` refuses while a roll is locked and unrevealed:

- It's short. Across 33 clue rolls on testnet (2026-11-05) the gap from lock to reveal was 2.2 s at the median, 2.8 s at the 90th percentile and 5.1 s at worst. A 60-second round has three such gaps. A clue that's due but not yet locked blocks nothing, because no seed exists yet.
- Nobody can extend it. Each step locks once, so a round has at most three, and anyone can lock a due roll but only the link ends the gap.
- It can't strand a round. If the reveal never comes, digging stays shut, on purpose: reopening after a timeout would hand the same lead back. `poke` then refunds as usual: `too-few-digs` at the round's end with under 2 digs, otherwise `missed-reveal` at the deadline. Every coin comes back either way, and anyone can call it.
- The treasure's lock changes nothing. It can't happen before the round's end, so that dig gets `This game has ended` first.

So a withheld clue now costs the holder the whole round rather than buying a lead. It's still a free option on the treasure: reveal on a win, withhold on a loss, and everyone is refunded.

The oracle's reveal order for a commitment with secret `s`: step 1 `H(H(H(s)))`, step 2 `H(H(s))`, step 3 `H(s)`, step 4 `s`. Byte layouts are in `tests/README.md`.

### NFTs

Token IDs are `<map>:<kind>`, like `snowy:penguin`: 36 in all, 12 per map, as listed in `data/README.md`.

| Method | Notes |
|---|---|
| `mint_nft({ token_id })` at least 1 yocto | First owner. Costs exactly `mint_price`. Anything attached goes to the balance first, and the price comes out of it. The NFT's storage comes out of that, and the treasury's **game balance** gets the rest. **A function-call key can't call this**, because it can't attach anything |

Standards: NEP-171 (`nft_transfer`, `nft_transfer_call`, `nft_token`, `nft_resolve_transfer`), NEP-177 (`nft_metadata`), NEP-178 (`nft_approve`, `nft_revoke`, `nft_revoke_all`, `nft_is_approved`) and NEP-181 (`nft_total_supply`, `nft_tokens`, `nft_supply_for_owner`, `nft_tokens_for_owner`), from `near-contract-standards`.

**Selling is the market contract's job**, in `../contract-market/`: an owner calls `nft_approve` with a price, and the market moves the token when someone buys. `list_nft` and `buy_nft` are gone, and so is any listing made with them.

- `nft_transfer` needs a yocto, so **a function-call key can't call it**. Tested in the sandbox.
- **A receiver needs no game record.** Receiving an NFT doesn't make one, because anyone could then grow storage for free by passing a token around fresh accounts. The owner's **first deed share pays for their record**, at the exact measured cost, in the same receipt: a `balance` event shows `deed_share` then `storage`, and `paid` and `earned` are the whole share.
- **A share too small for that isn't stranded.** It goes to the jackpot, exactly as for a deed with no owner, and `deed.owner` in `finished` and `deed_owner` in `get_room` are then null, so Verify's rule is the same one. On testnet that's only a share of 1 milliNEAR, from a pot of 50 to 99, for a name of 18 characters or longer. A share of 0 needs no record, and the owner is still named.
- **A transfer returns the approvals' storage deposit** to the old owner. `near-contract-standards` keeps it on `nft_transfer`, so this contract adds that.
- **An approved account hears when its approval ends.** After a transfer or a revoke, up to 4 approved accounts each get a detached `nft_on_approval_ended({ token_id, owner_id, approval_id })`, with 5 Tgas and no deposit. The account that made the transfer doesn't, since it knows. It's best effort: with under 7 Tgas left it's skipped, so a notice can never make a transfer fail, and a failed notice changes nothing here. `nft_transfer_call` hands nearly all its gas to the receiver, so it usually can't send one.

### Season

`close_season()`: anyone, once `ends_at_ms` has passed. Pays places 1, 2, 3 of the top list from the pool and starts the next season.

## Views

Plain JSON. Fields below are all exact.

**`get_config()`** gives the init config. **`get_now_ms()`** gives chain time. **`get_jackpot()`**, **`commitments_left()`**, **`commitments_next_index()`** and **`missed_reveals()`** each give a number.

**`closeness_range_of({ room_id })`** gives the closeness range a room is scored by, as a number. It answers from the id alone, so it also works for a round long gone from the ring, and for any id. See "The closeness range" below.

**`get_account({ id })`**, `null` if never credited: `{ account_id, balance, season_points }`. `balance` is a yocto string.

**`get_host({ id })`**: `{ finished, expired, open_rooms }`.

**`get_totals()`**, for monitoring: `{ balances, held, jackpot, season_pool }`. `balances` is a yocto string, the rest milliNEAR. The contract's NEAR balance should cover these plus its storage.

**`get_season()`**:

```
{ number, ends_at_ms, pool,
  top: [{ account, points }],              // up to 10 prize-eligible accounts, best first
  last_winners: [{ account, prize }] }
```

Accounts with the excluded suffix never appear in `top`, though they do collect points on their own record.

**`get_nfts({ from, limit })`**: all 36, whether minted or not, in deed order:

```
[{ token_id, map, kind, owner /* or null */, earned, landings }]
```

**`live_state()`**, one batched read for the board and every open room. Measured with 30 full rooms in the gas doc: 32.6 Tgas and 247 KB at worst, so it needs no paging. Open rooms are capped at 30. Send `accept-encoding: gzip`.

```
{ version,                // rises on every change to any room
  now_ms, jackpot,
  season: /* as get_season */,
  commitments_left, missed_reveals, max_open_rooms,
  rooms: [RoomSummary] }  // every open room, oldest first
```

**`get_rooms({ from, limit })`**: `[RoomSummary]` for open rooms, without `landmarks`. `limit` is capped at 30.

`RoomSummary`:

```
{ room_id, version, name, host, map, fee, pot, duration_sec, host_cut_bps,
  closeness_range,        // what this room is scored by. See "The closeness range"
  min_players, max_players, countdown_sec,
  status,                 // "waiting" or "live" here; also "finished" or "refunded" in get_room
  created_ms, deadline_ms,
  start_at_ms,            // when a countdown or full-room timer starts it, or null
  started_ms, ends_at_ms, // null until it starts
  tip_index,              // which commitment this room uses, so the oracle can derive its links
  next_step,              // 1 to 4 when live, otherwise null
  next_due_ms, reveal_deadline_ms,
  locked, lock_height,    // whether next_step is locked and waiting for a reveal
  players: [account],
  digs: [Dig],
  clues: [Clue],
  candidates: [id],       // landmark IDs still possible, in order
  landmarks: [[spot, kind, flip]]   // live_state only
}
```

`landmarks` is compact: index into the map's spot table, index into its roster, then 0 or 1 for `flip`. The browser has both tables in `generated/map-data.json` and `rosterOf`. Landmark IDs are the positions in this list.

`Dig`: `{ account, x, y, clue_index, bonus_bps, crowded, dug_at_ms }`.

`Clue`, as in `types.ts`: `{ level: "yolo" }`, `{ level: "category", category }`, `{ level: "kind", kind }` or `{ level: "detail", kind, tag }`.

**`get_room({ id })`**: everything, as `RoomSummary` without compact landmarks, plus the fields below. It fails for a room that's been deleted from the ring (the events still hold it all).

```
{ ...RoomSummary,
  created_height, tip, block_seed, layout_seed,
  landmarks: [{ id, kind, category, x, y, tags, flip }],
  rolls: [{ step, due_ms, lock_seed, digs_hash, lock_ms, lock_height,
            link, reveal_ms, reveal_height, roll_seed,   // null until revealed
            clue }],                                     // null for step 4
  result: null | {
    ended_ms, pot,
    split: null | { host_cut, jackpot, deed, season, prize },
    refund_reason,                // null, "too-few-digs", "expired" or "missed-reveal"
    treasure: null | { x, y, landmark_id },
    winner,
    ranking: [{ ...Dig, distance, closeness, score }],   // best first
    deed_owner,
    jackpot_win: null | { account, amount },
    jackpot_before, jackpot_after,
    season_points: [{ account, amount }]                 // by place. Empty with under 3 digs
  } }
```

**`get_recent_finished()`**: the last 30 finished and refunded rooms, newest first:

```
[{ room_id, name, host, map, fee, pot, players /* count */, digs /* count */, status,
   ended_ms, refund_reason, treasure, winner }]
```

## Events

NEP-297 logs: `EVENT_JSON:{"standard":"dig-here","version":"1.0.0","event":<name>,"data":{...}}`. NFTs also log `standard: "nep171"` events (`nft_mint`, `nft_transfer`). A receipt that moves coins logs one `balance` event at its end.

Rooms get deleted, so these are the permanent record. Everything a proof needs is here: rebuilding a round needs only `room_created`, `dig`, `locked`, `revealed`, and `finished` or `refunded`.

| Event | `data` |
|---|---|
| `room_created` | `room_id, name, host, map, fee, bond, duration_sec, host_cut_bps, closeness_range, min_players, max_players, countdown_sec, created_ms, deadline_ms, block_height, tip_index, tip, block_seed, layout_seed, landmarks: [{ id, kind, category, x, y, tags, flip }]` |
| `joined`, `left` | `room_id, account, players` (the new count), `start_at_ms` |
| `started` | `room_id, by` (`host`, `timer` or `deadline`), `started_ms, ends_at_ms, block_height, players: [account], pot` |
| `dig` | `room_id, account, x, y, clue_index, bonus_bps, crowded, dug_at_ms` |
| `locked` | `room_id, step, lock_seed, digs_hash, digs_count, lock_ms, lock_height, due_ms, reveal_deadline_ms` |
| `revealed` | `room_id, step, lock_seed, link, digs_hash, roll_seed, clue, candidates_after, treasure, reveal_ms, reveal_height`. For steps 1 to 3 `treasure` is null. For step 4 `clue` and `candidates_after` are null |
| `finished` | `room_id, map, host, players: [account], fee, host_cut_bps, closeness_range, bond, pot, split: { host_cut, jackpot, deed, season, prize }, treasure: { x, y, landmark_id }, winner, ranking: [{ account, x, y, clue_index, bonus_bps, crowded, dug_at_ms, distance, closeness, score }], deed: { token_id, owner, paid, earned, landings }, jackpot_before, jackpot_after, jackpot_win: null or { account, amount }, season_number, season_pool_after, season_points: [{ account, points }], ended_ms, block_height` |
| `refunded` | `room_id, reason, host, players: [account], fee, pot, bond, bond_returned, bond_penalty, jackpot_after, digs_count, ended_ms, block_height, missed_reveals` |
| `commitments_added` | `first_index, count, left` |
| `nft_minted` | `token_id, owner, price, treasury, treasury_received, storage_cost`. The last two are yocto strings |
| `nft_listed`, `nft_sold` | Old code only, so they're still in history. `price` in milliNEAR. Sales are now in the market's events, whose standard is `dig-here-market` and whose prices are yocto strings |
| `nft_listing_cancelled` | `token_id, reason` (`transferred` or `transfer_returned` from the old code, `market_moved` from the upgrade) |
| `closeness_range_changed` | `range_before, range, first_room`. Logged once, by the upgrade |
| `season_closed` | `season, starting_pool, pool_after, prizes: [{ account, prize }], next_season, next_ends_at_ms` |
| `balance` | `changes: [{ account, delta, balance, reason }]`. `delta` is a **signed** yocto string, `balance` the new total as a yocto string |

`reason` in `balance` is one of `deposit, storage, withdraw, withdraw_failed, bond, bond_returned, join, leave, refund, host_cut, prize, deed_share, jackpot, mint, mint_income, nft_buy, nft_sale, season_prize`.

## The closeness range

`closeness = max(0, 1000 - floor(distance / range))`, where `distance` is in thousandths of a pixel. **A round is scored by the range it was created under, for good**, whatever happens later.

| Rooms | `range` |
|---|---|
| Created before the upgrade to the market | 48 |
| Every room after, on any contract with this code | 96 |

**The rule for Verify, in order:**

1. `room.closeness_range` from `get_room`, `live_state` or `get_rooms`, which is always there on this code.
2. Rebuilding from events: `closeness_range` in that room's `room_created` or `finished` event.
3. Neither, for events from before the field existed: **48**. Those rounds can only be from the old code.

Or ask `closeness_range_of({ room_id })`, which gives the same answer for any room. `RULES.closenessRange` and `RULES.closenessRangeBefore` in `src/lib/game/rules.ts` hold the two values, and `scoreDig(dig, treasure, range)` in `engine.ts` takes the room's range as its third argument. Leaving it out means the new range, so **Verify and anything else scoring a real room must pass it**.

The fact behind this is one number, the first room id on the new range, under the storage key `closeness_new_from` and outside the contract's struct, so adding it changed no stored layout. `upgrade_to_market` sets it to `next_room_id` in the same transaction as the deploy, so no room can be created in between, and a room open during the upgrade keeps 48 to its end. `new` sets it to 1. With the key missing, every room is on the old range. Why 96: `docs/research/closeness-range.md`.

## Randomness and proof

`layout_seed`, `roll_seed`, `digs_hash` and the number stream are as in `tests/README.md` and the spec.

- The validator's seed comes first, ours second: `lock_seed` is fixed at the lock, and `link` only comes out in a later block.
- A reveal in the lock's own block is rejected. Replaying a link fails, because once used it's no longer the preimage of what's expected.
- A verifier can recompute all of it from `get_room` or the events. What it can't do alone is check `block_seed` or `lock_seed` against the chain, because they aren't the block header's `random_value`: see the gas doc.

## Storage

The contract's own balance holds its storage. See the gas doc for the numbers.

- **Player records** are paid by their first credit.
- **Rooms** while open: the bond stays locked in the contract, and it must cover the largest room `max_players` allows, or `create_room` fails.
- **Finished rooms** stay in a ring of 30, and the oldest is deleted. A fixed reserve at deploy pays for those, because the bond goes back. So do the commitment pool (at most 200), the season list and the 36 deed records, all bounded.

## Trust

No method can change the rules or move player funds after `new`. The contract has no owner. `upgrade_to_market` is private to the contract's own account, runs once, and moves no coins.

On testnet the deployer keeps a full-access key to `v1.dighere.testnet`, so a person could still redeploy. Before mainnet, delete every key on the account, so nothing can change the code either.

## Build and test

Only through the capped toolbox, from `contract/`:

```
../docker/near cargo near build non-reproducible-wasm --no-abi
../docker/near cargo near build non-reproducible-wasm --no-abi --features gas-probe --out-dir target/near-probe
../docker/near cargo test --lib
../docker/near cargo test --test sandbox -- --test-threads=1 --nocapture
../docker/near cargo test --test sandbox -- --ignored upgrading_in_place
```

The last one proves an in-place upgrade. It needs the live code at `target/near-old/dig_here.wasm`, checked against the account's `code_hash`, and the market's wasm from `../contract-market`. It builds up state on that code, deploys over it, compares every stored key and every view, plays the open rooms on, and sells an old NFT through the real market.

Both contracts working together are in `../contract-market/tests/sandbox.rs`.

`--no-abi` keeps the wasm small. `gas-probe` adds a method that prices the layout roll, and is only for tests.

Rewrite `tests/worst-layouts.json` with `cargo test --lib write_worst -- --ignored`.

## Deploy

To redeploy code to the same account, keeping its state, with a change that doesn't alter any stored layout:

```
../docker/near near contract deploy v1.dighere.testnet use-file target/near/dig_here.wasm \
  without-init-call network-config testnet sign-with-legacy-keychain send
```

The upgrade to the market had to run its one-time step in the same transaction, so it used `with-init-call upgrade_to_market json-args '{}' prepaid-gas '30 Tgas' attached-deposit '0 NEAR'` in place of `without-init-call`. Stored layouts didn't change, so the state stayed as it was, apart from clearing old listings and the new `closeness_new_from` key.


Live on `v1` since 2026-11-05, block 276351982 at the latest: code hash `HeyyJyAWDijgD738tEAoKtydeQpHjtFygyz8uU8emjiA`, sha256 `f775e5dd...`, from `7byeeAYY...`, which the sandbox's upgrade test ran on byte for byte. Transaction `Hc4uscCvwpoewBhmwQC1kbo3aiAuvevXGva9QBARNhaM`. Rooms from 175 on use the range of 96. Three old listings ended, with `market_moved`. Read before and after with no round open: `get_totals`, every other view, 25 accounts' balances and 30 rooms were all identical, apart from `closeness_range` added and `price` dropped. The total owed stayed 8.2010 NEAR, with 1.27 NEAR free above that and storage. The upgrade cost 0.0033 NEAR.

The commitment pool's next index on `v1` is 1, because the testnet smoke test used index 0 with a throwaway secret. The oracle reads it from `commitments_next_index()`.

A breaking change deploys a new `v2` account, and old state isn't migrated:

```
../docker/near near account create-account fund-myself v2.dighere.testnet '6 NEAR' autogenerate-new-keypair \
  save-to-legacy-keychain sign-as dighere.testnet network-config testnet sign-with-legacy-keychain send
../docker/near near contract deploy v2.dighere.testnet use-file target/near/dig_here.wasm \
  with-init-call new json-args '{"config":{"oracle":"oracle.dighere.testnet","treasury":"treasury.dighere.testnet","mint_price":500,"host_bond":100,"season_length_sec":86400,"prize_excluded_suffix":".bots.dighere.testnet"}}' \
  prepaid-gas '30 Tgas' attached-deposit '0 NEAR' network-config testnet sign-with-legacy-keychain send
```

The account needs 1 NEAR per 100 KB of wasm, plus the reserve in the gas doc.
