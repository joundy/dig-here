# Backend notes

Date: 2026-11-05, on testnet against `v1.dighere.testnet`, from one machine in Indonesia. Everything here was **run** unless marked otherwise. Times marked "chain" come from block timestamps in the contract's own events, so no local clock is involved.

## What ran

| What | How | Result |
|---|---|---|
| Full round: clue, treasure, payout | `server/tools/round-test.ts`, room 3 | Finished, winner paid, accounts cleaned up |
| Full round, backend restarted mid-round | `round-test.ts --restart`, room 6 | Stopped for 4 s after 23 s. Every roll still locked and revealed, and it finished |
| Missed reveal, oracle off | `round-test.ts --missed`, room 7, `ORACLE_ENABLED=0` | Locked by hand, deadline passed, `poke` returned `refunded`, reason `missed-reveal`, `missed_reveals` went to 1, all coins back in game balances |
| Real guest | `guest-test.ts`, `juror-test.ts` | Browser-generated key joined and dug straight after the response. `withdraw` refused on that key. `create_room` worked on 0.08 NEAR of gas coins |
| Lone juror | `juror-test.ts` | See below |
| Proofs for deleted rooms | `proof-test.mjs` | 44 rooms rebuilt from events alone. 13 had been dropped from the contract's ring (`get_room` says "No such room"), and each recomputed: layout, chain, digs hash, roll seeds, clues, treasure, ranking, split, using the game's own TypeScript rules |
| Indexer gaps | `indexer-check.ts` | A rebuild from zero and the live index, which had been restarted many times, held the same 1,513 rows |
| Sweeper | `sweep-test.ts` on a real guest | Withdrew 0.2988, returned 0.378 of the 0.3783 total to the root, account gone, browser key refused |
| Bots idle and resume | `DEMAND_WINDOW_SEC=30` | No rooms opened in 40 s with nobody connected, bot rooms left waiting were filled and played out, and a new room opened 3.3 s after a browser connected |
| SSE through `kamal-proxy` | Temporary container of the local image, 32 s | 5 frames, 2 heartbeats, same as direct, median 1 ms behind |
| Unit tests | `npm run test:server` | Pure logic, HTTP routes and limits |

**Not run:** SSE through Cloudflare, `TRUST_CF_CONNECTING_IP` on the real path, and a guest minting with the 0.6 credit (0.5985 after the record, against a 0.5 price, so it should pass).

## Reveal latency

Due to revealed, chain time:

| | Rolls | Due to locked p50 | Due to revealed p50 | p90 | Max |
|---|---|---|---|---|---|
| First version, one room, waits for finality | 8 | 2.4 s | 6.9 s | 8.4 s | 8.4 s |
| First version, 12 rooms at once | 43 | 2.0 s | 8.7 s | 11.9 s | 13.6 s |
| **Now, 12 rooms at once** | 43 | **0.6 s** | **3.5 s** | **3.8 s** | **5.0 s** |

Under an earlier run with the test itself using up the RPC quota, the first version reached 32 s p50. That's what led to the rate-limit back-off in `rpc.ts`.

**What changed:**

1. **Timers, not polls.** A roll due before the next poll gets a timer, which removes about 0.5 s on average.
2. **Sent to land on time.** Pokes go out 1.6 s of view time before due, using the lowest view age seen recently as the clock. 5 of 77 pokes landed too early, costing 0.0002 NEAR and about 2 s each. At a 2.0 s lead it was 3 of 10.
3. **Reveal on the lock's answer.** The first version waited for the next poll, then for the lock to be final, which alone cost about 2.5 s.
4. **10 lanes** instead of 6, and the first reveal's `get_room` read happens when the room goes live.

**The floor** is about 1.8 s (best seen 1.825 s): the lock lands in the block at or just after due, the RPC answer takes a block plus the round trip, then the reveal needs a block to be included and a block to execute. Blocks are about 0.6 s. Reaching it every time isn't realistic, so 3 to 4 s is what to expect. Sending the reveal before seeing the lock's answer would be faster, but a lost lock would then expose the link while the seed is still open, so it never does.

Players see a clue about 1 to 2 s after that, because the view has to show it. A reveal wakes the poller at once, instead of waiting out the second.

**The trade-off in this.** Reveals used to wait until the lock was final. Now the link can come out while the lock's block is only optimistic. A validator that produces the next block could in theory drop the lock's block after seeing the link, which re-rolls `lock_seed`. That's a one-way choice between two outcomes, and it takes a validator deliberately skipping a block for a coin-free testnet game. The spec only asks for a later block, and the contract enforces that. **For mainnet set `ORACLE_REVEAL_FINAL=1`**, which costs about 2 s a roll and closes this completely.

## Other timings

| What | Time |
|---|---|
| Guest, request to usable (5 in a row, with a 0.3 credit) | p50 **2.3 s**, 2.0 to 2.6 s, 4.1 s for the first after a restart. Research's sequential version was 5 s |
| Guest join, first transaction | 2.3 s |
| Lone juror hosting: bots arrive | 5 s and 9 s after the join landed |
| Lone juror joining a bot room: join landed to round started | **7.0 s, 8.0 s**, down from the 68 s the frontend saw |
| Sweep of one guest | 13.6 s |
| Index rebuild from block zero, 1,513 events | About 2 minutes, most of it waiting out 429s from the Transactions API (15 s each) |

