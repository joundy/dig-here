# Real-time state and history on NEAR testnet

Date: 2026-11-05. Marks: **[measured]** means run from this machine on testnet. **[read]** means taken from docs or a provider's page and not tested. **[inferred]** means worked out from measurements.

All timing comes from one machine in Indonesia, reaching Cloudflare's Jakarta edge, so it includes about 240 ms of round trip per RPC call. Other traffic from this IP, including other agents working on this project, may have used the same provider quotas during these tests. Each test ran at most 5 req/s for 30 seconds, or slower.

## Recommendation

1. **Live state: hybrid.** The backend polls one batched contract view once a second and pushes changes to browsers over Server-Sent Events (SSE). Browsers read nothing from the chain while SSE is up. If SSE goes quiet for 5 seconds, the browser polls the same view directly every 2 seconds until SSE comes back.
2. **RPC.** Browser: `test.rpc.fastnear.com`, then `near-testnet.drpc.org` for reads if that fails. Server: FastNEAR, with dRPC as read failover. Don't use `rpc.testnet.near.org` (deprecated, 3.2 s, cut off after 46 requests) or Intear (1 s added to every request without a key).
3. **Digs.** Browser signs and sends directly with `wait_until: EXECUTED_OPTIMISTIC`, draws the dig at once, and confirms on the response. **Sends must retry:** in bad spells 30 to 60% of sends from one shard never reached the chain, whatever `wait_until` was used. After 8 seconds with no answer, check the hash, then sign again with a new nonce.
4. **History.** Don't tail blocks. Anonymous Neardata allows 30 requests a minute and the chain makes about 100 blocks a minute. Index from the FastNEAR Transactions API instead, filtered to our contract, into `node:sqlite`. It works without a key and goes back to 2021.
5. **Helper and oracle sends.** One gas key with many nonce lanes. Gas keys work on testnet today.

**Decision for the user:** create a FastNEAR API key in the dashboard. Everything above works without one, but the limits are thin for a public demo, and I couldn't check what a free key raises them to, because no limits are published and it needs a sign-up.

## 1. RPC providers

Test: `wrap.testnet` `ft_metadata` view at 5 req/s for 30 seconds, alternating optimistic and final **[measured]**.

| Provider | Requests OK | p50 | p90 | p99 | What bit | Browser CORS |
| --- | --- | --- | --- | --- | --- | --- |
| `test.rpc.fastnear.com` | 150 of 150 | 238 ms | 258 ms | 290 ms | Occasional 429s, see below | `*`, all headers |
| `near-testnet.drpc.org` | 150 of 150 | 252 ms | 332 ms | 380 ms | 2 s cap on every free request | Echoes origin on preflight, `content-type` only; `*` on the response |
| `testnet-rpc.intea.rs` | 150 of 150 | 1266 ms | 1278 ms | 1781 ms | 1 s delay without a key (`x-api-key-missing` header says so) | `*`, `content-type` only |
| `rpc.testnet.near.org` | 46, then 429 | 3263 ms | 3682 ms | 3710 ms | 429 after 46 requests, `retry-after: 60`, "THIS ENDPOINT IS DEPRECATED" | `*`, all headers |

All four send CORS headers and answered a preflight from `https://dig.joundy.dev`, so a browser can call any of them directly **[measured]**. The docs also say JSON-RPC batch requests aren't supported, so each read is one HTTP request **[read]**.

**Limits that actually bit [measured]:**

- **FastNEAR has no steady limit I could pin down.** Clean: 5 req/s for 30 s (twice), 2 req/s for 60 s, 2.3 req/s for 180 s, 0.65 sends/s for 138 s. Not clean: one 1 req/s run got 27 of 65 requests refused with 429 during a 40-second stretch, and a burst of 50 parallel sends was refused whole, straight after 25 sends in the same minute. The 40-second stretch may have included other traffic from this IP, which I can't separate. Treat 429 as a normal event and retry or fail over.
- **dRPC free plan ends any request at about 2 seconds** with `code 30` "Request timeout on the free plan". Of 60 sends at `INCLUDED_FINAL`, `EXECUTED` or `FINAL`, none got an answer: 56 hit this cap and 4 hit the limit below. So did 6 of 10 cross-shard `EXECUTED_OPTIMISTIC`. It also returned `code 15` "Public endpoint rate limit" 5 times at about 1 tx/s. dRPC is good for reads. Don't use it as the main send path.
- **Docs warn** against load testing shared endpoints and publish no FastNEAR number ("Not published") **[read]**.

