# Security review: contract, backend, browser backend

Reviewed 2026-11-05 on branch `testnet-integration`, up to commit `4eab9a7`. Scope: `contract/` (live at `v1.dighere.testnet`), `server/`, `src/lib/backend/near.svelte.ts` and the code it calls, against `https://docs.near.org/smart-contracts/security/checklist.md` and every page in that section. Read-only for production code.

**No testnet coins were spent.** Testnet was only read, through views and block queries.

**The code tested is the code deployed.** The sandbox ran `contract/target/near/dig_here.wasm`, SHA-256 `a0d5b128...`, whose base58 form `BpqDsfNS...` equals the live `code_hash` of `v1.dighere.testnet`.

Evidence is marked:

- **[sandbox]**: ran on a local `near-sandbox` node with the real wasm, through `docker/near`
- **[native]**: ran as a Rust test against the contract's own code on the mocked VM
- **[harness]**: ran the real server or browser code, with a stand-in for the RPC node and funder, so no coin moved
- **[live read]**: read from testnet
- **[read]**: reasoning from the code, not run

## Summary

The contract's money handling held up. Random play and whole rounds never created or lost a yocto, and I found no way to steal from a balance without holding its key, or to strand a settlement. The problems are around it:

| # | Severity | Finding | Evidence |
|---|---|---|---|
| 1 | High | A browser's function-call key can move a whole game balance to someone else | sandbox |
| 2 | High | Guest limits fall to one burst, so the root can be drained to its floor | harness + sandbox |
| 3 | High (testnet) | Bots join any human's room at any fee, so a host can farm the bot budget | harness |
| 4 | High | Verify shows all green for a completely invented round | harness |
| 5 | Medium | The oracle can learn a clue early and dig on the old bonus, beyond what the spec admits | read |
| 6 | Medium | Sybil digs after clue 4 take the jackpot at a profit, and the cap doesn't stop it | native |
| 7 | Medium | All 30 lobby slots can be held at no bond cost | sandbox |
| 8 | Medium | Any client can make the server hammer the RPC, and the oracle lives on that same poll | harness |
| 9 | Medium (mainnet blocker) | The link goes out before the lock is final, so one validator can re-roll | read |
| 10 | Medium (mainnet blocker) | The contract account keeps a full-access key, and Verify doesn't check the code hash | live read |
| 11 | Low | A listed NFT can be sniped once clue 3 makes its landing public | sandbox |
| 12 | Low | Filling a room for a moment and leaving cancels the countdown | sandbox |
| 13 | Low | Smaller items, listed at the end of the findings | mixed |

## Fixed since this review (2026-11-05)

Each with a test that failed first. Findings below stay as written, as the record of what was found.

| Finding | What changed | What's left |
|---|---|---|
| 1 | `buy_nft` needs a yocto, and came off the guest key list | `join`, `create_room`, `mint_nft` and `list_nft` still spend silently. A stolen key can still join a thief's expensive room. Needs the decision the finding asks for |
| 2 | Guest slots are reserved before any await, on the retry path too. Funds are a running total, at most 10 guests are made at once, retries are capped at 4 an hour per key, and IPv6 counts by /64 | Turnstile, and lowering the credit |
| 3 | Bots only join a human's room at a fee up to 50 milliNEAR and a host cut up to 10%, in at most 3 rooms per host per hour | Limits are per account, so many hosts dodge the per-host count. The fee, cut and `botsBudget` still bound the loss |
| 5 | `dig` is refused between a lock and its reveal | The free option on the treasure, and the long deadline on short rounds |
| 8 | `/api/live` can't trigger a read. One poller, at most one read a second, plus oracle wakes at most every 500 ms. SSE capped at 500 in total and 20 per address | No general rate limit on other routes |
| 12 | Leaving a full room runs the countdown again | A griefer filling the room repeatedly can delay a start, up to the deadline |
| 13 | Commitments can name `first_index`. Malformed URLs and bad escapes get a 400. `buy_nft` returns approval deposits. Double credit is checked before retrying. The sweeper skips runs while the indexer is behind. Room names can't hold controls or bidi overrides | The rest of 13 |

## High

### 1. A browser's function-call key can move a whole game balance