The account and credit go on separate nonce lanes in parallel. Why the account can be credited before it exists: `deposit_for` only records a name. Guests can be made faster still with a name in the contract's shard (`v...` rather than `g-...`), about 0.7 s per dig per the research, but the spec names the pattern, so I left it.

## Costs

Chain figures, summed from every transaction of the room:

| Round | Transactions | NEAR burned | Oracle's share |
|---|---|---|---|
| 2 players, 2 digs | 14 | 0.0054 | 0.0024 (9 txs) |
| 3 players, 3 digs | 16 | 0.0059 | 0.0025 |
| 5 players, 3 digs | 18 | 0.0065 | 0.0023 |
| 7 players, 7 digs | 25 | 0.0087 | 0.0024 |

So about **0.006 NEAR a round**, plus 6% of the pot going to jackpot, deed and season.

A guest costs about 0.0074 NEAR burned (`create` plus `credit`) and otherwise comes back: 0.6 credit plus 0.08 gas.

**Coins per hour**, measured from each transaction's receipts:

| State | Sample | Gas burned, NEAR/h | Also leaves the bots |
|---|---|---|---|
| Bots on, one viewer connected, default pacing | 15 min, about 24 rounds an hour | **0.20** (bots 0.106, oracle 0.094) | About 0.2 NEAR/h into the jackpot and season pool, which a human can win |
| Bots off, or on with nobody connected for 5 min | 5 min | **0.025**, all of it one leftover round finishing. Zero once no rooms are open | None |

Pacing is `BOT_HOLD_MIN_SEC` and `BOT_HOLD_MAX_SEC`, how long a bot room waits for a visitor. A viewer connected for a whole day would use about 10 NEAR at this rate, so the 8 NEAR budget is what would stop it first.

The hard limits: `BOTS_BUDGET_NEAR` 8 in total, kept in sqlite so it survives restarts, `GUEST_DAILY_CAP` 25, and a floor on the root for each role.

| Root floor | NEAR | Stops |
|---|---|---|
| Bots | 10 | Hosting, refills, NFTs |
| Guests | 6 | New guests answer 503 |
| Oracle | 1 | Top-ups of `oracle.` and `warden.` |

So bots and guests run out first, and the oracle keeps its gas.

## Things worth knowing

**One shard really does swallow sends.** Testnet's shard index 8 holds names from `kk` to `tge`, which includes `oracle.dighere.testnet`. It answered `ShardStuck { missed_chunks: 114 }` at one point, and in a probe of 12 sends each, signers there lost 1, while signers on other shards lost 0. So `poke` and `reveal`, which anyone may call, go from **`warden.dighere.testnet`** on the contract's own shard. Bots have `u` to `z` names for the same reason. `add_commitments` must come from `oracle.`, so if that shard stalls for long the pool can't grow. It holds at least 50 and takes one per room.

**Rebroadcasting the same bytes through FastNEAR did nothing:** one join stayed lost for 40 s of that. So a send now tries once, goes through dRPC with `wait_until: NONE`, watches the hash for up to about 13 s, and then signs again with a higher nonce. dRPC has no `broadcast_tx_async` ("method is not available").

**FastNEAR rate limits are real.** It answers with a JSON error "Rate limits exceeded", and that came up repeatedly during testing, shared with whatever else runs from this IP. The backend then uses dRPC for 10 seconds without stopping. A key would help, and the research already flags that decision for the user.

**A commitment's index can shift.** `add_commitments` has no index argument, so a late upload or two overlapping oracles would move tips along. The oracle checks the tip with `get_room` and searches 400 indexes either side for its secret. If two oracles uploaded the same tips, a later room could reuse a known chain, which would let someone work out a result between lock and reveal. It only happens during an overlap.

**Keys.** All derived from `BACKEND_KEY_SEED` with a label, so nothing needs a key store: bots, lanes, sweep keys and test accounts. `ORACLE_SECRET` makes the commitments, and each secret is `HMAC-SHA256(ORACLE_SECRET, decimal tip index)`. Losing either secret refunds open rooms, and a new `BACKEND_KEY_SEED` would strand bots and guests.

**Lost coins, my mistake.** An early test used random in-memory keys and its cleanup failed, which stranded about 0.66 NEAR on three `rtabi41-*` accounts. Tests now derive their keys, and `reclaim.ts` got back everything else, including games still running when a host was deleted.

**A guest's or bot's NFT** keeps that account from being swept, because a deleted owner could never sell.

**The treasury's game balance** holds about 2 NEAR from mints, reachable only with its key in the `dig-here-near-creds` volume. Nothing withdraws it automatically.

## Faucet

Helper API: `http=429`, 0 left, resets at 18:09 UTC, so stopped there. Contract faucet: one call for 2 NEAR, which is within its once-an-hour rule.

## Local running

`server/run-local.sh` starts it under `systemd-run --user --scope --unit=dig-here-server -p MemoryMax=1G -p CPUQuota=100%`, log in `server/data/server.log`. `server/run-local.sh stop` stops it. The fixed unit name and the port both stop a second copy.
