export type Point = { x: number; y: number };

export type MapId = 'tropical' | 'snowy' | 'desert';

export type Category = 'animal' | 'tree' | 'building' | 'thing';

export type Kind =
  // Shared between maps.
  | 'horse' | 'palm' | 'pine' | 'windmill' | 'well' | 'lighthouse' | 'campfire' | 'boat'
  // Tropical island.
  | 'cow' | 'sheep' | 'duck' | 'apple' | 'hut' | 'scarecrow'
  // Snowy island.
  | 'penguin' | 'seal' | 'husky' | 'snowpine' | 'birch' | 'igloo' | 'cabin' | 'snowman' | 'sled'
  // Desert oasis.
  | 'camel' | 'lizard' | 'vulture' | 'cactus' | 'deadtree' | 'tent' | 'pyramid' | 'skull' | 'cart';

export type Tag = 'water' | 'inland' | 'north' | 'south' | 'east' | 'west';

export type Landmark = Point & {
  id: number;
  kind: Kind;
  category: Category;
  tags: Tag[];
  flip: boolean;
};

/** Only IDs live in the rules. The wording is in `copy.ts`, the way it would be with a contract. */
export type Clue =
  | { level: 'yolo' }
  | { level: 'category'; category: Category }
  | { level: 'kind'; kind: Kind }
  | { level: 'detail'; kind: Kind; tag: Tag };

export type Dig = Point & {
  account: string;
  clueIndex: number;
  bonusBps: number;
  /** Dug within the crowding radius of an earlier dig. */
  crowded: boolean;
  /** Seconds into the round. */
  dugAt: number;
};

export type RankedDig = Dig & {
  /** Distance to the treasure in thousandths of a pixel. */
  distance: number;
  /** Tenths of a point, 0 to 1000. */
  closeness: number;
  /** Tenths of a point. */
  score: number;
};

export type PotSplit = { hostCut: number; jackpot: number; deed: number; season: number; prize: number };

export type RefundReason = 'too-few-digs' | 'expired';

export type Result = {
  /** Null when the round was refunded, because no treasure was ever rolled. */
  treasure: (Point & { landmarkId: number }) | null;
  ranking: RankedDig[];
  winner: string | null;
  pot: number;
  split: PotSplit;
  refundReason: RefundReason | null;
  /** Filled in when the money moves. */
  deedOwner: string | null;
  jackpotWin: { account: string; amount: number } | null;
  /** Season points by account for this round. */
  seasonPoints: Record<string, number>;
};

export type GameStage = 'waiting' | 'live' | 'finished' | 'refunded';

export type Game = {
  id: string;
  name: string;
  host: string;
  mapId: MapId;
  /** All money is in integer milliNEAR. */
  fee: number;
  durationSec: number;
  hostCutBps: number;
  minPlayers: number;
  maxPlayers: number;
  /** Automatic start this long after the minimum is reached. 0 means the host starts it. */
  countdownSec: number;
  stage: GameStage;
  /** Seconds since the room opened, while waiting. */
  waited: number;
  /** Seconds until an automatic start, or null if none is running. */
  startIn: number | null;
  /** Seconds into the round. */
  elapsed: number;
  /** Everyone who joined. Each has a fee locked in the pot. */
  players: string[];
  clues: Clue[];
  /** Landmarks still consistent with every clue so far. Public, like the clues. */
  candidateIds: number[];
  digs: Dig[];
  result: Result | null;
  /** The money for this room has been moved. */
  paid: boolean;
};

export type NewGameInput = {
  name: string;
  host: string;
  mapId: MapId;
  fee: number;
  durationSec: number;
  hostCutBps: number;
  minPlayers: number;
  maxPlayers: number;
  countdownSec: number;
};

/** A rule was broken. The message is written to be shown to the player. */
export class GameError extends Error {}

/** A whole number from 0 up to, but not including, n. */
export type Rng = (n: number) => number;