**The claim that fails.** `money.rs` says a browser's key "can't move coins out", `session.ts` says a guest's key "can't take coins out of the game", and the sandbox test is named `function_call_keys_can_play_but_not_move_coins`. That test only tries `withdraw` and `nft_transfer`. `buy_nft`, `list_nft`, `mint_nft`, `join` and `create_room` spend the balance with nothing attached, and they're all on the key (`GUEST_METHODS`, `GAME_METHODS`). The same list goes on a wallet player's key, stored in `localStorage` as `access_key::plugin::testnet::<account>`.

**Attack with `buy_nft`.** The thief owns any NFT and lists it at the victim's balance. Using the stolen key, they call `buy_nft`, then `list_nft` at 1 milliNEAR, then buy it back from their own account. The same NFT is ready for the next victim.

**Attack with `join`, needing no NFT.** The thief hosts a room with the fee set to the victim's balance. The stolen key joins and never digs. The thief and an alt join and dig, so the victim can't win.

**Evidence [sandbox]**, with a key limited to exactly `GUEST_METHODS`:

- `buy_nft`: guest balance 599 -> 0 milliNEAR, thief's balance up by 599. After `withdraw`, the thief's wallet gained 601 milliNEAR net of gas, the contract's balance fell by 602, and the thief owned the NFT again.
- `join`: guest balance 599 -> 0. Thief plus alt went from 1306 to 1800 milliNEAR, a gain of 494 of the 599. The rest went to the jackpot, deed and season shares.

The docs' [one yocto page](https://docs.near.org/smart-contracts/security/one_yocto.md) names this pattern: transfers of value shouldn't run through a function-call key.

**Precondition.** The thief needs the key. I found no XSS (see "What held up"), but there's no CSP, and the key sits in `localStorage` for any script or browser extension on the page to read. For a guest, the "thief" can simply be the person who asked for the guest (finding 2).

**Fix.** This is a design change to the spec's "pays silently", so it needs your decision.

- Require 1 yocto on `buy_nft`, `mint_nft` and `list_nft`, and take them off both key lists.
- Give `join` and `create_room` a silent-spend cap: when nothing is attached, refuse a fee or bond above a per-account limit, which only a 1-yocto call can raise. Default it near the testnet fee choices.
- Correct the comments and extend the test to `buy_nft`.

### 2. Guest limits fall to one burst, and the root can be drained to its floor

**Bug.** `Guests.#create` runs `#checkLimits` before the row is inserted, with `await this.#checkFunds()` between them. While that read is in flight, every other request also passes the limits. `#checkFunds` makes it worse by overwriting `#funderSpare` with the fresh reading, so simultaneous requests don't add up. The cache expires every 15 seconds, so the window reopens four times a minute.

The `Origin` check doesn't help, because a script sets any `Origin` it likes.

**Attack.**

1. Send 200 `POST /api/guest-accounts` at once, with forged `Origin` and 200 fresh public keys.
2. All 200 rows are inserted. Rows whose creation fails because the funder ran dry stay in the table, and the retry path (`isRetry`) skips the limit checks, so they can be retried as the root refills the funder: 2 NEAR at a time, every 5 seconds at most, down to the 6 NEAR guest floor [read].
3. Each guest holds a 0.6 NEAR game balance and the attacker holds its key. Finding 1 moves that balance to the attacker, who withdraws it. The NFT comes back each time, so one NFT serves them all.

**Evidence.**

| Run [harness] | Result |
|---|---|
| Control: 6 requests one at a time from one IP | `200 200 200 429 429 429`, 3 accounts |
| 200 at once from one IP, limits 3 per hour and 25 per day, RPC stand-in answering in 150 ms | **200 × 200, 200 accounts, 136 NEAR of credit and gas sent** |
| `TRUST_CF_CONNECTING_IP=1`, forged header, 30 one at a time | 25 × 200 then 5 × 429: the per-IP limit is gone, and the daily cap holds |

The extraction step is proven in finding 1 **[sandbox]**. I did not run the whole chain on testnet, because it would burn the coins it demonstrates. With the root at about 46 NEAR and a 6 NEAR floor, about 40 NEAR is exposed [inferred]. Guests are switched off in production, so this is a testnet risk, but those coins are the scarce resource.

**Also.** Even without the burst, the 25-a-day cap is a cheap denial of service: a few IPs use up the day's guests, and jurors then see "Today's guest accounts have run out". The per-IP limit counts exact addresses, so one IPv6 /64 is effectively unlimited [read].

