# Contract gas and storage

Measured 2026-11-05, on the real wasm in a `near-sandbox` 2.14.0 node (protocol 88), by `contract/tests/sandbox.rs`. Wasm SHA-256 `a0d5b128e1aeb9ac16c187b29bfba3f1dd3a4cb06205572c01da63b7b47d27df`. Everything is **[measured]** unless marked **[inferred]** or **[read]**. Method and event fields are in `contract/README.md`.

All numbers are for the worst shape: 30-player rooms, every name 64 characters, a 40-byte room name, 20% host cut. Real rooms with shorter names cost less.

## Headlines

| | |
|---|---|
| Wasm | **379,583 bytes** (3.80 NEAR locked), of which 35,880 are map data. Built with `opt-level = "z"`, LTO, `panic = "abort"`, and `cargo near`'s wasm-opt |
| `create_room` | **typically 14 to 19 Tgas**, 0.0014 to 0.0019 NEAR burned. About 37 Tgas on the worst of 1,000 seeds per map |
| `dig` | **2.9 Tgas**, 0.00029 NEAR |
| `join` | **3.0 Tgas**, 0.00030 NEAR |
| `poke` | **3.1 Tgas** to lock, **12.1 Tgas** for a 30-player refund, 2.2 when nothing's due |
| `reveal` | **3.1 Tgas** for a clue |
| Settlement (`reveal` step 4) | **9.3 Tgas**, 0.00093 NEAR |
| `live_state`, 30 full rooms | **32.6 Tgas**, 246,690 bytes |
| Largest room | 3,682 bytes (0.037 NEAR) |
| Open room cap | **30**, `MAX_OPEN_ROOMS` in `rules.rs` |

## Gas by method

"Burned" is the whole transaction: conversion plus every receipt. Gas is bought at 10× this price and the rest refunded later, so the signer must briefly hold about ten times what's burned, on whatever is attached. "Attach" is what to send. Those for `join`, `start`, `dig`, `poke`, `reveal` and `withdraw` were each tried on the worst-case call and passed (`recommended_gas_is_enough_for_the_worst_case`).

| Call | Burned (Tgas) | NEAR burned | Storage change (bytes) | Attach (Tgas) |
|---|---|---|---|---|
| `deposit`, first (pays its record) | 2.524 | 0.00025 | +146 | 10 |
| `deposit`, again | 2.221 | 0.00022 | 0 | 10 |
| `deposit_for`, first | 2.535 | 0.00025 | +146 | 10 |
| `withdraw`, success | 5.175 | 0.00052 | 0 | 10, the minimum enforced |
| `add_commitments`, 1 tip | 2.013 | 0.00020 | +81 | 10 |
| `add_commitments`, 50 tips | 6.761 | 0.00068 | +4,050 | 30 |
| `add_commitments`, 100 tips (the most in a call) | 11.633 | 0.00116 | +8,100 | 30 |
| `create_room`, tropical seed | 18.888 | 0.00189 | +480 | 60, see below |
| `create_room`, desert seed | 13.826 | 0.00138 | +480 | 60 |
| `join`, 1st player | 2.574 | 0.00026 | +68 | 10 |
| `join`, 29th | 3.003 | 0.00030 | +68 | 10 |
| `join`, 30th (sets the full-room timer) | 3.022 | 0.00030 | +76 | 10 |
| `leave`, from 29 players | 3.013 | 0.00030 | -68 | 10 |
| `start`, 30 players | 3.432 | 0.00034 | -7 | 10 |
| `dig`, 1st | 2.716 | 0.00027 | +15 | 5 |
| `dig`, 30th (checks crowding against 29) | 2.878 | 0.00029 | +15 | 5 |
| `poke`, nothing due | 2.168 | 0.00022 | 0 | 30 |
| `poke`, lock with 30 digs | 3.015 to 3.069 | 0.00031 | +98 | 30 |
| `poke`, refund 30 players | 12.128 | 0.00121 | +29 | 30 |
| `reveal`, clue | 3.060 to 3.089 | 0.00031 | 0 to +34 | 30 |
| `reveal` step 4, settle with no deed owner | 8.594 | 0.00086 | +348 | 30 |
| `reveal` step 4, settle with an owned deed and the oldest room evicted | 9.339 | 0.00093 | -2,665 | 30 |
| `mint_nft`, first | 3.544 | 0.00035 | +815 | 30 |
| `mint_nft`, by the same owner | 3.903 | 0.00039 | +604 | 30 |
| `list_nft` | 2.209 | 0.00022 | +63, then +8 | 10 |
| `buy_nft` | 4.471 | 0.00045 | +193 | 30 |
| `nft_transfer`, cancelling a listing | 3.547 | 0.00035 | -8 | 30 |
| `close_season`, 3 winners | 2.914 | 0.00029 | 0 | 30 |

