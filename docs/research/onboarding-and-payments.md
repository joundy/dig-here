# Onboarding and payments on NEAR testnet

Date: 2026-11-05. Testnet only. Network at test time: protocol 88, nearcore 2.14.0-rc.5.

Guest accounts, recommended below, were later dropped by the user's decision. This stays as the record of what was measured. What the game does now is in `docs/plans/2026-11-06-testnet-design.md`.

How to read the marks:
- **[run]** I ran it. Node and Chromium in Docker, real transactions on testnet.
- **[read]** It comes from docs or library source. I didn't run it.
- **[inferred]** My conclusion from the two above.

Evidence and scripts are in the scratch folder, outside the repo: `/tmp/claude-1000/-home-neo-hackaton-near-map-game/2224e02d-65fc-48e1-a247-21a3d734f05e/scratchpad/onboarding/`. It has `live/` (scripts and results), `contract/` (a throwaway measuring contract, not the game) and `bundle/` (size tests). Throwaway keys are in `live/.keys`, and nothing from there is in this document.

---

## 1. Recommendations

| Question | Recommendation |
|---|---|
| **Signing library** | `near-api-js` 7.4, plus `@hot-labs/near-connect` **pinned to 0.11.x** and `function-call-key-plugin` 2.2. Load the wallet code only when someone clicks "Connect wallet". |
| **Juror onboarding** | One click, "Play as guest". The browser makes a key, and `POST /api/guest-accounts` creates `g-xxxxxx.<guest-root>.testnet` with the browser's **function-call key**, a backend sweep key, 0.05 NEAR for gas and a game balance credited by the backend. |
| **Guest gas** | The guest signs directly and pays its own gas. No relayer. |
| **Real wallets** | NEAR Connect on testnet. Offer Meteor and Intear for no-install use. |
| **Paying** | One payable `join(room, fee)`: anything attached goes to the game balance, then the fee comes out of the balance. A wallet tops up once with one approval. After that a function-call key joins silently. |
| **Winnings and refunds** | Credit the internal balance at settlement. Never push. Withdrawal is a separate call that needs 1 yocto, deducts first and restores on failure. |
| **Storage** | No NEP-145. Take the player's record cost from their first credit (about 0.001 NEAR, shown as a one-time line). The host bond covers room records. |
| **NEAR Auth** | Not for the hackathon: its shared testnet login **rejects our domain**. Consider it for production with our own credentials. |

**For production later:** drop guest accounts (they only work because testnet coins are free). Use wallets plus NEAR Auth with approved credentials, keep the same `join` and balance design, and add a cap on what a silent join can spend (section 5.4).

### Things the working design should change
1. **Attach little gas.** Gas is bought at 10× its burn price, so a 30 Tgas call holds 0.03 NEAR up front. In my tests a guest with 0.05 NEAR failed its second transaction. Attach 5 to 10 Tgas for digs and joins.
2. **One `join` method, not two.** Payable with nothing attached works from a function-call key.
3. **Testnet coins are the real limit.** The faucet gave 10 NEAR per new account. See section 3.5. A 20 NEAR mint costs more than one faucet grant.

---

## 2. Libraries

### 2.1 Bundle sizes [run]
Vite 8.3.6, default minifier, real entry points that call the API so tree-shaking is realistic. For scale, the game's current JS is 219.5 KB minified and 77.4 KB gzipped.

| Bundle | Min KB | Gzip KB | Brotli KB | Node polyfill trouble |
|---|---|---|---|---|
| `near-api-js` 7.4.0, sign and send | 195.2 | 59.5 | 49.9 | One warning, harmless at runtime (see below) |
| `near-api-js` 7.4.0, everything | 205.1 | 62.2 | 52.2 | Same |
| `near-kit` 0.20.2, sign and send | 245.5 | 74.3 | 63.3 | None |
| `near-connect` 0.12.0 alone | 57.5 | 14.6 | 12.8 | None |
| `near-connect` 0.11.4 alone | 52.5 | 13.2 | 11.6 | None |
| **0.11.4 + plugin + `near-api-js` (recommended)** | **248.2** | **72.7** | **61.8** | Same one warning |
| `near-connect` 0.12.0 + `near-kit` | 305.8 | 89.3 | 76.2 | None |
| NEAR Auth browser SDK + provider | 548.0 | 162.3 | 126.5 | **Crashes on load** (section 3.4) |

