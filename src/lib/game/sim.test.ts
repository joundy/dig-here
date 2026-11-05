import { describe, expect, it } from 'vitest';
import { closenessStudy, simulate } from './sim';

describe('balance', () => {
  it('prints win rates for each dig timing', () => {
    for (const players of [4, 8, 12, 20, 30]) {
      const r = simulate(players, 3000);
      console.log(`${String(players).padStart(2)} players  by clue ${r.winPctByClue.map((n) => `${n}%`.padStart(6)).join('')}   even ${r.evenPct}%   jackpot ${r.jackpotPerRoundPct}% of rounds`);
    }
  });

  it('prints what each closeness range does to the same digs', () => {
    for (const players of [2, 3, 4, 6, 8, 12, 20]) {
      console.log(`${players} players`);
      for (const r of closenessStudy(players, 3000, [48, 56, 64, 72, 80, 96, 112, 128])) {
        console.log(`  range ${String(r.range).padStart(3)}  all zero ${String(r.allZeroPct).padStart(5)}%  by clue ${r.winPctByClue.map((n) => `${n}%`.padStart(6)).join('')}  closest wins ${r.closestWinsPct}%  winner closeness ${r.meanWinnerCloseness}`);
      }
    }
  }, 300_000);

  it('keeps every timing a real choice in rooms up to 12 players', () => {
    for (const players of [4, 8, 12]) {
      const { winPctByClue, evenPct } = simulate(players, 2000);
      for (const pct of winPctByClue) expect(pct).toBeGreaterThan(evenPct * 0.25);
      expect(Math.max(...winPctByClue)).toBeLessThan(evenPct * 2.2);
    }
  });
});
