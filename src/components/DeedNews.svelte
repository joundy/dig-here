<script lang="ts">
  import { backend } from '../lib/backend';
  import { ago, near } from '../lib/format';
  import { kindName } from '../lib/game/copy';
  import { parseDeedId } from '../lib/market';
  import { explorer } from '../lib/near/config';
  import Sprite from './Sprite.svelte';
  import Who from './Who.svelte';

  const SHOWN = 8;

  const sales = $derived(backend.deedNews?.filter((e) => e.kind === 'sold').slice(0, SHOWN) ?? null);
  const me = $derived(backend.account);

  let now = $state(backend.nowMs());

  $effect(() => {
    const timer = setInterval(() => (now = backend.nowMs()), 30_000);
    return () => clearInterval(timer);
  });
</script>

<div class="news">
  <h2>Recent sales</h2>
  {#if sales === null}
    <p class="quiet">Sales history isn't available right now. It comes back with the game server.</p>
  {:else if sales.length === 0}
    <p class="quiet">Nothing has sold yet. The first sale shows up here.</p>
  {:else}
    <ol>
      {#each sales as sale (`${sale.id}${sale.at}`)}
        {@const row = parseDeedId(sale.id)}
        {#if row}
          <li>
            <a class="thumb" href="#/nfts/{sale.id}" aria-label="See the {kindName(row.kind)} NFT"><Sprite name={row.kind} scale={2} /></a>
            <div class="what">
              <a href="#/nfts/{sale.id}">{kindName(row.kind).replace(/^./, (c) => c.toUpperCase())}</a>
              <span class="who">to <Who account={sale.to ?? ''} {me} you="you" link={false} /></span>
            </div>
            <div class="sum">
              <strong>{near(sale.price ?? 0)}</strong>
              <span>
                {#if backend.testnet && sale.tx}<a href={explorer.tx(sale.tx)} target="_blank" rel="noopener">{ago(sale.at, now)}</a>{:else}{ago(sale.at, now)}{/if}
              </span>
            </div>
          </li>
        {/if}
      {/each}
    </ol>
  {/if}
</div>

<style>
  h2 {
    margin: 0 0 0.35rem;
    font-family: var(--display);
    font-size: 1.7rem;
    font-weight: 400;
    line-height: 1;
  }
  .quiet {
    margin: 0;
    color: var(--mist);
    font-size: 1.15rem;
    line-height: 1.15;
  }
  ol {
    display: grid;
    gap: 0.45rem;
    margin: 0;
    padding: 0;
    list-style: none;
  }
  li {
    display: grid;
    grid-template-columns: 2.6rem minmax(0, 1fr) auto;
    align-items: center;
    gap: 0.45rem;
  }
  .thumb {
    display: grid;
    place-items: center;
    height: 2.6rem;
    background: var(--deep);
  }
  .what {
    display: grid;
    min-width: 0;
    line-height: 1.1;
  }
  .what a {
    color: var(--foam);
    text-decoration: none;
    font-size: 1.2rem;
  }
  .who {
    color: var(--mist);
    font-size: 1.05rem;
    overflow: hidden;
    white-space: nowrap;
    text-overflow: ellipsis;
  }
  .sum {
    display: grid;
    justify-items: end;
    line-height: 1.1;
    white-space: nowrap;
  }
  .sum strong {
    font-weight: 400;
    font-size: 1.2rem;
    color: var(--sun);
  }
  .sum span {
    color: var(--mist);
    font-size: 1.05rem;
  }
</style>
