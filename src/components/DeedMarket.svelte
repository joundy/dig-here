<script lang="ts">
  import { audio } from '../lib/audio/audio.svelte';
  import { backend } from '../lib/backend';
  import { near, percent } from '../lib/format';
  import { landingChance } from '../lib/game/clues';
  import { kindName } from '../lib/game/copy';
  import { deedId } from '../lib/game/economy';
  import { getMap, MAP_IDS } from '../lib/game/map';
  import { RULES } from '../lib/game/rules';
  import type { Kind, MapId } from '../lib/game/types';
  import { openWallet, ui } from '../lib/ui.svelte';
  import { world } from '../lib/world/world';
  import type { DeedMark } from '../lib/world/world';
  import MapBadge from './MapBadge.svelte';
  import Sprite from './Sprite.svelte';

  const calm = matchMedia('(prefers-reduced-motion: reduce)').matches;

  let mapId = $state<MapId>('tropical');
  let selected = $state<number | null>(null);
  let priceNear = $state<number | null>(null);
  let busy = $state(false);
  let error = $state('');
  let note = $state('');

  const me = $derived(backend.account);
  const landmarks = $derived(getMap(mapId).landmarks);
  const landmark = $derived(selected === null ? null : landmarks[selected]);
  const id = $derived(selected === null ? '' : deedId(mapId, selected));
  const deed = $derived(selected === null ? null : backend.deedOf(id));
  const cost = $derived(deed === null ? null : deed.owner === null ? RULES.deedFirstPrice : deed.price);
  const mine = $derived(deed?.owner === me);

  const forSale = $derived(
    landmarks
      .map((l) => {
        const { owner, price } = backend.deedOf(deedId(mapId, l.id));
        return { landmark: l, owner, price: owner === null ? RULES.deedFirstPrice : price };
      })
      .filter((row) => row.price !== null && row.owner !== me)
      .sort((a, b) => a.price! - b.price! || a.landmark.id - b.landmark.id),
  );

  const myDeeds = $derived(
    MAP_IDS.flatMap((map) =>
      getMap(map).landmarks
        .map((l) => ({ map, landmark: l, deed: backend.deedOf(deedId(map, l.id)) }))
        .filter((row) => row.deed.owner === me),
    ),
  );
  const myEarnings = $derived(myDeeds.reduce((sum, row) => sum + row.deed.earned, 0));

  $effect(() => {
    world.showMap(mapId);
  });

  // Every landmark's flag on the map. Unowned ones have none, and can always be bought at the first price.
  $effect(() => {
    void mapId;
    const marks = new Map<number, DeedMark>();
    for (const l of landmarks) {
      const { owner, price } = backend.deedOf(deedId(mapId, l.id));
      if (owner === me) marks.set(l.id, 'mine');
      else if (owner) marks.set(l.id, price === null ? 'owned' : 'sale');
    }
    world.setDeedMarks(marks);
    return () => world.setDeedMarks(null);
  });

  // Changing map clears the ring, even when the new deed has the same number as the old one.
  $effect(() => {
    void mapId;
    world.highlight(selected);
  });

  $effect(() => {
    world.onLandmark = (landmarkId) => select(mapId, landmarkId);
    return () => {
      world.onLandmark = null;
      world.highlight(null);
    };
  });

  function title(kind: Kind, landmarkId: number): string {
    const name = kindName(kind);
    return `${name[0].toUpperCase()}${name.slice(1)} #${landmarkId}`;
  }

  function chance(map: MapId, landmarkId: number): string {
    return `${(landingChance(map)[landmarkId] * 100).toFixed(1)}%`;
  }

  function select(map: MapId, landmarkId: number | null) {
    mapId = map;
    selected = landmarkId;
    error = note = '';
    const price = landmarkId === null ? null : backend.deedOf(deedId(map, landmarkId)).price;
    priceNear = price === null ? null : price / 1000;
  }

  // On a phone the map and the deed panel sit above the lists.
  function selectFromList(map: MapId, landmarkId: number) {
    select(map, landmarkId);
    window.scrollTo({ top: 0, behavior: calm ? 'auto' : 'smooth' });
  }

  async function act(action: () => Promise<void>, done: string) {
    busy = true;
    error = note = '';
    try {
      await action();
      audio.coin();
      note = done;
    } catch (e) {
      error = (e as Error).message;
      audio.error();
    } finally {
      busy = false;
    }
  }

  function buy() {
    if (cost === null) return;
    const balance = backend.balanceOf(me);
    if (balance < cost) {
      openWallet(cost - balance);
      return;
    }
    void act(() => backend.buyDeed(id), 'It\'s yours. Hope the treasure likes it.');
  }

  function list(event: SubmitEvent) {
    event.preventDefault();
    const price = Math.round((Number(priceNear) || 0) * 1000);
    void act(() => backend.listDeed(id, price), `Up for sale at ${near(price)}.`);
  }

  function unlist() {
    priceNear = null;
    void act(() => backend.listDeed(id, null), 'Off the market.');
  }
