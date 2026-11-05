# Why the closeness range went from 48 to 96

A dig past the range scores 0, and 40 real rounds showed 16 where every dig did, so the closest dig won on the tie-break and the score meant nothing. This re-runs that question on today's maps. Measured 2026-11-05, on the rules at that commit.

**Tooling.** `closenessStudy` in `src/lib/game/sim.ts` plays each round once, then scores the very same digs under every range, so rows differ only by the range. `npm run sim` prints it. Players aim near a landmark that still fits the clues and split evenly across the four clues, like `simulate`. 3,000 rounds per row, on all three maps. Seeds 2 and 3 agreed with these to within about 2 points. Real rounds were re-scored from their stored digs and treasures.

## Real rounds

92 real finished rounds: every `finished` event in the local index, plus the 30 in `v1`'s ring on 2026-11-05. They average 2.85 digs each.

| Range | Every dig scored 0 | Winner's closeness (of 1000) | Rounds with a different winner |
|---|---|---|---|
| **48, before** | **41 of 92, 44.6%** | 390 | |
| 64 | 34, 37.0% | 442 | 0 |
| 80 | 33, 35.9% | 479 | 1 |
| **96, after** | **23 of 92, 25.0%** | 515 | 1 |
| 112 | 14, 15.2% | 550 | 2 |
| 128 | 10, 10.9% | 577 | 5 |

## Simulated, share of rounds where every dig scored 0

| Players | 48 | 80 | **96** | 112 | 128 |
|---|---|---|---|---|---|
| 2 | 73.6% | 55.1% | **43.9%** | 33.5% | 24.6% |
| 3 | 51.4% | 36.9% | **27.7%** | 18.9% | 12.2% |
| 4 | 26.4% | 18.7% | **13.4%** | 8.1% | 4.8% |
| 6 | 18.0% | 9.7% | **5.6%** | 2.8% | 1.3% |
| 8 | 7.5% | 3.6% | **1.9%** | 1.0% | 0.4% |
| 12 | 2.0% | 0.7% | **0.2%** | 0.2% | 0% |

## What a bigger range costs

Closeness falls more slowly, so the bonus counts for more against accuracy, and early digs gain. Win chance per dig, by the clue it was made under:

| Players, even chance | Range | Clue 1 | Clue 2 | Clue 3 | Clue 4 | Closest dig wins |
|---|---|---|---|---|---|---|
| 4, 25% | 48 | 15.4% | 19.4% | 29.7% | 35.5% | 88.4% |
| | **96** | **22.7%** | **20.2%** | **27.0%** | **30.1%** | **79.4%** |
| | 128 | 29.1% | 20.6% | 25.3% | 25.0% | 71.6% |
| 8, 12.5% | 48 | 7.0% | 10.5% | 18.4% | 14.1% | 68.5% |
| | **96** | **14.4%** | **10.5%** | **15.6%** | **9.5%** | **53.8%** |
| | 128 | 19.6% | 10.2% | 13.0% | 7.2% | 45.1% |
| 12, 8.3% | 48 | 5.2% | 8.1% | 13.6% | 6.5% | 53.7% |
| | **96** | **11.8%** | **7.7%** | **10.2%** | **3.6%** | **37.8%** |
| | 128 | 16.3% | 6.9% | 7.6% | 2.5% | 29.7% |
| 20, 5% | 48 | 4.1% | 6.3% | 7.5% | 2.1% | 35.7% |
| | **96** | **9.7%** | **5.0%** | **4.4%** | **0.8%** | **20.7%** |

## The choice

**96**, twice the old range, about a third of the map's width.

- All-zero real rounds fall from 44.6% to 25.0%, and from 26.4% to 13.4% at 4 players. 80, the first idea, only reached 35.9% of real rounds.
- Timing gets much fairer at 4 and 8 players, where most real rooms are. At 48, a first-clue dig was badly behind at every size. 112 is a little fairer still at 4 players, and worse from 8 up.
- It stays inside the balance test in `sim.test.ts`, every clue between 0.25 and 2.2 times even, up to 12 players.
- It stops short of 112 and 128, where in a room of 8 the closest dig no longer wins half the time, and a last-clue dig falls further behind.

**The cost:** in big rooms the last clue is a weak choice, at 0.43 times even with 12 players and 0.16 with 20. In a room of 20 the first clue's 2.5× bonus is worth more than patience. Rooms that big haven't happened yet. The host form now stops at 12 players for this reason, with the contract's limit left at 30: see `docs/research/user-audit.md`.

Small rooms still often score 0, because 2 or 3 digs can simply all be far away: 43.9% at 2 players. The closest dig still wins those, as it always did.

## Old rounds

Verify keeps working for rounds played under 48: see "The closeness range" in `contract/README.md`.
