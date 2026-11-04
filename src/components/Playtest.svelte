<script lang="ts">
  import { dummy } from '../lib/backend/dummy.svelte';

  let { gameId }: { gameId: string } = $props();

  const SPEEDS = [1, 5, 20];
  const stage = $derived(dummy.games.find((g) => g.id === gameId)?.stage);

  // The game ids start again after a reset, so staying here would show a different room.
  function reset() {
    dummy.reset();
    location.hash = '#/';
  }
</script>

<details class="playtest">
  <summary>Playtest controls</summary>
  <div class="row" role="group" aria-label="Game speed">
    {#each SPEEDS as speed}
      <button class:on={dummy.speed === speed} aria-pressed={dummy.speed === speed} onclick={() => (dummy.speed = speed)}>×{speed}</button>
    {/each}
  </div>
  <div class="row">
    {#if stage === 'waiting'}
      <button onclick={() => dummy.fillRoom(gameId)}>Fill room</button>
      <button onclick={() => dummy.startNow(gameId)}>Start now</button>
    {:else if stage === 'live'}
      <button onclick={() => dummy.skipToNextClue(gameId)}>Skip to next clue</button>
    {/if}
    <button onclick={() => dummy.endNow(gameId)}>End game</button>
    <button onclick={() => dummy.forceJackpot(gameId)}>Force jackpot</button>
  </div>
  <div class="row">
    <button onclick={() => dummy.endSeason()}>End season</button>
    <button onclick={reset}>Reset everything</button>
  </div>
</details>

<style>
  .playtest {
    margin-top: 1.25rem;
    font-size: 1.25rem;
  }
  summary {
    cursor: pointer;
  }
  :global(.stage.compact.game) .playtest {
    margin-top: 0.35rem;
  }
  .row {
    display: flex;
    flex-wrap: wrap;
    gap: 0.4rem;
    margin-top: 0.5rem;
  }
  button {
    font: inherit;
    line-height: 1.1;
    color: var(--foam);
    background: var(--deep);
    border: 0;
    padding: 0.55rem 0.7rem;
    cursor: pointer;
    transition: transform 0.09s cubic-bezier(0.3, 1.6, 0.6, 1);
  }
  @media (hover: hover) {
    button:hover {
      transform: translateY(-2px);
    }
  }
  button:active {
    transform: translateY(2px);
  }
  button.on {
    background: var(--foam);
    color: var(--ink);
  }
</style>
