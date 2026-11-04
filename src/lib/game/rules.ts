// Every tunable number in the game lives here, so balance changes are one-line edits.
// Everything is a whole number, so a contract can reproduce the rules exactly:
// positions are pixels on the 320×224 map, money is milliNEAR, percentages are basis points.
export const RULES = {
  /** Host share cap (2000 = 20%). */
  maxHostCutBps: 2000,
  jackpotBps: 300,
  deedBps: 200,
  seasonBps: 100,

  minPlayersFloor: 2,
  maxPlayersCap: 30,
  /** Fewer digs than this at the end refunds everyone who joined. */
  minDigs: 2,

  /** `startsAt` is the percentage of the round gone when that clue appears. The first says nothing. */
  clueSchedule: [
    { startsAt: 0, bonusBps: 25000 },
    { startsAt: 30, bonusBps: 15000 },
    { startsAt: 60, bonusBps: 12500 },
    { startsAt: 85, bonusBps: 10000 },
  ],

  /** Pixels at which closeness points reach zero. */
  closenessRange: 48,
  /** How far from its landmark the treasure can land, in pixels. */
  treasureScatter: 13,
  /** A dig within this many pixels of an earlier dig is crowded. */
  crowdRadius: 6,
  crowdBps: 8500,

  timerChoices: [60, 180, 300, 600],
  countdownChoices: [0, 30, 60, 120],
  /** A full room starts this soon, even with no countdown set. */
  fullRoomStartSec: 5,
  /** At this age a waiting room starts if it can, and refunds if it can't. */
  waitingDeadlineSec: 900,
  /** Warn a player who joined but hasn't dug when this little of the round is left. */
  noDigWarningSec: 20,

  hostBond: 100,
  expiredBondPenaltyBps: 1000,
  maxOpenRoomsPerHost: 3,

  deedFirstPrice: 3000,
  /** Share of the jackpot a winner takes. The rest starts the next one. */
  jackpotPayBps: 8000,
  /** A jackpot win pays at most this many times the round's pot. */
  jackpotCapPots: 100,

  /** Points per NEAR in the pot, for 1st, 2nd and 3rd place. */
  seasonPointsPerNear: [100, 30, 10],
  seasonMinDigs: 3,
  seasonPrizeBps: [6000, 3000, 1000],
  seasonLengthSec: 7 * 24 * 60 * 60,
} as const;
