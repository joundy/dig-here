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

Identify players with their predecessor. Payable methods put whatever's attached into the caller's game balance first, then take the cost from the balance. So a wallet can top up once with one approval, and a function-call key then pays silently with nothing attached.

The first credit to an account pays for its record out of that credit, at the exact measured cost. A deposit smaller than that fails.

Attach gas per the table below. Gas is bought at 10× its burn price and the rest refunded later, so don't attach more than the table says from a low-balance guest.

| Method | Attach (Tgas) |
|---|---|
| `dig` | 5 |
| `join`, `leave`, `start`, `deposit`, `deposit_for`, `list_nft` | 10 |
| `withdraw` (needs at least 5) | 10 |
| `poke` | 30 |
| `reveal` | 30 |
| `add_commitments` | 30 for 50 tips |
| `create_room` | 100 |
| `mint_nft`, `buy_nft`, `nft_transfer` | 30 |
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
| `deposit_for({ account_id })` payable | Credits someone else. Used for guest coins. Their record, if new, is paid out of the amount |
| `withdraw({ amount })` exactly 1 yocto | `amount` is a yocto string. Deducts first. Returns `true`, or `false` after restoring the balance if the transfer failed. Needs a full-access key, because a function-call key can't attach the yocto. Needs at least 5 Tgas |

### Rooms

| Method | Notes |
|---|---|
| `create_room({ name, map, fee, duration_sec, host_cut_bps, min_players, max_players, countdown_sec })` payable, returns `room_id` | `map` is `tropical`, `snowy` or `desert`. `name` at most 40 bytes after trimming. `fee` from 1 to 100,000,000,000. `duration_sec` is 60, 180, 300 or 600. `countdown_sec` is 0, 30, 60 or 120. `host_cut_bps` at most 2000. Players from 2 to 30. At most 3 open rooms per host, and **at most 30 open rooms in total**. Takes `host_bond` from the balance. Fails kindly when the commitment pool is empty |
| `join({ room_id })` payable | Fails once the round is due to start, even if nobody has called `poke` yet |
| `leave({ room_id })` | Fee back to the balance. Before the start only |
| `start({ room_id })` | Host only, at the minimum |
| `dig({ room_id, x, y, seen_clue })` | `x`, `y` are whole pixels on land. `seen_clue` is **how many clues the player could see** (1 at the start), so a dig racing a new clue fails and they can decide again |

The host isn't a player unless they also join.

### Rolls

| Method | Notes |
|---|---|
| `poke({ room_id })` anyone, returns a string | Does the first thing due, and nothing otherwise: `"started"`, `"locked"`, `"refunded"` or `"none"`. It never fails on a known room |
| `reveal({ room_id, link })` anyone | Needs the right preimage, in a later block than the lock, and before the deadline. On step 4 this also settles the room |
| `add_commitments({ tips })` oracle only, returns the number now in the pool | At most 100 tips a call and 200 waiting. Each is `H(H(H(H(s))))`. A tip's index is its place in upload order, starting at `commitments_next_index()` |

What `poke` does, in this order:

1. Waiting, and `start_at_ms` has passed: start. `"started"`
2. Waiting, `deadline_ms` has passed: start if at the minimum (`"started"`), otherwise refund with `expired` (`"refunded"`).
3. Live, `ends_at_ms` has passed with fewer than 2 digs: refund with `too-few-digs`. `"refunded"`
4. Live, `reveal_deadline_ms` of the next roll has passed, locked or not: refund with `missed-reveal`, returning the whole bond. `"refunded"`
5. Live, `next_due_ms` has passed and the next roll isn't locked: lock it. `"locked"`

The spec lists 4 and 5 the other way round, but its "locked or not" only makes sense if an overdue roll refunds rather than locks. This order does that.

Steps: 1, 2, 3 reveal clues 2, 3, 4, and 4 rolls the treasure. Clues are due at 30%, 60% and 85% of the round, the treasure at the end. Each reveal deadline is 120 seconds after that roll was due. Bonuses follow clues actually revealed, not the clock.

