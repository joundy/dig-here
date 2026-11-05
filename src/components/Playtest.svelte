<script lang="ts">
  import { backend } from '../lib/backend';

  let { gameId }: { gameId: string } = $props();

  const SPEEDS = [1, 5, 20];
  const stage = $derived(backend.games.find((g) => g.id === gameId)?.stage);
  const controls = backend.playtest;

  // The game ids start again after a reset, so staying here would show a different room.
  function reset() {
    controls?.reset();
    location.hash = '#/';
  }
</script>

{#if controls}
<details class="playtest">
  <summary>Playtest controls</summary>
  <div class="row" role="group" aria-label="Game speed">
    {#each SPEEDS as speed}
      <button class:on={controls.speed === speed} aria-pressed={controls.speed === speed} onclick={() => (controls.speed = speed)}>×{speed}</button>
    {/each}
  </div>
  <div class="row">
    {#if stage === 'waiting'}
      <button onclick={() => controls.fillRoom(gameId)}>Fill room</button>
      <button onclick={() => controls.startNow(gameId)}>Start now</button>
    {:else if stage === 'live'}
      <button onclick={() => controls.skipToNextClue(gameId)}>Skip to next clue</button>
    {/if}
    <button onclick={() => controls.endNow(gameId)}>End game</button>
    <button onclick={() => controls.forceJackpot(gameId)}>Force jackpot</button>
  </div>
  <div class="row">
    <button onclick={() => controls.endSeason()}>End season</button>
    <button onclick={reset}>Reset everything</button>
  </div>
</details>
{/if}

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
