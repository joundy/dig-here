# Dig Here: final plan

Date: 2026-11-05. Submissions close 2026-11-14, 23:59 UTC.

This plan turns our discussion into one list of work. Nothing in it is built yet.

**Changed after the first playtest (see each section):** the dimmed map is gone, the first clue's music is back to the original, maps have designed land with 40 landmarks whose positions are rolled for every game, and deeds are a mini NFT marketplace with one NFT per kind of landmark.

Each decision is marked:
- **[You]** you decided it.
- **[My call]** I chose it, and you can change it.
- **[Tune]** a starting number that we adjust after playtesting.

---

## 1. What we're building, and why

Dig Here is a multiplayer treasure game on an island map. A host opens a room, players pay to join, and clues narrow down where the treasure could be. Digging early scores more, and digging late means better information. The treasure only gets rolled when the timer ends, so nobody can know the answer early, including the host and us.

### Why these changes
After playing, your main concerns were:
- The game is too simple, because a player only makes one real decision.
- Waiting after you dig is boring.
- The game lists won't work once there are many games and some are spam.
- Clues should be much more visible, and stay on screen.
- New players need a short explanation.
- One map isn't enough.
- A round should gather its players first, in a waiting room.

### Goals
1. It's more fun over a whole session, not only during one round.
2. It stays easy to explain in 10 seconds.
3. Fairness stays the core idea: no secret exists anywhere.
4. It has a real economy that players run: hosts, deeds, the jackpot and seasons.
5. It works as well on a phone as on a desktop.

### Failure, even if it technically works
- A new player can't explain the game after one round.
- A host, or we, could influence who wins.
- A player's coins could get stuck.
- It feels like a blockchain app instead of a game.

### Order of work [You]
Game first, on the fake backend. Blockchain comes only after the game is final.

---

## 2. The player's journey

```
Open site → Tutorial (first visit only)
    ↓
Game Board: find a room (or Quick Play)
    ↓
Join → not enough balance? → Deposit
    ↓
Waiting Room: 2/3 players... study the map, poke the animals
    ↓
Minimum reached → countdown, or host presses Start, or room is full
    ↓
Round: clue 1 (YOLO, no information, highest bonus)
    ↓    clue 2 → clue 3 → clue 4
    ↓    place X → dig → watch your chances change → final seconds
Reveal: spots flash → chest drops → scores → jackpot? deed payout?
    ↓
Winnings land in your balance → next room, deed market or season table
```

---

## 3. The rules

### 3.1 Room stages

| Stage | What happens | Next stage |
|---|---|---|
| **Waiting** | Players join and leave. Nobody can dig. The map is visible. | Live or Refunded |
| **Live** | Clues appear and joined players dig. **No new players.** [You] | Finished or Refunded |
| **Finished** | Treasure rolled and money paid. | End |
| **Refunded** | Every joined player gets their fee back. | End |

**Starting a room**
- The host sets a minimum and maximum number of players. [You]
- Once the minimum is reached, the host can press Start. [You]
- The host can also turn on an automatic countdown: Off, 30 seconds, 1 minute or 2 minutes. [You] The countdown cancels if players leave and the room drops below the minimum. [My call]
- A full room starts after 5 seconds. [My call]
- The host can't start below the minimum. [My call]

**Coins can't get stuck** [My call]
- A waiting room has a 15-minute deadline.
- At the deadline, a room at its minimum starts by itself, and a room below it refunds everyone. So a host who disappears can't trap anyone's coins.
- Players can leave before the start and get their fee back.

**Joined but never dug** [My call]
- The fee stays in the pot, and the player can't win.
- The game warns them clearly in the last 20 seconds.
- If fewer than 2 players dug by the end, everyone who joined gets refunded.

### 3.2 Four clues [You]

A round has **four clues instead of three**.

| Clue | What it says | Bonus | Starts at |
|---|---|---|---|
| **1. YOLO** | Nothing. Dig anywhere and gamble. | **×2.5** [Tune] | 0% of the round |
| **2. Category** | "Near an animal" | ×1.5 [Tune] | 30% [Tune] |
| **3. Kind** | "Near a horse" | ×1.25 [Tune] | 60% [Tune] |
| **4. Detail** | "Near a horse, close to water" | ×1 | 85% [Tune] |

