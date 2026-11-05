<script lang="ts">
  import { fly } from 'svelte/transition';
  import { audio } from './lib/audio/audio.svelte';
  import { backend } from './lib/backend';
  import AccountDialog from './components/AccountDialog.svelte';
  import { tutorialHidden, ui } from './lib/ui.svelte';
  import { world } from './lib/world/world';
  import Board from './components/Board.svelte';
  import DeedMarket from './components/DeedMarket.svelte';
  import DigTray from './components/DigTray.svelte';
  import GameBoard from './components/GameBoard.svelte';
  import Header from './components/Header.svelte';
  import NewGame from './components/NewGame.svelte';
  import RoomGate from './components/RoomGate.svelte';
  import SeasonPage from './components/SeasonPage.svelte';
  import TopUpDialog from './components/TopUpDialog.svelte';
  import Tutorial from './components/Tutorial.svelte';
  import WalletDialog from './components/WalletDialog.svelte';
  import type { Point } from './lib/game/types';

  let hash = $state(location.hash);

  const route = $derived.by(() => {
    const path = hash.replace(/^#/, '') || '/';
    const game = path.match(/^\/game\/(.+)$/);
    if (game) return { name: 'game' as const, id: game[1], key: path };
    if (path === '/new') return { name: 'new' as const, id: '', key: path };
    // One key for the market and its NFTs, because the list has to still be there, as it was, on the way back.
    // `deeds` is what these pages were once called, and old links still work.
    const deed = path.match(/^\/(?:nfts|deeds)(?:\/(.+))?$/);
    if (deed) return { name: 'deeds' as const, id: deed[1] ?? '', key: '/deeds' };
    if (path === '/season') return { name: 'season' as const, id: '', key: path };
    return { name: 'lobby' as const, id: '', key: '/' };
  });

  const inGame = $derived(route.name === 'game');
  // These pages are one wide panel with the island behind it, rather than a map and a rail.
  const full = $derived(route.name === 'lobby' || route.name === 'season' || route.name === 'deeds');

  const calm = matchMedia('(prefers-reduced-motion: reduce)').matches;

  const SITE = 'Dig Here';
  const title = $derived.by(() => {
    if (route.name === 'game') {
      const game = backend.games.find((g) => g.id === route.id);
      return game ? `${game.name} | ${SITE}` : SITE;
    }
    if (route.name === 'new') return `Host a game | ${SITE}`;
    if (route.name === 'season') return `Season ${backend.season.number} | ${SITE}`;
    if (route.name === 'deeds') return `NFT market | ${SITE}`;
    return `${SITE}: a treasure-digging game on NEAR testnet`;
  });
  $effect(() => {
    document.title = title;
  });

  // The Room tells the board what it needs. Other screens leave the island idle.
  let board = $state<{ pickable: boolean; spot: Point | null; label: string }>({ pickable: false, spot: null, label: 'Map of the island' });

  $effect(() => {
    if (inGame) return;
    board = { pickable: false, spot: null, label: 'Map of the island' };
    audio.setMapMusic('tropical');
    audio.playMusic('lobby');
  });

  // NewGame and DeedMarket choose their own map.
  $effect(() => {
    if (full && route.name !== 'deeds') world.showMap('tropical');
  });

  // Once per visit, so a reload in the middle of a round never covers the map.
  if (!tutorialHidden() && !sessionStorage.getItem('dig-here-tutorial-seen')) {
    sessionStorage.setItem('dig-here-tutorial-seen', '1');
    ui.tutorial = true;
  }

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
<Header current={route.name} />
<div class="tray"><DigTray /></div>
{#if backend.lost}
  <p class="lost" role="status">Can't reach the island right now, so this may be out of date. Trying again…</p>
{/if}
<main
  class="stage"
  class:compact={ui.compact}
  class:short={ui.short}
  class:game={inGame}
  class:new={route.name === 'new'}
  class:full
>
  <div class="board-wrap">
    <Board
      pickable={board.pickable}
      spot={board.spot}
      label={board.label}
      camera={ui.coarse && inGame}
      fill={full || (ui.compact && inGame)}
    />
  </div>
  {#key route.key}
    <div class="rail" class:wide={route.name === 'deeds'} in:fly={{ x: 40, duration: calm ? 0 : 240 }}>
      {#if route.name === 'game'}
        <RoomGate id={route.id} onboard={(b) => (board = b)} />
      {:else if route.name === 'new'}
        <NewGame />
      {:else if route.name === 'deeds'}
        <DeedMarket id={route.id} />
      {:else if route.name === 'season'}
        <SeasonPage />
      {:else}
        <GameBoard />
      {/if}
    </div>
  {/key}
</main>
</div>

{#if ui.wallet}<WalletDialog />{/if}
{#if ui.topUp}<TopUpDialog request={ui.topUp} />{/if}
{#if backend.accountPrompt}<AccountDialog prompt={backend.accountPrompt} />{/if}
{#if ui.tutorial}<Tutorial />{/if}

<style>
  .lost {
    margin: 0 var(--px) 0.3rem;
    padding: 0.25rem 0.6rem;
    font-size: 1.2rem;
    line-height: 1.15;
    text-align: center;
    color: var(--ink);
    background: #ffc2d9;
  }
</style>