The warning is `util externalized`, from `generate-function` via `is-my-json-valid` in `near-api-js`. In Chromium the signing proof ran with no page errors and no polyfills.

Split the code: the guest path needs only `near-api-js` (59.5 KB gzipped), and wallet connect adds about 13 KB on click.

Wallet code itself isn't in the bundle. NEAR Connect downloads it at runtime from the manifest, for example 2 MB for Meteor [run: fetched the executor files]. The manifest and most wallet code come from `raw.githubusercontent.com` and jsDelivr, so this is a runtime dependency on those hosts. If the manifest can't load, the code falls back to an empty wallet list [read: source]. Passing our own `manifest` object removes that risk for the list itself, though not for the wallet scripts.

### 2.2 Browser proof [run]
Headless Chromium against real testnet, with no wallet and no extension. The page generated an ed25519 key, called `POST /api/guest-accounts`, made a view call, then signed `join` and `dig` locally.

| Step, ms from click | `near-api-js` | `near-kit` |
|---|---|---|
| Key generated | 12 | 6 |
| Account created and credited (2 transactions in sequence) | 5,097 | 4,884 |
| View call done | 5,705 | 6,263 |
| Join signed and executed | 8,137 | 10,239 |
| Dig signed and executed | 10,617 | 12,792 |

Example transactions: `GzCvXRFg6KJvRWmZdY6DJ2YdqQY9DqGS7ZD5rvhbSYL5` (join), `3XzL1HUdfa5Um5ZkZJm7eXv6jTw7CH5EionhP9t5YCsy` (dig). After a reload, the key from `localStorage` resumed and dug again in 2.9 s. No CORS trouble with `test.rpc.fastnear.com`.

Sending the two creation transactions in parallel should cut the 5 s to about 2.5 s, but they need separate backend keys for nonces [inferred, not run].

Time a player waits for a dig, depending on what the client waits for [run, two samples each]:

| `waitUntil` | Time |
|---|---|
| `INCLUDED` | 1.4 to 1.7 s |
| `EXECUTED_OPTIMISTIC` | 2.5 to 2.7 s |
| `FINAL` | 4.3 to 4.6 s |

So the X should appear immediately. Confirm it in the background.

### 2.3 Choice
**`near-api-js`.** It's 15 KB smaller gzipped, it's what the NEAR docs use, and the plugin already depends on it, so choosing `near-kit` would ship two libraries. `near-kit` worked just as well and has gas key support, but we don't need that.

**Pin `@hot-labs/near-connect` to 0.11.x.** `npm i @hot-labs/near-connect@latest function-call-key-plugin` fails with `ERESOLVE`, because the plugin's peer range is `^0.11.1` and latest is 0.12.0 [run]. With 0.11.4 and 2.2.0, `connector.use(plugin)` works in Chromium [run]. That only proves registration, because signing through the plugin needs a real wallet approval.

---

## 3. Guest accounts and alternatives

### 3.1 Costs [run]
| Account shape | Fee to funder (NEAR) | Account storage (limit 770 B free) |
|---|---|---|
| (a) one full-access key | 0.007115 | 182 B |
| (b) function-call key + backend full key | 0.007136 | 326 B |
| (c) function-call key only, **zero balance** | 0.007092 | 244 B |
| (b) with 10 method names | 0.007113 | 452 B |

