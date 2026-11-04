# Dig Here build steps (stages 1 to 3)

> **For agentic workers:** REQUIRED SUB-SKILL: superpowers:executing-plans. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build the approved game on the fake backend, ready for the user's playtest gate.

**Architecture:** Pure rules in `src/lib/game/` (whole-number maths, no UI). The fake chain in `src/lib/backend/dummy.svelte.ts` wraps them behind `GameBackend`. Svelte screens only talk to `backend`. The world canvas gets its round state through `world.sync`.

**Tech Stack:** Svelte 5 runes, Vite 8, TypeScript 6, vitest 5, canvas 2D, WebAudio. No new dependencies.

**Spec:** `docs/plans/2026-11-05-dig-here-final-plan.md`. Numbers come from there.

## Global Constraints

- All game logic uses whole numbers: pixels on the 320×224 grid, money in integer milliNEAR, percentages in basis points. No floats or trig in rules, because a contract must reproduce them.
- Every number lives in `RULES` in `src/lib/game/rules.ts`.
- Clue wording lives outside the rules. Rules store clue IDs.
- No secret anywhere: the treasure doesn't exist until the round ends.
- Mobile first: every screen is tested at 360×640 with touch.
- `prefers-reduced-motion` skips animations, including the dim sweep.
- Money never appears or vanishes in any flow.

## Review Focus

1. Joining with too little balance: rejected with nothing charged and the wallet dialog offered. Test in Task 3 and Task 5.
2. Host never starts, or players leave below the minimum: countdown cancels, deadline starts or refunds, no coins stuck. Test in Task 2.
3. Page reload mid-round: dimming, clue trail and digs are restored without replaying effects, and a finished reveal doesn't replay. Browser check in Task 12.
4. Account switch during a fake transaction: the action stays with the account that clicked. Test in Task 5.
5. Small phone, long account names, 4 clue lines: nothing overflows, and the map keeps usable space. Browser check in Task 12.

---

### Task 1: Whole-number maps and rules

**Files:** Create `src/lib/game/mapDefs.ts`. Modify `rules.ts`, `types.ts`, `map.ts`. Test `src/lib/game/map.test.ts`.

**Interfaces, produces:**
- `MapId = 'tropical' | 'snowy' | 'desert'`, `MAP_IDS`, `W = 320`, `H = 224`
- `getMap(id): GameMap`, with `landmarks`, `land: Uint8Array`, `hills: Uint8Array`
- `isLand(id, p): boolean`
- `Rng = (n: number) => number`, `seededRng(seed): Rng`, `mathRng`

- [ ] Write `map.test.ts`: every map has exactly 60 landmarks with integer in-range cells on land, spaced at least 18 cells apart, at least 2 of each kind. Run it and see it fail.
- [ ] Implement. Tropical keeps today's shapes and seed. Snowy has a main island, an islet and a frozen lake. Desert has a wide island with an oasis lake and pond.
- [ ] Run tests, then commit.

### Task 2: Room lifecycle, clues, scoring

**Files:** Modify `engine.ts`, `clues.ts`. Create `copy.ts`. Rewrite `engine.test.ts`.

**Interfaces, produces:**
- `createGame(id, input)`, `joinGame(game, account)`, `leaveGame(game, account)`, `startGame(game, by, rng)`
- `advance(game, seconds, rng)`, `placeDig(game, account, cell, seenClue?)`
- `scoreDig(dig, treasure)`, `rankDigs`, `splitPot(pot, hostCutBps)`, `potOf`, `currentBonus`
- `standing(game, account) → { wins, of } | null`
- `possibleArea(mapId, candidateIds) → Uint8Array`
- `landingChance(mapId) → number[]`
- `clueText(mapId, clue) → { text, plain }` in `copy.ts`

Tests pin these:
- [ ] Stages: can't dig while waiting. Can't join after the start. Fee count equals players. Leaving below the minimum cancels the countdown. Full room starts in 5 seconds. Deadline starts at the minimum and refunds below it, with `refundReason: 'expired'`. Fewer than 2 digs at the end refunds with `'too-few-digs'`. Host can't start below the minimum, and only the host can start.
- [ ] Clues: 4 clues at 0, 30, 60 and 85% of the round. The first narrows nothing. Others only narrow.
- [ ] Treasure: none stored before the end. It always lands on a lit cell, on land, for all maps.
- [ ] Scoring: 90 closeness at ×1.5 scores 135.0 and beats a perfect ×1 (100.0). Crowded dig multiplies by 0.85. Within 6 cells of an earlier dig is crowded, and the earlier dig isn't. `seenClue` mismatch rejects without placing. Ties go to the earliest dig. All zero means closest wins.
- [ ] `standing`: reports wins across candidate landmarks. `landingChance` sums to 1.
- [ ] Implement, run tests, commit.

### Task 3: Economy

**Files:** Create `src/lib/game/economy.ts`, `economy.test.ts`.

**Interfaces, produces:** `Ledger`, `newLedger()`, `deposit`, `withdraw`, `charge`, `credit`, `payRoom(ledger, game)`, `buyDeed`, `listDeed`, `closeSeason`, `seasonRanking`, `hostRecord`, `deedId(mapId, landmarkId)`, `totalMoney(ledger)`.

- [ ] Tests: pot split example (10 NEAR, 5% host: 0.5, 0.3, 0.2, 0.1, 8.9). Unowned deed share goes to the jackpot. Exact pixel wins 80% of the jackpot, capped at 100× the pot, earliest dig first. Refund returns every fee. Expired room loses 10% of the bond and adds an expired record. Finished room returns the bond and adds a finished record. Deed first sale goes to the jackpot. Resale pays the seller and only works if listed. Season points only for 3+ digs: 100, 30, 10 per NEAR. Prizes pay 60, 30, 10%. `totalMoney` never changes through a randomised run of all flows. Too little balance charges nothing.
- [ ] Implement, run tests, commit.

