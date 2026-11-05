/** What the dig button says and whether it works. The player's X stays put through all of these. */
export function digButton(state: { busy: boolean; tooLate: boolean; clueComing: boolean; bonus: string }): { label: string; disabled: boolean } {
  if (state.busy) return { label: 'Digging…', disabled: true };
  if (state.tooLate) return { label: 'Too late!', disabled: true };
  if (state.clueComing) return { label: 'New clue coming…', disabled: true };
  return { label: `Dig here at ${state.bonus}`, disabled: false };
}

/** The contract's own sentence when a dig lands while a roll is locked. */
export const CLUE_REFUSAL = /new clue is arriving/i;
