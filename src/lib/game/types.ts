export type Point = { x: number; y: number };

export type Category = 'animal' | 'tree' | 'building' | 'thing';

export type Kind =
  | 'horse' | 'cow' | 'sheep' | 'duck'
  | 'palm' | 'pine' | 'apple'
  | 'hut' | 'windmill' | 'well' | 'lighthouse'
  | 'scarecrow' | 'campfire' | 'boat';

export type Tag = 'water' | 'inland' | 'north' | 'south' | 'east' | 'west';

export type Landmark = Point & {
  id: number;
  kind: Kind;
  category: Category;
  tags: Tag[];
  flip: boolean;
};

export type Clue = {
  /** The funny line shown large. */
  text: string;
  /** The same clue said plainly, so nobody loses to a joke they didn't get. */
  plain: string;
};

export type Dig = Point & {
  account: string;
  clueIndex: number;
  bonus: number;
  /** Seconds into the round. */
  dugAt: number;
};

export type RankedDig = Dig & {
  distance: number;
  closeness: number;
  score: number;
};

export type Result = {
  /** Null when the round was refunded, because no treasure was ever rolled. */
  treasure: (Point & { landmarkId: number }) | null;
  ranking: RankedDig[];
  winner: string | null;
  pot: number;
  hostCut: number;
  prize: number;
};

export type GameStatus = 'open' | 'finished' | 'refunded';

export type Game = {
  id: string;
  name: string;
  host: string;
  /** All money is in integer milliNEAR. */
  fee: number;
  durationSec: number;
  hostCutBps: number;
  elapsed: number;
  status: GameStatus;
  clues: Clue[];
  /** Landmarks still consistent with every clue so far. Public, like the clues. */
  candidateIds: number[];
  digs: Dig[];
  result: Result | null;
};

export type NewGameInput = {
  name: string;
  host: string;
  fee: number;
  durationSec: number;
  hostCutBps: number;
};

/** A rule was broken. The message is written to be shown to the player. */
export class GameError extends Error {}

export type Rng = () => number;
