<script lang="ts">
  import { backend } from '../lib/backend';
  import { near } from '../lib/format';
  import { kindName, mapName } from '../lib/game/copy';
  import { deedChance } from '../lib/game/economy';
  import type { DeedRow } from '../lib/market';
  import { ui } from '../lib/ui.svelte';
  import DeedArt from './DeedArt.svelte';
  import Sprite from './Sprite.svelte';
  import Who from './Who.svelte';

  let { row, onopen }: { row: DeedRow; onopen?: () => void } = $props();

  const me = $derived(backend.account);
  const deed = $derived(backend.deedOf(row.id));
  const mine = $derived(!!me && deed.owner === me);
  const listed = $derived(deed.owner !== null && deed.price !== null);
  const title = $derived(kindName(row.kind).replace(/^./, (c) => c.toUpperCase()));
  const chance = $derived(Math.round(deedChance(row.map, row.kind) * 100));
  const scale = $derived(ui.compact ? 4 : 5);
  const amount = (milli: number) => near(milli).replace(' NEAR', '');
</script>

<a class="card {row.map}" class:mine href="#/deeds/{row.id}" onclick={onopen}>
  <div class="frame">
    <DeedArt map={row.map} kind={row.kind} {scale} alt="{title}, {mapName(row.map)}" />
    {#if mine}<span class="tag">{listed ? 'Your listing' : 'Yours'}</span>{/if}
  </div>
  <div class="info">
    <h3>{title}</h3>
    <p class="facts">
      <span class="set">{mapName(row.map).split(' ')[0]}</span>
      <span title="Roughly how often the treasure lands by this kind">{chance}% chance</span>
    </p>
    <p class="owner">
      {#if mine}You own this{:else if deed.owner}Owner <span class="who"><Who account={deed.owner} {me} link={false} /></span>{:else}No owner yet{/if}
    </p>
    <p class="deal">
      {#if listed}
        <Sprite name="coin" scale={2} />
        <strong>{amount(deed.price!)}<small>NEAR</small></strong>
        {#if deed.saleInProgress}<span class="cta busy">Selling</span>{:else}<span class="cta">{mine ? 'Manage' : 'Buy'}</span>{/if}
      {:else if deed.owner === null}
        <strong class="mint">{amount(backend.prices.mintPrice)}<small>NEAR</small></strong>
        <span class="cta">Mint</span>
      {:else}
        <span class="kept">{mine ? 'Not listed' : 'Not for sale'}</span>
        {#if mine}<span class="cta">Manage</span>{/if}
      {/if}
    </p>
  </div>
</a>

<style>
  .card {
    --frame: 3px;
    display: flex;
    flex-direction: column;
    min-width: 0;
    color: var(--foam);
    text-decoration: none;
    background: var(--deep);
    box-shadow:
      0 calc(-1 * var(--frame)) 0 0 var(--set),
      0 var(--frame) 0 0 var(--set),
      calc(-1 * var(--frame)) 0 0 0 var(--set),
      var(--frame) 0 0 0 var(--set);
    transition: transform 0.12s cubic-bezier(0.3, 1.6, 0.6, 1);
  }
  @media (hover: hover) {
    .card:hover {
      transform: translateY(-4px);
    }
    .card:hover .cta {
      color: var(--ink);
      background: var(--sun);
    }
  }
  .card:active {
    transform: translateY(2px);
  }
  .frame {
    position: relative;
    aspect-ratio: 4 / 5;
  }
  .tag {
    position: absolute;
    top: 0;
    left: 0;
    padding: 0.05rem 0.45rem 0.15rem;
    font-size: 1.1rem;
    line-height: 1.1;
    color: var(--ink);
    background: var(--pink);
  }
  .info {
    display: grid;
    gap: 0.1rem;
    padding: 0.35rem 0.5rem 0.5rem;
    border-top: var(--frame) solid var(--ink);
  }
  h3 {
    margin: 0;
    min-width: 0;
    font-family: var(--display);
    font-size: 1.75rem;
    font-weight: 400;
    line-height: 1;
    overflow: hidden;
    white-space: nowrap;
    text-overflow: ellipsis;
  }
  .facts {
    display: flex;
    justify-content: space-between;
    gap: 0.4rem;
    margin: 0;
    font-size: 1.1rem;
    line-height: 1.1;
    color: var(--mist);
    white-space: nowrap;
  }
  .set {
    color: var(--set);
  }
  .owner {
    margin: 0;
    font-size: 1.1rem;
    line-height: 1.15;
    color: var(--mist);
    overflow: hidden;
    white-space: nowrap;
    text-overflow: ellipsis;
  }
  .who {
    color: var(--foam);
  }
  .mine .owner {
    color: #ffb3d1;
  }
  .deal {
    display: flex;
    align-items: center;
    gap: 0.3rem;
    min-height: 2rem;
    margin: 0.15rem 0 0;
    white-space: nowrap;
  }
  .deal strong {
    font-family: var(--display);
    font-size: 1.6rem;
    font-weight: 400;
    line-height: 1;
    color: var(--sun);
    min-width: 0;
    overflow: hidden;
    text-overflow: ellipsis;
  }
  .deal small {
    margin-left: 0.2em;
    font-family: var(--body);
    font-size: 0.65em;
  }
  .deal strong.mint {
    color: var(--foam);
  }
  .cta {
    margin-left: auto;
    padding: 0.05rem 0.5rem 0.2rem;
    font-size: 1.2rem;
    line-height: 1.2;
    color: var(--foam);
    background: var(--sea);
    transition: none;
  }
  .cta.busy {
    color: var(--mist);
    background: none;
  }
  .kept {
    font-size: 1.15rem;
    color: var(--mist);
  }
</style>