</script>

<div class="market">
  <h1>Deeds</h1>
  <p class="what">Own a landmark. When the treasure lands there, you get {percent(RULES.deedBps)} of the pot.</p>
  <p class="legend">
    <span><i class="flag mine"></i>Yours</span>
    <span><i class="flag sale"></i>For sale</span>
    <span><i class="flag owned"></i>Owned</span>
    <span>No flag: first sale</span>
  </p>

  <div class="tabs" role="tablist" aria-label="Maps">
    {#each MAP_IDS as map}
      <button role="tab" aria-selected={mapId === map} class:on={mapId === map} onclick={() => select(map, null)}>
        <MapBadge mapId={map} compact />
      </button>
    {/each}
  </div>

  <section class="panel deed">
    {#if landmark && deed}
      <div class="head">
        <span class="art"><Sprite name={landmark.kind} scale={3} /></span>
        <div class="who">
          <h2>{title(landmark.kind, landmark.id)}</h2>
          <p>{mine ? 'You own this' : deed.owner ? `Owned by ${deed.owner}` : 'Nobody owns this'}</p>
        </div>
      </div>
      <dl>
        <div><dt>Price</dt><dd class="price">{cost === null ? 'Not for sale' : near(cost)}</dd></div>
        <div><dt>Chance</dt><dd>{chance(mapId, landmark.id)}</dd></div>
        <div><dt>Landings</dt><dd>{deed.landings}</dd></div>
        <div><dt>Earned</dt><dd>{near(deed.earned)}</dd></div>
      </dl>

      {#if mine}
        <form class="sell" onsubmit={list}>
          <label>
            <span>Price in NEAR</span>
            <input class="input" type="number" bind:value={priceNear} min="0.001" step="any" inputmode="decimal" placeholder="2" disabled={busy} />
          </label>
          <button class="btn" type="submit" disabled={busy}>{deed.price === null ? 'List for sale' : 'Change price'}</button>
        </form>
        {#if deed.price !== null}
          <button class="btn alt" disabled={busy} onclick={unlist}>Take off sale</button>
        {/if}
      {:else if cost !== null}
        <button class="btn" disabled={busy} onclick={buy}>{busy ? 'Signing…' : `Buy for ${near(cost)}`}</button>
      {/if}
      {#if error}<p class="error" role="alert">{error}</p>{/if}
      {#if note}<p class="note" role="status">{note}</p>{/if}
    {:else}
      <p class="prompt">Tap a landmark on the map to see its deed.</p>
    {/if}
  </section>

  <section class="list-block">
    <h2>For sale</h2>
    {#if forSale.length}
      <ul class="list">
        {#each forSale as row (row.landmark.id)}
          <li>
            <button class:on={selected === row.landmark.id} onclick={() => selectFromList(mapId, row.landmark.id)}>
              <Sprite name={row.landmark.kind} scale={1} />
              <span class="name">{title(row.landmark.kind, row.landmark.id)}</span>
              <span class="dim">{chance(mapId, row.landmark.id)}</span>
              <span class="amount">{near(row.price!)}</span>
            </button>
          </li>
        {/each}
      </ul>
    {:else}
      <p class="prompt">Nothing for sale here. Everyone loves their landmark too much.</p>
    {/if}
  </section>

  <section class="list-block">
    <h2>My deeds{#if myDeeds.length}<span class="total">Earned {near(myEarnings)}</span>{/if}</h2>
    {#if myDeeds.length}
      <ul class="list">
        {#each myDeeds as row (deedId(row.map, row.landmark.id))}
          <li>
            <button class:on={mapId === row.map && selected === row.landmark.id} onclick={() => selectFromList(row.map, row.landmark.id)}>
              <Sprite name={row.landmark.kind} scale={1} />
              <span class="name">{title(row.landmark.kind, row.landmark.id)}</span>
              <span class="dim">{row.deed.price === null ? 'Keeping' : `Selling ${near(row.deed.price)}`}</span>
              <span class="amount">{near(row.deed.earned)}</span>
            </button>
          </li>
        {/each}
      </ul>
    {:else}
      <p class="prompt">You own no land. Very modern of you.</p>
    {/if}
  </section>

  <p class="links">
    <a href="#/">Back to games</a>
    <a href="#/season">Season</a>
  </p>
</div>

<style>
  .legend {
    display: flex;
    flex-wrap: wrap;
    gap: 0.15rem 0.75rem;
    margin: 0.3rem 0 0.5rem;
    color: var(--mist);
    font-size: 1.1rem;
    line-height: 1.1;
  }
  .legend span {
    display: inline-flex;
    align-items: center;
    gap: 0.3rem;
  }
  .flag {
    width: 0.7rem;
    height: 0.55rem;
    outline: 2px solid var(--ink);
  }
  .flag.mine { background: #ff5ea8; }
  .flag.sale { background: var(--sun); }
  .flag.owned { background: #c8d4e6; }
  .market {
    display: grid;
    gap: 0.6rem;
  }
  h1 {
    margin: 0;
    font-family: var(--display);
    font-size: 2.6rem;
    font-weight: 400;
    line-height: 1;
    color: var(--sun);
    text-shadow: 3px 3px 0 var(--ink);
  }
  .what {
    margin: 0;
    font-size: 1.3rem;
    line-height: 1.15;
  }
  .tabs {
    display: grid;
    grid-template-columns: repeat(3, 1fr);
    gap: 0.2rem;
  }
  .tabs button {
    display: grid;
    place-items: center;
    min-height: 2.75rem;
    padding: 0;
    font: inherit;
    font-size: 1.3rem;
    background: var(--deep);
    border: 0;
    cursor: pointer;
  }
  .tabs button.on {
    background: var(--sun);
    --mist: var(--ink);
  }
  .deed {
    display: grid;
    gap: 0.5rem;
  }
  .head {
    display: flex;
    align-items: center;
    gap: 0.6rem;
  }
  .art {
    padding: 0.25rem;
    background: var(--deep);
  }
  .who {
    min-width: 0;
  }
  h2 {
    margin: 0;
    font-size: 1.6rem;
    font-weight: 400;
    line-height: 1.05;
  }
  .who p {
    margin: 0;
    overflow: hidden;
    font-size: 1.2rem;
    color: var(--mist);
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  dl {
    display: grid;
    grid-template-columns: 1fr 1fr;
    gap: 0.1rem 1rem;
    margin: 0;
  }
  dl div {
    display: flex;
    justify-content: space-between;
    gap: 0.5rem;
  }
  dt {
    color: var(--mist);
    font-size: 1.2rem;
  }
  dd {
    margin: 0;
    font-size: 1.25rem;
    white-space: nowrap;
    font-variant-numeric: tabular-nums;
  }
  .price {
    color: var(--sun);
  }
  .sell {
    display: grid;
    grid-template-columns: 1fr auto;
    align-items: end;
    gap: 0.5rem;
  }
  .sell label {
    display: grid;
    gap: 0.15rem;
    font-size: 1.1rem;
    color: var(--mist);
  }
  .sell .btn {
    width: auto;
    font-size: 1.5rem;
    white-space: nowrap;
  }
  .note {
    margin: 0;
    color: var(--sun);
    font-size: 1.25rem;
    line-height: 1.1;
  }
  .error {
    margin: 0;
  }
  .prompt {
    margin: 0;
    font-size: 1.25rem;
    line-height: 1.15;
    color: var(--mist);
  }
  .list-block h2 {
    display: flex;
    justify-content: space-between;
    align-items: baseline;
    margin-bottom: 0.25rem;
    font-size: 1.5rem;
  }
  .total {
    font-size: 1.2rem;
    color: var(--sun);
  }
  .list {
    max-height: 12.5rem;
    margin: 0;
    padding: 0;
    overflow-y: auto;
    overscroll-behavior: contain;
    list-style: none;
    background: var(--ink);
  }
  .list button {
    display: flex;
    align-items: center;
    gap: 0.4rem;
    width: 100%;
    min-height: 2.5rem;
    padding: 0.15rem 0.5rem;
    font: inherit;
    font-size: 1.2rem;
    text-align: left;
    color: var(--foam);
    background: none;
    border: 0;
    cursor: pointer;
  }
  .list button.on {
    background: var(--deep);
  }
  @media (hover: hover) {
    .list button:hover {
      background: var(--deep);
    }
  }
  .name {
    flex: 1;
    min-width: 0;
    overflow: hidden;
    white-space: nowrap;
    text-overflow: ellipsis;
  }
  .dim {
    color: var(--mist);
    font-size: 1.1rem;
    white-space: nowrap;
  }
  .amount {
    color: var(--sun);
    white-space: nowrap;
  }
  .links {
    display: flex;
    justify-content: space-between;
    margin: 0;
    font-size: 1.25rem;
  }
</style>
