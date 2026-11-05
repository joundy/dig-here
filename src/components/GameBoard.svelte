<script lang="ts" module>
  // Coming back from a room lands where you left off, because the board is rebuilt on the way.
  const remembered: { tab: 'waiting' | 'live' | 'finished'; page: number } = { tab: 'waiting', page: 0 };
</script>

<script lang="ts">
  import { untrack } from 'svelte';
  import { flip } from 'svelte/animate';
  import { backend } from '../lib/backend';
  import { boardView, quickPlayRoom, SORTS } from '../lib/board';
  import type { BoardTab, SortId } from '../lib/board';
  import { audio } from '../lib/audio/audio.svelte';
  import { near } from '../lib/format';
  import { mapName } from '../lib/game/copy';
  import { MAP_IDS } from '../lib/game/map';
  import type { MapId } from '../lib/game/types';
  import { attachFor } from '../lib/pay';
  import { tabArrows } from '../lib/tabs';
  import { ui } from '../lib/ui.svelte';
  import GameCard from './GameCard.svelte';
  import JackpotBadge from './JackpotBadge.svelte';

  const RERANK_MS = 2000;
  const TABS: { id: BoardTab; label: string }[] = [
    { id: 'waiting', label: 'Waiting' },
    { id: 'live', label: 'Live' },
    { id: 'finished', label: 'Finished' },
  ];
  const FEES: { value: number | null; label: string }[] = [
    { value: null, label: 'Any fee' },
    ...backend.prices.feeFilters.map((value) => ({ value, label: `Max ${near(value)}` })),
  ];
  const EMPTY: Record<BoardTab, string> = {
    waiting: 'Nobody is waiting. Suspicious. Host one and be the hero.',
    live: 'Every shovel is having a nap.',
    finished: 'No treasure found yet. Not even by accident.',
  };

  const calm = matchMedia('(prefers-reduced-motion: reduce)').matches;
  const hosts = (account: string) => backend.hostRecord(account);

  let tab = $state<BoardTab>(remembered.tab);
  let sort = $state<SortId>('best');
  let map = $state<MapId | 'all'>('all');
  let maxFee = $state<number | null>(null);
  let hideFull = $state(false);
  let page = $state(remembered.page);
  let rerank = $state(0);
  let busy = $state(false);
  let error = $state('');

  const filtered = $derived(map !== 'all' || maxFee !== null || (hideFull && tab === 'waiting'));
  const compact = $derived(ui.compact);

  // The cards themselves stay live. Only their order waits, so nothing jumps under the cursor.
  const view = $derived.by(() => {
    rerank;
    const options = { tab, sort, map, maxFee, hideFull: hideFull && tab === 'waiting', page, perPage: compact ? 4 : 6 };
    return untrack(() => boardView(backend.games, options, hosts));
  });
  const numbered = $derived(view.pages <= (compact ? 5 : 9));

  $effect(() => {
    remembered.tab = tab;
    remembered.page = page;
  });

  $effect(() => {
    const timer = setInterval(() => rerank++, RERANK_MS);
    return () => clearInterval(timer);
  });

  function firstPage() {
    page = 0;
  }

  function clearFilters() {
    map = 'all';
    maxFee = null;
    hideFull = false;
    page = 0;
  }

  async function quickPlay() {
    error = '';
    busy = true;
    try {
      await backend.ensureAccount();
      const me = backend.account;
      const balance = backend.balanceOf(me);
      // Short of coins, it picks something the wallet could pay for before anything dearer.
      const room = quickPlayRoom(backend.games, balance, me, hosts)
        ?? quickPlayRoom(backend.games, backend.walletOf(me), me, hosts, true)
        ?? quickPlayRoom(backend.games, Infinity, me, hosts, true);
      if (!room) {
        error = 'No room left to join. Host one!';
        return;
      }
      const attach = await attachFor('Entry fee', room.fee, room.fee);
      if (attach === null) return;
      await backend.join(room.id, attach);
      location.hash = `#/game/${room.id}`;
    } catch (e) {
      error = (e as Error).message;
      audio.error();
    } finally {
      busy = false;
    }
  }
</script>

