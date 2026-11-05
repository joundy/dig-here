# User audit: the whole game, as a stranger

Run 2026-11-05 on branch `testnet-integration`, against `https://dig.joundy.dev` and, for fixes not yet deployed, a local Vite proxying `/api` to the live site with no local oracle. Phone is a 360×640 touch browser, desktop 1280×800; also 320×568, 640×360 landscape, 768×1024 and 1920×1080. One headless Chromium at a time under the machine limits.

Signed-in states used real testnet transactions from throwaway accounts, deleted afterwards with `dighere.testnet` as beneficiary. Only the wallet's own window was stood in for, so **no real wallet has done any of this**. "Shot" names are in the session scratchpad, not the repo.

Severity: **Critical** breaks a promise of the game, **High** a stranger would get stuck or misled, **Medium** a real defect with a way round, **Low** polish.

## Findings

| # | Sev | Finding | Evidence | Fix | Verified by |
|---|---|---|---|---|---|
| 1 | Critical | **Nothing ever called `close_season`.** A season would hit 0:00 and stay there with prizes unpaid | `grep close_season server src` found nothing | The oracle closes it when due, retrying every 30 s, with its own key. The runner's keys can only poke and reveal | Unit test on when it's due. Not yet seen closing a real season: season 1 ends about 17 hours after this audit. **Check after deploy** |
| 2 | High | **A host who pressed Create wasn't in their own game.** Nothing said Join was still needed. Bots arrived, and 34 s later: "Dig! You're watching this one" | Shots `53`, `55`, on live | The form has "I'll play too", on by default: one approval covers bond and fee, and the join follows silently | Round on testnet, shot `93` |
| 3 | High | **A lone host waited 36 s** on the 30-second countdown (known item) | Timed on live: 34.4 s from the room opening | Starting defaults to "By hand". Bots are in within a second or so, and Start now is on screen. Countdowns stay available and their copy says what they do | Timed on testnet: Start now offered at 0.3 s, live at 4.4 s with a pause before pressing. Target was 15 s. No contract change |
| 4 | High | **Nothing said what the game is.** The first tutorial card was "Read the clues", and the board opened on Quick Play | Shots `02`, `10` | New first card, "Dig for treasure", and a line on the board for anyone not connected, with a How it works link | Shots `90`, `b6` |
| 5 | High | **Verify was below the fold on a phone**, under a sticky button, with text showing beneath that button | Shots `42`, `43` | Verify this round and Find another game sit side by side in a bar that stays on screen | Shot `b5-phone-results` |
| 6 | High | **A keyboard player could never pick a spot on the desert.** Arrows started from the map's middle, which is its lake, and each press said water | Round 207, shot `a4` before the fix | First press lands on the nearest land, later ones walk, and water is crossed to the far shore | Keyboard round on testnet to the end. Test on all three maps |
| 7 | High | **With no network the page lied:** "this is coming straight from the chain" over a 0 NEAR jackpot and "Nobody is waiting" | Shot `82-norpc-desk` | A loading state until the first read, and a strip saying it can't reach the island, which clears by itself | Shots `d4`, `d5`, unit test |
| 8 | High | **Faucet help ended at "try again later"** (known item) | Docs faucet answered 429 "retry in 3 hours" here | See "Faucet" below | Experiments below |
| 9 | Medium | **Disconnect left the game's key on the account** (known item) | Key list on chain after disconnecting | Disconnect asks. Removing goes through the wallet as a `DeleteKey`. If refused or declined it says the key stays, what the key can't do, and where to remove it | Key list on chain: gone when approved, still there when refused. Stand-in wallet: see "A human must try" |
| 10 | Medium | **Deleted accounts on the season list** (known item). All of the top ten were | `view_account` null for each, shot `14-season` | Marked "deleted" with a line saying what that means. See "Season" below | Shots `b5-*-season`, unit test |
| 11 | Medium | Quick Play gave a new wallet the dearest room when cheaper ones were open | Room 204: 0.1 NEAR with 0.01 rooms open | Someone paying from their wallet gets the cheapest | Unit test, then a 0.025 room over a 0.1 one |
| 12 | Medium | No description, no social preview, and `/favicon.ico` and `/robots.txt` answered 200 with the HTML page | `curl` on live | Description, Open Graph, Twitter card, 1200×630 image, icons, manifest, robots. Missing files are real 404s | `server/static.test.ts`, browser fetch of each |
| 13 | Medium | No security headers beyond what Cloudflare adds | `curl -I` on live | See "Headers" below | Below |
| 14 | Medium | A blank blue page for 4.3 s on a slow connection | Throttled to 50 KB/s, shot `83-slow-1s` | A splash in the HTML itself | Shot `d0` caught it |
| 15 | Medium | Back from a room always reset the board to Waiting, losing Finished and its page | Test on live | The board remembers its tab and page | Browser back, "Live 1" kept |
| 16 | Medium | 320 px phones: header cut off the Play button, Season and host form ran off the panel, "Earned" clipped | `scrollWidth` 334, shots `84-small-*` | Header and grids shrink properly | `scrollWidth` 320, shots `b5-small-*` |
| 17 | Medium | On a phone the NFT market had no way back to the games | Shot `14-deeds-phone` | Back to games link | Shot `b5-phone-nft` |
| 18 | Medium | A failed withdrawal check could close the wallet dialog and lose its message, if the failure came back faster than the `close` event | Found by trying an empty amount | The dialog knows when it stepped aside for the wallet, and empty amounts are caught first | Browser: "Enter an amount above 0." |
| 19 | Medium | Top up and Withdraw only found out an amount was impossible from the wallet or the contract | Top up 0.5 with 0.195 in the wallet | Plain lines before anything opens | Shot `c3`, browser |
| 20 | Medium | A name of 20 emoji passed the 40-character limit and then failed on the contract's 40 bytes, after the wallet | Read from the contract's check | Checked in bytes, before any wallet | Browser, shot `c4` |
| 21 | Medium | Host rooms needed a name, after the top-up, for no benefit | Read the order of checks | A blank name uses the suggestion shown | Round on testnet: "Beginner's luck" |
| 22 | Medium | URLs said `#/deeds`, the word the game dropped | Address bar | `#/nfts`, with `#/deeds` still working | Browser, both |
| 23 | Low | Fee buttons read "0.05 NEAR" but "0.1 NEAR" fit on one line and the others wrapped | Shot `14-new-phone` | The legend says NEAR, buttons show the number | Shot `91` |
| 24 | Low | "dighere.testnet owns the pine tree NFT and earned 0 NEAR" | Shot of a 0.03 pot | Says the pot was too small for its 2% to come to anything | Read, unit tests still pass |
| 25 | Low | Cards said "7 finished, 0 expired" with no subject | Shot `10` | "Host: 7 finished, 0 expired" | Shot `90` |
| 26 | Low | A bot host's room said "Starting in 0:51", then started in 4 s | Round 180 | "Starting any second…" once a person is in | Round 204 |
| 27 | Low | Same page title everywhere | Tab | A title per page | `document.title` |
| 28 | Low | Contrast below AA: small text on the sea blue at 3.5 to 4.1 | axe on `#/new` | `--mist` lightened, hints in foam. axe finds 0 on every screen checked | axe rerun: board, watch, wait, results, verify, season, new, NFTs, NFT page, tutorial |
| 29 | Low | Missing `h1` on two pages, skipped heading level, `<p>` inside a `<dl>`, nested `aside` | axe | Fixed | axe rerun |
| 30 | Low | Tabs had no arrow keys, though `role="tab"` promises them | Keyboard pass | Arrow keys on all three tab lists | Browser, on the board. Tab order and focus rings were already right |
| 31 | Low | Phone filters 36 px, header icons 32 px wide, form input 38 px | Tap audit | 44 px for filters and input, 40 for header icons. 34 px at 320 px wide, where the width has to come from somewhere | Tap audit rerun at 320 and 360 px |
| 32 | Low | A watcher's round had nowhere to go | Shot `b5-*-watch-live` | "Find one to join" | Shot |
| 33 | Low | `/%E0%A4%A` crashed the handler, which reaches a visitor as Cloudflare's 520, and `?before=abc` reached SQL as NaN | `curl` on live, reading | 400, and paging ignores nonsense. Names over 64 bytes refused | `server/static.test.ts`, `server/indexer.test.ts` |
| 34 | Low | SIGTERM killed the process with streams open and the database unclosed | Read `main.ts` | Graceful shutdown | Read. Runs on the next deploy |
| 35 | Low | A tab kept per-room maps forever, and a woken phone waited up to 5 s for fresh state | Read `near.svelte.ts` | Cleared when a room ends, and refreshed on wake | Unit tests still pass |
| 36 | Low | Signing out in one tab left another playing as that account | Read | Tabs follow each other through `storage` events | Read. Two tabs in the same round agreed throughout, shot `a6` |

