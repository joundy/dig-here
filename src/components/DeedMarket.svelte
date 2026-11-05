<script lang="ts">
  import { tick } from 'svelte';
  import { audio } from '../lib/audio/audio.svelte';
  import { backend } from '../lib/backend';
  import { near, percent } from '../lib/format';
  import { mapName } from '../lib/game/copy';
  import { deedKinds } from '../lib/game/economy';
  import { MAP_IDS } from '../lib/game/map';
  import { RULES } from '../lib/game/rules';
  import type { Kind, MapId } from '../lib/game/types';
  import { ALL_DEEDS, DEFAULT_SORT, islandStats, marketRows, parseDeedId, SORTS, tabCounts } from '../lib/market';
  import type { DeedRow, MarketSort, MarketTab } from '../lib/market';
  import { ui } from '../lib/ui.svelte';
  import { world } from '../lib/world/world';
  import DeedCard from './DeedCard.svelte';
  import DeedDetail from './DeedDetail.svelte';
  import DeedNews from './DeedNews.svelte';
  import IslandLineup from './IslandLineup.svelte';
  import Sprite from './Sprite.svelte';

  let { id = '' }: { id?: string } = $props();

  const TABS: { id: MarketTab; label: string }[] = [
    { id: 'sale', label: 'For sale' },
    { id: 'mint', label: 'Mint' },
    { id: 'all', label: 'All' },
    { id: 'mine', label: 'Mine' },
  ];
  const SKELETONS = 8;

  let tab = $state<MarketTab>('sale');
  let mapFilter = $state<MapId | 'all'>('all');
  let sort = $state<MarketSort>(DEFAULT_SORT.sale);
  let claiming = $state(false);
  let claimError = $state('');
  /** Where the list was when an NFT was opened, to go back to. */
  let listScroll = 0;

  const me = $derived(backend.account);
  const selected = $derived(id ? parseDeedId(id) : null);
  const read = (deedId: string) => backend.deedOf(deedId);
  const counts = $derived(tabCounts(me, read));
  const rows = $derived(marketRows(tab, mapFilter, sort, me, read));
  const sorts = $derived(SORTS.filter((option) => option.tabs.includes(tab)));
  /** Sorted by island, the list breaks into one collection per map. */
  const groups = $derived.by((): { map: MapId | null; rows: DeedRow[] }[] => {
    if (sort !== 'island') return [{ map: mapFilter === 'all' ? null : mapFilter, rows }];
    return MAP_IDS
      .filter((map) => mapFilter === 'all' || map === mapFilter)
      .map((map) => ({ map, rows: rows.filter((row) => row.map === map) }))
      .filter((group) => group.rows.length > 0);
  });
  const myEarnings = $derived(ALL_DEEDS.reduce((sum, row) => {
    const deed = read(row.id);
    return me && deed.owner === me ? sum + deed.earned : sum;
  }, 0));

  // The map is only the backdrop here. It follows whichever island you're looking at.
  $effect(() => {
    world.showMap(selected?.map ?? (mapFilter === 'all' ? 'tropical' : mapFilter));
  });

  // Coming back from an NFT puts you where you were. The hash change has already scrolled to the top.
  $effect(() => {
    if (id) return;
    const to = listScroll;
    void tick().then(() => window.scrollTo(0, to));
  });

  function chooseTab(next: MarketTab) {
    tab = next;
    sort = DEFAULT_SORT[next];
  }

  async function claim() {
    claiming = true;
    claimError = '';
    try {
      await backend.claimFromMarket();
      audio.coin();
    } catch (e) {
      claimError = (e as Error).message;
      audio.error();
    } finally {
      claiming = false;
    }
  }

  const found = (map: MapId) => (kind: Kind) => backend.deedOf(`${map}:${kind}`).owner !== null;
</script>

