# Testnet accounts and funding

Run on 2026-11-05, 06:27 to 06:46 UTC. Everything below under "ran" was executed, not read. Items marked "read only" came from source or docs and were not tested.

## Toolbox

Image `dig-here-near-tools`, built from `docker/near-tools.Dockerfile`, on Debian trixie:

| Tool | Version |
| --- | --- |
| Rust | 1.99.1, target `wasm32-unknown-unknown` |
| near-cli-rs | 0.30.1 |
| cargo-near | 0.22.0 |
| near-sandbox | 2.14.0 (neard, protocol 88) |
| Node | 24.22.2 |

`docker/near <command>` runs a command in the image with the project at `/work`, following your directory inside the project. It builds the image on first use. Extra `docker run` flags go in `DOCKER_NEAR_ARGS`.

Named volumes:

- `dig-here-near-creds`: `~/.near-credentials` (keys)
- `dig-here-near-cargo-registry`, `dig-here-near-cargo-git`: cargo caches

What the first builds turned up:

- **Base image.** The near-sandbox binary needs glibc 2.39, so bookworm fails with a `GLIBC_2.38 not found` error. Trixie works: the sandbox started and produced blocks.
- **S3 is slow.** The sandbox tarball came down at about 34 KB/s from here, so a build with no cache takes about 17 minutes. Docker's layer cache avoids this on later builds.
- **`cargo near new`** fails its first commit without a git identity, so the image sets one (`near-tools`). It does not affect anything outside the container, but a `git commit` run inside the container would carry that name.

## Rust and wasm

Docs ask for `wasm32-unknown-unknown`, and no `wasm32v1-none` or older compiler is needed. Current `cargo near build` prints:

```
contract's near-sdk targets protocol version 84; rustc 1.99.1 accepted (bulk-memory opcodes supported by nearcore VM)
```

Ran: built the `cargo near new` template with Rust 1.99.1 (102.6 KB), deployed it to testnet, called `init` and `bid`, and read the result back. All worked.

The template's `rust-toolchain.toml` pins Rust 1.93.0. That pin isn't in the image, and with it the first build took 57 s, against 8.5 s for a build on the image's Rust after removing the pin (with the registry cached by then, so not a clean comparison). rustup very likely downloads 1.93 into the throwaway container on every run. So in our contract, set `channel = "1.99.1"` or remove the pin.

Use `cargo near build non-reproducible-wasm` for fast local builds. The other mode, `reproducible-wasm`, runs its own Docker container and was not tested.

## Accounts

Root account: **`dighere.testnet`**, the first name tried, created through the faucet.

```
docker/near near account create-account sponsor-by-faucet-service dighere.testnet \
  autogenerate-new-keypair save-to-legacy-keychain network-config testnet create
```

Use `save-to-legacy-keychain` and `sign-with-legacy-keychain`. They write plain files into the Docker volume. The docs' `save-to-keychain` means an OS keyring, which a container doesn't have (read only, not tried).

Keys are in the `dig-here-near-creds` volume and in `.kamal/secrets-testnet.env` (mode 600, gitignored, confirmed with `git check-ignore`), which holds `NEAR_ROOT_ACCOUNT` and `NEAR_ROOT_PRIVATE_KEY`. The key file in the volume also holds the seed phrase; the env file does not. `.dockerignore` already excludes `.kamal`, so the game image can't pick it up.

Docs mismatch: `near generate-keypair` is in the docs but does not exist in CLI 0.30.1, the latest release (ran it, got "command does not exist").

## Funding

**Balance reached: 53.98 test NEAR on `dighere.testnet`, short of the 300 to 500 target.** The rate limit is what stopped it.

| Source | Gives | Limit | Works without a person? |
| --- | --- | --- | --- |
| Helper API, `POST https://helper.nearprotocol.com/account` (what the CLI uses) | 10 NEAR per new account | 10 per 12 hours (headers) | Yes |
| Same API on `helper.testnet.near.org` (what the docs faucet uses) | 10 NEAR per new account | Same counter (see below) | Yes |
| Contract `v2.faucet.nonofficial.testnet`, method `request_near` (behind near-faucet.io, per its repo README; read only) | 2 NEAR per call | Asking for 10 fails: "Withdraw request too large!". Published source says one request per receiver per hour | Yes, costs about 0.0008 NEAR in fees |

### Helper API

Every response carries:

```
x-ratelimit-limit: 10
x-ratelimit-remaining: <n>
x-ratelimit-reset: 1793902145.67
```

- That reset is 18:09:05 UTC, about 12 hours after the window began at about 06:09. The published `near-contract-helper` source also says 10 per 12 hours (read only).
- **The two helper hosts share one counter.** One request to each showed the remaining count falling in sequence and the same reset time, so the second host gives no extra quota.
- **Something else used the quota.** My second account creation showed 4 remaining, meaning 6 used. Only 2 of those were mine, so 4 came from elsewhere in the window. I can't tell from what. The limit looks per-IP (read only, from the source), so another agent or machine on this connection is possible.
- Stopped with **1 request left, unused**. No 429 was reached and nothing asked me to stop.
- The most this gives is 100 NEAR per 12 hours, and less if something else shares the quota.

