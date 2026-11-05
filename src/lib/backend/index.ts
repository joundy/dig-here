import type { GameBackend } from './types';

// Dynamic, with the mode folded in at build time, so a build carries one backend and not the other.
const module = import.meta.env.VITE_BACKEND === 'dummy' ? await import('./dummy.svelte') : await import('./near.svelte');

export const backend: GameBackend = module.backend;