**Not covered by the settlement figures:** an exact-pixel jackpot hit adds one more credit, about 0.1 Tgas **[inferred]**, and a top list already holding ten 64-character names adds about 0.05 Tgas of state **[inferred]**. Both are well inside the 30 attached. The jackpot path itself ran and passed on a smaller room.

**A full round costs** about 18 + 30 joins (90) + 30 digs (86) + 4 pokes (12) + 4 reveals (18) = **about 224 Tgas, or 0.022 NEAR, burned in total**. The oracle's share is about 30 Tgas, or 0.003 NEAR, which is what it needs per room besides commitments (0.0014 NEAR per 10).

### The withdraw callback

A failed transfer's coins come back only through `on_withdraw`, so it must never run out of gas. It burned **1.877 Tgas** on the failure path with a 64-character name, called with the minimum 10 Tgas attached. It first had 2 Tgas reserved, which was far too close, so **it now has 5 Tgas, and `withdraw` refuses less than 10 Tgas attached**. Test: deleted the account with the coins on their way, and every yocto came back.

## Layout gas, the main risk

Rolling the layout is the costly part of `create_room`. A draw isn't quite a hash: there's a SHA-256 host call every 8 words. Measured by a `gas-probe` build of the wasm, which runs only the roll on a chosen seed:

| Map | Seeds scanned | Median draws | Median Tgas | Worst draws | Worst Tgas |
|---|---|---|---|---|---|
| tropical | 1,000 | 4,295 | 15.14 | 10,410 | 33.77 |
| snowy | 1,000 | 3,566 | 13.81 | 7,553 | 26.51 |
| desert | 1,000 | 2,855 | 11.72 | 3,620 | 14.48 |

That's about **3 Tgas per 1,000 draws**. The wasm's draw counts matched the native scan on every seed.

The brief expected worst cases around 1,000 draws. They're ten times that, because a try that lands on a spot unfit for the kind still draws, and rejects are common. The vectors' own layouts already ranged from 2,550 to 4,978 draws. It doesn't matter: the gas is well under any limit.

A wider native scan of **30,000 seeds per map** (counts only, no gas) found:

| Map | Median | p99 | p99.9 | Max |
|---|---|---|---|---|
| tropical | 4,295 | 8,781 | 9,840 | 13,592 |
| snowy | 3,565 | 4,343 | 7,230 | 9,102 |
| desert | 2,849 | 3,378 | 3,587 | 4,173 |

The jump at the top is a whole-layout restart. The worst seen, 13,592 draws, comes to about 44 Tgas in the probe **[inferred from the slope]**, and `create_room` adds about 3 Tgas around that **[inferred]**, so **about 47 Tgas**.