Freshness of the newest block when the answer arrives, including network time **[measured]**:

| Provider | Optimistic p50 | Final p50 |
| --- | --- | --- |
| FastNEAR | 1353 ms | 2572 ms |
| dRPC | 1422 ms | 2634 ms |
| Intear | 1427 ms | 3013 ms |

## 2. Block timing and the countdown

180 seconds of FastNEAR polling, 203 block intervals, local clock checked against NTP at 45 µs off **[measured]**:

| | min | p50 | p90 | p99 | max |
| --- | --- | --- | --- | --- | --- |
| Time per block | 356 ms | 602 ms | 658 ms | 704 ms | 1257 ms |
| Optimistic block's age on arrival | 811 ms | 1309 ms | 1602 ms | 1917 ms | 2856 ms |
| Final block's age on arrival | 1752 ms | 2530 ms | 2830 ms | 3503 ms | 5235 ms |
| Final behind optimistic, in blocks | 0 | 2 | 2 | 2 | 4 |

- Average 604.6 ms per block. A separate shorter sample in `testnet-accounts-and-funding.md` saw 0.77 s, so expect some drift. Docs say about 600 ms and 1.2 s to final **[read]**.
- The smallest gap between block timestamp and true time was 697 ms. So block timestamps aren't ahead of real time, and that's as tight as this method can bound clock skew.

**How the browser should show a countdown:**

1. The contract stores `ends_at_ms` from `env::block_timestamp_ms`. That's the only clock that decides anything.
2. Phone clocks can be seconds off, so the browser never trusts its own. Each SSE frame carries `server_ms` from the NTP-synced backend. The browser keeps `offset = server_ms - Date.now()`, using the sample from the last 20 frames with the shortest delivery delay (highest offset).
3. Without the backend, it takes the same offset from direct RPC reads: the highest `block_timestamp - Date.now()` of recent samples, plus 800 ms for the block's age **[inferred from the 697 to 811 ms floor]**.
4. **Show zero early.** A dig takes 1.4 to 2.1 s to run, p90 2.6 s (section 5). The contract tests the time in the block where the dig runs. So the visible countdown should reach zero, and the dig button should close, 2.5 s before `ends_at_ms` **[inferred]**. A last-moment dig then still lands, and nobody sees "too late" after pressing in time.
5. Clues need two helper transactions, the first waited to final. Expect about 3.3 s + 1.4 s + 2 s of delivery, so about 7 s from starting the sequence to a clue on screen **[inferred]**. On a 60-second round that's over 10% of the round, so start the sequence early. The plan already bases the bonus on when clues are revealed, so a late clue costs no player anything.

## 3. Neardata