**Fix.**

- Reserve the slot synchronously: run the limit check and the insert together, before any `await`.
- Keep a running total for the funds check instead of re-reading over it.
- Put the same limits on the retry path, or cap attempts per row.
- Add a global limit on guest creations in flight.
- Bucket IPv6 by /64.
- Use a Turnstile check on this one route, since it hands out coins.
- Lower the credit: finding 1 turns each guest directly into withdrawable coins.

### 3. Bots join any human's room at any fee

**Bug.** `#tendWaiting` and `botTarget` never read `room.fee` or `room.host_cut_bps`, and `#join` attaches whatever the fee needs, up to the bot's whole spare wallet. A human-hosted room counts as `humanHere`, so bots fill it quickly while anyone is watching. Anyone can make that true by reading `/api/state`.

**Attack.** Host a room with a fee of 0.2 NEAR, a 20% host cut and `min_players` 8. Bots fill it and dig on their own. The host's cut is risk-free at 20% of everything they paid, and the host can also join and dig last to try for the prize. Repeat until `botsBudget` (8 NEAR) is gone.

**Evidence [harness]**: the real `Bots` class and real signing, with an RPC stand-in and the attacker's room in the frame. All 8 bots sent `join` for that room within 40 seconds. Five attached 0.22 NEAR. The other three attached nothing, and at zero balance the chain would refuse them; I didn't trace why those three differed. On the five funded bots alone, the pot is 1 NEAR and the host cut 0.2 NEAR per round, for about 0.002 NEAR of the host's gas [inferred from the gas doc]. No round was played out.

The loss is capped by the budget, and bots are testnet only. But they'd also stop filling rooms during the demo once it's spent.

**Fix.** Bots join only rooms with a fee at or under 50 milliNEAR and a host cut at or under 5%, or only rooms with a real second player. Also cap how many bots go into one host's rooms per hour.

### 4. Verify shows all green for a completely invented round

**The claim that fails.** `verify.ts` opens with "Nothing here trusts our backend". But `proofOf` falls back to `roomFromEvents`, built from our own `/api/games/:id/proof`, whenever a room has left the ring of 30 finished rooms. And `get_room` comes from one RPC node with no proof. Every check is internal consistency between numbers from the same source, and `lock_seed` and the block heights are never tied to the chain. Whoever serves the data can write a consistent story.

The screen exists to protect players from us, so the case that matters is us, or our server when compromised.

**Attack.** Pick the digs you like, then try invented `lock_seed` values until your account's dig wins, and serve the round that would produce it. The round's money never has to exist.

**Evidence [harness]**: the real `verifyRound`, forged rounds built with the same rules code:

| Forged data | Screen says |
|---|---|
| Whole round invented, the forger wins, seeds and heights made up | **All 29 checks passed** |
| A dig stamped 58 s into a 60 s round, after every clue, still on the 2.5× bonus | **All 29 checks passed** |
| Step 4's `digs_hash` leaves out a dig | **All 29 checks passed** |
| `status: finished` with `result: null` | **All 22 checks passed**, the treasure group just vanishes |
| `status: finished`, no rolls, no result | **All 3 checks passed** |
| Refunded as `missed-reveal`, with every reveal on time | **All 19 checks passed** |
| Same player digs twice | Caught, but only by the ranking and season lines. The dig check itself passed |

The causes, one by one:

- `digsAtLock` accepts any prefix of the digs, even for the treasure roll, where it must be all of them.
- `digChecks` looks up the bonus from `clue_index`, but never checks `clue_index` against when clues came out.
- `endChecks` and `refundChecks` return no checks when `result` is missing, and an empty group is dropped. `overallState` then says pass.
- A `missed-reveal` refund has `ok = true` hard-coded.
- Credits aren't checked at all, though the proof carries the `balance` rows.

**The screen's "What you're trusting" text** says the numbers are what "the contract stored", which isn't so for the event path. It also never mentions the backend, the RPC node or the contract's code hash.

**The lock seed can't be confirmed yet.** I tried to recompute `lock_seed` from the block's `random_value`, the receipt ID and block hashes, on three real testnet locks. No formula I tried matched [live read], so the guess in the gas doc stays unproven.

**Fix.**