**No dimmed map.** [You] We built it and removed it after playing, because it looked bad. The screen still shows "4 spots possible, about 25% each".

**Known trade-off:** clues and landmark positions are public, so a script can work out the exact spots that still fit, and a player without one has to find them by eye. The number line helps, but doesn't remove that edge.

### 3.3 Money

- **Deposit first.** [You] Players add coins before joining.
- **The fee locks when you join.** [My call] We agreed on deposit first, and I originally said the fee comes out when you dig. It has to happen at join instead, otherwise players could fill a room for free and never dig, and the minimum would mean nothing.
- **Withdraw anytime.** [My call] Only unlocked balance can be withdrawn. This needs a wallet approval.
- **Winnings and refunds go to your balance,** so the next round is instant. [My call]

**How the pot splits** (only when a round finishes):

| Share | Amount | Goes to |
|---|---|---|
| Host cut | 0–20%, set by host [You] | Host |
| Jackpot | 3% [Tune] | Jackpot |
| Deed share | 2% [Tune] | Owner of the landmark where the treasure landed. If unowned, the jackpot. |
| Season pool | 1% [Tune] | This season's prizes |
| **Winner** | **All the rest** | Winner's balance |

Example with a 10 NEAR pot and a 5% host cut: host 0.5, jackpot 0.3, deed 0.2, season 0.1, winner **8.9**.

We take nothing from rounds. Our only income is NFT minting (section 3.7). [You]

### 3.4 Scoring

**Score = closeness × bonus × crowding**

| Number | Today | New | Why |
|---|---|---|---|
| Bonus by clue | ×2 / ×1.5 / ×1 | **×2.5 / ×1.5 / ×1.25 / ×1** [Tune] | YOLO needs a big reward, and late digs were too weak |
| Distance where closeness hits 0 | 300 | **150** [Tune] | Being accurate should matter more |
| Crowding penalty | None | **×0.85** within 6 pixels of an earlier dig [Tune] | Section 3.5 |

Earlier digs still score higher, as you wanted. The new numbers stop one early dig from beating almost everything.

**Tested with 30,000 simulated rounds per setting.** This is the win chance per dig, with players split evenly across the clues. "Even" is what each player would get if all timing were equally good.

| Players | YOLO ×2.5 | Clue 2 ×1.5 | Clue 3 ×1.25 | Clue 4 ×1 | Even |
|---|---|---|---|---|---|
| 4 | 15.8% | 19.2% | 28.5% | 36.5% | 25.0% |
| 8 | 7.2% | 10.1% | 19.2% | 13.5% | 12.5% |
| 12 | 4.7% | 8.1% | 13.1% | 7.4% | 8.3% |
| 20 | 3.8% | 6.6% | 7.8% | 1.8% | 5.0% |
| 30 | 3.6% | 4.8% | 4.2% | **0.5%** | 3.3% |

These come from the real rules (`npm run sim`). An earlier quick simulation made YOLO look better in small rooms because of a bug, and this table replaces it. For comparison, today's rules gave the last clue about 5% at 9 players (even: 11.1%).

- **Waiting is safer in small rooms, and early digs get stronger as rooms grow.** No timing wins every time in rooms up to about 12 players.
- **YOLO is a real gamble in small rooms,** which may be fine, because that's what YOLO means. **The last clue is too weak in big rooms.** We check both at the playtest gate.
- **The simulated players are simple.** They aim near a random landmark that still fits, so they behave like someone who always finds the spots that fit. Real players will still differ, so these numbers are a starting point.

Other scoring rules stay as they are: ties go to whoever dug first, and if everyone scores 0, the closest wins.

**Pixel grid** [My call]: digs and the treasure snap to the 320×224 pixel grid. It suits the art, makes "exact pixel" meaningful for the jackpot, and lets a contract do all of this in whole numbers.

### 3.5 Crowding [You liked it]

If your dig is within 6 pixels of an earlier dig, your score is multiplied by 0.85.

- Only the later digger is penalised, so nobody can harm a dig that's already placed.
- A soft circle shows around each dig. Placing your X inside one shows "Crowded: ×0.85" before you confirm.
- It adds a mind game: the obvious spot may already be taken.
- In the simulation, it cut a copier's win rate from 3.1% to 2.2% per dig at 8 players. Those copiers copied blindly, so a smart one would do better.

