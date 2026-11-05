<script lang="ts">
  import { backend } from '../lib/backend';
  import { timeLeft } from '../lib/board';
  import { clock, near, percent } from '../lib/format';
  import { potOf } from '../lib/game/engine';
  import type { Game } from '../lib/game/types';
  import { isBot, shortName } from '../lib/names';
  import { ui } from '../lib/ui.svelte';
  import MapBadge from './MapBadge.svelte';

  let { game }: { game: Game } = $props();

  const me = $derived(backend.account);
  const record = $derived(backend.hostRecord(game.host));
  const joined = $derived(game.players.includes(me));
  const over = $derived(game.stage === 'finished' || game.stage === 'refunded');
  const left = $derived(timeLeft(game));
  const time = $derived.by(() => {
    if (game.stage === 'live') return `${clock(left)} left`;
    return game.startIn !== null ? `Starts in ${clock(left)}` : `Closes in ${clock(left)}`;
  });
  const soon = $derived(game.stage === 'live' ? left <= 20 : game.startIn !== null);
  const result = $derived(game.result);
  const winner = $derived(result?.winner === me ? 'You won' : result?.winner && shortName(result.winner));

  // The finished list is a short summary. The card fills in once it's on screen.
  $effect(() => {
    if (over && !game.landmarks.length) void backend.loadGame(game.id);
  });
</script>

<a class="card" class:mine={joined} class:over class:compact={ui.compact} href="#/game/{game.id}">
  <span class="title">
    <span class="name">{game.name}</span>
    {#if joined}
      <span class="tag">You're in</span>
    {:else if game.host === me}
      <span class="tag">Your room</span>
    {/if}
  </span>
  <span class="map"><MapBadge mapId={game.mapId} compact /></span>
  <span class="fee">{near(game.fee)}</span>

  {#if over}
    <span class="result">
      {#if result?.winner}
        <span class="winner">{#if result.winner !== me}<span class="wordy">{'Won by '}</span>{/if}{winner}{#if isBot(result.winner)}<span class="bot">bot</span>{/if}</span>
        {#if result.split.prize}<span class="prize">{near(result.split.prize)}</span>{/if}
      {:else}
        <span class="refunded">Refunded</span>
      {/if}
    </span>
  {:else}
    <span class="players">{game.players.length}/{game.maxPlayers}<span class="wordy">{' players'}</span></span>
    <span class="time" class:soon>{time}</span>
    <span class="fill" aria-hidden="true"><span style:width="{(game.players.length / game.maxPlayers) * 100}%"></span></span>
  {/if}

  {#if !over || game.landmarks.length}<span class="small cut">Host keeps {percent(game.hostCutBps)}</span>{/if}
  <span class="small pot">Pot {near(potOf(game))}</span>
  <span class="small record">Host: {record.finished} finished, {record.expired} expired</span>
</a>

<style>
  .bot {
    margin-left: 0.3rem;
    padding: 0 0.2rem;
    font-size: 0.85em;
    color: var(--ink);
    background: var(--mist);
  }
  .card {
    display: grid;
    grid-template-columns: minmax(0, 1fr) auto;
    grid-template-areas:
      'title title'
      'map fee'
      'players time'
      'fill fill'
      'cut pot'
      'record record';
    align-items: center;
    align-content: start;
    gap: 0.2rem 0.5rem;
    height: 100%;
    padding: 0.45rem 0.65rem 0.5rem;
    color: inherit;
    text-decoration: none;
    background: var(--deep);
    box-shadow: inset 0 0 0 var(--px) transparent;
    transition: transform 0.12s cubic-bezier(0.3, 1.6, 0.6, 1), background 0.12s;
  }
  .card.over {
    grid-template-areas:
      'title title'
      'map fee'
      'result result'
      'cut pot'
      'record record';
  }
  /* A phone shows four of these at once, so each gets three lines. The pot is fee times players. */
  .card.compact {
    grid-template-columns: auto minmax(0, 1fr) auto;
    grid-template-areas:
      'title title fee'
      'map players time'
      'fill fill fill'
      'cut record record';
    gap: 0.1rem 0.5rem;
    padding: 0.3rem 0.55rem 0.35rem;
  }
  .card.compact.over {
    grid-template-areas:
      'title title fee'
      'map result result'
      'cut record record';
  }
  .card.compact .pot,
  .card.compact .wordy {
    display: none;
  }
  .card.compact .record {
    text-align: right;
  }
  .card.compact .players {
    justify-self: center;
  }
  .card.mine {
    box-shadow: inset 0 0 0 var(--px) var(--sun);
  }
  .card:active {
    transform: translateY(2px);
    background: #0e327d;
  }
  @media (hover: hover) {
    .card:hover {
      transform: translateY(-4px);
      background: #1a4db3;
    }
    .card:hover .name {
      color: var(--sun);
    }
  }
  .title {
    grid-area: title;
    display: flex;
    align-items: center;
    gap: 0.5rem;
    min-width: 0;
  }
  .name {
    min-width: 0;
    overflow: hidden;
    font-size: 1.55rem;
    line-height: 1.1;
    white-space: nowrap;
    text-overflow: ellipsis;
  }
  .tag {
    flex: none;
    padding: 0 0.3rem;
    font-size: 1.05rem;
    line-height: 1.2;
    color: var(--ink);
    background: var(--sun);
  }
  .map {
    grid-area: map;
    font-size: 1.2rem;
  }
  .fee {
    grid-area: fee;
    font-size: 1.4rem;
    line-height: 1.1;
    color: var(--sun);
    white-space: nowrap;
    text-align: right;
  }
  .players,
  .time,
  .result {
    font-size: 1.25rem;
    line-height: 1.1;
    white-space: nowrap;
  }
  .players {
    grid-area: players;
  }
  .time {
    grid-area: time;
    text-align: right;
    font-variant-numeric: tabular-nums;
  }
  .soon,
  .prize {
    color: var(--sun);
  }
  .result {
    grid-area: result;
    display: flex;
    justify-content: space-between;
    gap: 0.5rem;
    min-width: 0;
  }
  .refunded {
    color: var(--mist);
  }
  .winner {
    min-width: 0;
    overflow: hidden;
    text-overflow: ellipsis;
  }
  .fill {
    grid-area: fill;
    display: block;
    height: var(--px);
    background: var(--ink);
  }
  .fill span {
    display: block;
    height: 100%;
    background: var(--sun);
    transition: width 0.3s steps(6);
  }
  .small {
    overflow: hidden;
    font-size: 1.1rem;
    line-height: 1.1;
    color: var(--mist);
    white-space: nowrap;
    text-overflow: ellipsis;
  }
  .cut {
    grid-area: cut;
  }
  .pot {
    grid-area: pot;
    text-align: right;
  }
  .record {
    grid-area: record;
  }
</style>