- Fetch the proof's transactions from a public RPC by hash, with the browser checking `executor_id`, success and the log text, so the backend supplies only hashes.
- Say on screen which source each round came from. Compare two RPC providers when both answer.
- Make a finished room with no result or an incomplete chain go red, by requiring steps 1 to 4 and all three clues.
- Require step 4's hash to cover every dig.
- Recompute each dig's `clue_index` from the reveal order.
- Check a `missed-reveal` against the deadline and the rolls.
- Check the `balance` rows.
- Show the code hash, and name the trust in the RPC and the contract's key (finding 10).

## Medium

### 5. The oracle can learn a clue early and dig on the old bonus

The spec says of the oracle: "We see the result before revealing, but all we can do is refuse". That's true of the treasure, because digs close before its lock. It isn't true of clues.

**Attack [read]**, by anyone holding `ORACLE_SECRET`:

1. The holder knows every link from the start. Once a clue's lock lands, `lock_seed` is public, so they can compute the next clue at once.
2. They hold back the reveal, and dig from an alt with `seen_clue` still at the old count. The dig is accepted at the higher bonus, with knowledge nobody else has.
3. The hold can be long. The deadline is 120 s after due, which outlasts a 60 s round: step 1 is due at 18 s and can wait until 138 s. Nothing forces a clue out before digging closes, so everyone else plays the whole round without it.

It also has a free option on the treasure: reveal when the holder wins, withhold when they lose, and everyone is refunded at no cost to the oracle. The spec admits refusing, but not that it can be used this way with nothing at stake.

**A smaller version for outsiders [read].** Anyone who sees the `reveal` before it lands, meaning the relaying RPC node or a chunk producer, knows the clue about one block early. NEAR has no public mempool, and a dig in that window needs to land before the reveal, so this is narrow.

Bots run in the same process as the secret. They use only public data (`aim` reads `room.candidates`), so that isn't a leak today [read].

**Fix.** Refuse digs while a roll is pending: a lock to reveal window where the contract rejects `dig`. It removes both the insider's lead and the front-run, because nobody can use a clue they learned between lock and reveal. It needs care with the dig window, and it means a withheld clue stops digging, which is visible. Also shorten the window for short rounds, such as the lesser of 120 s and 20% of the duration. On mainnet, a slashable oracle bond would price the free option. Correct the spec's sentence either way.

### 6. Sybil digs after clue 4 take the jackpot at a profit

The plan says the 100× cap stops people running "tiny rounds with their own wallets" for a jackpot others built. The numbers say otherwise.

**Evidence [native]**: the contract's own rolls, 600 seeds per map. Clue 4 leaves about 2.1 candidates, and K digs on the likeliest pixels hit as follows:

| Map | K = 2 | K = 3 | K = 10 | K = 30 | Check of K = 30 with `roll_treasure`, 12,000 rolls |
|---|---|---|---|---|---|
| tropical | 0.25% | 0.37% | 1.23% | 3.70% | 3.77% |
| snowy | 0.23% | 0.35% | 1.16% | 3.47% | 3.33% |
| desert | 0.22% | 0.33% | 1.10% | 3.31% | 3.12% |

**The economics [inferred from these rates and the gas doc].** A 30-account room at fee F milliNEAR has a pot of 0.03F NEAR and a cap of 3F NEAR. It costs about 0.02 NEAR in gas plus 6% of the pot. At a jackpot of 10 NEAR and a fee of 3 milliNEAR, a win pays 8 NEAR, for an expected 0.28 NEAR per round at a cost of about 0.026. So about 29 rounds and 0.75 NEAR to take 8 NEAR. It breaks even at a jackpot of about 0.8 NEAR. The cap only sets the fee the farmer has to choose.

**Scope.** Live jackpot today is 0.054 NEAR [live read], so this needs a jackpot to grow first. The plan discloses farming of season points, not this.

**Fix.** The payout has to stay below what a ticket costs. Options: pay the jackpot only for digs made before clue 3, which cuts the hit rate; lower the cap to about 1.5 pots; or cap by unique funded accounts in some way. Sybil resistance isn't free, so this is a design choice.

### 7. All 30 lobby slots can be held at no bond cost

`docs/research/contract-gas-and-storage.md` prices lobby-filling at 10% of the bond per slot per 15 minutes. That applies only to a room that expires. A host with one alt avoids it.

