<script lang="ts">
  import { untrack } from 'svelte';
  import { bonus, clock } from '../lib/format';
  import { clueText } from '../lib/game/copy';
  import { secondsLeft, secondsToNextClue } from '../lib/game/engine';
  import { RULES } from '../lib/game/rules';
  import type { Game } from '../lib/game/types';
  import { ui } from '../lib/ui.svelte';
  import Parrot from './Parrot.svelte';

  let { game }: { game: Game } = $props();

  const SCHEDULE = RULES.clueSchedule;

  let height = $state(window.innerHeight);

  // Opening a round already under way shows its clues as they are, with no pop for the old ones.
  const restored = untrack(() => game.elapsed > 3);
  const shownOnEntry = untrack(() => (restored ? game.clues.length : 0));

  const count = $derived(game.clues.length);
  const newest = $derived(game.clues[count - 1]);
  const left = $derived(secondsLeft(game));
  const nextIn = $derived(secondsToNextClue(game));
  const spots = $derived(game.candidateIds.length);
  const progress = $derived(Math.min(100, (game.elapsed / game.durationSec) * 100));

  // Four clue lines have to fit around the map, so short screens lose the joke first.
  const joke = $derived(newest && (!(ui.compact || ui.short) || height >= 680));

  /** The full YOLO wording only fits on one line while it's the big newest row on a wide screen. */
  function wording(index: number): string {
    const clue = game.clues[index];
    if (clue.level === 'yolo' && (ui.compact || index < count - 1)) return 'YOLO: no clue';
    return clueText(game.mapId, clue).plain;
  }
</script>

<svelte:window bind:innerHeight={height} />