### 3.6 Jackpot [You liked it]

- 3% of every pot goes into one jackpot shared across all maps. [My call]
- **You win it by digging on the exact pixel of the treasure.** That's very easy to explain and exciting to see.
- In the simulation, it hit roughly once per 400 rounds at 8 players, and once per 150 rounds at 20 players. [Tune]
- A win pays 80% of the jackpot, and the other 20% starts the next one. [My call]
- **Payout cap: at most 100× that round's pot.** [My call] Without this, someone could run tiny rounds with their own wallets to try for a jackpot that others built up.
- If two players hit the exact pixel, the earlier dig wins.

### 3.7 Landmark NFTs [You]

One NFT for each kind of landmark on each map, such as the Snowy Penguin. [You] With 12 kinds on 3 maps, that's about 36. Everything is fake for now, with no contract logic decided yet. [You]

- **Mint:** every NFT starts unminted. The first owner mints it for 20 NEAR, which goes to us. [You] That's up to 720 NEAR if all 36 are minted.
- **Earning:** when the treasure lands by any landmark of that kind, the owner gets the 2% share.
- **After minting** it's a normal NFT. [You] It only sells if its owner lists it. The owner sets any price, and can change it or take it off the market. A sale pays the seller.
- **Fairness:** owners can't influence where the treasure lands, and owning an NFT gives no information.

**Kinds don't have equal chances,** because some have more landmarks on the map. Each NFT's card shows its rough chance (for example, 3 of 40 landmarks is about 8%). [My call]

### 3.8 Season with prizes [You]

- **Length:** weekly, with a shorter length for demos. [My call]
- **Prize pool:** 1% of every pot. [Tune]
- **Points:** only rounds with at least 3 digs count. Points scale with the pot: 1st place earns 100 points per NEAR in the pot, 2nd earns 30 and 3rd earns 10. [Tune] Scaling means tiny rounds earn almost nothing.
- **Prizes:** the top 3 get 60%, 30% and 10% of the pool. [Tune]
- **Ending:** anyone can trigger the season's end once its time is up.
- **Bots:** if we add them, they can't win season prizes. [My call]

**Known weakness:** one person with many wallets can farm points by playing themselves. Each fake round costs them about 6% of its pot, but the rules alone can't fully prevent this without checking identity, and a big enough prize pool could make it profitable. We'll accept this and state it openly in the README. [My call]

### 3.9 Hosts

A host sets: name, entry fee, timer, host cut, minimum and maximum players, countdown, and **map**. [You] A "Surprise me" option picks the map at random. [My call]

The host can't choose the location or a hint, and the randomness is on the game's side. [You] The host isn't a player automatically. They can join their own room like anyone else, because they know nothing other players don't.

**Limits** [My call, Tune]:
- Minimum players: at least 2.
- Maximum players: at most 30. A fixed limit also keeps gas costs predictable on chain.

### 3.10 Stopping spam

Anyone can host, and spam shouldn't bury good games. [You] No one can pay to appear higher in the list. [My call]

- **Hosting bond:** 0.1 NEAR from the host's balance. [Tune] It comes back when the room ends. If the room expires below its minimum, 10% goes to the jackpot.
- **At most 3 open rooms per host.**
- **Host record on every card:** for example, "12 finished, 1 expired".
- **Default sort pushes spam down** (section 4.1).

---

## 4. Screens

### 4.1 Game Board (replaces the long list on the right) [You]

The island stays in the background, and the list becomes a full-width board with pages instead of a long scroll.

```
 DIG HERE                                      Balance 12.5 NEAR  [+]
 ┌────────────────────────────────────────────────────────────────┐
 │ [ Quick Play ]  [ Host a game ]         JACKPOT  41.2 NEAR     │
 │                                                                │
 │ Waiting (24) | Live (11) | Finished                            │
 │ Sort: Best v   Map: All v   Fee: Any v   [x] Hide full         │
 │                                                                │
 │ ┌────────────┐ ┌────────────┐ ┌────────────┐                   │
 │ │ Lunch money│ │ Snow rush  │ │ Big digs   │                   │
 │ │ Tropical   │ │ Snowy      │ │ Desert     │                   │
 │ │ 1 NEAR     │ │ 0.5 NEAR   │ │ 5 NEAR     │                   │
 │ │ 7/10  0:42 │ │ 2/5 waiting│ │ 9/20  0:12 │                   │
 │ │ Host 5%    │ │ Host 10%   │ │ Host 2%    │                   │
 │ │ 12 finished│ │ 3 finished │ │ 40 finished│                   │
 │ └────────────┘ └────────────┘ └────────────┘                   │
 │              < 1  2  3  4 >                                    │
 └────────────────────────────────────────────────────────────────┘
```

