<script lang="ts">
  import { audio } from '../lib/audio/audio.svelte';
  import { backend } from '../lib/backend';
  import { near, percent } from '../lib/format';
  import { kindName } from '../lib/game/copy';
  import { deedChance, deedCount, deedId, deedKinds } from '../lib/game/economy';
  import { MAP_IDS } from '../lib/game/map';
  import { RULES } from '../lib/game/rules';
  import type { Kind, MapId } from '../lib/game/types';
  import { attachFor } from '../lib/pay';
  import { ui } from '../lib/ui.svelte';
  import { world } from '../lib/world/world';
  import MapBadge from './MapBadge.svelte';
  import Sprite from './Sprite.svelte';
  import Who from './Who.svelte';

  type Tab = 'market' | 'mint' | 'all' | 'mine';
  type Row = { map: MapId; kind: Kind; id: string };

  const TABS: { id: Tab; label: string }[] = [
    { id: 'market', label: 'For sale' },
    { id: 'mint', label: 'Mint' },
    { id: 'all', label: 'All NFTs' },
    { id: 'mine', label: 'My NFTs' },
  ];
  const PER_PAGE = 8;
  const allRows: Row[] = MAP_IDS.flatMap((map) => deedKinds(map).map((kind) => ({ map, kind, id: deedId(map, kind) })));

  let tab = $state<Tab>('market');
  let mapFilter = $state<MapId | 'all'>('all');
  let page = $state(0);
  let busyId = $state('');
  let error = $state('');
  let note = $state('');
  let editing = $state('');
  let priceNear = $state<number | null>(null);
  let sending = $state('');
  let sendTo = $state('');

  const me = $derived(backend.account);
  const mintPrice = $derived(backend.prices.mintPrice);
  const perPage = $derived(ui.compact ? 4 : PER_PAGE);

  const matching = $derived.by(() => {
    const onMap = allRows.filter((r) => mapFilter === 'all' || r.map === mapFilter);
    if (tab === 'all') return onMap;
    if (tab === 'mine') return onMap.filter((r) => backend.deedOf(r.id).owner === me);
    if (tab === 'mint') return onMap.filter((r) => backend.deedOf(r.id).owner === null);
    return onMap
      .filter((r) => {
        const { owner, price } = backend.deedOf(r.id);
        return owner !== null && owner !== me && price !== null;
      })
      .sort((a, b) => backend.deedOf(a.id).price! - backend.deedOf(b.id).price! || a.id.localeCompare(b.id));
  });
  const pages = $derived(Math.max(1, Math.ceil(matching.length / perPage)));
  const current = $derived(Math.min(page, pages - 1));
  const rows = $derived(matching.slice(current * perPage, (current + 1) * perPage));
  const myEarnings = $derived(allRows.reduce((sum, r) => {
    const deed = backend.deedOf(r.id);
    return deed.owner === me ? sum + deed.earned : sum;
  }, 0));

  // The map is only the backdrop here. It follows the map filter.
  $effect(() => {
    world.showMap(mapFilter === 'all' ? 'tropical' : mapFilter);
  });

  function choose(next: Tab) {
    tab = next;
    page = 0;
    editing = error = note = '';
  }

  function chooseMap(next: MapId | 'all') {
    mapFilter = next;
    page = 0;
    editing = '';
  }

  function title(kind: Kind): string {
    const name = kindName(kind);
    return `${name[0].toUpperCase()}${name.slice(1)}`;
  }

  /** `action` resolves to false when it stepped aside without doing anything, as when the wallet opened instead. */
  async function act(id: string, action: () => Promise<void | false>, done: string) {
    busyId = id;
    error = note = '';
    try {
      if ((await action()) === false) return;
      audio.coin();
      note = done;
      editing = '';
    } catch (e) {
      error = (e as Error).message;
      audio.error();
    } finally {
      busyId = '';
    }
  }

  function mint(row: Row) {
    void act(row.id, async () => {
      await backend.ensureAccount();
      const attach = await attachFor(`Mint the ${title(row.kind)} NFT`, mintPrice, 50);
      if (attach === null) return false;
      await backend.mintDeed(row.id, attach);
    }, `You minted the ${title(row.kind)} NFT. Keep it, or list it under My NFTs.`);
  }

  function buy(row: Row, price: number) {
    void act(row.id, async () => {
      await backend.ensureAccount();
      // A wallet's own approval tops up whatever's missing, so only the playtest has to have the coins first.
      if (backend.identity.kind !== 'wallet' && (await attachFor('', price, price)) === null) return false;
      await backend.buyDeed(row.id, price);
    }, `The ${title(row.kind)} NFT is yours. Hope the treasure likes it.`);
  }

  function startListing(row: Row) {
    editing = row.id;
    const { price } = backend.deedOf(row.id);
    priceNear = price === null ? null : price / 1000;
    error = note = '';
  }

  function list(event: SubmitEvent, row: Row) {
    event.preventDefault();
    const price = Math.round((Number(priceNear) || 0) * 1000);
    void act(row.id, () => backend.listDeed(row.id, price), `Listed for ${near(price)}.`);
  }

  function send(event: SubmitEvent, row: Row) {
    event.preventDefault();
    const to = sendTo.trim();
    void act(row.id, () => backend.transferDeed(row.id, to), `Sent to ${to}.`);
  }

  function startSending(row: Row) {
    sending = row.id;
    sendTo = '';
    error = note = '';
  }

  function unlist(row: Row) {
    void act(row.id, () => backend.listDeed(row.id, null), 'Off the market. It stays yours.');
  }