| Question | Answer |
| --- | --- |
| Key required? | No, but anonymous use is capped: **30 requests a minute**, error "rate-limit exceeded of 30 blocks per minute" **[measured]**. |
| What counts? | Everything I tried: full block, `/headers`, `/shard/N`, `/block_opt/N` and even `/last_block/final` redirects each got exactly 30 **[measured]**. |
| Can it tail the chain anonymously? | **No.** About 100 blocks a minute against 30 allowed **[inferred]**. My first tail stopped after 29 blocks in 16.6 s **[measured]**. |
| How far back? | **All of it.** `first_block` points to 42,376,888. Heights sampled from 200 blocks ago to 2021-04-09 (height 43,305,296) all answered in about 310 ms **[measured]**. |
| Lag, optimistic | Asking two blocks ahead holds the request until the block exists. Age on arrival p50 1043 ms, p90 1130 ms, max 1155 ms **[measured]**. |
| Lag, final | Age on arrival p50 2237 ms, p90 2386 ms, max 2433 ms **[measured]**. |
| Too far ahead | Head + 200 gives 404, "The block is too far in the future" **[measured]**. |
| Sizes | Full block p50 about 35 KB, largest seen 106 KB, about 13.5 KB when gzipped. `/headers` about 12.7 KB. One empty `/shard/N` about 1.1 KB. Testnet has 10 shards **[measured]**. |
| Reliability | 58 of 58 requests OK over 4 minutes, within the limit **[measured]**. |
| CORS | Echoes the origin, with credentials allowed **[measured]**. |
| Streaming? | Polling only, not a WebSocket or webhook product **[read]**. |

Neardata is slightly fresher than polling RPC (1.04 s against 1.31 s), because it answers as soon as the block exists. That isn't worth anything without a key.

**Finding events in a block [measured, proof ran for 60 seconds].** The proof found 14 events from 5 live contracts in the 29 blocks it got, such as `nep171:nft_transfer` on `epochals.testnet`:

```js
for (const shard of block.shards)
  for (const o of shard.receipt_execution_outcomes) {
    const out = o.execution_outcome.outcome;
    if (out.executor_id !== CONTRACT || 'Failure' in out.status) continue;
    for (const log of out.logs)
      if (log.startsWith('EVENT_JSON:')) handle(JSON.parse(log.slice(11)), o.tx_hash, o.execution_outcome.id);
  }
```

A shard-only fetch would save bandwidth, but costs the same against the limit, and a reshard would move our contract.

### FastNEAR Transactions API, the better source for us

`https://tx.test.fastnear.com` wasn't in the original question, but it solves the block limit, because it's already filtered by account **[measured]**:

- Works with no key, though the docs say to send one **[read]**. Allows 62 requests at 5 req/s before a 429, which fits about 60 a minute **[inferred]**. p50 328 ms.
- `POST /v0/account` with `account_id`, `is_real_receiver`, `from_tx_block_height`, `limit` (up to 200), `resume_token` lists transactions. `POST /v0/transactions` takes up to 20 hashes and returns every receipt with its logs, so events come directly.
- History for `wrap.testnet` starts 2021-04-16, with 2.4 million transactions.
- CORS: echoes the origin.
- Same company as FastNEAR RPC and Neardata, so one outage could hit all three.

## 4. Live state: polling or push

Load for 50 players and 30 open rooms:

| Option | RPC load | From | Notes |
| --- | --- | --- | --- |
| (a) Each browser polls its room every 1 s | **50 req/s**, 4.3 M a day | 50 browsers | Fine if every browser has its own IP. 10 times anything I tested if the players share venue Wi-Fi, which is a real risk at a demo. |
| (a) Same, every 2 s | 25 req/s | 50 browsers | Slower, and still shares the Wi-Fi risk. |
| (b) Backend polls each room every 1 s | 30 req/s | One IP | Over anything tested, and RPC has no batching. |
| (b) Backend polls one batched view every 1 s | **1 req/s**, 86 k a day | One IP | Same load for 2 players or 500. Needs a contract view returning all open rooms. |
| (b) Backend tails Neardata | 1.7 req/s, about 5 GB a day raw | One IP | Refused without a key: 30 a minute. |
| **(c) Hybrid: batched view, SSE, direct fallback** | **1 req/s**; up to 25 req/s only while the backend is down | One IP, then browsers | **Recommended.** |

All figures **[inferred]** from the measured rates above. Writes are the same in every option, and small: players dig once a round, and helper transactions come to about 1.3 tx/s if 30 rooms each run 8 helper transactions over 180 seconds.

How long until other players see a dig **[inferred from the measured parts]**: 1.75 s for it to show in an optimistic view, 0.5 s average wait for the next poll, 0.25 s for the read, and well under 0.1 s for SSE. **About 2.5 s**, about the same as polling directly once a second. The player digging sees their own dig instantly.

