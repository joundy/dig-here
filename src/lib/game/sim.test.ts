import { describe, expect, it } from 'vitest';
import { simulate } from './sim';

describe('balance', () => {
  it('prints win rates for each dig timing', () => {
    for (const players of [4, 8, 12, 20, 30]) {
      const r = simulate(players, 3000);
      console.log(`${String(players).padStart(2)} players  by clue ${r.winPctByClue.map((n) => `${n}%`.padStart(6)).join('')}   even ${r.evenPct}%   jackpot ${r.jackpotPerRoundPct}% of rounds`);
    }
  });

  it('keeps every timing a real choice in rooms up to 12 players', () => {
    for (const players of [4, 8, 12]) {
      const { winPctByClue, evenPct } = simulate(players, 2000);
      for (const pct of winPctByClue) expect(pct).toBeGreaterThan(evenPct * 0.25);
      expect(Math.max(...winPctByClue)).toBeLessThan(evenPct * 2.2);
    }
  });
});
