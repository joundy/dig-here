<script lang="ts">
  import { untrack } from 'svelte';
  import { flip } from 'svelte/animate';
  import { fly } from 'svelte/transition';
  import { audio } from '../lib/audio/audio.svelte';
  import { backend } from '../lib/backend';
  import { clock, near, percent } from '../lib/format';
  import { RULES } from '../lib/game/rules';
  import type { Game } from '../lib/game/types';
  import { attachFor } from '../lib/pay';
  import { ui } from '../lib/ui.svelte';
  import MapBadge from './MapBadge.svelte';
  import Playtest from './Playtest.svelte';
  import Who from './Who.svelte';

  let { game, me }: { game: Game; me: string } = $props();

  let busy = $state(false);
  let error = $state('');

  const count = $derived(game.players.length);
  const joined = $derived(game.players.includes(me));
  const full = $derived(count >= game.maxPlayers);
  const need = $derived(game.minPlayers - count);
  const deadline = $derived(Math.max(0, RULES.waitingDeadlineSec - game.waited));

  const status = $derived.by(() => {
    if (game.startIn !== null) return `Starting in ${clock(game.startIn)}`;
    if (need > 0) return `Need ${need} more`;
    return game.host === me ? 'Ready when you are' : 'Waiting for the host';
  });
  const small = $derived(need > 0 ? `Everyone gets refunded in ${clock(deadline)} if it doesn't fill.` : game.startIn === null ? `Starts by itself in ${clock(deadline)}.` : '');

  let seen = untrack(() => game.players.length);
  $effect(() => {
    const n = game.players.length;
    if (n > seen) {
      untrack(() => {
        audio.join();
        audio.roomFilling(n / game.maxPlayers);
      });
    }
    seen = n;
  });

  async function run(action: () => Promise<void>) {
    error = '';
    busy = true;
    try {
      await action();
    } catch (e) {
      error = (e as Error).message;
      audio.error();
    } finally {
      busy = false;
    }
  }

  function join() {
    void run(async () => {
      await backend.ensureAccount();
      const attach = await attachFor('Entry fee', game.fee, game.fee);
      if (attach === null) return;
      await backend.join(game.id, attach);
    });
  }

  function leave() {
    void run(async () => {
      await backend.leave(game.id);
      audio.refund();
    });
  }
</script>

<div class="top">
  <p class="round-crumb"><a href="#/">Game board</a></p>
  <div class="title">
    <h2>{game.name}</h2>
    <MapBadge mapId={game.mapId} compact={ui.compact} />
  </div>
  <ul class="facts">
    <li>Host <Who account={game.host} {me} you="you" /></li>
    <li>Entry {near(game.fee)}</li>
    <li>Round {clock(game.durationSec)}</li>
    <li>Host keeps {percent(game.hostCutBps)}</li>
  </ul>
</div>

