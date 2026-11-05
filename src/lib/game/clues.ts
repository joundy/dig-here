import type { Clue, Game, Landmark, Rng, Tag } from './types';

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

  const candidates = game.candidateIds.map((id) => game.landmarks[id]);
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
