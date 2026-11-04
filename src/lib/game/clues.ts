import { MAP } from './map';
import type { Category, Clue, Game, Kind, Landmark, Rng, Tag } from './types';

const CATEGORY_COPY: Record<Category, Clue> = {
  animal: { text: 'Something around here is chewing loudly.', plain: 'Near an animal' },
  tree: { text: 'Somewhere shady, with bark.', plain: 'Near a tree' },
  building: { text: 'Someone built something here and regrets it.', plain: 'Near a building' },
  thing: { text: 'Somebody left their stuff lying around.', plain: 'Near something left outdoors' },
};

const KIND_COPY: Record<Kind, Clue & { name: string }> = {
  horse: { name: 'horse', text: 'Ask the horse. It will not answer.', plain: 'Near a horse' },
  cow: { name: 'cow', text: 'A cow is judging this exact patch of grass.', plain: 'Near a cow' },
  sheep: { name: 'sheep', text: 'Count the sheep, then stop at the right one.', plain: 'Near a sheep' },
  duck: { name: 'duck', text: 'The duck knows. Never trust the duck.', plain: 'Near a duck' },
  palm: { name: 'palm tree', text: 'Look for a tree that is on holiday.', plain: 'Near a palm tree' },
  pine: { name: 'pine tree', text: 'Follow the smell of car air freshener.', plain: 'Near a pine tree' },
  apple: { name: 'apple tree', text: 'One tree here keeps dropping things on people.', plain: 'Near an apple tree' },
  hut: { name: 'hut', text: 'Somebody small lives very close to this.', plain: 'Near a hut' },
  windmill: { name: 'windmill', text: 'It is by something going round in circles.', plain: 'Near a windmill' },
  well: { name: 'well', text: 'Wishing will not help, but the well is close.', plain: 'Near a well' },
  lighthouse: { name: 'lighthouse', text: 'The big striped candle is nearby.', plain: 'Near a lighthouse' },
  scarecrow: { name: 'scarecrow', text: 'Find the worst-dressed person on the island.', plain: 'Near a scarecrow' },
  campfire: { name: 'campfire', text: 'Follow the smell of burnt marshmallow.', plain: 'Near a campfire' },
  boat: { name: 'boat', text: 'Someone parked a boat and forgot about it.', plain: 'Near a boat' },
};

const TAG_COPY: Record<Tag, { text: string; plain: string }> = {
  water: { text: 'one that can hear splashing', plain: 'close to water' },
  inland: { text: 'one that has never seen the sea', plain: 'far from water' },
  north: { text: 'one up north, wearing a scarf', plain: 'in the north half' },
  south: { text: 'one down south, getting a tan', plain: 'in the south half' },
  east: { text: 'one out east, up early for the sunrise', plain: 'in the east half' },
  west: { text: 'one out west, up late for the sunset', plain: 'in the west half' },
};

function pick<T>(items: readonly T[], rng: Rng): T {
  return items[Math.floor(rng() * items.length)];
}

function landmarksOf(ids: number[]): Landmark[] {
  return ids.map((id) => MAP.landmarks[id]);
}

/**
 * Rolls the next clue from whatever still fits. Nothing is decided ahead of time: the
 * landmark picked here is forgotten straight away, and only the public clue survives.
 * That is why the host, the server and the developer can't know the location.
 */
export function rollNextClue(game: Game, rng: Rng): void {
  const candidates = landmarksOf(game.candidateIds);
  const seed = pick(candidates, rng);
  const level = game.clues.length;

  if (level === 0) {
    game.clues.push({ ...CATEGORY_COPY[seed.category] });
    game.candidateIds = candidates.filter((l) => l.category === seed.category).map((l) => l.id);
  } else if (level === 1) {
    const { text, plain } = KIND_COPY[seed.kind];
    game.clues.push({ text, plain });
    game.candidateIds = candidates.filter((l) => l.kind === seed.kind).map((l) => l.id);
  } else {
    const tag = chooseTag(seed, candidates, rng);
    const { name } = KIND_COPY[seed.kind];
    const copy = TAG_COPY[tag];
    const article = /^[aeiou]/.test(name) ? 'an' : 'a';
    game.clues.push({
      text: `Not just any ${name}: ${copy.text}.`,
      plain: `Near ${article} ${name} ${copy.plain}`,
    });
    game.candidateIds = candidates.filter((l) => l.tags.includes(tag)).map((l) => l.id);
  }
}

// Prefer a tag that narrows things down but leaves more than one option, to keep the end uncertain.
function chooseTag(seed: Landmark, candidates: Landmark[], rng: Rng): Tag {
  const remaining = (tag: Tag) => candidates.filter((l) => l.tags.includes(tag)).length;
  const ideal = seed.tags.filter((t) => remaining(t) < candidates.length && remaining(t) >= 2);
  if (ideal.length) return pick(ideal, rng);
  const narrowing = seed.tags.filter((t) => remaining(t) < candidates.length);
  return pick(narrowing.length ? narrowing : seed.tags, rng);
}

export function kindName(landmarkId: number): string {
  return KIND_COPY[MAP.landmarks[landmarkId].kind].name;
}
