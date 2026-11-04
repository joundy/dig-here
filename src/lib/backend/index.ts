import { dummy } from './dummy.svelte';
import type { GameBackend } from './types';

// The one line to change when the real NEAR backend exists.
export const backend: GameBackend = dummy;