**Evidence [sandbox]**: a room held for **1,500 s**. Joined just before the 900 s deadline, the room started at the deadline, ran 600 s with no digs, and refunded as `too-few-digs`. Host 199 -> 199, alt 9 -> 9, jackpot 0. Only gas is lost.

**Attack [inferred].** For slots nobody can join, set `max_players` to 2 and fill the room at once. It goes live in 5 s and refunds after 600 s. With 10 hosts and one alt at fee 1 milliNEAR, that's 30 slots, 3 NEAR of bonds returned each cycle, and about 0.0028 NEAR of gas per slot per cycle: about 0.5 NEAR an hour, from faucet coins. Nobody else can create a room: "Too many games are open right now". The oracle pays for each refund poke. Bots also stop hosting once 20 rooms are open.

**Fix.** Apply the same bond penalty when a started room gets no digs at all. Don't let a global cap be the only limit: page `live_state`, and lift `MAX_OPEN_ROOMS` to what paging allows. A room with no digs should also be short-lived.

### 8. Any client can make the server hammer the RPC

`/api/live` calls `state.wake()` on every connection, and a wake skips the poller's timer. Nothing limits reconnects.

**Evidence [harness]**: the real `App`, `LiveState` and SSE routes, with an RPC stand-in answering in 60 ms.

| | `live_state` reads per second |
|---|---|
| Idle | 0.4 |
| One client reconnecting in a loop (29,783 connections in 8 s) | **16.0**, limited only by the stand-in's round trip |

**Why it matters [read, not proven end to end].** The oracle acts on `onPoll`, and all of it comes from this one read. FastNEAR limiting the server pushes reads to dRPC, whose free tier caps at about 2 s. If reads stop for 120 s, rooms refund as `missed-reveal`. That would let a player who's behind force a refund. I didn't test FastNEAR's real limit, because hammering a public service to find out isn't polite. The real load is also heavy: 30 full rooms are about 247 KB of JSON per read, as the gas doc notes.

**Related.**

- SSE allows 3,000 clients in total and has no per-IP limit, so one client can use every slot [harness: 300 held, `/api/state` still answered, and the code reads `MAX_CLIENTS`]. Browsers then fall back to `/api/state`.
- No route has any rate limit.

**Fix.** Rate-limit `wake` for client-triggered wakes, to at most once a second. Keep the wake for the oracle's own events. Add per-IP connection limits on `/api/live` and `/api/guest-accounts`. Run the oracle's poll separately from what clients can trigger, and give the oracle its own RPC budget.

### 9. The link goes out before the lock is final (mainnet blocker)

`ORACLE_REVEAL_FINAL` defaults to false and `#lockThenReveal` reveals on the poke's optimistic answer, so a link can be public while its lock's block can still be dropped. `docs/research/backend-notes.md` already records this trade-off, and the config says to turn it on for mainnet.

The risk goes further than a single re-roll [read]. The sandbox shows that each action gets its own seed (see "What held up"), which suggests a validator could also try different poke transactions for its re-lock. With the link public, one validator alone could pick among many results, and that's the exact case the spec rules out.

The contract only requires a later block. **Fix:** enforce it on chain: `require!(env::block_height() >= lock_height + 3)`, sized to NEAR's finality depth and tuned against the reveal latency, instead of relying on a flag.

### 10. The contract keeps a full-access key, and Verify doesn't check the code hash (mainnet blocker)

`v1.dighere.testnet` has a full-access key [live read], while `lib.rs` says "There's no admin method after this". Whoever holds that key can replace the code and take every balance. That's reasonable on testnet, and it's also the one thing that makes every Verify check and every "the contract decides" claim conditional.

**Fix.** Before mainnet, delete the key or move it to a published multisig or timelock. Show `code_hash` on the Verify screen next to a reproducible build hash. The checklist asks for both.

## Low

### 11. A listed NFT can be sniped once clue 3 makes its landing public

Clue 3 names the kind, and after it every candidate is that kind, so the deed that gets the share is public for the last 40% of the round.

**Evidence [sandbox]**: after clue 3, a buyer paid 10 milliNEAR for the listed NFT and collected the 60 milliNEAR share from a 3,000 milliNEAR pot. They can then re-list it. An unminted deed can be minted the same way, when the pot justifies the price [read].

