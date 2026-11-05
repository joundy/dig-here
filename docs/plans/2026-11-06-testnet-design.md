# Dig Here on NEAR testnet: build spec

Date: 2026-11-06. Testnet only. Research behind this: `docs/research/`. Game rules: `docs/plans/2026-11-05-dig-here-final-plan.md` and `src/lib/game/rules.ts`, which win on anything not said here.

## Hard rules for everyone building this

- **Testnet only.** Never mainnet, never real money. Never touch any other app or domain.
- **Installs only in Docker**, through `docker/near` (capped at 6 GB, 6 CPUs). Project npm dependencies are fine.
- **Machine limits (the user's PC froze once):** one headless browser at a time, inside `systemd-run --user --scope -p MemoryMax=3G -p CPUQuota=300%`. Vitest with `--maxWorkers=2`, never `--root /`. Stop and report if `df -h /` shows under 10 GB free. Never touch other projects' containers.
- **Never commit or print keys.** `.kamal/` is gitignored. Keys are in `.kamal/secrets-testnet.env` and the `dig-here-near-creds` volume.
- **Test coins are scarce:** about 54 NEAR, and the faucet gives 10 NEAR per new account, 10 times per 12 hours. Delete throwaway accounts with `dighere.testnet` as beneficiary.
- No `git push`. Comments explain why, not what. API paths use lowercase-hyphen words.
- State what you ran versus what you only read. Don't claim anything you didn't run.

## Principles

1. **The contract decides everything.** Every rule, roll and coin lives on chain.
2. **The backend can't change an outcome.** It triggers, reveals, caches and records. If it dies, coins stay safe and refundable, and the game can still be read directly from chain.
3. **Same rules in TypeScript and Rust**, proven by shared test vectors, because players recheck rounds in their browser.
4. **Testnet extras are switched off in production:** bots. They're config, not contract rules.

## Accounts

| Account | Purpose |
|---|---|
| `dighere.testnet` | Root. Funds everything, parent of the others |
| `v1.dighere.testnet` | The contract. A breaking change deploys `v2`, and old state isn't migrated |
| `oracle.dighere.testnet` | Tops up commitments, triggers and reveals |
| `treasury.dighere.testnet` | Receives NFT mint money |
| `<name>.bots.dighere.testnet` | Bots, testnet only |

## Money

- The contract stores balances in yoctoNEAR (`u128`). Fees, prices, pots and every split are whole **milliNEAR** (`u64`), exactly as `src/lib/game/economy.ts`, then converted (× 10^21) when credited.
- **`join` and `create_room`, `mint_nft`, `buy_nft` are payable:** anything attached goes to the game balance, then the cost comes out of the balance. So a wallet tops up once with one approval, and a function-call key then pays silently with nothing attached. `buy_nft` needs at least 1 yocto, so a function-call key can't spend a balance on someone else's NFT.
- **Winnings and refunds credit the balance.** Never push coins at settlement.
- **`withdraw(amount)`** needs exactly 1 yocto, deducts first, and restores in a private callback only on failure.
- **Storage:** a player's first credit pays their record (measure `env::storage_usage()` before and after, take the exact cost). The host bond covers the room. Check `max_players` fits the bond at `create_room`.
- Identify players with `predecessor_account_id`, never the signer.
- Attach little gas: 5 Tgas for `dig` and 10 for `join` as a start, then set from measurements. Gas is bought at 10× its burn price.

## Config, set at contract init

```
oracle, treasury, mint_price (milli), host_bond (milli),
season_length_sec, prize_excluded_suffix
```

Testnet values: `mint_price` 500 (0.5 NEAR, **production 20,000 = 20 NEAR, the user's number**, lowered only because faucet coins are scarce), `host_bond` 100, `season_length_sec` 86,400, `prize_excluded_suffix` `.bots.dighere.testnet`. Testnet fee choices in the UI: 0.01, 0.05, 0.1, 0.25 NEAR. All other numbers come from `rules.ts`.

## Contract methods

```
new(config)
deposit()                        payable
deposit_for(account_id)          payable, no longer called by the game
withdraw(amount)                 exactly 1 yocto, promise with private callback

create_room(name, map, fee, duration_sec, host_cut_bps, min_players, max_players, countdown_sec) -> room_id   payable
join(room_id)                    payable
leave(room_id)                   fee back to balance
start(room_id)                   host only, at the minimum
dig(room_id, x, y, seen_clue)

poke(room_id)                    anyone. Does whatever is due: see below
reveal(room_id, link)            anyone holding the right preimage
add_commitments(tips)            oracle only

mint_nft(token_id)               payable. First owner, pays mint_price to treasury
list_nft(token_id, price|null)   owner only
buy_nft(token_id, seen_price)    payable, at least 1 yocto. Pays the lister
close_season()                   anyone, after the end time
NEP-171, NEP-177, NEP-178, NEP-181 for NFTs
```

Views: `get_config`, `get_now_ms`, `get_rooms(from, limit)` (open rooms, no landmarks), `get_room(id)` (everything, including landmarks, digs, clues and proof data), `get_recent_finished()`, `get_account(id)` (balance, season points), `get_host(id)`, `get_jackpot`, `get_season`, `get_nfts(from, limit)` (owner, price, earned, landings), `commitments_left`, `missed_reveals`.

`poke(room_id)` does the first of these that applies, and nothing otherwise:
1. Waiting, and a countdown or the full-room timer ran out: start.
2. Waiting, past the 15-minute deadline: start if at the minimum, otherwise refund with `expired`.
3. Live, the round's end has passed with fewer than 2 digs: refund with `too-few-digs`, with no lock or treasure roll.
4. Live, a roll is due and not locked: lock it (below).
5. A roll has passed its reveal deadline, locked or not: refund everyone with `missed-reveal`, return the host's whole bond, increment `missed_reveals`.

Time is `env::block_timestamp_ms()`. Digs are rejected once block time reaches the round's end, and while a roll is locked and unrevealed. A dig's bonus follows **clues actually revealed**, not the clock, so a late clue never costs anyone.

## Randomness (the user's requirement)

Goal: neither a validator nor we can know or choose a result alone, and any player can prove a finished round.

**Commitment.** The oracle draws a secret `s` per commitment and computes a hash chain: `tip = H(H(H(H(s))))`, `H` = SHA-256. It uploads tips with `add_commitments`. `create_room` pops the next tip and stores it in the room. It fails kindly if the pool is empty. The oracle derives `s` as `HMAC-SHA256(ORACLE_SECRET, tip_index)`, so it stores nothing else.

**Rolls.** Four steps: step 1 clue 2, step 2 clue 3, step 3 clue 4, step 4 treasure.

1. **Lock** (`poke`, once due: clue time reached, or round end). The contract stores `lock_seed = env::random_seed()` for this block, and `digs_hash` of the digs so far, plus `lock_ms`.
2. **Reveal** (`reveal`, in a **later** block). The contract requires `H(link) == previous` (the tip for step 1, then the last revealed link) and stores `link`. Then:

```
roll_seed = SHA256("dig-here-v1" || room_id u64 LE || step u8 || lock_seed || link || digs_hash)
```

Validator seed first, ours second. The validator can't know the result when deciding on the lock, because it lacks `link`. We see the result before revealing, but all we can do is refuse, and that visibly refunds the round. It's still a free option, because the oracle pays nothing for refusing. `dig` is refused between a lock and its reveal, so nobody can use a clue learned in that gap. **Missed reveals are public.**

Reveal deadline: 120 seconds after the roll was due.

`digs_hash` = SHA-256 over each dig in order: account UTF-8 bytes, 0x00, x u16 LE, y u16 LE, clue_index u8, `dug_at_ms` u64 LE. Empty list hashes the empty string. Taken at lock, so a dig after the lock can't affect the roll.

**Number stream**, identical in TS and Rust. `Rng(n)` returns a whole number below n, as in `rules`:

```
block k = SHA256(roll_seed || k u32 LE), k from 0. Words are its bytes as u32 LE, in order.
below(n): limit = 2^32 - (2^32 mod n). Take the next word until word < limit. Return word mod n.
```

**The layout** is rolled at `create_room` with `roll_seed = SHA256("dig-here-layout-v1" || room_id u64 LE || env::random_seed() || tip)`. Its seed is stored in the room. A validator could only influence where landmarks stand before anyone has joined, which decides nothing, so it doesn't need the two-step process.

**Clue and treasure rolling** use the exact call order of `src/lib/game/clues.ts` and `rollTreasure` in `engine.ts`.

**Proof.** Every roll's `lock_seed`, `lock block height`, `link`, `digs_hash`, and results stay in the room and in events. The "Verify this round" screen checks in the browser, using the same rules code:
- each link hashes to the previous one and up to the tip, which was stored before the room existed
- each roll seed recalculates
- the layout, each clue, the treasure, the ranking and the pot split come out exactly as played

Be honest in that screen: we show which values come from the contract. Check whether the block's random value is independently readable over RPC, and if so compare it too.

## Layout on chain

The JS `rollLayout` tries thousands of cells, which would be too costly. Instead:

**Generator** (`scripts/gen-map-data`), run by hand, committed output: for each map, on a roughly 3-pixel grid, find spots where at least one kind can stand, using today's `canStand` with nothing placed. Thin to at most 500 spots per map (at least 5 pixels apart). Each spot: `x, y, tags, kindMask` (which of the map's 12 kinds fit). Also output the land bitmap, row by row, 320×224 bits.

Outputs: `src/lib/game/generated/map-data.json`, and `contract/data/` for the contract to `include_bytes!`.

**Algorithm**, the same in TS and Rust, all whole numbers:

```
pool = every kind in roster order, repeated count times. Fisher-Yates with rng.
order = pool's habitat kinds, then the others, each keeping pool order. (HABITAT in mapDefs.ts)
for each kind in order, for spread in 90, 70, 50, 36:
  best = none; found = 0
  repeat up to 150 tries, stop at found == 8:
    spot = spots[rng(spots.length)]
    skip unless kindMask has this kind, spot clears every placed landmark (below)
    room = min over placed of: d² , or d²/4 (floor) if the same kind. Skip if same kind and d² < spread².
    room is infinity when nothing is placed
    found++. If room > best's room, best = this spot
  if best: place it, flip = rng(2) == 0, go to next kind
all spreads failed: start over from pool, using the stream's next numbers. At most 20 restarts, then panic.
```

Clearing, same as `canStand` today: `d² >= MIN_SPACING²` (20) and the two `FOOTPRINT` boxes are separated by at least `BOX_GAP` on x or y. Landmark IDs are placement order. Tags come from the spot.

Keep the visual feel: same-kind landmarks far apart, every game different. Test on at least 500 seeds per map that it never fails.

## Shared test vectors

`contract/tests/vectors.json`, generated from the TS rules, checked by both sides:
- `below` streams
- layouts (seed to landmarks)
- clue and treasure rolls from given candidates
- `digs_hash`, roll seeds, hash chains
- scoring, ranking, pot split, jackpot and season points

At least 50 cases per area. TS and Rust must agree exactly.

## Backend: one Node 24 container, no framework (`server/`)

| Part | Job |
|---|---|
| **Static** | Serves the built game, with the same caching as `deploy/nginx.conf` |
| **Oracle** | Keeps at least 50 commitments in the pool. Watches open rooms, calls `poke` when due, `reveal` a block after each lock |
| **Bots** | Testnet only (`BOTS_ENABLED`). Host rooms, join, dig with public data, keep the lobby alive. Budgeted, and pause if the root runs low |
| **Live state** | Polls one batched contract view about once a second, serves everyone: `GET /api/state`, `GET /api/live` (SSE) |
| **Indexer** | Reads our contract's transactions from the FastNEAR Transactions API into `node:sqlite` (not tailing blocks: anonymous Neardata is too rate limited, see `docs/research/realtime-and-indexing.md`). `GET /api/finished-games`, `GET /api/games/:id/proof`, `GET /api/players/:id/history`. Decides nothing. Live play works without it |

Secrets in environment only. Signer queues per account so nonces never collide (the research recommends one gas key with several nonce lanes for the oracle). RPC: FastNEAR, with dRPC read failover, never `rpc.testnet.near.org`. Retries check status first, because a timed-out transaction may still land. Log with no keys. A `GET /api/health` shows pool size, root balance and last block.

Frontend reads the backend first, and falls back to direct RPC views if it's unreachable.

## Frontend

- `src/lib/backend/near.svelte.ts` implements `GameBackend`, mapping contract rooms to the existing `Game` type so the screens barely change.
- `src/lib/backend/index.ts` picks it by `VITE_BACKEND` (`near` default, `dummy` for tests and playtest).
- **The first action that needs an account asks once:** "Connect NEAR wallet" (`@hot-labs/near-connect` pinned 0.11.x, `function-call-key-plugin` 2.2, `near-api-js` 7.4, loaded on click). Watching loads no wallet code.
- Optimistic: the X appears at once and confirms in the background, sent with `wait_until: EXECUTED_OPTIMISTIC`, never `NONE`. Clear errors, and roll back on failure.
- Time comes from chain time plus a measured offset. Never trust the local clock alone.
- Labels: bots are clearly marked.
- **"Verify this round"** on results (section above), with links to the testnet explorer.
- Screens must say plainly that these are testnet coins. Playtest controls are hidden on `near`.

## Build order

1. Map data, layout, number stream, TS rules alignment, vectors.
2. Contract, with sandbox tests. Measure gas and storage. Deploy `v1` to testnet.
3. Backend: oracle first, a full round on testnet driven from a script.
4. Frontend: wallet path, a full round in a real browser on testnet, then verify screen.
5. Bots, indexer.
6. Deploy to dig.joundy.dev, and test the live site.
7. Security review against NEAR's checklist. README update.

Report honestly at the end: what ran, what didn't, and what a human must try, especially a real wallet round.

## Backend API (fixed, so backend and frontend can be built side by side)

JSON fields are snake_case. Local dev server: `http://localhost:8787`. Vite proxies `/api` to it.

- `GET /api/health`: `{ ok, contract, oracle_pool, root_balance, last_state_ms, bots_enabled, bot_join_limits: { max_fee_milli, max_host_cut_bps } }`. Bots only join a human's room within those limits, and a few such rooms per host per hour.
- `GET /api/state`: `{ version, fetched_ms, live: <exact contract live_state result> }`, gzip, with ETag.
- `GET /api/live`: SSE. `event: state` with the same body whenever `version` changes, comment heartbeat every 15 seconds.
- `GET /api/finished-games?before=<id>&limit=<n>`: `{ games: [...] }`, newest first.
- `GET /api/games/:id/proof`: every event for the room, in order, including seeds and block heights.
- `GET /api/players/:id/history`.

Bots are **demand-driven**, to save coins and RPC calls: with no browser connected for 5 minutes they stop hosting and digging beyond finishing what's open, and they start within seconds when one connects. A lone juror must see players in a waiting room within about 15 seconds.

The function-call key a wallet adds at sign-in allows: `join`, `leave`, `start`, `dig`, `create_room`, `mint_nft`, `list_nft`, `poke`.

Lost sends are real on testnet (see research): a client stops waiting after 8 seconds, checks the hash, and only then re-signs. Close the visible dig window 2.5 seconds before the on-chain end.

## Notes from the user's review (not built yet)

- **NFT owner share:** stays 2% of the pot, but must become configurable: a contract config value, read by the UI and Verify, rather than a fixed constant.
- **FastNEAR API key:** the user will sign up and send it. Then add it to the server's secrets and redeploy.
- **Jackpot seeding from mint money (25% suggested):** still to confirm with the user.

Making the share configurable changes the contract's stored config, so it needs a state migration or a new contract. Do it between test sessions, not while someone's playing.

## Decision: no guest accounts

Every player, including jurors, uses a real testnet wallet, by the user's decision. This replaces every mention of guests above. Watching needs no account. Bots stay, testnet only.

**Signing in.** The first action needing an account opens the connect dialog, with no wallet code loaded before that. NEAR Connect shows wallets flagged for testnet and for function-call keys. The plugin adds a key for the eight game methods with a 0.25 NEAR allowance. The game checks the key is really on chain, and says so if the wallet skipped it.

**First payment.** `join`, `create_room` and `mint_nft` from a short balance show what they need before the wallet is asked: the cost, a 0.002 NEAR setup if the account has no record yet, and a choice of no extra, about 5 games or about 20 games. A choice with extra must leave at least 0.1 NEAR in the wallet, and any choice at least 0.02 NEAR for gas. If none fits, the dialog shows the faucet steps instead.

**Signing moves.** With nothing attached, the game signs in `KeySender` using the plugin's stored key, because `KeySender` handles lost sends and the plugin doesn't. If that key is out of allowance or gone, the move goes through the plugin to the wallet. Coins attached always go to the wallet. Disconnecting removes the key from this browser, but it stays on the account until the owner deletes it.

**Onboarding links, tried 2026-11-05 from one machine:**

| Link | What happened |
|---|---|
| `wallet.meteorwallet.app` | A headless browser got a Cloudflare block, so it wasn't tried further. Its connect dialog does load through NEAR Connect. Creating a testnet account there is untested |
| `wallet.intear.tech` | Loads, and asks for a password. Testnet support past that is untested |
| `wallet.near.org` | Loads, and lists Meteor and Intear among others |
| `docs.near.org/getting-started/faucet` | Loads, and its form calls `helper.testnet.near.org`, which answered 429 "retry in 6 hours" because this machine had used up its share. That same service funded this project earlier, but delivery wasn't seen today |
| `near-faucet.io` | Loads, but the one proper request (1 NEAR) came back "Error occured", so the game doesn't offer it |
| `testnet.mynearwallet.com` | Loads, but no longer creates accounts, so the game doesn't offer it |
