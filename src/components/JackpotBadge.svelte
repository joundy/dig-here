<script lang="ts">
  import { Tween } from 'svelte/motion';
  import { cubicOut } from 'svelte/easing';
  import { backend } from '../lib/backend';
  import { near } from '../lib/format';
  import Sprite from './Sprite.svelte';

  let { compact = false }: { compact?: boolean } = $props();

  const calm = matchMedia('(prefers-reduced-motion: reduce)').matches;
  const shown = new Tween(0, { duration: calm ? 0 : 900, easing: cubicOut });

  $effect(() => {
    shown.target = backend.jackpot;
  });
</script>

<div class="jackpot" class:compact aria-label="Jackpot {near(backend.jackpot)}">
  <span class="coin"><Sprite name="coin" scale={compact ? 3 : 5} /></span>
  <span class="words">
    <span class="label">Jackpot</span>
    <span class="number">{near(Math.round(shown.current))}</span>
  </span>
</div>

<style>
  .jackpot {
    display: flex;
    align-items: center;
    gap: 0.6rem;
  }
  .coin {
    animation: spin 1.2s steps(4) infinite;
  }
  .words {
    display: grid;
    line-height: 1;
  }
  .label {
    font-size: 1.15rem;
    color: var(--mist);
    text-transform: uppercase;
    letter-spacing: 0.05em;
  }
  .number {
    font-family: var(--display);
    font-size: 2.6rem;
    color: var(--sun);
    font-variant-numeric: tabular-nums;
    white-space: nowrap;
    text-shadow: 3px 3px 0 var(--ink);
  }
  .compact {
    gap: 0.4rem;
  }
  .compact .label {
    font-size: 1rem;
  }
  .compact .number {
    font-size: 1.7rem;
    text-shadow: 2px 2px 0 var(--ink);
  }
  @keyframes spin {
    0%, 100% { transform: scaleX(1); }
    50% { transform: scaleX(0.3); }
  }
</style>
