# Dig Here (working title)

A multiplayer map guessing game for the NEAR Hackathon, Games track. This is the first prototype:
**wallets, money and other players are all fake**, and nothing touches NEAR yet.

## The game

A host creates a game and sets the entry fee, the timer and their share of the pot (20% at most).
Players pay the fee and dig one spot on the island. While the timer runs, three clues narrow down
what the treasure is near. When it ends, the game picks the exact spot, and the best score wins the
pot minus the host's share.

- **Score** = closeness (0 to 100) × bonus. The bonus depends on which clue was showing when you dug:
  ×2 on the first, ×1.5 on the second, ×1 on the third.
- **Fairness:** the treasure location doesn't exist until the timer ends. Each clue is rolled from
  what's still possible, so the host has no secret to abuse.
- Ties go to whoever dug first. Fewer than 2 players means everyone is refunded.

All the balance numbers are in `src/lib/game/rules.ts`.

## Try it

```sh
npm install
npm run dev
```

1. Open the URL it prints and click anywhere. See the island and open games run by bots, and hear the
   music start (browsers only allow sound after the first click).
2. Click a game, then click the map. See a pink X and a button saying "Dig here for ...".
3. Click the button. See your balance drop and your dig listed with its bonus.
4. Open "Playtest controls" and click "Skip to next clue". See a "New clue!" banner, a sharper clue and
   a lower bonus, and hear the music step up.
5. Click "End game now". See the possible spots flash in turn, the chest drop, and the scoreboard fill in.
6. Switch account in the top right to play as someone else in the same game.

On a phone, run `npm run dev -- --host` and open the Network URL it prints, on the same Wi-Fi. Tap the
map to place your X, drag the X to fine-tune it, drag the map to pan, and pinch or use + and − to zoom.

Run the rules tests with `npm test`.

## Code map

- `src/lib/game/`: the rules, with no UI or storage. A NEAR contract will implement the same steps.
- `src/lib/backend/types.ts`: everything the UI needs from the chain.
- `src/lib/backend/dummy.svelte.ts`: the fake chain, wallets and bots. Replace this to go live.
- `src/lib/world/`: the pixel-art island. Sprites are drawn as text in `sprites.ts`.
- `src/lib/audio/`: the original chiptune (`tracks.ts`) and sound effects, synthesized in the browser
  with no audio files.
- `src/components/`: the screens.