<section class="panel board">
  <h1 class="sr-only">Dig Here: open games</h1>
  {#if backend.identity.kind === 'none'}
    <p class="pitch">
      One dig each on the same island. <b>The treasure doesn't exist until the timer ends</b>, and the best dig takes the pot.
      <button class="how" onclick={() => (ui.tutorial = true)}>How it works</button>
    </p>
  {/if}
  <div class="actions">
    <button class="btn" disabled={busy} onclick={quickPlay}>{busy ? 'Finding a hole…' : 'Quick Play'}</button>
    <a class="btn alt" href="#/new">Host a game</a>
    <div class="jackpot"><JackpotBadge compact={compact || ui.short} /></div>
    <div class="links">
      <a href="#/nfts">NFTs</a>
      <a href="#/season">Season</a>
    </div>
  </div>
  {#if error}<p class="error" role="alert">{error}</p>{/if}
  {#if backend.offline && !backend.lost && backend.ready}<p class="offline" role="status">The game server is away, so this is coming straight from the chain.</p>{/if}

  <div class="tabs" role="tablist" aria-label="Games by stage" tabindex="-1" onkeydown={tabArrows}>
    {#each TABS as item}
      <button role="tab" aria-selected={tab === item.id} class:on={tab === item.id} onclick={() => { tab = item.id; firstPage(); }}>
        {item.label} <span class="count">{view.counts[item.id]}</span>
      </button>
    {/each}
  </div>

  <div class="filters">
    <label>
      <span class="sr-only">Sort</span>
      <select class="select" bind:value={sort} disabled={tab === 'finished'} onchange={firstPage}>
        {#each SORTS as option}
          <option value={option.id}>{option.label}</option>
        {/each}
      </select>
    </label>
    <label>
      <span class="sr-only">Map</span>
      <select class="select" bind:value={map} onchange={firstPage}>
        <option value="all">All maps</option>
        {#each MAP_IDS as id}
          <option value={id}>{mapName(id)}</option>
        {/each}
      </select>
    </label>
    <label>
      <span class="sr-only">Entry fee</span>
      <select class="select" bind:value={maxFee} onchange={firstPage}>
        {#each FEES as fee}
          <option value={fee.value}>{fee.label}</option>
        {/each}
      </select>
    </label>
    <label class="check" class:off={tab !== 'waiting'}>
      <input type="checkbox" bind:checked={hideFull} disabled={tab !== 'waiting'} onchange={firstPage} />
      Hide full
    </label>
  </div>

  {#if !backend.ready}
    <div class="empty" aria-busy="true"><p>Rowing out to the island…</p></div>
  {:else if view.rooms.length}
    <ul class="cards" class:compact>
      {#each view.rooms as game (game.id)}
        <li animate:flip={{ duration: calm ? 0 : 240 }}><GameCard {game} /></li>
      {/each}
    </ul>
  {:else}
    <div class="empty">
      {#if filtered}
        <p>Your filters buried everything.</p>
        <button class="btn alt" onclick={clearFilters}>Dig them up</button>
      {:else}
        <p>{EMPTY[tab]}</p>
      {/if}
    </div>
  {/if}

  {#if view.pages > 1}
    <nav class="pager" aria-label="Pages">
      <button aria-label="Previous page" disabled={view.page === 0} onclick={() => (page = view.page - 1)}>‹</button>
      {#if numbered}
        {#each { length: view.pages } as _, i}
          <button class:on={i === view.page} aria-current={i === view.page ? 'page' : undefined} onclick={() => (page = i)}>{i + 1}</button>
        {/each}
      {:else}
        <span class="where">{view.page + 1} of {view.pages}</span>
      {/if}
      <button aria-label="Next page" disabled={view.page === view.pages - 1} onclick={() => (page = view.page + 1)}>›</button>
    </nav>
  {/if}
</section>

<style>
  .pitch {
    margin: 0;
    font-size: 1.3rem;
    line-height: 1.15;
    color: var(--mist);
  }
  .pitch b {
    font-weight: 400;
    color: var(--foam);
  }
  .how {
    padding: 0.5rem 0;
    margin: -0.3rem 0;
    font: inherit;
    color: var(--sun);
    text-decoration: underline;
    background: none;
    border: 0;
    cursor: pointer;
    white-space: nowrap;
  }
  .offline {
    margin: 0;
    font-size: 1.15rem;
    line-height: 1.1;
    color: var(--mist);
  }
  .board {
    display: grid;
    gap: 0.6rem;
  }
  .actions {
    display: grid;
    grid-template-columns: minmax(10rem, 15rem) minmax(10rem, 15rem) 1fr auto;
    align-items: center;
    gap: 0.75rem;
  }
  .jackpot {
    justify-self: center;
  }
  .links {
    display: flex;
    gap: 0.3rem;
  }
  .links a {
    display: grid;
    place-items: center;
    min-height: 2.75rem;
    padding: 0 0.75rem;
    font-size: 1.35rem;
    text-decoration: none;
    background: var(--deep);
    transition: transform 0.09s cubic-bezier(0.3, 1.6, 0.6, 1);
  }
  .links a:active {
    transform: translateY(2px);
  }
  @media (hover: hover) {
    .links a:hover {
      transform: translateY(-2px);
      color: var(--sun);
    }
  }
  /* The header carries these links on a big screen. */
  @media (min-width: 961px) {
    .links {
      display: none;
    }
    .actions {
      grid-template-columns: minmax(10rem, 15rem) minmax(10rem, 15rem) 1fr;
    }
    .jackpot {
      justify-self: end;
    }
  }
  .error {
    margin: 0;
  }
  .tabs {
    display: grid;
    grid-template-columns: repeat(3, 1fr);
    gap: 0.2rem;
  }
  .tabs button {
    min-height: 2.75rem;
    padding: 0 0.25rem;
    font: inherit;
    font-size: 1.4rem;
    white-space: nowrap;
    color: var(--foam);
    background: var(--deep);
    border: 0;
    cursor: pointer;
  }
  .tabs button.on {
    color: var(--ink);
    background: var(--sun);
  }
  .count {
    opacity: 0.75;
  }
  .filters {
    display: grid;
    grid-template-columns: repeat(3, minmax(0, 12rem)) auto;
    justify-content: start;
    align-items: center;
    gap: 0.4rem;
  }
  .check {
    display: flex;
    align-items: center;
    gap: 0.35rem;
    min-height: 2.25rem;
    padding-left: 0.3rem;
    font-size: 1.25rem;
    white-space: nowrap;
    cursor: pointer;
  }
  .check input {
    width: 1.2rem;
    height: 1.2rem;
    margin: 0;
    accent-color: var(--sun);
  }
  .check.off {
    opacity: 0.45;
    cursor: default;
  }
  .cards {
    display: grid;
    grid-template-columns: repeat(3, minmax(0, 1fr));
    gap: 0.5rem;
    margin: 0;
    padding: 0;
    list-style: none;
  }
  .cards.compact {
    grid-template-columns: minmax(0, 1fr);
    gap: 0.4rem;
  }
  @media (max-width: 760px) {
    .cards:not(.compact) {
      grid-template-columns: repeat(2, minmax(0, 1fr));
    }
  }
  .empty {
    display: grid;
    justify-items: center;
    gap: 0.75rem;
    padding: 2.5rem 1rem;
    text-align: center;
    background: var(--deep);
  }
  .empty p {
    margin: 0;
    font-size: 1.5rem;
    line-height: 1.15;
  }
  .empty .btn {
    width: auto;
  }
  .pager {
    display: flex;
    align-items: center;
    justify-content: center;
    gap: 0.2rem;
  }
  .pager button {
    min-width: 2.5rem;
    height: 2.5rem;
    padding: 0;
    font: inherit;
    font-size: 1.4rem;
    color: var(--foam);
    background: var(--deep);
    border: 0;
    cursor: pointer;
    transition: transform 0.09s cubic-bezier(0.3, 1.6, 0.6, 1);
  }
  .pager button.on {
    color: var(--ink);
    background: var(--sun);
  }
  .pager button:disabled {
    opacity: 0.35;
    cursor: default;
  }
  .pager button:not(:disabled):active {
    transform: translateY(2px);
  }
  .where {
    padding: 0 0.75rem;
    font-size: 1.3rem;
    white-space: nowrap;
  }
  @media (max-width: 960px) {
    .actions {
      grid-template-columns: 1fr 1fr;
      gap: 0.45rem;
    }
    .actions .btn {
      font-size: 1.6rem;
      padding: 0.45rem 0.25rem 0.6rem;
    }
    .jackpot {
      justify-self: start;
    }
    .links {
      justify-self: end;
    }
    .filters {
      grid-template-columns: repeat(3, minmax(0, 1fr));
      gap: 0.3rem;
    }
    .filters .select {
      height: 2.75rem;
      padding: 0 0 0 0.25rem;
      font-size: 1.1rem;
    }
    .check {
      grid-column: 1 / -1;
      min-height: 2.25rem;
    }
    .board {
      gap: 0.45rem;
    }
  }
</style>