Creation takes about 2.0 to 2.5 s. About 0.007 NEAR of the fee is a fixed burn [read: gas docs], so it's never recoverable. A zero-balance account with two keys is allowed [run].

### 3.2 The four options
| | (a) Own full key | **(b) Function-call key + backend sweep key** | (c) Relayer, zero balance | (d) NEAR Auth |
|---|---|---|---|---|
| Popups | 0 | 0 | 0 | Auth0 redirect or popup per signature [read] |
| Coins can leave the game | Yes, so it can be farmed | **No** [run] | No | Depends on the keys added |
| Reclaim after inactivity | Only with a second key | **Yes** [run] | Yes, through the relayer [run] | No |
| Backend down, can guests still act? | Yes | **Yes** | **No** | No, it needs a relayer [read] |
| Dig gas | About 1.9 Tgas | About 1.9 Tgas | 2.83 Tgas, paid by us | Not measured |
| Dig time | 2.2 to 2.6 s | 2.2 to 2.6 s | 3.0 s | Not measured |
| Extra attack surface | Coin farming | Backend key store | Relayer endpoint that can be drained | Third-party login |
| Works on dig.joundy.dev today | Yes | Yes | Yes | **No** |

**Pick (b)** for the hackathon:
- The browser key can only call the methods we list. `withdraw` was refused ("Deposit is not allowed with function call") and an unlisted method was refused ("Access key does not allow method") [run]. Creating guests in a loop gains nothing, because the coins can't leave.
- Reclaiming needs no special power in the contract, which keeps "nobody can touch the funds" true. The backend acts only as the guest account's own key holder.
- It keeps your rule that if the backend dies, funds stay safe: guests still sign and pay gas themselves.
- The contract needs nothing guest-specific except a public `deposit_for(account_id)`. If season rules need to exclude guests, the account suffix identifies them.

What (b) gives up: guests can't withdraw or transfer NFTs, because NEP-171 needs 1 yocto and a function-call key can't attach it. Show "Connect a wallet to own NFTs" instead.

Be open about it in the UI: guest coins are testnet coins managed by the game.

### 3.3 Why not a relayer [run]
It works: a zero-balance guest joined and dug, and the relayer paid (0.00026 to 0.00029 NEAR per call). Three catches:

- **Attached deposits come from the relayer, and that's a way to drain it.** A failing call with 0.03 NEAR attached cost the relayer 0.03 and paid the guest **+0.03**. This matches the protocol page. The relayer tutorial says the opposite ("any attached deposit comes from the client's account"), and I measured that to be wrong. Any relayer must reject deposits above 0.
- **Allowance doesn't apply.** The docs say a function-call key's allowance isn't checked for meta transactions, so the relayer needs its own limits [read].
- **It's a single point of failure** for guests, which is what section 3.2 avoids.

A function-call key can't smuggle a deposit through a delegate: both 0.01 NEAR and 1 yocto were refused [run].

Keep a relayer for later, or for one narrow use: a zero-balance account can't pay gas to delete itself, and deleting through the relayer worked (1.17 Tgas) [run].

### 3.4 NEAR Auth [run and read]
- The docs say testnet needs no approval and gives a shared Auth0 client [read].
- I tried that client's `/authorize` with different return addresses [run]:

| `redirect_uri` | Result |
|---|---|
| `http://localhost:3000` | 302 to login |
| `http://localhost:5173` | 403 Callback URL mismatch |
| `https://dig.joundy.dev` | **403 Callback URL mismatch** |

So jurors can't use it on our domain. It would need our own Auth0 setup, which I didn't test.

- There's no Svelte SDK, but the browser SDK is framework-agnostic [read].
- It adds 162 KB gzipped, including a second copy of `near-api-js` (5.1.1).
- It crashes on load under Vite without a Buffer polyfill: `Cannot read properties of undefined (reading 'from')` [run]. I didn't try a polyfill, because the domain problem already decides this.
- Each signature is an Auth0 context switch [read]. For production, add a function-call key on first login so digs stay silent [inferred].

