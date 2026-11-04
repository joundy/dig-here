<script lang="ts">
  import { fly } from 'svelte/transition';
  import { audio } from './lib/audio/audio.svelte';
  import { ui } from './lib/ui.svelte';
  import { world } from './lib/world/world';
  import Board from './components/Board.svelte';
  import Header from './components/Header.svelte';
  import Lobby from './components/Lobby.svelte';
  import NewGame from './components/NewGame.svelte';
  import Room from './components/Room.svelte';
  import type { Point } from './lib/game/types';

  let hash = $state(location.hash);

  const route = $derived.by(() => {
    const path = hash.replace(/^#/, '') || '/';
    const game = path.match(/^\/game\/(.+)$/);
    if (game) return { name: 'game' as const, id: game[1], key: path };
    if (path === '/new') return { name: 'new' as const, id: '', key: path };
    return { name: 'lobby' as const, id: '', key: '/' };
  });

  const inGame = $derived(route.name === 'game');

  // The Room tells the board what it needs. Other screens leave the island idle.
  let board = $state<{ pickable: boolean; spot: Point | null; label: string }>({ pickable: false, spot: null, label: 'Map of the island' });

  $effect(() => {
    if (route.name === 'game') return;
    world.idle();
    board = { pickable: false, spot: null, label: 'Map of the island' };
    audio.playMusic('lobby');
  });

  // Every button and link answers with a sound, wherever it is on the page.
  function onclick(event: MouseEvent) {
    audio.unlock();
    if ((event.target as Element).closest('button, a, summary, label.choice')) audio.click();
  }

  function onmouseover(event: MouseEvent) {
    if (ui.coarse) return;
    const el = (event.target as Element).closest('button, a, summary, label.choice');
    if (el && !el.contains(event.relatedTarget as Node)) audio.hover();
  }
</script>

<svelte:window
  onhashchange={() => { hash = location.hash; window.scrollTo(0, 0); }}
  onkeydown={() => audio.unlock()}
  onpointerdown={() => audio.unlock()}
  {onclick}
  {onmouseover}
/>

<div class="app" class:locked={ui.short || (ui.compact && inGame)}>
<Header />
<main
  class="stage"
  class:compact={ui.compact}
  class:short={ui.short}
  class:game={inGame}
  class:new={route.name === 'new'}
>
  <div class="board-wrap">
    <Board
      pickable={board.pickable}
      spot={board.spot}
      label={board.label}
      camera={ui.coarse && inGame}
      fill={ui.compact && inGame}
    />
  </div>
  {#key route.key}
    <div class="rail" in:fly={{ x: 40, duration: 240 }}>
      {#if route.name === 'game'}
        <Room id={route.id} onboard={(b) => (board = b)} />
      {:else if route.name === 'new'}
        <NewGame />
      {:else}
        <Lobby />
      {/if}
    </div>
  {/key}
</main>
</div>