- **Tabs:** Waiting, Live (watch only) and Finished.
- **Sort:** Best (default), Starting soon, Biggest pot, Lowest fee, Lowest host cut, Most players.
- **Best** combines players joined and the host's record, so empty rooms from new or unreliable hosts sink. They're still reachable by other sorts. [My call, Tune]
- **Filters:** map, entry fee range, hide full rooms.
- **Pages:** 6 cards per page on desktop, 4 on a phone in one column, with no long scrolling.
- **Quick Play:** one tap joins the best waiting room you can afford. Many players won't need the list at all. [My call]

### 4.2 Host a game

The current form, plus a map picker with previews, minimum and maximum players, countdown, and the bond clearly shown. The example payout includes the full pot split.

### 4.3 Waiting Room (new) [You]

```
 Lunch money        Tropical island        Host: mabel.near
 
 Players  ██████░░░░  3 / 10   (minimum 3 reached)
 Starting in 0:24   [Host: Start now]
 
 Entry 1 NEAR  |  Round 3:00  |  Host keeps 5%
 You: joined   [Leave and get your coins back]
 
 salty.near, goose.near, you
```

The map stays visible so players can study it, and the island toys work here too (section 4.8). A sound plays when someone joins, and the music builds as the room fills.

### 4.4 Clue trail (replaces the old clue area) [You]

```
 ●━━━━━━━●━━━━━━━●━━━╸╌╌╌╌╌╌╌╌○
 ×2.5    ×1.5    ×1.25        ×1

 1  YOLO: no clue
 2  Near an animal
 3  Near a horse              ← newest, biggest, with the parrot's joke
 4  [locked]  Unlocks in 0:42

 4 spots possible, about 25% each
```

- **Clues stay on screen.** Earlier clues stay until the end, so all four show by the last clue. They aren't crossed out, because they're still true.
- **The bar** shows the round's time and where the bonus drops.
- **A new clue is a big moment:** its stop lights up and the clue pops in, along with the existing banner and music change. [You]
- **The YOLO clue** gets its own look, with the parrot saying something like "No clue yet. YOLO!"
- **On a phone:** one line per clue in plain wording, and the parrot's joke for the newest clue only. Four lines must fit around the map on small phones, so we need to test this at 360×640 early.

**The number line** is how players judge the odds. It's exact once the final clue is out, because the final pick is equal across whatever remains. Before that it's approximate, so it says "about".

### 4.5 After you dig (fixes the boredom) [You asked, ideas are mine]

Built in this order:

**1. Live standing**
```
 You'd win on 2 of 4 spots right now
```
- A new clue rules out spots: "Your horse is gone!"
- A new dig can take a spot from you: "mabel.near just stole a spot from you!"
- The browser works it out from public data, assuming the treasure lands on each landmark. It's labelled "right now", because it can change.

**2. Dig tray:** a small bar showing your active rooms, so you can join several at once. It alerts you when a clue lands in another room.

**3. Island toys:** section 4.8.

**4. Bigger final 10 seconds:** faster music, slight screen shake, and remaining possible spots flashing for tension.

### 4.6 Reveal and results

The existing reveal stays. The score table now shows how each score was made (for example `90 × 1.5 × 0.85 = 114.7`). It also shows the deed payout line, and a big full-screen jackpot moment when someone hits the exact pixel.

### 4.7 Tutorial pop-up (new) [You]

Shows on first visit, with **Skip** and **Don't show again**. A "How to play" button can reopen it. Four short cards:

1. **Read the clues.** The first clue is nothing: YOLO, for the biggest bonus. Three more clues narrow it down.
2. **Mark your spot.** Place your X on land. You get one dig per round.
3. **Dig early or wait.** Score = closeness × bonus, and the bonus drops with each clue. Example: 90 closeness at ×1.5 scores 135, which beats a perfect dig at ×1 (100). Don't dig right next to someone else.
4. **The treasure appears.** A small animation: four trees light up at 25% each and land on one. Highest score wins the pot, and the exact pixel wins the jackpot.