**Decision: no fix needed.** The layout isn't too costly. A typical `create_room` burns 0.0015 NEAR, the host only ever pays it once per room, and it's far under the limit of 1 PGas per receipt [read from testnet's protocol config]. **Attach 60 Tgas**, which clears everything seen. If a rare layout did run out of gas, the call just fails, the deposit comes back, and trying again gets a new seed. No test has run `create_room` itself at exactly 60 Tgas on a worst-case seed, because a seed can't be chosen on chain.

If it ever matters, the cheapest fix is hashing inside the wasm: a host SHA-256 costs about 10 Ggas with its register reads, and half the roll's gas goes on them **[inferred, not tried]**.

Never failing: rolled 2,000 seeds per map, then 30,000 per map, and every one placed all 40 landmarks.

## `live_state`, one batched read

| State | Gas (Tgas) | JSON bytes |
|---|---|---|
| 30 open rooms, 30 players each, no digs | 17.630 | 93,813 |
| **30 full rooms, 30 digs each** | **32.556** | **246,690** |

- **Gas fits, so no paging.** Measured by calling it as a transaction, which runs the same code. A plain view on the sandbox node also returned it.
- **The limit for a view** is a node setting (`max_gas_burnt_view`), not visible over RPC. NEAR's default is 300 Tgas, from memory, **not checked**. I haven't tried a large `live_state` on a public RPC, because that would take 30 full rooms on testnet. This leaves a margin of 9×.
- **The open-room cap is 30** (`MAX_OPEN_ROOMS`). `create_room` beyond it fails kindly: "Too many games are open right now". Tested. Gas grows about 1.1 Tgas per full room, so the cap could rise to about 100 on gas alone **[inferred]**, but the size below argues against it.
- **Landmarks are in compact form**, `[spot, kind, flip]`, about 400 bytes a room instead of about 3.6 KB. With 30 rooms that's about 96 KB less per read, or about 28%. A poller can afford to get them every time, and they never change.

**Size is the real cost, not gas.** The RPC returns view results as a JSON array of byte values, which triples them: `live_state` with one small live room was 1,292 bytes of JSON and **4,399 bytes on the wire**, or 1,050 with gzip [measured on `test.rpc.fastnear.com`, 0.33 s]. So the absolute worst case is about **840 KB a poll, or about 200 KB with gzip [inferred]**. Backends should send `accept-encoding: gzip`. Real rooms are much smaller: most of that 247 KB is 64-character names repeated, and 10 rooms of 8 players with 20-character names would be about 20 KB of JSON **[inferred]**.

If that ever bites, `version` in the response and per room already allows a smaller view returning only rooms changed since a given version. Not built, because nothing needs it yet.

**A griefing note.** With a cap, someone can fill the lobby: 10 accounts, 3 rooms each, all left below their minimum. Each slot costs them 10% of the bond when it expires, so holding all 30 slots for 15 minutes costs 0.3 NEAR on testnet's bond. That's about 29 NEAR a day. On mainnet the bond should make that expensive enough, but it's worth watching. Rooms past their deadline stay open until someone pokes them, so the oracle should poke them promptly.

### Other views

| View | Gas (Tgas) | Bytes |
|---|---|---|
| `get_rooms`, 30 full rooms | 30.208 | 233,806 |
| `get_room`, finished, 30 players | 4.044 | 20,996 |
| `get_room`, live, 30 digs | 3.018 | 12,180 |
| `get_recent_finished`, 30 full rooms | 11.436 | 9,204 |
| `get_nfts`, all 36 | 6.403 | 4,071 |
| `nft_tokens`, 2 tokens | 2.385 | 891 |
| `get_account` | 1.535 | 137 |

## Logs

A receipt can log 16,384 bytes and 100 lines [read from testnet's protocol config]. Going over fails the call, which would strand a settlement, so these matter:

| Receipt | Log bytes |
|---|---|
| Settlement with an owned deed, 30 long names | 10,679 |
| Settlement, no owner | 10,442 |
| 30-player refund | 7,752 |

An exact-pixel hit adds one `balance` row, about 150 bytes **[inferred]**. Every path stays under the limit.

## Storage

1 NEAR per 100 KB, confirmed by testnet's `storage_amount_per_byte` of 10^19 yocto [read from its protocol config].

### Records

| Record | Bytes | NEAR |
|---|---|---|
| Player record, 64-character name (pays for itself on first credit) | 146 | 0.00146 |
| Player record, `dighere.testnet` on testnet | 97 | 0.00097 |
| Room when created | 480 | 0.0048 |
| Each player | 68 (64-char name) | 0.00068 |
| Each dig | 15 | 0.00015 |
| Each lock | 98 | 0.00098 |
| Finished room, the largest possible | **3,682** | **0.037** |
| A waiting commitment (at most 200) | 81 | 0.00081 |
| First NFT mint / next by the same owner (paid from the mint price) | 815 / 604 | 0.0082 / 0.0060 |

### Who pays

| Storage | Paid by | Bound |
|---|---|---|
| Player records | Their first credit, at the exact measured cost | One each, paid |
| Open rooms | Host bond, locked while open | `create_room` needs `host_bond >= (1300 + 83 * max_players) * byte cost`. A test holds that formula to the real encoding. 30 players needs 0.0379 NEAR, and testnet's bond is 0.1 |
| The ring of 30 finished rooms | The reserve, because the bond goes back | 30 × 3,682 bytes = **1.10 NEAR** at the very most |
| Commitments | The reserve | 200 × 81 = **0.162 NEAR** |
| Deed records, season list, main state | The reserve | About **0.05 NEAR** |
| NFT tokens | The mint price, by taking it from what the treasury gets | 36 tokens |

Eviction releases storage: settling a room when the ring is full changed storage by -2,665 bytes. Storage stayed flat with the ring full (`open_rooms_are_capped_and_old_rooms_fall_off_the_ring`).

**The reserve the contract needs above its code is 1.31 NEAR at most.** `v1` was funded with 5.5 NEAR: 3.80 for the code, 1.70 free. If the reserve ever ran out, withdrawals would fail with `LackBalanceForState` and restore nothing lost, because the receipt reverts whole; topping up the account fixes it.

`get_totals()` plus the account's balance shows this at any time. `assert_solvent` in the sandbox tests checks that the contract holds everything it owes plus its storage, after each kind of round.

## Testnet

Deployed `v1.dighere.testnet`. See `contract/README.md` for how to redeploy.

A smoke test ran the real thing, with the deploy and all of it costing the root about 0.01 NEAR beyond the coins sent to these accounts: `new`, the views including `live_state`, `add_commitments` from the oracle, then room 1 (`create_room` with top-up, two joins, `start`), a `too-few-digs` refund through `poke` a minute later, and both balances withdrawn. The tip it used has a throwaway secret, so room 1 used it up on purpose: **the pool's next index is 1, and the oracle should start there.**

| Real testnet transaction | Burned (Tgas) |
|---|---|
| Deploy and `new` | 31.663 |
| `add_commitments`, 1 tip | 2.284 |
| `create_room`, tropical | 19.034 |
| `join` from balance | 2.801 |
| `join` with top-up, first record | 3.387 |
| `start`, 2 players | 2.549 |

First credits on testnet paid for records: 97 bytes (0.00097 NEAR) for `dighere.testnet` and 104 bytes (0.00104 NEAR) for `oracle.dighere.testnet`. Both balances then withdrew to zero, and `get_totals` shows nothing owed.

After all of this: root 46.36 NEAR, `v1` 5.50 NEAR (3.81 locked, 1.69 free), oracle 2.00, treasury 0.10.

Those match the sandbox closely, which supports trusting the rest.

## Block randomness, for the verify screen

`random_value` is in every block header over RPC. **It isn't what the contract sees**: smoke room 1 on testnet was created at height 276315289, whose `random_value` is `3a38302a...`, and its `block_seed` is `666f8add...` [both measured]. `env::random_seed()` is, as far as I recall, that value mixed with the receipt, but I haven't derived one to prove it. So the "Verify this round" screen can't compare `block_seed` or `lock_seed` to a header, and it should say that those two values come from the contract.
