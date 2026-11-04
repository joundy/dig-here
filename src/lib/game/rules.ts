// Every tunable number in the game lives here, so balance changes are one-line edits.
export const RULES = {
  /** Host share cap, in basis points (2000 = 20%). */
  maxHostCutBps: 2000,
  /** Below this many players the round refunds everyone. */
  minPlayers: 2,
  /** `startsAt` is the fraction of the round already gone when that clue appears. */
  clueSchedule: [
    { startsAt: 0, bonus: 2 },
    { startsAt: 0.5, bonus: 1.5 },
    { startsAt: 0.9, bonus: 1 },
  ],
  /** Map units at which closeness points reach zero. The map is 1000 wide. */
  closenessRange: 300,
  /** How far from its landmark the treasure can land, in map units. */
  treasureScatter: 40,
  timerChoices: [60, 180, 300, 600],
} as const;