This takes earnings from owners who list, and adds no risk to the buyer. **Fix:** record the deed's owner at clue 3's reveal, and pay that owner at settlement.

### 12. Filling a room for a moment and leaving cancels the countdown

`join` sets the 5-second full-room timer. `leave` clears `start_at_ms` only below the minimum or with no countdown. So the short timer survives.

**Evidence [sandbox]**: a room with a 120 s countdown and a maximum of 3. A griefer joined to fill it and left at once. The countdown went from 120,000 ms to 4,634 ms left, and `poke` started the round with 2 players. It costs the griefer only gas, and anyone still on their way misses the round. **Fix:** when a leave takes a room below full, restore the countdown that was running.

### 13. Smaller items

- **Season sniping and real farming cost [inferred].** A settled round adds points after `ends_at_ms` until someone calls `close_season`, so a late self-funded round can jump the table, and the leader's only defence is to close first. The plan discloses farming at about 6%. Own the three top places and the pool comes back too, so it profits when season volume is over about 5 times the pot total the leader won. A deed owner pays less again. **Fix:** ignore points from rooms finishing after the end time, and state the formula in the README.
- **No index guard on commitments [read].** `add_commitments` doesn't check for duplicates. A lost upload landing late can put the same tip in the pool twice, and `findChain` exists because shifted tips are expected. Two rooms sharing a chain means the second's links are public once the first ends. **Fix:** `add_commitments(first_index, tips)`, requiring `first_index == tip_tail`, and report a mismatch.
- **Malformed URL hangs a socket [harness].** `new URL()` runs outside the `try` in `App.#handle`. `GET // HTTP/1.1` gave an unhandled rejection, one log line and no response after 4 s, with the socket left open. **Fix:** move it inside the `try`.
- **`buy_nft` keeps the seller's approval deposit [read, storage measured].** It ignores what `internal_transfer` returns, so there's no refund promise. Storage fell 96 bytes in the sandbox and the contract keeps that deposit, about 0.001 NEAR. My wallet reading was swamped by gas refunds, so it proves nothing. **Fix:** refund as `nft_transfer` does.
- **Sweeper trusts the indexer [read].** `idleGuests` treats a missing `player_activity` row as idle. If the indexer is down or behind, an active guest older than 12 hours can be swept unless they're in an open room right then. A guest joining between the busy check and the delete leaves later credits on a deleted account, recoverable only if the same key returns. **Fix:** skip sweeps when the indexer is behind, and remove the browser key first.
- **Sweep key and one seed [read].** Every guest has a full-access key derived from `BACKEND_KEY_SEED`, which also derives the full-access lanes of `guests.` and `bots.` and the `warden.` key. One leak takes all of those, though not the root or oracle keys. It's in the environment and I found no leak (below). **Fix:** acceptable on testnet. Don't carry the pattern to anything with real coins.
- **Possible double credit [read].** `#credit` can sign `deposit_for` again after a lost send, and if the older copy lands first, both land. Unlike a repeated `poke`, the repeat doesn't fail. It costs 0.6 NEAR when it happens, and an attacker can't trigger it directly. **Fix:** check the record's balance before re-signing, or don't re-sign.
- **Guest key has no gas allowance [read].** `addFunctionCallAccessKey` is called with no allowance, so a stolen key can burn the guest's 0.08 NEAR wallet on gas. The wallet plugin's default is 0.25 NEAR. **Fix:** set a small allowance.
- **Deployment trap in `TRUST_CF_CONNECTING_IP` [read].** Off behind a proxy, everyone shares the proxy's address, so 3 guests an hour for everyone. On with the origin reachable directly, the header can be forged (finding 2). **Fix:** make deploy docs say which applies, and only trust the header from Cloudflare's address ranges.
- **`/api/health` detail [read].** It's public and shows root balance, oracle stats and burn rates. No secrets, but it tells an attacker how much is left to drain. **Fix:** keep the status line public and hide the rest.
- **No CSP or `X-Frame-Options` [read].** Neither `static.ts`, `deploy/nginx.conf` nor `index.html` sets one. There's no XSS today, but the keys sit in `localStorage` with no second line of defence. **Fix:** a strict CSP once the wallet connector's needs are known.
- **Wallet connector loads remote code [read].** `@hot-labs/near-connect` fetches its manifest from `raw.githubusercontent.com` and jsDelivr, and runs wallets in `sandbox="allow-scripts"` iframes, on click only. That's a supply-chain trust worth knowing. **Fix:** pin or self-host the manifest for mainnet.
- **Room names can mislead [read].** Names are escaped, but any 40 bytes pass, including right-to-left overrides and lookalikes. It's display spoofing only. **Fix:** strip control and bidi characters in the contract or at display.

