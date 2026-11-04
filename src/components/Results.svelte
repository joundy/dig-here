<script lang="ts">
  import { onDestroy, untrack } from 'svelte';
  import { audio } from '../lib/audio/audio.svelte';
  import { bonus, near } from '../lib/format';
  import { kindName } from '../lib/game/clues';
  import type { Game } from '../lib/game/types';
  import { buzz } from '../lib/ui.svelte';
import { world } from '../lib/world/world';
  import Parrot from './Parrot.svelte';

  let { game, me, dramatic = false, ondone }: { game: Game; me: string; dramatic?: boolean; ondone?: () => void } = $props();

  const result = $derived(game.result!);
  const treasure = $derived(result.treasure);
  const isWinner = $derived(result.winner === me);
  const myDig = $derived(result.ranking.find((d) => d.account === me));
  const place = $derived(myDig ? result.ranking.indexOf(myDig) + 1 : 0);

  // Rows land from last place up to first, so the winner is the final beat.
  let revealed = $state(untrack(() => (dramatic ? 0 : result.ranking.length)));
  let announced = $state(untrack(() => !dramatic));
  const timers: ReturnType<typeof setTimeout>[] = [];

  $effect(() => {
    if (!dramatic) return;
    untrack(() => {
      const count = result.ranking.length;
      for (let i = 1; i <= count; i++) {
        timers.push(setTimeout(() => {
          revealed = i;
          audio.scoreRow(i / count);
        }, i * 170));
      }
      timers.push(setTimeout(() => {
        announced = true;
        if (isWinner) {
          buzz([40, 60, 40, 60, 120]);
          audio.fanfare();
          world.celebrate();
        } else if (myDig) {
          audio.lose();
        } else {
          audio.coin();
        }
        ondone?.();
      }, (count + 1) * 170));
    });
  });

  onDestroy(() => timers.forEach(clearTimeout));

  const headline = $derived.by(() => {
    if (isWinner) return `You win ${near(result.prize)}! Squawk!`;
    return `${result.winner} wins ${near(result.prize)}.`;
  });

  const detail = $derived.by(() => {
    const where = `It landed by a ${treasure ? kindName(treasure.landmarkId) : 'mystery'}.`;
    if (isWinner || !myDig) return where;
    return `${where} You came ${place} of ${result.ranking.length}. Better dig next time.`;
  });
</script>

<div class="results">
  {#if game.status === 'refunded'}
    <Parrot text="Not enough players, so no treasure!" plain="A game needs 2 digs. Every entry fee went back." />
  {:else}
    {#if announced}
      <Parrot text={headline} plain={detail} />
    {:else}
      <Parrot text="And the scores are..." />
    {/if}

    <table>
      <thead>
        <tr><th scope="col">Player</th><th scope="col" class="n">Close</th><th scope="col" class="n">Bonus</th><th scope="col" class="n">Score</th></tr>
      </thead>
      <tbody>
        {#each result.ranking as d, i (d.account)}
          {@const visible = result.ranking.length - i <= revealed}
          <tr class:win={i === 0 && visible} class:me={d.account === me} class:visible>
            <td>{d.account === me ? 'You' : d.account}</td>
            <td class="n">{d.closeness}</td>
            <td class="n">{bonus(d.bonus)}</td>
            <td class="n">{d.score}</td>
          </tr>
        {/each}
      </tbody>
    </table>

    <p class="host">
      {game.host === me ? `You hosted, so you keep ${near(result.hostCut)}.` : `Host ${game.host} keeps ${near(result.hostCut)} of the ${near(result.pot)} pot.`}
    </p>
  {/if}

  <a class="btn" href="#/">Find another game</a>
</div>

<style>
  table {
    width: 100%;
    margin: 0.9rem 0 0.6rem;
    border-collapse: collapse;
    font-size: 1.35rem;
    line-height: 1.1;
    font-variant-numeric: tabular-nums;
  }
  th {
    text-align: left;
    font-weight: 400;
    color: var(--mist);
    font-size: 1.15rem;
    padding: 0 0 0.15rem;
  }
  td {
    padding: 0.14rem 0;
    overflow-wrap: anywhere;
  }
  tbody tr {
    opacity: 0;
    transform: translateX(14px);
    transition: opacity 0.14s ease-out, transform 0.18s cubic-bezier(0.3, 1.5, 0.6, 1);
  }
  tbody tr.visible {
    opacity: 1;
    transform: none;
  }
  .n {
    text-align: right;
    padding-left: 0.75rem;
  }
  .win td {
    color: var(--sun);
  }
  .me td {
    color: #ffb3d1;
  }
  .win.me td {
    color: var(--sun);
  }
  .results :global(.btn) {
    position: sticky;
    bottom: 0;
  }
  .host {
    margin: 0 0 1rem;
    color: var(--mist);
    font-size: 1.2rem;
    line-height: 1.15;
  }
</style>