## The known items

### Lone host
Live at about 5 s, against 36 s before and a 15 s target, with one tap. If a host walks away from a by-hand room, guests see "Waiting for the host. Starts by itself in 14:xx", and the 15-minute limit starts it. A timed option under 30 s isn't possible without a contract change, because `COUNTDOWN_CHOICES` is 0, 30, 60, 120, and by-hand beat it without one.

Bots help with three of a human host's rooms an hour. Past that the room says so after 20 seconds, rather than saying nothing.

### Disconnect and the key
A function-call key can't delete itself, so this needs one wallet approval. If it can't be done, the key stays on the account but this browser has forgotten it, so nobody holds a copy, and it can only play this game with its 0.25 NEAR gas allowance. Reconnecting adds a new key rather than reusing the old one.

### Season
**Done:** the list marks deleted accounts, and the oracle closes the season.

**What's left, honestly:** the contract can't tell whether an account exists, and has no owner to correct its list, so deleted accounts stay ranked and take their prizes when season 1 closes. That's about 0.16 NEAR at most, parked under their names. They are all our own test accounts, so the coins aren't lost to a player:

- `server/tools/reclaim.ts` can re-create direct children of the root and withdraw, which covers `e2e*` and `ua*`. The `g-*.guests.dighere.testnet` names would need `guests.dighere.testnet` re-created first, and that isn't scripted, for about 0.05 NEAR.
- **Throwaway test accounts that play 3-dig rounds will keep landing on the list**, including from this audit, and get marked deleted. A contract change could widen the prize exclusion to everything under `.dighere.testnet`. It wasn't made: Verify would need versioning for season points, and that's a lot of risk for test coins.