### 3.5 Abuse limits and reclaiming
All [inferred] from the measurements above; the sweep itself was [run].

**Limits on `POST /api/guest-accounts`:**
- 3 new guests per IP per hour, 1 per browser, and the same public key returns the same account.
- A global daily cap, and refuse when the funder drops below a floor.
- Same-origin only. The server picks the name and validates the key.
- IP from `CF-Connecting-IP`, but only if traffic really arrives through Cloudflare. I didn't confirm that path, so check it when building.
- Keep Turnstile in reserve. Coins can't leave, so abuse only wastes budget up to the cap.

**Reclaim** (backend, from its indexer, after N idle hours and no open rooms):
1. With the sweep key, call `withdraw(all)` with 1 yocto.
2. Wait for finality.
3. Transfer the coins to the root, then delete the account as a separate step. The docs warn never to use `DeleteAccount` in place of `Transfer`, and that refunds to a deleted account are burned [read].

In my run a direct withdraw and delete returned 1.705986 of the guest's 1.706268 NEAR [run]. Afterwards the browser key fails with "Access key ... does not exist", so the frontend should catch that and make a new guest [run].

**Budget per guest:** 0.0071 burned, 0.05 gas (reclaimable), plus the game balance (reclaimable). Measured burn is about 0.0002 NEAR per transaction, so 0.05 NEAR lasts about 250 transactions if gas attached stays at 10 Tgas or less.

**Coin supply, a real constraint:**
- The faucet gave 10 NEAR per new account [run].
- Contract code locks 1 NEAR per 100 KB. My 192 KB test contract used 192,401 bytes [run].
- So a 500 KB contract locks about 5 NEAR, and at 0.5 NEAR per guest one faucet grant covers about 20 guests.
- Testnet fee tiers should be far below the dummy's 0.1 to 5 NEAR, unless we find a larger faucet source.
- The 20 NEAR mint price can't be tested from one faucet grant. Consider a lower testnet price.

---

## 4. Wallets on testnet

**Can NEAR Connect work with testnet? Yes.** `new NearConnector({ network: "testnet" })` filters the list to wallets flagged for testnet [run].

| Wallet | `testnet` flag | Install needed? | What I saw |
|---|---|---|---|
| **Meteor** | Yes | **No, web wallet** | Popup opens `wallet.meteorwallet.app/connect/testnet/login` [run], so it clearly targets testnet. The headless popup got a Cloudflare block, so I stopped there. |
| **Intear** | Yes | **No, web wallet** | Popup opens `wallet.intear.tech/connect` [run], which asks for a password. The network isn't in the URL, so testnet is **unconfirmed** past this point. |
| Nightly | Yes | Extension | In the list [run] |
| Ledger | Yes | Hardware | In the list [run] |
| NEAR CLI | Yes | CLI | In the list [run] |
| Ethereum Wallets | Yes | Extension | Removed by the filter below: no function-call key support |
| WalletConnect, Unity | Yes | App | Not listed unless we pass a `walletConnect` config [run] |
| HOT, MyNearWallet, OKX, Trezu, Hana | No flag | | Hidden on testnet [run] |
| Near Mobile | `false` | | Hidden on testnet [run] |

MyNearWallet's `testnet.mynearwallet.com` is up [run], but its manifest entry has no testnet flag, so the connector hides it.

Use `features: { signInWithFunctionCallKey: true }`, which leaves Meteor, Intear, Ledger, Nightly and NEAR CLI [run]. A wallet that can't add a key would need an approval for every dig, which would kill the game.

**Can't be tested headlessly:**
- Creating a wallet account (password, seed phrase).
- Getting testnet coins into it.
- The approval screens, the on-chain add-key at sign-in, mobile QR flows, and Cloudflare-protected wallet pages.

**So a person must try one Meteor round by hand** before the deadline. Nobody has run the wallet path end to end yet, including the plugin's local signing.