The oracle's reveal order for a commitment with secret `s`: step 1 `H(H(H(s)))`, step 2 `H(H(s))`, step 3 `H(s)`, step 4 `s`. Byte layouts are in `tests/README.md`.

### NFTs

Token IDs are `<map>:<kind>`, like `snowy:penguin`: 36 in all, 12 per map, as listed in `data/README.md`.

| Method | Notes |
|---|---|
| `mint_nft({ token_id })` payable | First owner. Costs exactly `mint_price`. The NFT's storage comes out of that, and the treasury's **game balance** gets the rest |
| `list_nft({ token_id, price })` | Owner only. `price` is milliNEAR, or `null` to delist |
| `buy_nft({ token_id, seen_price })` payable | Must match the current price. Pays the seller's game balance |

Standards: NEP-171 (`nft_transfer`, `nft_transfer_call`, `nft_token`, `nft_resolve_transfer`), NEP-177 (`nft_metadata`), NEP-178 (`nft_approve`, `nft_revoke`, `nft_revoke_all`, `nft_is_approved`) and NEP-181 (`nft_total_supply`, `nft_tokens`, `nft_supply_for_owner`, `nft_tokens_for_owner`), from `near-contract-standards`.

- `nft_transfer` needs exactly 1 yocto, so **a guest's function-call key can't send one**. This is expected. Tested in the sandbox.
- **The receiver must already have a game record**, or the transfer fails with "The receiver needs a Dig Here balance first". `deposit_for` fixes that. Settlements and sales credit an NFT's owner and must never have to create a record.
- Any transfer ends a listing, including one the owner had made before.

### Season

`close_season()`: anyone, once `ends_at_ms` has passed. Pays places 1, 2, 3 of the top list from the pool and starts the next season.

## Views

Plain JSON. Fields below are all exact.