### Faucet
Tried 2026-11-05, from this machine:

| Route | Result |
|---|---|
| Docs faucet, in a browser | "Account creation failed (429): Rate limit exceeded, retry in 3 hours." The limit is 10 per 12 hours per connection, which this project had used up itself. Shot `74` |
| `near-faucet.io`, one request for 1 NEAR | Its page spun, its first call answered `Error occured`, and no coins arrived after 2 minutes. **Not offered**, as before |
| Contract `v2.faucet.nonofficial.testnet`, `request_near`, directly | **Works.** Paid 2 NEAR to `dighere.testnet` in one call. Refuses a name with two dots before `.testnet`: "Invalid receiver account id!". Costs under 0.001 NEAR, but needs about 0.035 in the wallet up front with 30 Tgas. Holds about 988 NEAR |
| Meteor account creation | Its security policy allows reCAPTCHA, so it's taken to have a human check. Not attempted |

The game's help now quotes the refusal, says what it means, and offers: ask someone to send 0.2 NEAR, wait for the time the message gives, NEAR's Telegram if the faucet is broken, and watching meanwhile. A wallet that already holds 0.035 NEAR or more with a plain name also gets **Ask for 2 test NEAR**, limited to once an hour per browser, which is the contract's published rule even though it isn't enforced. It never suggests another network or another account to get past a limit.

The button itself ran only under a unit test, because throwaways here are subaccounts, which the contract refuses. The contract call ran for real.

### Closeness of 96 and big rooms
Win chance per dig by clue, as a multiple of an even chance. 3,000 rounds per row, two seeds, on `simulate`:

