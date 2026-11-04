import { getMap } from './map';
import type { Clue, Game, Landmark, MapId, Rng, Tag } from './types';

function landmarksOf(mapId: MapId, ids: number[]): Landmark[] {
  const { landmarks } = getMap(mapId);
  return ids.map((id) => landmarks[id]);
}

// Prefer a tag that narrows things down but leaves more than one option, to keep the end uncertain.
function tagOptions(seed: Landmark, candidates: Landmark[]): Tag[] {
  const remaining = (tag: Tag) => candidates.filter((l) => l.tags.includes(tag)).length;
  const ideal = seed.tags.filter((t) => remaining(t) < candidates.length && remaining(t) >= 2);
  if (ideal.length) return ideal;
  const narrowing = seed.tags.filter((t) => remaining(t) < candidates.length);
  return narrowing.length ? narrowing : seed.tags;
}

/**
 * Rolls the next clue from whatever still fits. Nothing is decided ahead of time: the
 * landmark picked here is forgotten straight away, and only the public clue survives.
 * That is why the host, the server and the developer can't know the location.
 */
export function rollNextClue(game: Game, rng: Rng): void {
  const level = game.clues.length;
  if (level === 0) {
    game.clues.push({ level: 'yolo' });
    return;
  }

  const candidates = landmarksOf(game.mapId, game.candidateIds);
  const seed = candidates[rng(candidates.length)];
  let clue: Clue;
  let fits: (l: Landmark) => boolean;
  if (level === 1) {
    clue = { level: 'category', category: seed.category };
    fits = (l) => l.category === seed.category;
  } else if (level === 2) {
    clue = { level: 'kind', kind: seed.kind };
    fits = (l) => l.kind === seed.kind;
  } else {
    const options = tagOptions(seed, candidates);
    const tag = options[rng(options.length)];
    clue = { level: 'detail', kind: seed.kind, tag };
    fits = (l) => l.tags.includes(tag);
  }
  game.clues.push(clue);
  game.candidateIds = candidates.filter(fits).map((l) => l.id);
}

const chances = new Map<MapId, number[]>();

/**
 * Each landmark's exact chance of getting the treasure, worked out by walking every way the clues
 * can go. Landmarks aren't quite equal, because the last clue narrows some groups more than others.
 */
export function landingChance(mapId: MapId): number[] {
  const known = chances.get(mapId);
  if (known) return known;

  const all = getMap(mapId).landmarks;
  const result = all.map(() => 0);
  const each = (ids: Landmark[], p: number, visit: (seed: Landmark, p: number) => void) => {
    for (const seed of ids) visit(seed, p / ids.length);
  };

  each(all, 1, (seedA, pA) => {
    const byCategory = all.filter((l) => l.category === seedA.category);
    each(byCategory, pA, (seedB, pB) => {
      const byKind = byCategory.filter((l) => l.kind === seedB.kind);
      each(byKind, pB, (seedC, pC) => {
        const options = tagOptions(seedC, byKind);
        for (const tag of options) {
          const final = byKind.filter((l) => l.tags.includes(tag));
          for (const l of final) result[l.id] += pC / options.length / final.length;
        }
      });
    });
  });
  chances.set(mapId, result);
  return result;
}