For automated wallet-path tests, `registerDebugWallet` looks usable with a fake wallet [read: source, not tried].

---

## 5. Payment flow

### 5.1 Function-call keys can't attach deposit
- Docs: function-call keys "do **not allow** to **attach NEAR tokens** to the call", and 1 yocto "cannot be attached with a function-call key" [read: access-keys, one_yocto].
- Attaching 0.01 NEAR or 1 yocto fails at the RPC with "Deposit is not allowed with function call" [run].
- A **payable** method with **nothing attached** works from a function-call key [run: 2.2 Tgas]. This is what makes one `join` possible.

The plugin signs locally only when every call has zero deposit, and otherwise goes to the wallet [read: its README]. So one method gets the right behaviour without any branching in our UI.

### 5.2 Approvals per design [inferred from the above, no wallet actually approved]
| | Session start | Each later round | Cash out |
|---|---|---|---|
| **Deposit first** | Sign-in 1 + deposit 1 | 0 | 1 |
| **Pay on every join** | Sign-in 1 | **1 every round** | 0 to 1 |
| **Hybrid: join with a top-up (recommended)** | Sign-in 1 + join 1 | 0 until the balance runs out, then 1 | 1 |
| **Guest (any design)** | 0 | 0 | Not offered |

The hybrid costs the same as deposit first, but there's no separate deposit screen: the first approval is "join, and add a few rounds' worth". [run] on testnet: a top-up of 0.2 NEAR, then the next round paid with nothing attached.

Digs never need an approval in any design.

If `join` fails, the attached deposit returns to the caller [run: 0.03 NEAR came back], so a failed join can't lose coins.

### 5.3 Gas reality [run]
| Call | Tgas burned | NEAR burned |
|---|---|---|
| `dig` | 1.9 | 0.00019 |
| `join` from balance | 2.2 | 0.00022 |
| `join` with attached fee | 2.0 | 0.00020 |
| `withdraw` with callback | 4.5 | 0.00040 |

**Gas is bought at 0.001 NEAR per Tgas**, 10× the burn price of 0.0001 [read: gas docs; run: error said `cost: 0.0309` for 30 Tgas]. The difference comes back, but not instantly. Our 0.05 NEAR guest sent 30 Tgas calls in a row, and the second failed with "Not enough balance" even though it would have been nearly untouched after the refund.

Allowance works the same way. With the plugin's default 0.25 NEAR, attaching 250 Tgas or more was refused, and 100 Tgas passed the check [run].

**The rule: attach 5 Tgas for `dig` and 10 Tgas for `join`,** adjusted once the real contract is measured. The real methods will burn more than my test ones.

### 5.4 Risk to note
A function-call key sits in `localStorage` and can spend the game balance through `join`. Someone with that key could join the victim into a costly room they host. It can't withdraw. Fine for testnet. For production, add a contract-side cap: a `join` with nothing attached may spend at most a limit the owner set with a 1 yocto call [inferred].

### 5.5 Winnings: internal balance, not push [run]
| Same 3 payees | Tgas burned | Receipts | Time | Failure |
|---|---|---|---|---|
| **Internal credit** | **2.36** | **1** | 2.1 s | None possible |
| Push with callbacks | 9.33 | 11 | 3.9 s | Needs a callback for each |

| Full 30-player refund | Tgas burned | Note |
|---|---|---|
| **Credit 30 balances** | **7.0 to 7.8** | Attached 100 Tgas |
| Push 30 with callbacks | 75 | 92 receipts. 150 Tgas attached **failed**, 290 worked, so it's close to the 300 cap |

**What a failed push does:**
- With a callback: the coins went to the missing account's game balance, and the callback logged it.
- With no callback: **the transaction still reported success**, the coins stayed in the contract and **nobody was credited**. They're stranded unless the contract has some way to recover them.