</script>

<section class="panel market" class:phone={ui.compact}>
  <h1>NFT market</h1>
  <p class="what">
    Earn {percent(RULES.deedBps)} of the pot when the treasure lands by your kind of landmark.
    Mint a new one for {near(mintPrice)}, or buy one someone has listed.
  </p>

  <div class="tabs" role="tablist" aria-label="NFTs">
    {#each TABS as item}
      <button role="tab" aria-selected={tab === item.id} class:on={tab === item.id} onclick={() => choose(item.id)}>{item.label}</button>
    {/each}
  </div>

  <div class="maps" role="group" aria-label="Filter by map">
    <button class:on={mapFilter === 'all'} aria-pressed={mapFilter === 'all'} onclick={() => chooseMap('all')}>All maps</button>
    {#each MAP_IDS as map}
      <button class:on={mapFilter === map} aria-pressed={mapFilter === map} onclick={() => chooseMap(map)}><MapBadge mapId={map} compact /></button>
    {/each}
  </div>

  {#if error}<p class="error" role="alert">{error}</p>{/if}
  {#if note}<p class="note" role="status">{note}</p>{/if}
  {#if tab === 'mine' && matching.length}<p class="total">Earned so far: {near(myEarnings)}</p>{/if}

  {#if rows.length}
    <ul class="cards">
      {#each rows as row (row.id)}
        {@const deed = backend.deedOf(row.id)}
        {@const mine = deed.owner === me}
        <li class="card" class:mine>
          <div class="art">
            <span class="stack">
              <Sprite name={row.kind} scale={3} />
              {#if row.kind === 'windmill'}<span class="blades"><Sprite name="bladesPlus" scale={3} /></span>{/if}
            </span>
          </div>
          <h2>{title(row.kind)}</h2>
          <div class="where"><MapBadge mapId={row.map} compact /><span>{deedCount(row.map, row.kind)} on the map</span></div>
          <p class="owner">{#if mine}You own this{:else if deed.owner}Owner: <Who account={deed.owner} {me} />{:else}Not minted yet{/if}</p>
          <dl>
            <div><dt>Chance</dt><dd>~{Math.round(deedChance(row.map, row.kind) * 100)}%</dd></div>
            <div><dt>Landed</dt><dd>{deed.landings}</dd></div>
            <div><dt>Earned</dt><dd>{near(deed.earned)}</dd></div>
          </dl>

          {#if editing === row.id}
            <form class="edit" onsubmit={(e) => list(e, row)}>
              <label>
                <span>Your price in NEAR</span>
                <input type="number" bind:value={priceNear} min="0.001" step="any" inputmode="decimal" disabled={busyId === row.id} />
              </label>
              <button class="btn small" type="submit" disabled={busyId === row.id}>{deed.price === null ? 'List it' : 'Save price'}</button>
              <button class="plain" type="button" onclick={() => (editing = '')}>Cancel</button>
            </form>
          {:else if sending === row.id}
            <form class="edit" onsubmit={(e) => send(e, row)}>
              <label>
                <span>Send to account</span>
                <input bind:value={sendTo} placeholder="name.testnet" autocomplete="off" disabled={busyId === row.id} />
              </label>
              <button class="btn small" type="submit" disabled={busyId === row.id || !sendTo.trim()}>{busyId === row.id ? 'Asking your wallet…' : 'Send'}</button>
              <button class="plain" type="button" onclick={() => (sending = '')}>Cancel</button>
            </form>
          {:else if mine}
            {#if deed.price !== null}
              <p class="selling">Listed for <strong>{near(deed.price)}</strong></p>
              <button class="btn small alt" onclick={() => startListing(row)}>Change price</button>
              <button class="plain" disabled={busyId === row.id} onclick={() => unlist(row)}>Take off market</button>
            {:else}
              <p class="selling">Not listed</p>
              <button class="btn small alt" disabled={busyId === row.id} onclick={() => startListing(row)}>List for sale</button>
            {/if}
            {#if backend.canTransferDeeds}
              <button class="plain" onclick={() => startSending(row)}>Send to someone</button>
            {/if}
          {:else if deed.owner === null}
            <button class="btn small" disabled={busyId === row.id} onclick={() => mint(row)}>
              {busyId === row.id ? 'Minting…' : `Mint for ${near(mintPrice)}`}
            </button>
          {:else if deed.price !== null}
            <button class="btn small" disabled={busyId === row.id} onclick={() => buy(row, deed.price!)}>
              {busyId === row.id ? 'Signing…' : `Buy for ${near(deed.price)}`}
            </button>
          {:else}
            <p class="kept">Not for sale</p>
          {/if}
        </li>
      {/each}
    </ul>
  {:else if tab === 'mine'}
    <p class="empty">You own no land. Very modern of you.</p>
  {:else if tab === 'mint'}
    <p class="empty">Every NFT here has been minted. Check For sale.</p>
  {:else}
    <p class="empty">Nothing for sale here. Everyone loves their landmark too much.</p>
  {/if}

  {#if pages > 1}
    <nav class="pager" aria-label="Pages">
      <button aria-label="Previous page" disabled={current === 0} onclick={() => (page = current - 1)}>‹</button>
      <span>{current + 1} / {pages}</span>
      <button aria-label="Next page" disabled={current === pages - 1} onclick={() => (page = current + 1)}>›</button>
    </nav>
  {/if}

  <p class="links"><a href="#/">Back to games</a><a href="#/season">Season</a></p>
</section>

<style>
  .market h1 {
    margin: 0;
    font-family: var(--display);
    font-size: 2.6rem;
    font-weight: 400;
    line-height: 1;
    color: var(--sun);
  }
  .what {
    margin: 0.3rem 0 0.7rem;
    color: var(--mist);
    font-size: 1.2rem;
    line-height: 1.15;
    max-width: 46rem;
  }
  .tabs {
    display: grid;
    grid-template-columns: repeat(4, 1fr);
    gap: 0.35rem;
  }
  .maps {
    display: flex;
    flex-wrap: wrap;
    gap: 0.3rem;
    margin-top: 0.35rem;
  }
  .maps button {
    min-height: 2.5rem;
    padding: 0.1rem 0.6rem;
    font: inherit;
    font-size: 1.15rem;
    line-height: 1;
    color: var(--mist);
    background: none;
    border: 0;
    box-shadow: inset 0 0 0 2px var(--deep);
    cursor: pointer;
  }
  .maps button.on {
    color: var(--foam);
    background: var(--deep);
    box-shadow: inset 0 -3px 0 var(--sun);
  }
  .kept {
    margin: auto 0 0;
    padding: 0.4rem 0;
    color: var(--mist);
    font-size: 1.15rem;
    line-height: 1.1;
    text-align: center;
  }
  .pager {
    display: flex;
    align-items: center;
    justify-content: center;
    gap: 0.6rem;
    margin-top: 0.6rem;
    font-variant-numeric: tabular-nums;
  }
  .pager button {
    width: 2.75rem;
    height: 2.75rem;
    font: inherit;
    font-size: 1.6rem;
    color: var(--foam);
    background: var(--deep);
    border: 0;
    cursor: pointer;
  }
  .pager button:disabled {
    opacity: 0.4;
    cursor: default;
  }
  .tabs button {
    display: flex;
    align-items: center;
    justify-content: center;
    min-height: 2.75rem;
    padding: 0.2rem 0.3rem;
    font: inherit;
    font-size: 1.2rem;
    line-height: 1;
    color: var(--foam);
    background: var(--deep);
    border: 0;
    cursor: pointer;
    transition: transform 0.09s cubic-bezier(0.3, 1.6, 0.6, 1);
  }
  .tabs button:active {
    transform: translateY(2px);
  }
  .tabs button.on {
    color: var(--ink);
    background: var(--sun);
  }
  .note,
  .total {
    margin: 0.5rem 0 0;
    color: var(--sun);
    font-size: 1.2rem;
    line-height: 1.15;
  }
  .cards {
    display: grid;
    grid-template-columns: repeat(4, minmax(0, 1fr));
    gap: 0.5rem;
    margin: 0.7rem 0 0;
    padding: 0;
    list-style: none;
  }
  .phone .cards {
    grid-template-columns: repeat(2, minmax(0, 1fr));
  }
  .card {
    display: flex;
    flex-direction: column;
    gap: 0.2rem;
    min-width: 0;
    padding: 0.5rem;
    background: var(--deep);
    transition: transform 0.12s cubic-bezier(0.3, 1.6, 0.6, 1);
  }
  @media (hover: hover) {
    .card:hover {
      transform: translateY(-3px);
    }
  }
  .card.mine {
    box-shadow: inset 0 0 0 3px var(--pink);
  }
  .art {
    display: grid;
    place-items: center;
    height: 4.6rem;
    background: var(--mist);
    box-shadow: inset 0 -4px 0 #a7bfe6;
  }
  .stack {
    position: relative;
    display: inline-block;
    line-height: 0;
  }
  /* The world draws a windmill's blades separately, so they can spin. */
  .blades {
    position: absolute;
    top: -6px;
    left: 0;
  }
  .card h2 {
    margin: 0.2rem 0 0;
    font-family: var(--display);
    font-size: 1.7rem;
    font-weight: 400;
    line-height: 1;
    overflow-wrap: anywhere;
  }
  .where {
    display: flex;
    flex-wrap: wrap;
    justify-content: space-between;
    gap: 0 0.4rem;
    color: var(--mist);
    font-size: 1.05rem;
    line-height: 1.1;
  }
  .owner {
    margin: 0;
    color: var(--sun);
    font-size: 1.1rem;
    line-height: 1.1;
    overflow: hidden;
    white-space: nowrap;
    text-overflow: ellipsis;
  }
  .mine .owner {
    color: #ffb3d1;
  }
  dl {
    margin: 0 0 0.3rem;
    font-size: 1.1rem;
    line-height: 1.12;
  }
  dl div {
    display: flex;
    justify-content: space-between;
    gap: 0.4rem;
  }
  dt {
    color: var(--mist);
  }
  dd {
    margin: 0;
    font-variant-numeric: tabular-nums;
  }
  .selling {
    margin: auto 0 0;
    font-size: 1.1rem;
    line-height: 1.1;
  }
  .selling strong {
    font-weight: 400;
    color: var(--sun);
  }
  .card > .btn {
    margin-top: auto;
  }
  .card .btn.small {
    font-size: 1.35rem;
    padding: 0.35rem 0.25rem 0.5rem;
    box-shadow: inset 0 -4px 0 #d98f00, inset 0 2px 0 #ffe680;
  }
  .card .btn.small.alt {
    margin-top: 0.25rem;
    color: var(--foam);
    background: var(--sea);
    box-shadow: inset 0 -4px 0 var(--ink);
  }
  .edit {
    display: grid;
    gap: 0.25rem;
    margin-top: auto;
  }
  .edit span {
    display: block;
    color: var(--mist);
    font-size: 1.05rem;
    line-height: 1.1;
  }
  .edit input {
    width: 100%;
    font: inherit;
    font-size: 1.3rem;
    color: var(--ink);
    background: var(--foam);
    border: 0;
    padding: 0.2rem 0.4rem;
  }
  .plain {
    min-height: 2rem;
    font: inherit;
    font-size: 1.1rem;
    color: var(--mist);
    background: none;
    border: 0;
    text-decoration: underline;
    cursor: pointer;
  }
  .empty {
    margin: 1.5rem 0;
    color: var(--mist);
    text-align: center;
  }
  .links {
    display: flex;
    justify-content: space-between;
    margin: 0.8rem 0 0;
    font-size: 1.2rem;
  }
</style>
