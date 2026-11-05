export type OracleStep =
  | { type: 'poke' }
  | { type: 'reveal'; step: number; tip_index: number }
  | { type: 'wait-final' }
  | null;

/**
 * A poke that lands early only costs 0.0002 NEAR, but one that lands late delays a clue for everyone. The state
 * this reads is already over a second old and a send takes over a second more, so it can safely go a bit early.
 */
export const POKE_LEAD_MS = 1500;

/** What a room needs right now, worked out only from chain state, so a restart mid-round loses nothing. */
export function nextStep(room: any, nowMs: number, finalHeight: number | null): OracleStep {
  if (room.status === 'waiting') {
    if (room.start_at_ms !== null && nowMs + POKE_LEAD_MS >= room.start_at_ms) return { type: 'poke' };
    if (nowMs + POKE_LEAD_MS >= room.deadline_ms) return { type: 'poke' };
    return null;
  }
  if (room.status !== 'live') return null;

  if (nowMs >= room.ends_at_ms && room.digs.length < 2) return { type: 'poke' };
  if (room.reveal_deadline_ms !== null && nowMs >= room.reveal_deadline_ms) return { type: 'poke' };
  if (room.locked) {
    // The link stays secret until the lock can't be reorganised away, so no validator can
    // see the link and then swap the seed it mixes with.
    if (finalHeight === null || finalHeight < room.lock_height) return { type: 'wait-final' };
    return { type: 'reveal', step: room.next_step, tip_index: room.tip_index };
  }
  if (room.next_due_ms !== null && nowMs + POKE_LEAD_MS >= room.next_due_ms) return { type: 'poke' };
  return null;
}