Deeds and seasons aren't in the tutorial. They're explained on their own pages, so the first explanation stays short. [My call]

### 4.8 Island toys [My call]

Tapping a landmark gives a silly reaction: the duck quacks and runs, the windmill spins faster, and the scarecrow does something odd if you keep tapping. They're free and never affect who wins.

### 4.9 Wallet dialog (new) [You]

Shows **game balance** and **wallet** separately, with Deposit (quick amounts plus custom) and Withdraw. If your balance is too low when you join, it opens with the missing amount filled in.

### 4.10 NFT market (new) [You]

The map is only the background. You choose from cards, not from the map. Tabs: For sale, Mint, All NFTs, My NFTs, with a map filter. Each card shows the art, map, owner, chance, times landed, and earnings, with Mint, Buy, List for sale, Change price, or Take off market.

### 4.11 Season page (new)

Top players, your rank, prize pool, and time left.

---

## 5. The three maps [You, themes are my suggestion]

| Map | Landmarks | Feel |
|---|---|---|
| **Tropical island** (today's) | Horses, palm trees, huts, boats | Sunny and silly |
| **Snowy island** | Penguins, pine trees, igloos, snowmen | Cosy and cold |
| **Desert oasis** | Camels, cacti, tents, wells | Hot and dusty |

**Same on every map:** size, 40 landmarks from 12 kinds, the 4 clue categories, and the rules.

**Better land** [You asked for a better map]: hills with cliffs, paths, streams, bridges, fields and ground detail, with fewer landmarks so the map isn't crowded.

**Different on every map:** coast shape, landmarks, colours, clue jokes, and a music variation.

**Random positions** [You]: the land and scenery stay the same on each map, but every game rolls where the landmarks stand. Landmarks of the same kind are spread far apart, so a clue never points at one corner of the map.

**Art needed:** about 18 new sprites, since a few like wells and campfires can be reused. This is one of the biggest pieces of work.

---

## 6. Code changes

### Rules (`src/lib/game/`)
| File | Change |
|---|---|
| `types.ts` | Room stages, map ID, min and max players, countdown, joined players, crowding, deed, jackpot and season types. Clues stored as IDs, with wording in the UI. |
| `rules.ts` | All the new numbers from section 3. |
| `engine.ts` | Join, leave, start, deadline, dig with crowding, whole-number scoring, pot split, jackpot, deed share, season points, and `standing()` for live standing. |
| `clues.ts` | Works per map. Four clues, where the first rolls nothing. Wording moves to per-map files. |
| `map.ts` | `MAPS[mapId]`. `MAP` is used directly in 7 files today, and all of them change. |
| `sim.ts` (new) | Balance simulation in the repo, so re-testing a number takes one command. |

### Fake backend (`src/lib/backend/`)
- `types.ts`: the new interface, including `deposit`, `withdraw`, `join`, `leave`, `start`, `dig`, deed and season calls.
- `dummy.svelte.ts`: wallet and game balances, rooms, bond, jackpot, deeds and seasons. Bots fill rooms for playtesting.
- A random 0.3–1.5 second fake transaction delay, so the UI is ready for real chain timing.
- New playtest controls: fill room, start now, force jackpot, end season.

### Screens (`src/components/`)
| File | Change |
|---|---|
| `Lobby.svelte` | Replaced by `GameBoard`, `GameCard` and `BoardFilters` |
| `NewGame.svelte` | New host options |
| `Room.svelte` | 642 lines today, so split into `WaitingRoom`, `ClueTrail`, `Standing` and a smaller `Room` |
| `Results.svelte` | Score breakdown, deed line, jackpot moment |
| New | `Tutorial`, `WalletDialog`, `DigTray`, `DeedMarket`, `SeasonPage`, `JackpotBadge` |
| `App.svelte`, `Header.svelte`, `app.css` | New routes, balance button, full-width board layout |

### Island (`src/lib/world/`)
- `terrain.ts`: bakes and caches each map, with its own colours.
- `sprites.ts`: about 18 new sprites and per-map palettes.
- `world.ts`: `enterGame` takes a map, plus toy reactions, crowding circles, and final-seconds effects.

### Audio (`src/lib/audio/`)
- A fourth music intensity level for the extra clue, per-map music variations, plus new sounds for joining, room filling, a spot being stolen, and the jackpot.
- I can't hear audio, so you'd need to judge how these sound.

---

## 7. On-chain design (built last, but the rules are shaped for it now)

This section is here so that nothing in the game turns out to be impossible on chain. **Checked in the NEAR docs:** function-call keys, the wallet connector and key plugin, randomness limits, and storage cost. Anything else gets checked before we build it.

### The setup
- **Contract:** Rust on testnet. [My call] Testnet entries are eligible, so no real money is involved. Rust is already installed, but `cargo-near` and the `near` CLI aren't.
- **Login:** NEAR Connect (`@hot-labs/near-connect`) with `function-call-key-plugin`. After one wallet approval at login, the game signs allowed calls with no popups, which is the track's bonus.
- **Why deposit first works:** NEAR's function-call keys can't attach coins. So `join` and `dig` use the deposited balance and need no popup, while `deposit` and `withdraw` go through the wallet.

### Correction to what I told you earlier
I said a stolen limited key "could only spend balance on digs". That's true, but it undersold the risk: **a thief could still lose your balance by joining rooms they host, or win it back from you in a round.** They can't withdraw it directly. To limit this:
- Withdrawals and deed purchases always need a wallet approval.
- The UI encourages keeping only a small balance in the game.
- A per-player limit on the highest fee the limited key can pay, if time allows.

### Methods
| Signed with the limited key (no popup) | Needs wallet approval | Anyone can call |
|---|---|---|
| `create_game`, `join`, `leave`, `start`, `dig` | `deposit`, `withdraw`, `buy_deed`, `list_deed` | `advance`, `close_season` |

`advance` reveals due clues, starts expired rooms, and finishes rounds.

### Things a contract can't do, and our answers
| Problem | Answer |
|---|---|
| **A contract can't act on its own**, so clues and endings need a trigger | A small always-on service calls `advance` on time. `dig` also triggers it. If the service dies, a "Reveal next clue" button lets any player do it. |
| **Randomness** | Roll clues and the treasure from `env::random_seed()`, hashed with the room ID and step. The treasure rolls only after digging closes. |
| **Randomness limits, from NEAR's docs** | A block's validator can predict the seed and could refuse to include a transaction. Others can't predict it. We'd disclose this. It's acceptable on testnet, and it would need a stronger design before real money. |
| **Decimals** | Whole-number maths only, using pixels and basis points. A contract can't use the current `Math.cos` and decimal scoring. |
| **Land check** | Export each map to a land grid and landmark table, which the contract includes as data. |
| **Last-second digs** | `dig` includes the clue the player saw. If the bonus changed before it landed, the dig is rejected instead of quietly scoring less, and the player can retry. The fee stays safe. |
| **Storage cost** (1 NEAR per 100 KB) | Bond and registration cover it. Fixed player limits, name length limits, and old rooms deleted. |
| **Game list without a server** | View calls with paging, then sort and filter in the browser. |
| **Front-running** | Digs are public by design, and there's no answer to steal. Someone could still take a spot first to crowd you, which is low stakes. We test copied, reordered and delayed transactions, as NEAR's docs advise. |
| **Trust** | No admin method can change the rules or move player funds. Season length and shares are fixed at launch. |

### Keeping two rule copies the same
The rules will exist in TypeScript and Rust. We'd generate shared test files with fixed random seeds and expected results, and both versions must produce the same answers.

### Not planned unless time remains
Social or email login through NEAR Auth. Its docs show a React SDK and a testnet setup, but we use Svelte, so this needs checking first.

---

## 8. Testing

| Level | What |
|---|---|
| **Rule tests** | Every rule in section 3. Money is never lost or created in any split, refund or payout. Updates the existing 57 tests. |
| **Map tests** | For all 3 maps: landmark spacing, on land, enough of each kind, and every clue path ends with a valid spot. The treasure always lands near a landmark that fits the clues. |
| **Balance simulation** | Re-run whenever a number changes. |
| **Browser tests** | Full journey on 5 phone and desktop sizes with touch, as we did before: tutorial, deposit, join, wait, dig, reveal, withdraw. |
| **You playing** | Fun and sound can only be judged by you. Real phones too. I'd ask before using your Galaxy A73. |
| **Contract tests** | Rust unit tests, shared test files, and NEAR sandbox tests of the full round, refunds, withdraw failures, and bad-order transactions. |
| **Testnet** | A full real round with real signed transactions. |

---

## 9. Schedule

These dates are estimates. Your playtest feedback will decide how much changes.

| Dates | Stage | Done when |
|---|---|---|
| **Nov 5** | **0. Set-up** | Local git repo created, so we can undo anything. Needs your OK. |
| **Nov 5–6** | **1. Rules and fake backend** | All rules pass tests. Simulation is in the repo. |
| **Nov 6–8** | **2. New screens** | The full journey in section 2 works on phone and desktop. |
| **Nov 7–9** | **3. Two new maps** | Host can pick any of 3 maps, each with its own art and clues. |
| **Nov 9** | **Playtest gate: you play it** | You approve the fun and we freeze the rules. **This is also when you decide on bots.** |
| **Nov 9–11** | **4. Contract on testnet** | A full round works in sandbox, then on testnet. |
| **Nov 11–12** | **5. Real backend** | Real wallet, deposit, and silent digs, plus the always-on service. |
| **Nov 13** | **6. Final deploy and hackathon items** | Live on dig.joundy.dev. README, license and repo prepared for you. |
| **Nov 14** | **Buffer** | Nothing planned. You post and submit. |

### The most important date is Nov 9
You chose game first, which is the right order. But if the rules keep changing after Nov 9, the contract won't be ready, and without a contract **there's nothing NEAR for judges to review**. Ideas after Nov 9 go on a "later" list unless they're small.

### What I'd cut first if we run late
1. Dig tray (players can only follow one room at a time)
2. Island toys beyond a handful
3. Third map (ship 2)
4. NFT resale (players can mint NFTs but not list them)
5. Automatic season ending (a simpler points table, with no on-chain prizes)

**Never cut:** the contract, deposit, waiting room, clue trail, tutorial, Game Board, crowding, and the jackpot.

---

## 10. Main risks

| Risk | Effect | What we do |
|---|---|---|
| **Too much for 10 days.** This is a lot of work, deeds and seasons especially | Contract rushed or missing | The Nov 9 freeze and the cut list |
| **Rules get complicated** | Fails the 10-second test | Tutorial covers only clues, dig, score, and jackpot. Deeds and seasons stay optional. |
| **A lone judge can't get past the waiting room** | Judge never sees the best part | **Must be solved at the Nov 9 gate** (section 11) |
| **Scripts can see the exact possible spots** | Script users find spots faster than people searching by eye | The number line helps. We accepted this when removing the dimmed map. |
| **Multi-wallet farming** | Unfair seasons and crowding abuse | Rewards scale with the pot, the jackpot has a cap, and we disclose the weakness. |
| **Testing shows the numbers are wrong** | Rounds feel unfair | All numbers live in one file and can be re-simulated. |
| **Phones run out of space** | Clue trail crowds the map | Test at 360×640 early. |
| **Real players take time to confirm** | Dig timing feels bad | Fake delay rehearses this from stage 1. |
| **Real-money gambling questions** | Legal risk | Testnet only. Get proper advice before any mainnet launch. |

---

## 11. Still open

| Item | When | My suggestion |
|---|---|---|
| **Bots or no bots** [You: decide later] | **By Nov 9** | Simple labelled bots. Without them, a lone judge can't finish a round. They could share the always-on service. |
| Map themes | When reading this plan | Tropical, snowy, desert |
| Local git repo | Before we start | Yes. Local only, with nothing pushed or made public. |
| Numbers marked [Tune] | Playtest gate | Starting values above |

---

## 12. Not doing

**Considered and left out:** bribe the parrot, second dig, side bets, shovel choice, round modifiers, top-3 payouts, catch-a-crab mini-game, joining after the start [You].

**Not needed for the rules:** NEAR Intents, NEP-245 tokens, mainnet. Deeds could become NEP-171 NFTs later, but that's not planned.

---

## 13. Parked until Nov 13

Repo goes public, README "do X, see Y" steps, LICENSE, list of libraries and AI code, X post, mainnet payout account, submission details, and whether `config/deploy.yml` (with your internal IP) gets published. Only you post, and only with your OK do I push or submit. Re-read the live `HACKATHON.md` first, since rules can change.
