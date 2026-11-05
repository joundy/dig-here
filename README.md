# Dig Here (working title)

A multiplayer treasure-map game for the NEAR Hackathon, Games track. **Wallets, money and other players are all fake for now, and nothing touches NEAR yet.** The contract comes after the rules are final. The full design is in `docs/plans/2026-11-05-dig-here-final-plan.md`.

## The problem

Treasure and guessing games usually need someone to hide the answer, and that person can cheat. In Dig Here, no answer exists until the timer ends, so nobody can know it early: not the host, and not us.

## The game

Each game rolls new positions for the landmarks on its map, with landmarks of the same kind spread far apart. A host opens a room and sets the entry fee, timer, map, their share of the pot (20% at most), and the minimum and maximum players. Players deposit coins, then join. The fee locks when you join, and you get it back if you leave before the start. The round starts when the minimum is reached, by the host or a countdown, and nobody can join after that.

**Four clues**, each worth a lower bonus. The screen always shows how many spots are still possible.

| Clue | Says | Bonus |
|---|---|---|
| 1. YOLO | Nothing | ×2.5 |
| 2. Category | "Near an animal" | ×1.5 |
| 3. Kind | "Near a horse" | ×1.25 |
| 4. Detail | "Near a horse, close to water" | ×1 |

**You get one dig. Score = closeness × bonus × crowding.** Digging within 6 pixels of an earlier dig multiplies your score by 0.85. When the timer ends, the game picks the spot, and the best score wins the pot. Ties go to whoever dug first. With fewer than 2 digs, everyone is refunded.

**The pot:** host cut (0–20%), jackpot 3%, NFT owner 2%, season pool 1%, and the winner gets the rest.

**The economy around the rounds:**
- **Jackpot:** dig on the treasure's exact pixel to win it. A win pays at most 100× that round's pot.
- **NFTs:** one for each kind of landmark on each map, about 36 in all. The owner earns 2% of the pot when the treasure lands by that kind. Owners can list theirs for sale at any price in a mini marketplace. NFTs are fake for now, like the money.
- **Season:** weekly points, scaled by the pot, with prizes for the top 3.
- **Hosts:** each room locks a small bond, and hosts have a public record, so spam rooms sink down the board.

All the balance numbers are in `src/lib/game/rules.ts`. Run `npm run sim` to see how each dig timing does.

**Known weaknesses:** clues and landmarks are public, so a script can work out the exact spots that still fit. One person with many wallets can play themselves to farm season points, and a player can use several wallets to cover more of the map. Each extra dig costs a fee and the rounds cost part of the pot, but rules alone can't prevent this.

## Try it

```sh
npm install
npm run dev
```

1. Open the URL it prints. See the how-to-play pop-up. Tap through it, or tick "Don't show again".
2. Press **Quick Play**. See the wallet ask for more coins, because your game balance starts at 0. Deposit 10 NEAR. See your balance go up.
3. Press **Quick Play** again. See a waiting room with the player bar filling up.
4. Open **Playtest controls** and press **Start now**. See the round start on clue 1, YOLO, at ×2.5.
5. Tap the map, then press **Dig here**. See your balance stay the same, since the fee was paid on joining, and "You'd win on N of N spots right now".
6. In Playtest controls, press **Skip to next clue**. See a banner, a sharper clue, a lower bonus, and your spots change.
7. Press **End game**. See the possible spots flash, the chest drop, and the scores with the pot split.
8. Press **Force jackpot** in another round to see a jackpot win.
9. Go to **NFTs**. Buy one from the For sale tab. Then, under My NFTs, list it at your own price.
10. Go to **Season**. See the prize pool and your rank.
11. Tap the balance button. Withdraw your coins, or switch account to play as someone else in the same room.

On a phone, run `npm run dev -- --host` and open the Network URL it prints, on the same Wi-Fi. Tap the map to place your X, drag the X to fine-tune it, drag the map to pan, and pinch or use + and − to zoom.

Run the tests with `npm test`.

## Code map

- `src/lib/game/`: the rules in whole-number maths, with no UI or storage, so a contract can implement the same steps.
  - `engine.ts`: rooms, clues, digs, scoring. `economy.ts`: where the coins go. `map.ts`, `mapDefs.ts`: the three maps, and `rollLayout` for each game's landmark positions. `copy.ts`: clue wording.
- `src/lib/board.ts`: how the Game Board ranks rooms.
- `src/lib/backend/types.ts`: everything the UI needs from the chain.
- `src/lib/backend/dummy.svelte.ts`: the fake chain, wallets and bots. Replace this to go live.
- `src/lib/world/`: the pixel-art islands. Sprites are drawn as text in `sprites.ts`.
- `src/lib/audio/`: the original chiptune and sound effects, synthesized in the browser with no audio files.
- `src/components/`: the screens.

## Built with

Svelte, Vite, TypeScript, Vitest, and the Jersey 10 and Jersey 20 fonts (OFL). The code was written with Claude Code.
