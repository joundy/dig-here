<script lang="ts">
  import { flip } from 'svelte/animate';
  import { backend } from '../lib/backend';
  import { clock, near, percent } from '../lib/format';
  import { potOf, secondsLeft } from '../lib/game/engine';
  import Parrot from './Parrot.svelte';

  const open = $derived(backend.games.filter((g) => g.status === 'open'));
  const done = $derived(backend.games.filter((g) => g.status !== 'open').slice(0, 4));
</script>

<Parrot
  text="The treasure doesn't exist yet. Squawk!"
  plain="Clues narrow it down, then the game picks the spot when the timer ends. Dig early and your dig counts for more."
/>

<a class="btn host" href="#/new">Host a game</a>

<h2>Open games</h2>
<ul class="games">
  {#each open as game (game.id)}
    <li animate:flip={{ duration: 220 }}>
      <a class="game" href="#/game/{game.id}">
        <span class="name">{game.name}</span>
        <span class="time" class:soon={secondsLeft(game) <= 20}>{clock(secondsLeft(game))}</span>
        <span class="sub">Clue {game.clues.length} of 3, {game.digs.length} {game.digs.length === 1 ? 'player' : 'players'}</span>
        <span class="sub right">Pot {near(potOf(game))}</span>
        <span class="sub">Host keeps {percent(game.hostCutBps)}</span>
        <span class="sub right">{near(game.fee)} to enter</span>
      </a>
    </li>
  {/each}
</ul>

{#if done.length}
  <h2>Just finished</h2>
  <ul class="games">
    {#each done as game (game.id)}
      <li animate:flip={{ duration: 220 }}>
        <a class="game" href="#/game/{game.id}">
          <span class="name">{game.name}</span>
          <span class="sub right">{near(game.result?.prize ?? 0)}</span>
          <span class="sub whole">
            {game.status === 'refunded' ? 'Too few players, everyone refunded' : `Won by ${game.result?.winner}`}
          </span>
        </a>
      </li>
    {/each}
  </ul>
{/if}

<style>
  .host {
    margin-top: 1rem;
  }
  h2 {
    font-size: 1.5rem;
    font-weight: 400;
    line-height: 1;
    margin: 1.25rem 0 0.4rem;
  }
  .games {
    list-style: none;
    margin: 0;
    padding: 0;
    display: grid;
    gap: 0.5rem;
  }
  .game {
    display: grid;
    grid-template-columns: 1fr auto;
    gap: 0 1rem;
    padding: 0.5rem 0.75rem;
    background: var(--deep);
    color: inherit;
    text-decoration: none;
    transition: transform 0.12s cubic-bezier(0.3, 1.6, 0.6, 1), background 0.12s;
  }
  .game:active {
    background: var(--ink);
  }
  @media (hover: hover) {
    .game:hover {
      transform: translateX(-5px);
      background: var(--ink);
    }
    .game:hover .name {
      color: var(--sun);
    }
  }
  .name, .time {
    font-size: 1.6rem;
    line-height: 1.1;
  }
  .time {
    text-align: right;
    font-variant-numeric: tabular-nums;
  }
  .soon {
    color: var(--sun);
  }
  .sub {
    color: var(--mist);
    font-size: 1.2rem;
    line-height: 1.15;
  }
  .right {
    text-align: right;
  }
  .whole {
    grid-column: 1 / -1;
  }
</style>