## What held up

### Coins and totals

- **Conservation.** There's a monitoring view, `get_totals`, and the sandbox has `assert_solvent`. There's no on-chain assertion. I added my own check after every call: sum of records = `total_balances`; `held` = bonds plus pots of open rooms; deposits minus withdrawals = everything owed plus storage kept, to the yocto.
  - **[native]** 15,000 random steps over 6 seeds, of which about 3,900 were real calls and the rest found nothing legal to do. They include 179 failed withdrawals, 20 NFT buys, 239 transfers, 98 refunds and 11 season closes, but no settled round. No violation.
  - **[native]** 120 directed rounds of up to 30 long names, with fees up to the 100,000,000 NEAR maximum: **100 settled, 32 jackpots forced by choosing the block seed, 21 deed shares paid, 20 missed reveals, 60 seasons closed**. No violation.
- **Solvency live [live read].** Holding 14.532 NEAR, owed 8.954, storage 4.303: 1.275 NEAR spare. The gas doc's worst-case reserve of 1.31 NEAR above code fits the 1.70 funded, leaving about 0.39 spare at the worst.
- **Rounding.** `split_pot` gives the remainder to the prize, and `prizes()` leaves it in the pool. No dust is stranded [read, and the conservation check].
- **Overflow.** `overflow-checks = true`, and the 100,000,000 NEAR maximum fee fits u64 through the split and points [native].
- **Reentrancy and callbacks.** `withdraw` deducts first. `on_withdraw` and `nft_resolve_transfer` refuse outside callers [sandbox: "Method ... is private"]. Existing `withdraw_success_and_failure_callback` passes, and the failure path has 5 Tgas against a measured 1.88.
- **Access.** Outsider `new`: private. Second `new`: "already been initialized". Outsider `add_commitments`: refused [sandbox].
- **Payout to a deleted account, or a missing treasury.** Settlement only credits records, with no outgoing transfer, so neither can fail it. A failed withdraw is restored [read, existing test].
- **Storage exhaustion.** Records and mints are paid at measured cost. Open rooms, the ring (30), commitments (200) and NFTs (36) are all bounded. Approvals are paid by the owner [read].
- **Collections' prefixes.** Unique. The NFT library's `TokensPerOwner` shares first byte 0 with `accounts`, but keys can't collide because their lengths differ [read].

### Settlement can't be blocked

- **Gas.** Worst shape, 30 players with 64-character names: settlement 9.3 Tgas and refund 12.1 Tgas against 30 attached. Existing `recommended_gas_is_enough_for_the_worst_case` passes [sandbox].
- **Logs.** The most in one call was 10,606 bytes against 16,384, with jackpots and owned deeds included [native].
- **Panics in a roll.** A landmark with no tags would make clue 4 call `below(0)` and panic forever. All 1,500 spots have tags, 0 untagged [native].
- **Empty rankings.** Lock of step 4 needs 2 digs, and the too-few check comes first [read].
- **Long names.** 64-character names were part of the worst shape, in the sandbox and in the directed rounds. `MAX_PLAYERS_CAP` bounds how many.

### Randomness

- **Lock after the last counted dig.** Digs need `now < ends`, step 4's lock needs `now >= ends`, in block time. So the lock is in a later block than any dig it counts [read].
- **Same-block lock and reveal, replay.** A batch of `poke` and `reveal` fails whole, old links can't answer new locks, wrong links fail. Existing `reveal_rejects_replays_wrong_links_and_the_same_block` passes. A link from another room fails with "doesn't match" [sandbox].
- **Contract player reading `random_seed`.** A probe contract read the seed in block 142, and its `poke` locked in block 143 with an unrelated seed. It can't run in the same block as its own promise. Two pokes in one batch, same block 146, got different seeds, so seeds are per action, and one contract's seed tells nothing about another's [sandbox]. It also has no link to combine with.
- **Selective `poke`, gating on the seed.** Without the link, nobody who isn't the oracle can tell a good lock from a bad one, so choosing the block gains nothing [read].
- **Front-running `reveal` with the link.** The seed doesn't depend on the caller, so copying gives the same result, and the oracle's own reveal then fails harmlessly [read]. The one gain is in finding 5.
- **Forcing a refund to escape a loss.** I found no way on chain: `reveal` makes no outside call and can't be made to panic, and the deadline only passes if the oracle fails. `too-few-digs` can't be reached after seeing a result. Off chain, see finding 8.
- **Layout bias.** Kinds are a fixed roster, so odds per deed don't move. Everything about a layout is public before anyone joins [read].
- **Hash domains.** Separate prefixes, fixed-width fields, and `digs_hash` uses a 0x00 terminator that account names can't contain [read].
- **Oracle secrets.** Each secret is an HMAC of its index, so revealing one reveals no others [read].