Other reasons:
- NEAR's docs warn that a single failure in a batch can count as lost tokens, and that refunds to deleted accounts burn [read: token-loss]. Reclaimed guests are exactly such accounts. An internal credit to a deleted name is simply kept.
- It suits the helper too: it pays settlement gas, and a small fixed call is easy to budget.
- Settlement can't partly fail, because it's one receipt.
- Winnings are instantly spendable, which is what makes "next round" silent.

**Withdraw** follows NEAR's safe pattern [read: reentrancy]: 1 yocto so a function-call key can't call it, deduct before the transfer, restore in the callback only on failure. The deduct and transfer worked [run]. A failed withdraw wasn't run directly, but the same callback shape was tested on failed pushes.

---

## 6. Storage

**Measured** with a 31-character account name [run]. The real contract's records will differ, so measure again.

| Record | Bytes | NEAR locked |
|---|---|---|
| Player balance record | 92 | 0.00092 |
| Room record | 85 | 0.00085 |
| Joined entry | 85 | 0.00085 |
| Dig | 96 | 0.00096 |
| Full 30-player room (all of the above except balance) | About 5.5 KB | About 0.055 |

NEAR locks the contract's own balance for storage, and the docs warn that unpaid state growth is an attack [read: storage-staking, security/storage]. So every write must be paid for by someone.

| Option | Popups | Surprise | Verdict |
|---|---|---|---|
| NEP-145 `storage_deposit` | One more approval, can't use a function-call key | A concept players don't care about | Skip. It matters for FT interoperability, and nothing here needs it. |
| Contract absorbs it | None | None, but anyone can grow its state | No |
| **Charged in the first credit** | None extra | "0.001 NEAR one-time setup" | **Yes** |
| **Host bond covers the room** | None extra | None for players | **Yes** |

**How it works:**
- **Player record.** The first credit measures `env::storage_usage()` before and after, and takes the exact cost from the amount [run: 1 NEAR credited 0.99908, then 0.5 NEAR credited 0.5].
- **Guests.** `deposit_for` works the same, so the backend pays [run].
- **Room and per-player records.** At `create_room`, require `hostBond` (0.1 NEAR in `rules.ts`) to cover `max_players × bytes per player × byte cost`. Players see only their fee. A 30-player room needs about 0.055 NEAR by my numbers, so the current bond fits, but check this against the real records.
- **Freeing it.** If per-player records are removed at settlement, that storage is released and the bond returns whole. This assumes verification can read digs from events, which is for the randomness and indexer work to confirm.
- **Settlement can't run out of storage.** Everyone paid (winner, host, deed owner) already has a record, because they joined, hosted or minted. So settlement creates nothing new.

The UI should show the setup cost once, in the first top-up: "Join 0.10 + setup 0.001".

---

## 7. Other things found

- **RPC limits.** `test.rpc.fastnear.com` returned 429 once during a burst of calls from this machine [run]. Other agents may have been using the same IP. Players call from their own IPs, but the backend shares one, so it should use `FailoverRpcProvider` with several endpoints [read: exported, not run].
- **Rust.** `near-sdk` 5.30 needs Rust 1.95 and failed on 1.86. A plain `cargo build --target wasm32-unknown-unknown --release` on 1.95 deployed and ran on testnet [run].
- **Docs paths.** The `token-loss` page is at `protocol/network/token-loss`, and access keys are at `protocol/accounts-contracts/access-keys`.
- **Meta transactions** must identify the player with `predecessor_account_id`, not `signer_account_id`. In my test the signer differed from the predecessor [run]. Use the predecessor everywhere, so a relayer stays possible later.

## 8. Not verified
- Any real wallet approval, including plugin local signing and top-up joins through a wallet.
- Intear's testnet support past its password page.
- Real game contract gas and storage (my numbers come from a small test contract).
- Guest limits under load, and the IP header path on the home lab.
- Parallel account creation with several backend keys.