### Contract faucet

**The published rule isn't being enforced on the deployed contract.** The published source has a 1-hour gap per receiver. I made a second call about 25 seconds after the first to test it, and it succeeded. I stopped there and made no more calls: the contract holds about 1,014 NEAR for everyone, so draining it through a missing check isn't polite use. Treat it as one call per hour, about 48 NEAR a day at most, and don't use extra receiver accounts to get around that.

### Repeatable funding

This is the same pattern the docs faucet page uses: create a temporary account, then move its coins. Run it with `<n>` as a new number each time (01 to 04 are used). Check the remaining count, leave a gap between runs, and stop on anything other than HTTP 200.

```bash
docker/near bash -s <n> <<'EOF'
a=dighere-fund-$1.testnet; c=~/.near-credentials/testnet
pub=$(jq -r .public_key $c/dighere.testnet.json)
code=$(curl -s -o /tmp/body -D /tmp/hdr -w '%{http_code}' -X POST https://helper.nearprotocol.com/account \
  -H 'content-type: application/json' \
  -d "{\"newAccountId\":\"$a\",\"newAccountPublicKey\":\"$pub\"}")
echo "$a http=$code $(grep -i '^x-ratelimit-remaining' /tmp/hdr)"
[ "$code" = 200 ] || { head -c 300 /tmp/body; exit 9; }
sleep 3
umask 077; jq --arg a "$a" '. + {account_id:$a}' $c/dighere.testnet.json > $c/$a.json
near account delete-account $a beneficiary dighere.testnet network-config testnet sign-with-legacy-keychain send
rm -f $c/$a.json
EOF
```

Each run nets about 10 NEAR, and the delete costs about 0.00003 NEAR in fees.

Contract faucet, at most once an hour:

```bash
docker/near near contract call-function as-transaction v2.faucet.nonofficial.testnet request_near \
  json-args '{"receiver_id":"dighere.testnet","request_amount":"2000000000000000000000000"}' \
  prepaid-gas '100.0 Tgas' attached-deposit '0 NEAR' \
  sign-as dighere.testnet network-config testnet sign-with-legacy-keychain send
```

### Reaching the target

Next window opens at 18:09 UTC today. At 10 accounts per window, 300 NEAR takes about 3 windows (1.5 days) and 500 NEAR about 5 windows (2.5 days), if nothing else shares the quota. That fits the 2026-11-14 deadline, but someone has to run it each window.

Storage is confirmed at 1 NEAR per 100 KB (`storage_amount_per_byte` is 10^19 yoctoNEAR on the live network). A 20 NEAR NFT mint is by far the biggest cost in our plan: one mint equals two faucet accounts. A lower mint price on testnet would cut the funding need sharply.

## Verified on testnet

Ran, then cleaned up by deleting the test accounts into the root:

- **Sub-account:** `smoke.dighere.testnet` and `hello.dighere.testnet` created with `create-account fund-myself`. Fee about 0.00008 NEAR.
- **Transfer:** root to sub-account and back. Fee about 0.00002 NEAR.
- **Delete with beneficiary:** coins arrive at the root.
- **Contract:** deploy and calls, as above.

```bash
docker/near near account create-account fund-myself x.dighere.testnet '1 NEAR' autogenerate-new-keypair \
  save-to-legacy-keychain sign-as dighere.testnet network-config testnet sign-with-legacy-keychain send
docker/near near tokens dighere.testnet send-near x.dighere.testnet '0.5 NEAR' \
  network-config testnet sign-with-legacy-keychain send
```

### Time from send to final

Transfers sent with `send_tx`, three per setting on each RPC, 0.001 NEAR each. Times are full round trips from this machine, and include network latency.

| `wait_until` | `rpc.testnet.near.org` | `test.rpc.fastnear.com` |
| --- | --- | --- |
| `INCLUDED` | 4.4 to 5.2 s | 1.8 to 2.1 s |
| `EXECUTED_OPTIMISTIC` | 4.8 to 4.9 s, one timeout at 13.3 s | 7.9 to 10.8 s |
| `INCLUDED_FINAL` | 5.6 to 7.2 s | 3.1 to 3.7 s |
| `FINAL` | 17.6 s, two timeouts at 13.3 s | 5.0 to 9.9 s |

- Average block time is 0.77 s over the last 100 blocks. Final was 1 block behind the head in one sample.
- One contract call with a refund (`bid`, single sample) took 14.3 s to `FINAL` on FastNEAR.
- **A `TIMEOUT_ERROR` does not mean the transaction failed.** All 24 transfers landed, confirmed by the receiving balance, including the three that timed out. The backend must check status before retrying, or it risks paying twice.
- **Use FastNEAR, not `rpc.testnet.near.org`, for the backend.** It was faster to `INCLUDED_FINAL` and `FINAL`, and it never timed out in this small sample.
- The odd `EXECUTED_OPTIMISTIC` result on FastNEAR (slower than `FINAL`) is unexplained. Don't rely on it without checking again.