| Players | Clue 1 | Clue 2 | Clue 3 | Clue 4 |
|---|---|---|---|---|
| 8 | 1.15 | 0.84 | 1.25 | 0.76 |
| 10 | 1.25 | 0.83 | 1.2 | 0.7 |
| **12** | **1.42** | **0.94** | **1.2** | **0.44** |
| 16 | 1.69 | 0.99 | 1.04 | 0.25 |
| 20 | 1.9 | 1.0 | 0.95 | 0.15 |
| 30 | 2.33 | 0.95 | 0.53 | 0.03 |

Clear benefit from capping: at 30 a last-clue dig almost never wins and a first-clue dig is over the 2.2× band `sim.test.ts` holds up to 12. **The host form now stops at 12**, the size that test protects. Bot rooms already stop at 10, and the last 100 finished rooms topped out at 5 players. The contract's cap stays 30, so nothing about rounds changes, no upgrade is needed and old rounds verify as before.

**Clue timing wasn't changed:** the simulation places digs evenly across clues whatever the schedule, so it can't show a benefit. Changing bonus or timing would need versioned rules for Verify, with nothing to justify it.

## Headers
- **Content Security Policy, enforced,** with a fresh nonce per page. NEAR Connect runs each wallet in a sandboxed `srcdoc` iframe that inherits the policy, so it passes them the nonce. `'unsafe-eval'` stays because Meteor's and Nightly's bundles contain `new Function`. `connect-src https: wss:` stays because each wallet has its own servers.
- `frame-ancestors 'none'`, because a silent key means a framed page could trick someone into a move.
- HSTS, `nosniff`, `Referrer-Policy`, `Permissions-Policy` leaving HID, USB and Bluetooth for Ledger, and `Cross-Origin-Opener-Policy: same-origin-allow-popups`, because wallet windows answer through `window.opener`.
- Caching and compression were already right: hashed assets immutable, others revalidate, gzip at origin, Brotli at Cloudflare.

**Tested:** the built game behind the real handler, then Meteor, Intear, Nightly, Ledger and NEAR CLI each opened from the wallet list. No policy violations from any. Intear, Nightly, Ledger and NEAR CLI showed their own screens. Meteor's frame loaded and stayed blank in this browser, the same with and without the policy. Past that point each needs a person.

## What already held up
No console errors on any route, apart from Cloudflare's beacon being refused by this machine's network. First paint 0.4 s, 137 KB. Reload at every step of a round came back correct. Two tabs agreed. Rejected approvals, closed windows and refused connects all say so and let you retry. Verify passed all 41 checks. Sound toggles persist, tutorial's "once per visit" works, reduced motion is respected, and focus rings are clear. The market's flow from earlier, 31 checks, passed again on the new code, on real testnet.

## Checks that couldn't finish
**Explorer links.** `testnet.nearblocks.io` answers a Cloudflare challenge (`cf-mitigated: challenge`) to `curl-cffi` and `stealth-fetch`, exit 3. It's a human check, so I stopped there. The URL forms come from NearBlocks' own routes, unverified past that page.

## Product decisions, with a recommendation
1. **Starter coins, parked earlier.** The faucet is the weakest step for a juror on shared wifi. Recommend sending about 0.2 test NEAR once per real wallet from the backend, capped per day.
2. **A timed start under 30 s.** Needs one constant in the contract. By-hand met the target, so I'd leave it unless hosts with friends ask.
3. **Host form cap of 12.** Reversible in one line. Say if you want bigger rooms offered regardless.
4. **Prize exclusion for all project accounts.** See "Season". Recommend it only if a new contract is deployed for other reasons.
5. **An early `Claim`-style step for season prizes,** so a prize can't go to an account that's gone. Not worth it on testnet. Worth considering before mainnet.

## A human must try
- A **real wallet** end to end: sign in, top up, silent dig, Disconnect with **Remove the key**, then look at the account's keys. Meteor's and others' handling of `DeleteKey` hasn't been seen. Intear's connector doesn't name the action at all, so it's the one most likely to refuse, and the dialog says what happens if so.
- A **wallet popup under the new policy** on the live site. The executors load and show their screens, but no approval window has been seen past that.
- One **explorer link**, past Cloudflare.
- **The season closing**, about 17 hours from this audit: Season page, last winners, and the `closed season` line in the log.