**The contract needs:** a cheap `live_state` view returning a version counter and the compact state of open rooms. A single view can't exceed the gas limit, so test it with 30 full rooms once the contract exists. That's the one piece here I couldn't measure yet.

**SSE over WebSockets:** data only flows from server to browser, because digs go straight to the chain. SSE reconnects by itself and is plain HTTP.

- Through `kamal-proxy` v0.10.2, 15 events in 8 s arrived 500 ms apart, delivered within 1 ms, with no buffering **[measured locally in Docker]**.
- The current `deploy/nginx.conf` must not buffer the stream if the Node backend sits behind it. Set `proxy_buffering off` on that path **[read, not tested]**.
- Cloudflare has a 125-second read timeout **[read]**. Send a frame at least every 5 seconds to stay well under it. I haven't tested SSE through Cloudflare on `dig.joundy.dev`, so check this first after deploying.

**Fallback when the backend is down:**

1. Open `EventSource('/api/live-state')`. Every frame carries `version`, `server_ms` and changed rooms.
2. No frame for 5 seconds: start reading `live_state` directly, every 2 seconds, through FastNEAR. On a 429 or a failure, move to dRPC.
3. Keep reconnecting SSE with backoff in the background. When a frame arrives with a version at or past the last seen, stop polling.
4. Digs and refunds go directly to the chain. A dead backend stops clue reveals, because only it holds the next chain link, and history. Players can still see the room and, once the reveal deadline passes, take the full refund the design provides.

The direct path needs the browser's list of RPC URLs and contract ID to ship in the frontend build, not come from the backend.

## 5. Transactions

Each row is 10 sends of one function call (with a storage write and an event) through FastNEAR, timed from send to response **[measured]**. Same shard means the signer and contract are on one shard:

| `wait_until` | Same shard p50 | p90 | Cross-shard p50 | p90 |
| --- | --- | --- | --- | --- |
| `NONE` | 243 ms | 259 ms | 251 ms | 264 ms |
| `INCLUDED` | 1459 ms | 1715 ms | 1487 ms | 1654 ms |
| `EXECUTED_OPTIMISTIC` | **1396 ms** | 1848 ms | **2121 ms** | 2576 ms |
| `INCLUDED_FINAL` | 2596 ms | 3177 ms | 2808 ms | 3003 ms |
| `EXECUTED` | 2639 ms | 3263 ms | 2933 ms | 3124 ms |
| `FINAL` | 3347 ms | 30 s (one send timed out) | 4156 ms | 5130 ms |

- Gas: about 0.00014 NEAR per call **[measured]**.
- An earlier run of the same-shard `EXECUTED_OPTIMISTIC` row gave p50 1659 ms, p90 3579 ms, so a send of 3 to 4 s does happen.
- On the same shard, `INCLUDED` came back reporting `EXECUTED_OPTIMISTIC`, because the call had already run.
- `testnet-accounts-and-funding.md` saw slower FastNEAR figures for transfers (`EXECUTED_OPTIMISTIC` 7.9 to 10.8 s, 3 samples) and left that unexplained. My 20 samples here don't show it, but the difference isn't explained either. Allow for an occasional slow send.

**Sends get lost in spells [measured].** Each batch is sends about 1.5 s apart through FastNEAR, with the hash checked 10 seconds later. The probe signer is on shard index 8, the other on shard index 0, and both call the same contract:

| Order | Signer's shard | Level | Reached the chain |
| --- | --- | --- | --- |
| 1 | 8 | `NONE` | 7 of 10 |
| 2 | 8 | `INCLUDED` | 7 of 10, the other 3 answered `Timeout` |
| 3 | 8 | `EXECUTED_OPTIMISTIC` | 4 of 10, the other 6 answered `Timeout` |
| 4 | 8 | `broadcast_tx_async` | 7 of 10 |
| 5 | 0 | `NONE` | **10 of 10** |
| 6 | 0 | `EXECUTED_OPTIMISTIC` | **10 of 10** |
| 7 | 8 | `EXECUTED_OPTIMISTIC` | 4 of 8, the other 4 answered `Timeout` after 30 s |
| 8 | 8 | `INCLUDED` | 10 of 10 (it had recovered) |

