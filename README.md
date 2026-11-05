# Dig Here (working title)

A multiplayer treasure-digging game on NEAR **testnet**, for the NEAR Hackathon, Games track. Coins here are test coins with no value.

**Play it:** https://dig.joundy.dev (no wallet or install needed)
**Contract:** `v1.dighere.testnet`

## The problem

Guessing games usually need someone to hide the answer, and that person can cheat. In Dig Here no answer exists until the timer ends, the contract does every roll, and any player can recheck a finished round in their browser.

## The game

A host opens a room and sets the entry fee, timer, map, their share of the pot (20% at most), and the minimum and maximum players. Players join and the fee locks. They can leave before the start and get it back. Each game rolls new landmark positions on the map.

**Four clues**, each worth a lower bonus. The screen always shows how many spots are still possible.

| Clue | Says | Bonus |
|---|---|---|
| 1. YOLO | Nothing | ×2.5 |
| 2. Category | "Near an animal" | ×1.5 |
| 3. Kind | "Near a horse" | ×1.25 |
| 4. Detail | "Near a horse, close to water" | ×1 |

**You get one dig. Score = closeness × bonus × crowding.** Digging within 6 pixels of an earlier dig multiplies your score by 0.85. When the timer ends the treasure is rolled, and the best score wins the pot. Ties go to whoever dug first. With fewer than 2 digs, everyone is refunded.

**The pot:** host cut (0–20%), jackpot 3%, NFT owner 2%, season pool 1%, and the winner gets the rest.

**Around the rounds:**
- **Jackpot:** dig on the treasure's exact pixel to win it. A win pays at most 100× that round's pot.
- **NFTs:** one NEP-171 token for each kind of landmark on each map, 36 in all. The first owner mints it, and the money goes to the project (0.5 NEAR on testnet, planned 20 NEAR in production). The owner earns 2% of the pot when the treasure lands by that kind, and can list it at any price.
- **Season:** points scaled by the pot, with prizes for the top 3.
- **Hosts:** each room locks a small bond, and hosts have a public record, so spam rooms sink down the board.

## How NEAR is used

- **Every rule and coin is in the contract** (`contract/`, Rust): rooms, clues, scoring, payouts, NFTs and seasons.
- **Randomness has two sources, and neither side can know a result alone.** Before a room exists we commit to a hash chain. For each roll, the contract first records the block's random seed, then in a later block we reveal the next link, and the contract rolls from both. A validator can't predict the result because it lacks the link. We can only refuse to reveal, which publicly refunds everyone.
- **Anyone can verify a round.** "Verify this round" on the results screen redoes the links, seeds, layout, clues, treasure, ranking and pot split in your browser with the same rules, which `contract/tests/vectors.json` holds identical between TypeScript and Rust.
- **Players don't feel the chain.** A guest gets a real testnet account in about 2 seconds, signed by a function-call key in their browser, with no popups. Wallet users approve one top-up, then play silently. Winnings go to a game balance so the next round is instant.
- **The backend can't change an outcome** (`server/`). It triggers due steps, reveals links, serves live state, runs test-only bots and guest accounts, and indexes history. If it dies, coins stay safe and refundable, and the game can still be read directly from chain.

## Try it

1. Open https://dig.joundy.dev. See a short how-to-play. Tap through or skip it.
2. Press **Quick Play**, then **Play as guest**. See a room within about 10 seconds. You now have a real testnet account with free test coins.
3. Wait a few seconds. See labelled bots join and the round start on clue 1, YOLO, at ×2.5.
4. Tap the map, then press **Dig here**. See your X land at once, then "You'd win on N of N spots right now".
5. Watch clues arrive, the bonus fall, and your winning spots change.
6. When the timer ends, see the spots flash, the chest drop, the scores, and the pot split.
7. Press **Verify this round**. See each check recalculated in your browser.
8. Go to **NFTs**, open **Mint**, and mint one. Then list it under **My NFTs**.
9. To use your own account, choose **Connect NEAR wallet** instead. A testnet wallet such as Meteor works, and lets you withdraw and buy NFTs from other players.

## Run it locally

```sh
npm install
VITE_BACKEND=dummy npm run dev     # the whole game with a fake chain and playtest controls
npm test                           # rules and shared vectors
npm run sim                        # balance simulation
```

The contract builds in Docker: `docker/near cargo near build non-reproducible-wasm`, from `contract/`. Its tests, methods and events are in `contract/README.md`. The backend needs testnet keys in `.kamal/secrets-testnet.env`, and `server/run-local.sh` starts one copy. Don't run a second oracle against a live deployment.

## Known limits

- **Testnet only.** Bots and guest accounts are test-only and won't exist in production. Going to mainnet needs the items below first.
- **Randomness:** we hold the secret side, so refusing to reveal is a free way to cancel a round. It's public and refunded, but with real money we'd need to lock up coins that are lost on a missed reveal. Reveals currently don't wait for the lock to be final.
- **A stolen browser key** can't withdraw or buy NFTs, but it can spend the game balance by joining rooms. Production needs a spending cap.
- **Scripts:** clues and landmarks are public, so a script can work out the exact spots that still fit.
- **Multiple wallets:** one person can dig from several, and farm seasons, though every dig costs a fee. Rules alone can't prevent this.
- **The contract deployer still holds a full-access key.** It should be removed before any real use.

Full findings: `docs/research/security-review.md`.

## Code map

- `contract/`: the Rust contract, shared vectors and map data.
- `server/`: oracle, bots, guests, live state, indexer, sweeper.
- `src/lib/game/`: the rules in whole-number maths. `random.ts` is the number stream and hashes.
- `src/lib/backend/near.svelte.ts`: the game's connection to the chain. `dummy.svelte.ts` is the fake chain.
- `src/lib/world/`: the pixel-art islands. `src/lib/audio/`: the original chiptune, synthesized in the browser. `src/components/`: the screens.
- `docs/plans/`: the design. `docs/research/`: measurements behind it.

## Built with

Svelte, Vite, TypeScript, Vitest, Rust, near-sdk, near-api-js, NEAR Connect, and the Jersey 10 and Jersey 20 fonts (OFL). The code was written with Claude Code.