{#snippet lineup(map: MapId)}
  {@const stats = islandStats(map, read)}
  <header class="island {map}">
    <IslandLineup {map} kinds={deedKinds(map)} found={found(map)} />
    <div class="plate">
      <h2>{mapName(map)}</h2>
      <p>
        <span>{stats.minted} of {stats.total} minted</span>
        {#if stats.floor !== null}<span>From <b>{near(stats.floor)}</b></span>{/if}
        {#if stats.earned > 0 && !ui.compact}<span>{near(stats.earned)} earned</span>{/if}
      </p>
    </div>
  </header>
{/snippet}

<section class="panel market">
  {#if id}
    {#if selected}
      {#key selected.id}<DeedDetail row={selected} />{/key}
    {:else}
      <div class="state">
        <Sprite name="parrot" scale={4} />
        <h2>There's no such NFT</h2>
        <p>That link doesn't match any landmark on our islands.</p>
        <a class="btn alt small" href="#/deeds">See all NFTs</a>
      </div>
    {/if}
  {:else}
    <header class="head">
      <h1>NFT market</h1>
      <label class="sort">
        <span class="sr-only">Sort by</span>
        <select class="select" bind:value={sort}>
          {#each sorts as option}<option value={option.id}>{option.label}</option>{/each}
        </select>
      </label>
      <p>Own a landmark and earn {percent(RULES.deedBps)} of the pot whenever the treasure lands by one.</p>
    </header>

    <div class="tabs" role="tablist" aria-label="NFTs">
      {#each TABS as item}
        <button role="tab" aria-selected={tab === item.id} class:on={tab === item.id} onclick={() => chooseTab(item.id)}>
          {item.label} {#if backend.deedsReady && (item.id !== 'mine' || me)}<span class="count">{counts[item.id]}</span>{/if}
        </button>
      {/each}
    </div>

    <div class="bar">
      <div class="islands" role="group" aria-label="Filter by island">
        <button class:on={mapFilter === 'all'} aria-pressed={mapFilter === 'all'} onclick={() => (mapFilter = 'all')}>All islands</button>
        {#each MAP_IDS as map}
          <button class="{map}" class:on={mapFilter === map} aria-pressed={mapFilter === map} onclick={() => (mapFilter = map)}>
            <Sprite name={map === 'tropical' ? 'palm' : map === 'snowy' ? 'penguin' : 'camel'} scale={1} />
            {mapName(map).split(' ')[0]}
          </button>
        {/each}
      </div>
    </div>

    {#if backend.deedsError}
      <div class="trouble" role="alert">
        <p>{backend.deedsError}</p>
        <button class="btn alt small" onclick={() => backend.reloadDeeds()}>Try again</button>
      </div>
    {/if}

    {#if backend.marketClaim > 0}
      <div class="claim" role="status">
        <p>The market is holding {near(backend.marketClaim)} for you, because a payment couldn't reach your account when it was due.</p>
        <button class="btn small" disabled={claiming} onclick={claim}>{claiming ? 'Waiting for your wallet…' : 'Send it to my wallet'}</button>
        {#if claimError}<p class="error" role="alert">{claimError}</p>{/if}
      </div>
    {/if}

    <div class="shop">
      <div class="list">
        {#if !backend.deedsReady}
          <ul class="cards" aria-busy="true" aria-label="Loading the market">
            {#each { length: SKELETONS }, i}<li class="ghost" style:--i={i}><span></span></li>{/each}
          </ul>
        {:else if tab === 'mine' && !me}
          <div class="state">
            <Sprite name="chest" scale={5} />
            <h2>Your collection lives in your wallet</h2>
            <p>Connect it to see the NFTs you own and what they've earned.</p>
            <button class="btn small" onclick={() => backend.ensureAccount().catch(() => {})}>Connect wallet</button>
          </div>
        {:else if rows.length === 0}
          <div class="state">
            {#if tab === 'mine'}
              <Sprite name="chest" scale={5} />
              <h2>Your chest is empty</h2>
              <p>Mint a landmark nobody owns yet, or buy one from another player.</p>
              <div class="pair">
                <button class="btn small" onclick={() => chooseTab('mint')}>See what's left to mint</button>
                <button class="btn alt small" onclick={() => chooseTab('sale')}>See what's for sale</button>
              </div>
            {:else if tab === 'mint'}
              <Sprite name="shovel" scale={5} />
              <h2>{mapFilter === 'all' ? 'Every NFT has been minted' : `All of ${mapName(mapFilter)} is minted`}</h2>
              <p>From here on they only change hands between players.</p>
              <button class="btn alt small" onclick={() => chooseTab('sale')}>See what's for sale</button>
            {:else}
              <Sprite name="coin" scale={6} />
              <h2>Nothing for sale {mapFilter === 'all' ? 'yet' : `on ${mapName(mapFilter)}`}</h2>
              <p>Everyone's holding on to their landmark. You can still mint one nobody owns.</p>
              <button class="btn small" onclick={() => chooseTab('mint')}>See what's left to mint</button>
            {/if}
          </div>
        {:else}
          {#if tab === 'mine'}<p class="earned"><Sprite name="coin" scale={2} /> Your NFTs have earned {near(myEarnings)}</p>{/if}
          {#each groups as group (group.map ?? 'flat')}
            {#if group.map}{@render lineup(group.map)}{/if}
            <ul class="cards">
              {#each group.rows as row (row.id)}
                <li><DeedCard {row} onopen={() => (listScroll = window.scrollY)} /></li>
              {/each}
            </ul>
          {/each}
        {/if}
      </div>

      <aside class="side"><DeedNews /></aside>
    </div>
  {/if}
</section>

<style>
  .market {
    --set: var(--mist);
  }
  :global(.market .tropical) {
    --set: #5fd98f;
  }
  :global(.market .snowy) {
    --set: #8fdcf5;
  }
  :global(.market .desert) {
    --set: #ff9d4d;
  }
  .head {
    display: grid;
    grid-template-columns: auto minmax(0, 1fr) minmax(9rem, 12rem);
    align-items: center;
    gap: 0.25rem 1rem;
    margin-bottom: 0.6rem;
  }
  .head .sort {
    grid-column: 3;
    grid-row: 1;
  }
  h1 {
    margin: 0;
    font-family: var(--display);
    font-size: 2.8rem;
    font-weight: 400;
    line-height: 1;
    color: var(--sun);
    white-space: nowrap;
  }
  .head p {
    grid-column: 2;
    grid-row: 1;
    margin: 0;
    font-size: 1.2rem;
    line-height: 1.15;
    color: var(--mist);
    max-width: 44rem;
  }
  .tabs {
    display: grid;
    grid-template-columns: repeat(4, 1fr);
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
  .bar {
    display: flex;
    flex-wrap: wrap;
    align-items: stretch;
    justify-content: space-between;
    gap: 0.4rem;
    margin: 0.4rem 0 0.7rem;
  }
  .islands {
    display: flex;
    flex: 1 1 auto;
    gap: 0.2rem;
    min-width: 0;
  }
  .islands button {
    display: inline-flex;
    align-items: center;
    justify-content: center;
    gap: 0.25rem;
    min-height: 2.75rem;
    padding: 0 0.6rem;
    font: inherit;
    font-size: 1.2rem;
    line-height: 1;
    white-space: nowrap;
    color: var(--mist);
    background: none;
    border: 0;
    box-shadow: inset 0 0 0 2px var(--deep);
    cursor: pointer;
  }
  .islands button.on {
    color: var(--foam);
    background: var(--deep);
    box-shadow: inset 0 -3px 0 var(--set);
  }
  .sort .select {
    height: 2.5rem;
  }
  .shop {
    display: grid;
    grid-template-columns: minmax(0, 1fr) 15.5rem;
    gap: 1rem;
    align-items: start;
  }
  .list {
    display: grid;
    gap: 0.7rem;
    min-width: 0;
  }
  .side {
    position: sticky;
    top: 0.5rem;
    padding: 0.6rem 0.65rem 0.7rem;
    background: rgb(18 63 154 / 0.45);
  }
  .cards {
    display: grid;
    grid-template-columns: repeat(auto-fill, minmax(13rem, 1fr));
    gap: 0.75rem;
    margin: 0;
    padding: 3px;
    list-style: none;
  }
  .cards > li {
    display: grid;
    min-width: 0;
  }
  .ghost {
    aspect-ratio: 13 / 22;
    background: var(--deep);
    animation: breathe 1.2s steps(4) infinite alternate;
    animation-delay: calc(var(--i) * 90ms);
  }
  .ghost span {
    display: block;
    height: 70%;
    background: rgb(247 247 238 / 0.08);
  }
  @keyframes breathe {
    from { opacity: 0.45; }
    to { opacity: 0.9; }
  }
  .island {
    --frame: 3px;
    display: grid;
    position: relative;
    margin: 3px;
    background: var(--deep);
    box-shadow:
      0 calc(-1 * var(--frame)) 0 0 var(--set),
      0 var(--frame) 0 0 var(--set),
      calc(-1 * var(--frame)) 0 0 0 var(--set),
      var(--frame) 0 0 0 var(--set);
  }
  .plate {
    display: flex;
    flex-wrap: wrap;
    align-items: baseline;
    justify-content: space-between;
    gap: 0 1rem;
    padding: 0.25rem 0.6rem 0.35rem;
  }
  .plate h2 {
    margin: 0;
    font-family: var(--display);
    font-size: 1.8rem;
    font-weight: 400;
    line-height: 1;
    color: var(--set);
  }
  .plate p {
    display: flex;
    flex-wrap: wrap;
    gap: 0 0.9rem;
    margin: 0;
    font-size: 1.15rem;
    line-height: 1.15;
    color: var(--mist);
  }
  .plate b {
    font-weight: 400;
    color: var(--sun);
  }
  .earned {
    display: flex;
    align-items: center;
    gap: 0.4rem;
    margin: 0;
    font-size: 1.3rem;
    color: var(--sun);
  }
  .state {
    display: grid;
    justify-items: center;
    gap: 0.5rem;
    padding: 2rem 1rem 2.25rem;
    text-align: center;
    background: rgb(18 63 154 / 0.45);
  }
  .state h2 {
    margin: 0.2rem 0 0;
    font-family: var(--display);
    font-size: 2rem;
    font-weight: 400;
    line-height: 1;
  }
  .state p {
    margin: 0;
    font-size: 1.25rem;
    line-height: 1.15;
    color: var(--mist);
    max-width: 26rem;
  }
  .small {
    width: auto;
    font-size: 1.5rem;
    padding: 0.4rem 1rem 0.6rem;
  }
  .pair {
    display: flex;
    flex-wrap: wrap;
    justify-content: center;
    gap: 0.75rem;
    margin-top: 0.25rem;
  }
  .trouble {
    display: flex;
    flex-wrap: wrap;
    align-items: center;
    justify-content: space-between;
    gap: 0.4rem 0.75rem;
    margin-bottom: 0.7rem;
    padding: 0.4rem 0.6rem;
    color: var(--ink);
    background: #ffc2d9;
  }
  .claim {
    display: grid;
    gap: 0.4rem;
    margin-bottom: 0.7rem;
    padding: 0.5rem 0.6rem 0.6rem;
    background: var(--deep);
    box-shadow: inset 3px 0 0 var(--sun);
  }
  .claim p {
    margin: 0;
    font-size: 1.25rem;
    line-height: 1.15;
  }
  .claim .btn {
    justify-self: start;
  }
  .trouble p {
    margin: 0;
    font-size: 1.25rem;
    line-height: 1.15;
  }

  @media (max-width: 960px) {
    .shop {
      grid-template-columns: minmax(0, 1fr);
    }
    .side {
      position: static;
    }
    .cards {
      grid-template-columns: repeat(auto-fill, minmax(9.3rem, 1fr));
      gap: 0.6rem;
    }
  }
  @media (max-width: 480px) {
    h1 {
      font-size: 2.4rem;
    }
    .head {
      grid-template-columns: auto minmax(0, 1fr);
      gap: 0.3rem 0.5rem;
    }
    .head .sort {
      grid-column: 2;
    }
    .head p {
      grid-column: 1 / -1;
      grid-row: 2;
      font-size: 1.1rem;
    }
    .tabs button {
      font-size: 1.25rem;
    }
    .islands button {
      flex: 1 1 0;
      padding: 0 0.2rem;
      font-size: 1.1rem;
    }
  }
</style>