- Earlier the same day, a signer on the same shard lost 1 of about 115, and the first `NONE` batch before the restart was also 7 of 10.
- Chunks weren't the cause as far as I can see: 60 blocks in a row had no missed chunk on any shard.
- So this isn't about `wait_until`. Whether it's specific to FastNEAR is unsettled: a dRPC batch at `NONE` landed 6 of 10, but it overlapped another test on the same key, so it proves nothing.
- Row 7, straight after rows 5 and 6, points at the signer's shard, but I can't name the cause. Treat it as normal testnet weather.
- The contract's counter shows these timed-out sends did not land later **[inferred from the total]**.

**Reads after a send [measured]:**

| Read | min | p50 | p90 | Samples |
| --- | --- | --- | --- | --- |
| Optimistic view shows the change | 256 ms | 1748 ms | 2270 ms | 8 |
| Final view shows the change | 2711 ms | 3267 ms | 3295 ms | 4 |
| Transactions API has it | 3047 ms | 4055 ms | 4067 ms | 4 |

**What a dig should use:** `EXECUTED_OPTIMISTIC`.

- It returns the result and logs, so the browser knows whether the dig worked. `INCLUDED` barely saves time, and doesn't say whether the dig worked.
- Draw the dig immediately, mark it confirmed on the response.
- A timeout doesn't tell you what happened, in either direction. Mine never landed. `testnet-accounts-and-funding.md` saw timed-out transfers land. FastNEAR holds a lost send for 30 s, which is far too long for a game. So give up waiting at 8 s, poll `tx` by hash, and if it's unknown, sign again with a new nonce. A second dig is harmless if the contract allows one dig per player per room. Tell the player "still digging" during the wait.
- A last-moment dig can be lost and have no time left to retry. The contract treats it as not dug, and the player keeps their refund path. That's worth one line in the UI.
- Money the user will act on (a win or a payout on screen) should wait for a final view. Backend helper steps that depend on an earlier transaction should use `FINAL`, as the randomness order needs.
- **Guest names can make digs faster.** Shards split on the whole account name sorted as text, so the leftmost part decides, not the parent: `g123.dighere.testnet` lands on a different shard from `dighere.testnet`, while `dig-g123.dighere.testnet` lands on the same one under today's boundaries. That's the difference between 1.4 s and 2.1 s **[inferred from the shard layout's `boundary_accounts`; the timing gap is measured]**. A later reshard could move a boundary, which only costs that speed. Wallet users land wherever their name falls.

**Nonces [measured]:**

| Test | Result |
| --- | --- |
| One key, 5 and 20 parallel sends, in nonce order | All succeeded, about 2.3 s |
| One key, 50 parallel | All 429: FastNEAR's limit, not a nonce problem |
| One key, 6 sent newest first, 700 ms apart | 1 succeeded, 5 `InvalidNonce`: once a higher nonce lands, lower ones are dead |
| Gas key, 8 and 32 parallel, one per lane | All succeeded, 2.3 to 2.9 s |

**Gas keys work on testnet [measured]:** protocol version 88, and they arrived in 86 **[read]**. I created one with 64 lanes through `near-kit` 0.20.2, funded it with 2 NEAR, and sent 40 transactions, costing 0.0055 NEAR, then withdrew 1.5 NEAR. `view_access_key` shows `GasKeyFullAccess` with balance and `num_nonces`.

Use them like this:

- **Oracle and helper:** one gas key, about 32 lanes, one lane per in-flight transaction. Withdraw before deleting, because deleting burns the balance and fails above 1 NEAR **[read]**.
- **Bots:** one account each already means one nonce each, so no gas key is needed unless one bot runs many rooms.
- **Limits [read]:** function-call gas keys can't set an allowance, and from protocol 87 a gas key can't sign the inner part of a meta transaction.
- **Lost sends still apply.** A lost transaction on a lane doesn't block other lanes, which is another reason to use them for the helper.
- Without gas keys, one sender behind a queue also works, but a lost transaction stalls everything behind it until it times out. Sending several at once risks the `InvalidNonce` result above.

## 6. History indexer

Smallest design that survives downtime, tested **[measured]**:

- **Source:** Transactions API, once every 5 seconds. Neardata stays available for checking a single block.
- **Storage:** `node:sqlite` in the Node 24 backend, no dependency, on a Docker volume. It's a cache: everything can be rebuilt from the chain, so losing the file costs only a rebuild.

```sql
CREATE TABLE cursor(id INTEGER PRIMARY KEY CHECK(id=1), height INTEGER NOT NULL);
CREATE TABLE events(
  receipt_id TEXT NOT NULL, log_index INTEGER NOT NULL, block_height INTEGER NOT NULL,
  tx_hash TEXT NOT NULL, standard TEXT NOT NULL, event TEXT NOT NULL, data TEXT NOT NULL,
  PRIMARY KEY(receipt_id, log_index));
CREATE INDEX events_by_kind ON events(event, block_height);
```

**Loop:**

1. `POST /v0/account` with `account_id`, `is_real_receiver: true`, `from_tx_block_height: cursor - 300`, oldest first, `limit: 200`, following `resume_token`.
2. `POST /v0/transactions`, 20 hashes at a time.
3. For each receipt executed by our contract and not failed, parse `EVENT_JSON:` lines and `INSERT OR IGNORE`.
4. Move the cursor only after the rows are stored. On a 429, wait 15 seconds and retry.

Finished games, proofs, NFT sales and host records are then all queries or small summary tables over `events`. The contract must emit everything a proof needs (digs hash, seeds, links), because events are the record. The primary key makes rereading harmless, which is why the 300-block overlap is safe.

**Results [measured]:**

- Accuracy: on the probe contract the indexer stored 69 events when the contract's own counter said 69. After stopping it and sending 10 more, a restart stored only the 10 new ones: 79 and 79, no gaps and no duplicates.

- Catch-up on a busy real contract: 970 transactions and 1154 events, covering 12,568 blocks (about 2.1 hours of chain) in about a minute, without a key. That's about 100 times real time on a contract busier than ours is likely to be, and the 452 KB database shows size won't matter.
- Node 24's `node:sqlite` worked with no flag, printing only an experimental warning **[measured on 24.19]**.

**If the Transactions API is down:** history pauses and the live game doesn't notice. When it returns, the cursor catches up. For a longer outage, Neardata can replay the gap at 30 blocks a minute without a key, too slow for more than a short gap, or quickly with a paid key.

## What's still open

- What a FastNEAR key raises each limit to. Docs mention a free tier and paid plans, with no numbers **[read]**.
- SSE through Cloudflare on the real domain.
- `live_state` gas with 30 full rooms.
- Why FastNEAR refused requests in the one 40-second stretch.
- Why sends get lost in spells. Before any demo, send 10 test digs from the guest name pattern and from the helper, and check all 10 land.
- `near-api-js` 7.4.0's type files mention gas keys, but I only ran them through `near-kit`.

Sources: [RPC providers](https://docs.near.org/api/rpc/providers.md), [gas keys](https://docs.near.org/protocol/accounts-contracts/gas-keys.md), [transactions](https://docs.near.org/api/rpc/transactions.md), [blocks and finality](https://docs.near.org/integrations/blocks-and-finality.md), [Neardata](https://docs.fastnear.com/neardata.md), [Transactions API](https://docs.fastnear.com/tx.md), [FastNEAR auth](https://docs.fastnear.com/auth.md), [Cloudflare 524](https://developers.cloudflare.com/support/troubleshooting/http-status-codes/cloudflare-5xx-errors/error-524/).