**`get_config()`** gives the init config. **`get_now_ms()`** gives chain time. **`get_jackpot()`**, **`commitments_left()`**, **`commitments_next_index()`** and **`missed_reveals()`** each give a number.

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
[{ token_id, map, kind, owner /* or null */, price /* milli, or null */, earned, landings }]
```

**`live_state()`**, one batched read for the board and every open room. Measured with 30 full rooms in the gas doc.

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
| `room_created` | `room_id, name, host, map, fee, bond, duration_sec, host_cut_bps, min_players, max_players, countdown_sec, created_ms, deadline_ms, block_height, tip_index, tip, block_seed, layout_seed, landmarks: [{ id, kind, category, x, y, tags, flip }]` |
| `joined`, `left` | `room_id, account, players` (the new count), `start_at_ms` |
| `started` | `room_id, by` (`host`, `timer` or `deadline`), `started_ms, ends_at_ms, block_height, players: [account], pot` |
| `dig` | `room_id, account, x, y, clue_index, bonus_bps, crowded, dug_at_ms` |
| `locked` | `room_id, step, lock_seed, digs_hash, digs_count, lock_ms, lock_height, due_ms, reveal_deadline_ms` |
| `revealed` | `room_id, step, lock_seed, link, digs_hash, roll_seed, clue, candidates_after, treasure, reveal_ms, reveal_height`. For steps 1 to 3 `treasure` is null. For step 4 `clue` and `candidates_after` are null |
| `finished` | `room_id, map, host, players: [account], fee, host_cut_bps, bond, pot, split: { host_cut, jackpot, deed, season, prize }, treasure: { x, y, landmark_id }, winner, ranking: [{ account, x, y, clue_index, bonus_bps, crowded, dug_at_ms, distance, closeness, score }], deed: { token_id, owner, paid, earned, landings }, jackpot_before, jackpot_after, jackpot_win: null or { account, amount }, season_number, season_pool_after, season_points: [{ account, points }], ended_ms, block_height` |
| `refunded` | `room_id, reason, host, players: [account], fee, pot, bond, bond_returned, bond_penalty, jackpot_after, digs_count, ended_ms, block_height, missed_reveals` |
| `commitments_added` | `first_index, count, left` |
| `nft_minted` | `token_id, owner, price, treasury, treasury_received, storage_cost`. The last two are yocto strings |
| `nft_listed` | `token_id, owner, price` (null when delisted) |
| `nft_sold` | `token_id, seller, buyer, price` |
| `nft_listing_cancelled` | `token_id, reason` (`transferred` or `transfer_returned`) |
| `season_closed` | `season, starting_pool, pool_after, prizes: [{ account, prize }], next_season, next_ends_at_ms` |
| `balance` | `changes: [{ account, delta, balance, reason }]`. `delta` is a **signed** yocto string, `balance` the new total as a yocto string |

`reason` in `balance` is one of `deposit, storage, withdraw, withdraw_failed, bond, bond_returned, join, leave, refund, host_cut, prize, deed_share, jackpot, mint, mint_income, nft_buy, nft_sale, season_prize`.

## Randomness and proof

`layout_seed`, `roll_seed`, `digs_hash` and the number stream are as in `tests/README.md` and the spec.

- The validator's seed comes first, ours second: `lock_seed` is fixed at the lock, and `link` only comes out in a later block.
- A reveal in the lock's own block is rejected. Replaying a link fails, because once used it's no longer the preimage of what's expected.
- A verifier can recompute all of it from `get_room` or the events. What it can't do alone is check `block_seed` or `lock_seed` against the chain, because `env::random_seed()` mixes the block's random value with the receipt: see the gas doc.

## Storage

The contract's own balance holds its storage. See the gas doc for the numbers.

- **Player records** are paid by their first credit.
- **Rooms** while open: the bond stays locked in the contract, and it must cover the largest room `max_players` allows, or `create_room` fails.
- **Finished rooms** stay in a ring of 30, and the oldest is deleted. A fixed reserve at deploy pays for those, because the bond goes back. So do the commitment pool (at most 200), the season list and the 36 deed records, all bounded.

## Trust

No method can change the rules or move player funds after `new`. The contract has no owner.

On testnet the deployer keeps a full-access key to `v1.dighere.testnet`, so a person could still redeploy. Before mainnet, delete every key on the account, so nothing can change the code either.

## Build and test

Only through the capped toolbox, from `contract/`:

```
../docker/near cargo near build non-reproducible-wasm --no-abi
../docker/near cargo near build non-reproducible-wasm --no-abi --features gas-probe --out-dir target/near-probe
../docker/near cargo test --lib
../docker/near cargo test --test sandbox -- --test-threads=1 --nocapture
```

`--no-abi` keeps the wasm small. `gas-probe` adds a method that prices the layout roll, and is only for tests.

Rewrite `tests/worst-layouts.json` with `cargo test --lib write_worst -- --ignored`.

## Deploy

To redeploy code to the same account, keeping its state, with a change that doesn't alter any stored layout:

```
../docker/near near contract deploy v1.dighere.testnet use-file target/near/dig_here.wasm \
  without-init-call network-config testnet sign-with-legacy-keychain send
```

A breaking change deploys a new `v2` account, and old state isn't migrated:

```
../docker/near near account create-account fund-myself v2.dighere.testnet '8 NEAR' autogenerate-new-keypair \
  save-to-legacy-keychain sign-as dighere.testnet network-config testnet sign-with-legacy-keychain send
../docker/near near contract deploy v2.dighere.testnet use-file target/near/dig_here.wasm \
  with-init-call new json-args '{"config":{"oracle":"oracle.dighere.testnet","treasury":"treasury.dighere.testnet","mint_price":500,"host_bond":100,"season_length_sec":86400,"prize_excluded_suffix":".bots.dighere.testnet"}}' \
  prepaid-gas '30 Tgas' attached-deposit '0 NEAR' network-config testnet sign-with-legacy-keychain send
```

The account needs 1 NEAR per 100 KB of wasm, plus the reserve in the gas doc.
