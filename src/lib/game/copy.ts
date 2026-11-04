// Everything the game says about clues and places. The rules only ever store IDs.
import { MAP_DEFS } from './mapDefs';
import type { Category, Clue, Kind, MapId, Tag } from './types';

type Words = { text: string; plain: string };

const YOLO: Words = { text: 'No clue yet. Dig anywhere. YOLO!', plain: 'No clue: a blind gamble, for the biggest bonus' };

const CATEGORY_COPY: Record<MapId, Record<Category, Words>> = {
  tropical: {
    animal: { text: 'Something around here is chewing loudly.', plain: 'Near an animal' },
    tree: { text: 'Somewhere shady, with bark.', plain: 'Near a tree' },
    building: { text: 'Someone built something here and regrets it.', plain: 'Near a building' },
    thing: { text: 'Somebody left their stuff lying around.', plain: 'Near something left outdoors' },
  },
  snowy: {
    animal: { text: 'Something nearby has very warm opinions.', plain: 'Near an animal' },
    tree: { text: 'Look for something tall wearing a snow hat.', plain: 'Near a tree' },
    building: { text: 'Someone is indoors, and proud of it.', plain: 'Near a building' },
    thing: { text: 'Somebody left their stuff out to freeze.', plain: 'Near something left outdoors' },
  },
  desert: {
    animal: { text: 'Something nearby is judging you and sweating.', plain: 'Near an animal' },
    tree: { text: 'Somewhere with a tiny bit of shade. Maybe.', plain: 'Near a plant' },
    building: { text: 'Someone built something and the sand wants it back.', plain: 'Near a building' },
    thing: { text: 'Somebody left their stuff here a long time ago.', plain: 'Near something left outdoors' },
  },
};

const KIND_COPY: Record<Kind, Words & { name: string }> = {
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
  penguin: { name: 'penguin', text: 'A very small waiter knows where it is.', plain: 'Near a penguin' },
  seal: { name: 'seal', text: 'Listen for clapping from a sausage.', plain: 'Near a seal' },
  husky: { name: 'husky', text: 'Something fluffy is screaming about breakfast.', plain: 'Near a husky' },
  snowpine: { name: 'snowy pine', text: 'A tree here gave up and became a snowball.', plain: 'Near a snowy pine' },
  birch: { name: 'birch tree', text: 'Find the tree in a striped pyjama.', plain: 'Near a birch tree' },
  igloo: { name: 'igloo', text: 'Somebody built a house out of the weather.', plain: 'Near an igloo' },
  cabin: { name: 'cabin', text: 'Someone inside is pretending to enjoy this.', plain: 'Near a cabin' },
  snowman: { name: 'snowman', text: 'His carrot has seen things.', plain: 'Near a snowman' },
  sled: { name: 'sled', text: 'Somebody got off in a hurry.', plain: 'Near a sled' },
  camel: { name: 'camel', text: 'Ask the one carrying its own luggage.', plain: 'Near a camel' },
  lizard: { name: 'lizard', text: 'A tiny dragon is doing push-ups near it.', plain: 'Near a lizard' },
  vulture: { name: 'vulture', text: 'Someone is waiting for you to get tired.', plain: 'Near a vulture' },
  cactus: { name: 'cactus', text: 'Do not hug the thing that marks the spot.', plain: 'Near a cactus' },
  deadtree: { name: 'dead tree', text: 'This tree stopped trying years ago.', plain: 'Near a dead tree' },
  tent: { name: 'tent', text: 'Someone is camping, and it is not going well.', plain: 'Near a tent' },
  pyramid: { name: 'pyramid', text: 'Look for a very pointy tax office.', plain: 'Near a pyramid' },
  skull: { name: 'skull', text: 'Its previous owner did not find the treasure.', plain: 'Near a skull' },
  cart: { name: 'cart', text: 'A wheel fell off and so did the plan.', plain: 'Near a cart' },
};

const TAG_COPY: Record<Tag, { text: string; plain: string }> = {
  water: { text: 'one that can hear splashing', plain: 'close to water' },
  inland: { text: 'one that has never seen the sea', plain: 'far from water' },
  north: { text: 'one up north, wearing a scarf', plain: 'in the north half' },
  south: { text: 'one down south, getting a tan', plain: 'in the south half' },
  east: { text: 'one out east, up early for the sunrise', plain: 'in the east half' },
  west: { text: 'one out west, up late for the sunset', plain: 'in the west half' },
};

export function kindName(kind: Kind): string {
  return KIND_COPY[kind].name;
}

export function withArticle(name: string): string {
  return `${/^[aeiou]/.test(name) ? 'an' : 'a'} ${name}`;
}

export function clueText(mapId: MapId, clue: Clue): Words {
  if (clue.level === 'yolo') return YOLO;
  if (clue.level === 'category') return CATEGORY_COPY[mapId][clue.category];
  if (clue.level === 'kind') return KIND_COPY[clue.kind];
  const { name } = KIND_COPY[clue.kind];
  const tag = TAG_COPY[clue.tag];
  return { text: `Not just any ${name}: ${tag.text}.`, plain: `Near ${withArticle(name)} ${tag.plain}` };
}

export function mapName(mapId: MapId): string {
  return MAP_DEFS[mapId].name;
}