### Rules

- **Listing after transfer.** An approved account's transfer cancels the listing: "This NFT isn't for sale". A transfer call to an account with no code returns the token and clears the listing [sandbox].
- **Approvals.** One from before a sale can't move the token after it: "Sender not approved" [sandbox].
- **`seen_price`.** An exact match is required [read, existing test].
- **Host playing their own room.** Allowed by the plan. The host has no information [read].
- **Starting early.** `start` needs the minimum, as the spec says. Players see the setting.
- **Suffix.** `.bots.dighere.testnet` can only be created under that parent [read].

### Server

- **Committed secrets: none.** Scanned the tree, all of `git log --all -p` and `dist` for `ed25519:` private keys (80+ base58 characters), and history for secret names with values. No private keys, and no public-key-sized `ed25519:` values either in history. The hex "seed" matches are the layout test vectors. `.kamal`, `config/deploy.yml` and `server/data` are ignored. `.dockerignore` excludes `.kamal` and `server/data`.
- **Keys in logs: none.** `server/data/server.log` (1,327 lines) and the other local run outputs have no private-key-sized `ed25519:` values, and the log has no secret names. Reading `log.ts` and its callers, no key goes to a log, and client errors are generic.
- **SQL injection.** All statements are prepared with parameters [read].
- **Path traversal.** Six encoded forms of `../../etc/passwd`, backslashes, a NUL and `/assets/` escapes never returned a file outside `dist`. They got the app page or a 404, and a bad escape got a 500 with no detail [harness].
- **SSRF.** All fetches go to configured URLs, none from user input [read].
- **Memory.** SSE frames are one shared buffer per change, with a 4 MB cap per client. The other maps are capped or bounded by rooms [read].
- **CPU routes.** 64 clients on `/api/finished-games?limit=100`, on a copy of the local database with 75 games, in the same 1-CPU process: 2,477 requests in 10 s, event loop delay at most 74 ms [harness]. Not a problem at this size.
- **Stolen key limits.** A function-call key can't `withdraw`, `nft_transfer` or add keys [existing test]. Finding 1 is what it can do.

### Frontend

- **XSS.** No `{@html}`, `innerHTML` or similar anywhere in `src`, so Svelte escapes room and account names. Links are built with a fixed `https://testnet.nearblocks.io/...` prefix, so an account name can't become `javascript:` [read; no browser run].

## Not tested

- Nothing ran end to end on testnet, including the chains in findings 2 and 3.
- FastNEAR's real rate limit (finding 8), and a 247 KB `live_state` over a public RPC.
- The `lock_seed` formula: three samples, no match, and I may simply have the wrong formula.
- The wallet path in a real browser.
- Validator behaviour: all such claims are reasoning.

## How this was run

Scratch copies only, in the session's scratchpad, which won't survive. Contract tests ran through `docker/near` with a separate target volume, and Node harnesses inside `systemd-run --user --scope -p MemoryMax=1G -p CPUQuota=100%`. Vitest used `--maxWorkers=2` in a scratch copy.

To reproduce the two that matter most:

- **Finding 1:** add a key with `AccessKey::function_call_access(game, &GUEST_METHODS, ...)` to the existing `function_call_keys_can_play_but_not_move_coins` setup. The thief lists an NFT at the guest's balance, and the key calls `buy_nft`.
- **Finding 2:** build `Guests` with a fake funder and set `RPC_PRIMARY` to a local server that answers `view_account` after 150 ms. `Promise.all` 200 POSTs with `Origin` set to an allowed value.
