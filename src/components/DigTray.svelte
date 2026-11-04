<script lang="ts">
  import { onDestroy, untrack } from 'svelte';
  import { audio } from '../lib/audio/audio.svelte';
  import { backend } from '../lib/backend';
  import { clock } from '../lib/format';
  import { isOpen, secondsLeft } from '../lib/game/engine';
  import type { Game } from '../lib/game/types';

  const FLASH_MS = 1500;

  let hash = $state(location.hash);

  const me = $derived(backend.account);
  const openId = $derived(hash.match(/^#\/game\/(.+)$/)?.[1] ?? null);
  const mine = $derived(backend.games.filter((g) => isOpen(g) && g.players.includes(me)));
  const others = $derived(mine.filter((g) => g.id !== openId));

  let flashing = $state<Record<string, boolean>>({});
  const timers = new Set<ReturnType<typeof setTimeout>>();

  function alert(id: string) {
    flashing[id] = true;
    audio.blip(988);
    const timer = setTimeout(() => {
      timers.delete(timer);
      flashing[id] = false;
    }, FLASH_MS);
    timers.add(timer);
  }

  // The open room is counted too, so leaving it doesn't report clues you already saw.
  const seen = new Map<string, number>();
  $effect(() => {
    for (const game of mine) {
      const count = game.clues.length;
      const before = seen.get(game.id);
      seen.set(game.id, count);
      if (before !== undefined && count > before && game.id !== openId) untrack(() => alert(game.id));
    }
  });

  onDestroy(() => timers.forEach(clearTimeout));

  function status(game: Game): string {
    if (game.stage === 'live') return clock(secondsLeft(game));
    return game.startIn !== null ? `Starts ${clock(game.startIn)}` : `${game.players.length}/${game.maxPlayers}`;
  }
</script>

<svelte:window onhashchange={() => (hash = location.hash)} />

{#if others.length}
  <nav class="tray" aria-label="Your other rooms">
    {#each others as game (game.id)}
      {@const dug = game.digs.some((d) => d.account === me)}
      <a class="chip" class:flash={flashing[game.id]} href="#/game/{game.id}">
        <span class="name">{game.name}</span>
        <span class="time">{status(game)}</span>
        {#if game.stage === 'live'}
          <span class="dug" class:todo={!dug}>{dug ? 'Dug' : 'Dig!'}</span>
        {/if}
      </a>
    {/each}
  </nav>
{/if}

<style>
  .tray {
    flex: none;
    display: flex;
    justify-content: safe center;
    gap: 0.4rem;
    padding: 0.2rem 0.5rem;
    overflow-x: auto;
    overscroll-behavior-x: contain;
    scrollbar-width: none;
    background: var(--deep);
  }
  .tray::-webkit-scrollbar {
    display: none;
  }
  .chip {
    flex: none;
    display: flex;
    align-items: center;
    gap: 0.4rem;
    min-height: 2rem;
    padding: 0 0.5rem;
    color: var(--foam);
    background: var(--ink);
    font-size: 1.15rem;
    line-height: 1;
    white-space: nowrap;
    text-decoration: none;
    transition: transform 0.09s cubic-bezier(0.3, 1.6, 0.6, 1);
  }
  @media (hover: hover) {
    .chip:hover {
      transform: translateY(-2px);
    }
  }
  .chip:active {
    transform: translateY(2px);
  }
  .name {
    max-width: 8.5rem;
    overflow: hidden;
    text-overflow: ellipsis;
  }
  .time {
    color: var(--sun);
    font-variant-numeric: tabular-nums;
  }
  .dug {
    color: var(--mist);
  }
  .todo {
    color: #ffb3d1;
  }
  .flash {
    animation: chip-flash 0.3s steps(2) 5;
  }
  @keyframes chip-flash {
    50% {
      color: var(--ink);
      background: var(--sun);
    }
  }
</style>