<div class="bottom waiting-panel">
  <div class="players-bar">
    <div class="track" role="img" aria-label="{count} of {game.maxPlayers} players, {game.minPlayers} needed">
      <div class="fill" class:ready={need <= 0} style:width="{(count / game.maxPlayers) * 100}%"></div>
      <span class="minimum" style:left="{(game.minPlayers / game.maxPlayers) * 100}%"></span>
    </div>
    <span class="tally">{count} / {game.maxPlayers}</span>
  </div>

  <p class="status" class:go={game.startIn !== null} role="timer">{status}</p>
  {#if small}<p class="small">{small}</p>{/if}

  {#if error}<p class="error" role="alert">{error}</p>{/if}

  <div class="buttons" class:pair={game.host === me && need <= 0}>
    {#if game.host === me && need <= 0}
      <button class="btn" onclick={() => run(() => backend.start(game.id))} disabled={busy}>Start now</button>
    {/if}
    {#if joined}
      <button class="leave" onclick={leave} disabled={busy}>{busy ? 'One moment…' : `Leave and get ${near(game.fee)} back`}</button>
    {:else if full}
      <button class="btn" disabled>Room is full</button>
    {:else}
      <button class="btn" onclick={join} disabled={busy}>{busy ? 'Joining…' : `Join for ${near(game.fee)}`}</button>
    {/if}
  </div>

  <p class="hint">Study the map. Tap things.</p>

  <ul class="players">
    {#each game.players as player (player)}
      <li class:me={player === me} in:fly={{ y: 10, duration: 220 }} animate:flip={{ duration: 180 }}><Who account={player} {me} /></li>
    {:else}
      <li class="empty">Nobody yet. Be the first!</li>
    {/each}
  </ul>

  <Playtest gameId={game.id} />
</div>

<style>
  .title {
    display: flex;
    flex-wrap: wrap;
    align-items: center;
    justify-content: space-between;
    gap: 0.25rem 0.75rem;
  }
  h2 {
    margin: 0;
    min-width: 0;
    font-family: var(--display);
    font-size: 2.6rem;
    font-weight: 400;
    line-height: 1;
    overflow-wrap: anywhere;
  }
  .facts {
    list-style: none;
    display: flex;
    flex-wrap: wrap;
    gap: 0 0.9rem;
    margin: 0.4rem 0 0;
    padding: 0;
    color: var(--mist);
    font-size: 1.25rem;
    line-height: 1.15;
  }
  .players-bar {
    display: flex;
    align-items: center;
    gap: 0.75rem;
    margin-top: 0.9rem;
  }
  .track {
    position: relative;
    flex: 1;
    height: 16px;
    background: var(--deep);
  }
  .fill {
    height: 100%;
    background: var(--mist);
    transition: width 0.25s cubic-bezier(0.3, 1.4, 0.6, 1), background 0.2s;
  }
  .fill.ready {
    background: var(--sun);
  }
  /* Marks how full the room must get before it can start. */
  .minimum {
    position: absolute;
    top: -4px;
    bottom: -4px;
    width: 4px;
    margin-left: -2px;
    background: var(--foam);
    box-shadow: 0 0 0 1px var(--ink);
  }
  .tally {
    flex: none;
    font-size: 1.5rem;
    line-height: 1;
    font-variant-numeric: tabular-nums;
  }
  .status {
    margin: 0.5rem 0 0;
    font-family: var(--display);
    font-size: 2.2rem;
    line-height: 1;
    font-variant-numeric: tabular-nums;
  }
  .status.go {
    color: var(--sun);
  }
  .small {
    margin: 0.15rem 0 0;
    color: var(--mist);
    font-size: 1.15rem;
    line-height: 1.1;
  }
  .buttons {
    display: grid;
    gap: 0.7rem;
    margin: 0.75rem 3px 0;
  }
  .leave {
    min-height: 2.75rem;
    padding: 0 0.75rem;
    font: inherit;
    font-size: 1.25rem;
    color: var(--foam);
    background: var(--deep);
    border: 0;
    cursor: pointer;
    transition: transform 0.09s cubic-bezier(0.3, 1.6, 0.6, 1);
  }
  @media (hover: hover) {
    .leave:hover {
      transform: translateY(-2px);
    }
  }
  .leave:active {
    transform: translateY(2px);
  }
  .leave:disabled {
    opacity: 0.75;
    cursor: progress;
  }
  .players {
    list-style: none;
    display: flex;
    flex-wrap: wrap;
    gap: 0.25rem 0.75rem;
    margin: 0.75rem 0 0;
    padding: 0;
    font-size: 1.25rem;
    line-height: 1.15;
  }
  .players .me {
    color: #ffb3d1;
  }
  .players .empty {
    color: var(--mist);
  }
  .hint {
    margin: 0.5rem 0 0;
    color: var(--sun);
    font-size: 1.25rem;
    line-height: 1.1;
  }
  :global(.stage.compact.game) h2 {
    font-size: 2rem;
  }
  :global(.stage.compact.game) .facts {
    gap: 0 0.5rem;
    margin-top: 0.1rem;
    font-size: 1.05rem;
  }
  :global(.stage.compact.game) .players-bar {
    margin-top: 0.1rem;
  }
  :global(.stage.compact.game) .status {
    margin-top: 0.3rem;
    font-size: 1.8rem;
  }
  :global(.stage.compact.game) .buttons {
    margin-top: 0.45rem;
    gap: 0.6rem;
  }
  :global(.stage.compact.game) .buttons.pair {
    grid-template-columns: 1fr 1fr;
  }
  :global(.stage.compact.game) .leave {
    line-height: 1.05;
  }
  /* Up to 30 names: one line that scrolls sideways, so the buttons stay on screen. */
  :global(.stage.compact.game) .players {
    flex-wrap: nowrap;
    margin-top: 0.25rem;
    gap: 0 0.6rem;
    overflow-x: auto;
    scrollbar-width: none;
    white-space: nowrap;
    font-size: 1.15rem;
  }
  :global(.stage.compact.game) .players li {
    flex: none;
  }
  :global(.stage.compact.game) .hint {
    margin-top: 0.3rem;
  }
</style>