### Task 4: Board ranking and balance simulation

**Files:** Create `src/lib/board.ts`, `board.test.ts`, `src/lib/game/sim.ts`, `sim.test.ts`. Add `npm run sim`.

**Interfaces, produces:** `boardView(games, { tab, sort, map, maxFee, hideFull, page, perPage }, hosts) → { rooms, pages, counts }`, `quickPlayRoom(games, balance, account, hosts)`, `SORTS`.

- [ ] Tests: empty rooms from hosts with expired records rank below active rooms in Best. Each sort orders correctly. Filters work. Paging is stable. Quick Play skips full, unaffordable and already-joined rooms.
- [ ] Implement. `sim.ts` uses the real engine and prints win rates per clue. Commit.

### Task 5: Fake backend

**Files:** Modify `backend/types.ts`, `backend/dummy.svelte.ts`.

**Interfaces, produces:** `GameBackend` with `account`, `games`, `jackpot`, `season`, `deeds`, `walletOf`, `balanceOf`, `hostRecord`, `deposit`, `withdraw`, `createGame`, `join`, `leave`, `start`, `dig`, `buyDeed`, `listDeed`. Dummy extras: `switchAccount`, `fillRoom`, `startNow`, `skipToNextClue`, `endNow`, `forceJackpot`, `endSeason`, `reset`, `speed`.

- [ ] Storage key `dig-here-dummy-v2`. New accounts: wallet 50 NEAR, game balance 0. Fake transaction delay 0.3–1.5 seconds. The action's account is captured before the delay.
- [ ] Bots host varied rooms, including spammy empty ones, buy some deeds (which seeds the jackpot), list some for resale, join rooms, and dig at varied clues using only public data.
- [ ] Commit. UI is rebuilt in Tasks 6–10.

### Task 6: World

**Files:** Modify `world/world.ts`, `terrain.ts`, `sprites.ts`. Create `world/themes.ts`. Modify `Board.svelte`.

**Interfaces, produces:** `world.showMap(mapId)`, `world.enterGame(mapId, digs, possible)`, `world.setPossible(ids | null, animate)`, `world.setTension(0..1)`, `world.onLandmark`, plus `sync` with `crowdRings`.

- [ ] Coordinates become cells, and `UNIT` goes away. Per-map terrain is cached.
- [ ] Dimming: land outside the lit area goes dark with a pixel dissolve. Non-candidate landmarks fade. Crowding rings show while picking. Toys react to taps with a sound and a line. Final seconds flash remaining spots.
- [ ] Commit.

### Task 7: App frame

**Files:** Modify `App.svelte`, `Header.svelte`, `app.css`, `ui.svelte.ts`. Create `WalletDialog.svelte`, `Tutorial.svelte`.

- [ ] Routes: `#/`, `#/new`, `#/game/:id`, `#/deeds`, `#/season`. Board and Season are full width with the island behind.
- [ ] Balance button opens the wallet with Deposit, Withdraw and the playtest account picker. Tutorial: 4 cards, Skip, Don't show again, `?` button.
- [ ] Commit.

### Task 8: Game Board and host form

**Files:** Create `GameBoard.svelte`, `GameCard.svelte`, `MapBadge.svelte`. Delete `Lobby.svelte`. Modify `NewGame.svelte`.

- [ ] Tabs, sort, filters, pages, Quick Play, Host a game, jackpot, links to deeds and season.
- [ ] Host form: map picker with Surprise me, minimum and maximum players, countdown, bond, full split example.
- [ ] Commit.

### Task 9: Round screens

**Files:** Create `WaitingRoom.svelte`, `ClueTrail.svelte`, `Standing.svelte`, `DigTray.svelte`. Modify `Room.svelte`, `Parrot.svelte`, `Playtest.svelte`.

- [ ] Waiting room with player bar, countdown, Start, Leave, join and watch states.
- [ ] Clue trail with 4 stops, kept clues, locked next clue with countdown, spots line, phone layout.
- [ ] Standing line with "stolen spot" and "your spot is gone" events. Crowded and dark-area notes. Warning in the last 20 seconds if you haven't dug. Dig tray for other rooms.
- [ ] Commit.

### Task 10: Results, deeds, season

**Files:** Modify `Results.svelte`. Create `DeedMarket.svelte`, `SeasonPage.svelte`, `JackpotBadge.svelte`.

- [ ] Results: score breakdown, full pot split, deed line, jackpot moment.
- [ ] Deed Market: map tabs, tap a landmark, owner, price, chance, landings, earned, Buy, List, My deeds.
- [ ] Season: pool, time left, table, your rank.
- [ ] Commit.

### Task 11: New map art and audio

**Files:** Modify `sprites.ts`, `sprites.test.ts`, `themes.ts`, `copy.ts`, `audio/*`.

- [ ] 18 new sprites, with a test that every kind on every map has a sprite. Snowy and desert palettes, clue jokes, and music variations. Fourth intensity level. New sounds for joining, room filling, stolen spot and jackpot.
- [ ] Check every map by screenshot. Commit.

### Task 12: Check it all

- [ ] `npm test`, `npm run check`, `npm run build`.
- [ ] Browser run on 5 device sizes with touch: tutorial, deposit, join, wait, dig, reveal, withdraw, deeds, season, reload mid-round.
- [ ] Update README with the new rules and "do X, see Y" steps. Commit. Hand over to the user for the playtest gate.
