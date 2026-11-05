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

/** The next chain time this room needs a poke, or null if it needs none. A locked roll needs a reveal instead. */
export function pokeDue(room: any): number | null {
  if (room.status === 'waiting') return room.start_at_ms !== null ? Math.min(room.start_at_ms, room.deadline_ms) : room.deadline_ms;
  if (room.status !== 'live') return null;
  if (room.locked) return room.reveal_deadline_ms;
  if (room.digs.length < 2 && room.next_due_ms !== null) return Math.min(room.next_due_ms, room.ends_at_ms);
  return room.next_due_ms;
}

/**
 * What a room needs right now, worked out only from chain state, so a restart mid-round loses nothing.
 * `finalHeight` is null unless reveals are set to wait for finality. Then a lock must be final before its link comes out.
 */
export function nextStep(room: any, nowMs: number, finalHeight: number | null = null, waitForFinal = false): OracleStep {
  if (room.status === 'waiting') {
    if (room.start_at_ms !== null && nowMs + POKE_LEAD_MS >= room.start_at_ms) return { type: 'poke' };
    if (nowMs + POKE_LEAD_MS >= room.deadline_ms) return { type: 'poke' };
    return null;
  }
  if (room.status !== 'live') return null;

  if (nowMs >= room.ends_at_ms && room.digs.length < 2) return { type: 'poke' };
  if (room.reveal_deadline_ms !== null && nowMs >= room.reveal_deadline_ms) return { type: 'poke' };
  if (room.locked) {
    if (waitForFinal && (finalHeight === null || finalHeight < room.lock_height)) return { type: 'wait-final' };
    return { type: 'reveal', step: room.next_step, tip_index: room.tip_index };
  }
  if (room.next_due_ms !== null && nowMs + POKE_LEAD_MS >= room.next_due_ms) return { type: 'poke' };
  return null;
}