<div class="trail">
  {#if joke && newest}
    <Parrot text={clueText(game.mapId, newest).text} compact={ui.compact} instant={restored && count === shownOnEntry} />
  {/if}

  <div class="head">
    <div class="track" aria-hidden="true">
      <div class="bar"><div class="fill" style:width="{progress}%"></div></div>
      {#each SCHEDULE as stop, i}
        <span class="stop" class:first={i === 0} class:passed={i < count - 1} class:current={i === count - 1} style:left="{stop.startsAt}%"></span>
        <span class="label" class:first={i === 0} class:current={i === count - 1} style:left="{stop.startsAt}%">{bonus(stop.bonusBps)}</span>
      {/each}
    </div>
    <div class="clock" class:urgent={left <= 10} role="timer">
      <strong>{clock(left)}</strong>
    </div>
  </div>

  <span class="sr-only" aria-live="polite">{count ? wording(count - 1) : ''}</span>

  <ol class="rows">
    {#each SCHEDULE as _, i}
      {#if i < count}
        <li class:newest={i === count - 1} class:pop={i === count - 1 && i >= shownOnEntry} class:yolo={game.clues[i].level === 'yolo'}>
          <span class="n">{i + 1}</span>
          <span class="text">{wording(i)}</span>
        </li>
      {:else if i === count}
        <li class="locked">
          <span class="n">{i + 1}</span>
          <svg class="lock" viewBox="0 0 7 8" aria-hidden="true" shape-rendering="crispEdges">
            <path fill="currentColor" d="M2 0h3v1h1v2h1v5H0V3h1V1h1zm0 1v2h3V1z" fill-rule="evenodd" />
          </svg>
          <span class="text">{(nextIn ?? 0) > 0 ? `Unlocks in ${clock(nextIn ?? 0)}` : 'Unlocking…'}</span>
        </li>
      {:else}
        <li class="hidden">
          <span class="n">{i + 1}</span>
          <span class="text">???</span>
        </li>
      {/if}
    {/each}
  </ol>

  <p class="spots">{spots} {spots === 1 ? 'spot' : 'spots'} possible, {spots === 1 ? '100%' : `about ${Math.round(100 / spots)}% each`}</p>
</div>

<style>
  .trail {
    display: grid;
    gap: 0.5rem;
    min-width: 0;
  }
  .head {
    display: flex;
    align-items: flex-start;
    gap: 0.9rem;
    min-width: 0;
  }
  .track {
    position: relative;
    flex: 1;
    min-width: 0;
    height: 2.6rem;
  }
  .bar {
    position: absolute;
    top: 3px;
    left: 0;
    right: 0;
    height: 10px;
    background: var(--deep);
  }
  .fill {
    height: 100%;
    background: var(--sun);
    transition: width 0.25s linear;
  }
  .stop {
    position: absolute;
    top: 0;
    width: 16px;
    height: 16px;
    margin-left: -8px;
    background: var(--deep);
    box-shadow: inset 0 0 0 3px var(--ink);
  }
  .stop.first {
    margin-left: 0;
  }
  .stop.passed {
    background: var(--sun);
  }
  .stop.current {
    background: var(--sun);
    box-shadow: inset 0 0 0 3px var(--ink), 0 0 10px 3px var(--sun);
    animation: glow 0.6s steps(2) infinite alternate;
  }
  .label {
    position: absolute;
    top: 1.15rem;
    transform: translateX(-50%);
    color: var(--mist);
    font-size: 1.2rem;
    line-height: 1;
    white-space: nowrap;
    font-variant-numeric: tabular-nums;
  }
  .label.first {
    transform: none;
  }
  .label.current {
    color: var(--sun);
  }
  .clock {
    flex: none;
  }
  .clock strong {
    display: block;
    font-family: var(--display);
    font-weight: 400;
    font-size: 3.4rem;
    line-height: 0.85;
    font-variant-numeric: tabular-nums;
  }
  .urgent strong {
    color: #ff8a8a;
    animation: throb 0.5s steps(2) infinite alternate;
  }
  .rows {
    list-style: none;
    margin: 0;
    padding: 0;
    display: grid;
    gap: 0.15rem;
    min-width: 0;
  }
  li {
    display: flex;
    align-items: center;
    gap: 0.45rem;
    min-width: 0;
    color: var(--foam);
    font-size: 1.3rem;
    line-height: 1.1;
  }
  .n {
    flex: none;
    width: 1.25em;
    text-align: center;
    color: var(--mist);
    background: var(--deep);
  }
  .text {
    min-width: 0;
  }
  .newest {
    align-items: flex-start;
    font-family: var(--display);
    font-size: 2rem;
    line-height: 1;
    color: var(--sun);
  }
  .newest .n {
    color: var(--ink);
    background: var(--sun);
  }
  .yolo.newest {
    color: #ffb3d1;
  }
  .yolo.newest .n {
    background: var(--pink);
  }
  .pop {
    animation: pop 0.34s cubic-bezier(0.3, 1.6, 0.6, 1);
    transform-origin: left center;
  }
  .locked,
  .hidden {
    color: var(--mist);
  }
  .hidden {
    opacity: 0.6;
  }
  .lock {
    flex: none;
    width: 14px;
    height: 16px;
    color: var(--sun);
  }
  .spots {
    margin: 0;
    color: var(--foam);
    font-size: 1.3rem;
    line-height: 1.1;
  }
  /* Phone upright: every row is one line, and it all fits around the map at 360×640. */
  :global(.stage.compact.game) .trail {
    gap: 0.2rem;
  }
  :global(.stage.compact.game) .head {
    align-items: center;
    gap: 0.6rem;
  }
  :global(.stage.compact.game) .track {
    height: 2rem;
  }
  :global(.stage.compact.game) .label {
    top: 1rem;
    font-size: 1.05rem;
  }
  :global(.stage.compact.game) .clock strong {
    font-size: 2.5rem;
  }
  :global(.stage.compact.game) .rows {
    gap: 0;
  }
  :global(.stage.compact.game) li {
    font-size: 1.15rem;
    line-height: 1.08;
  }
  :global(.stage.compact.game) .newest {
    font-size: 1.5rem;
    line-height: 1;
  }
  :global(.stage.compact.game) .text {
    overflow: hidden;
    white-space: nowrap;
    text-overflow: ellipsis;
  }
  :global(.stage.compact.game) .lock {
    width: 10px;
    height: 12px;
  }
  :global(.stage.compact.game) .spots {
    font-size: 1.15rem;
    line-height: 1.08;
  }
  :global(.stage.short) .clock strong {
    font-size: 2.6rem;
  }
  @keyframes glow {
    to { box-shadow: inset 0 0 0 3px var(--ink), 0 0 4px 1px var(--sun); }
  }
  @keyframes pop {
    from { transform: scale(1.35); opacity: 0.2; }
  }
  @keyframes throb {
    to { transform: scale(1.06); }
  }
</style>
