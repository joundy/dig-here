<script lang="ts">
  import { onDestroy, untrack } from 'svelte';
  import { Tween } from 'svelte/motion';
  import { fly } from 'svelte/transition';
  import { flip } from 'svelte/animate';
  import { cubicOut } from 'svelte/easing';
  import { audio } from '../lib/audio/audio.svelte';
  import { backend } from '../lib/backend';
  import { bonus, clock, near, percent } from '../lib/format';
  import { currentBonus, potOf, secondsLeft, secondsToNextClue, splitPot } from '../lib/game/engine';
  import { isLand } from '../lib/game/map';
  import { RULES } from '../lib/game/rules';
  import type { Point } from '../lib/game/types';
  import { buzz, showBanner, ui } from '../lib/ui.svelte';
  import { world } from '../lib/world/world';
  import Parrot from './Parrot.svelte';
  import Playtest from './Playtest.svelte';
  import Results from './Results.svelte';

  type BoardState = { pickable: boolean; spot: Point | null; label: string };
  let { id, onboard }: { id: string; onboard: (b: BoardState) => void } = $props();

  const game = $derived(backend.games.find((g) => g.id === id));
  const me = $derived(backend.account);
  const myDig = $derived(game?.digs.find((d) => d.account === me));
  const canPick = $derived(game?.status === 'open' && !myDig);

  let spot = $state<Point | null>(null);
  let error = $state('');
  let busy = $state(false);
  /** On a phone, the pot, the player list and the test controls live in a slide-up sheet. */
  let moreOpen = $state(false);

  /** 'playing' during the round, then 'rolling', 'chest', 'scores' through the reveal, then 'done'. */
  let phase = $state<'playing' | 'rolling' | 'chest' | 'scores' | 'done'>('done');
  let dramatic = $state(false);

  const pot = new Tween(0, { duration: 350, easing: cubicOut });
  $effect(() => {
    pot.target = game ? potOf(game) : 0;
  });

  // Enter the room: the island shows this round's digs, with no effects for the old ones.
  untrack(() => {
    const g = game;
    if (!g) return;
    world.enterGame($state.snapshot(g.digs));
    if (g.status === 'open') {
      phase = 'playing';
      audio.stopMusic(0.15);
      audio.playMusic('hunt', g.clues.length - 1);
    } else {
      audio.playMusic('lobby');
      world.setDusk(1);
      if (g.result?.treasure) {
        world.showFinal(g.result.treasure, g.result.winner);
        ui.focus = { x: g.result.treasure.x, y: g.result.treasure.y };
      }
    }
  });

  world.onPick = pick;

  $effect(() => {
    onboard({
      pickable: !!canPick,
      spot,
      label: canPick ? 'Island map. Click a spot, or use the arrow keys, to choose where to dig.' : 'Island map',
    });
  });

  $effect(() => {
    if (!game) return;
    world.sync({ digs: $state.snapshot(game.digs), me, spot, pickable: !!canPick });
  });

  // Each account makes its own choice, so a half-made one doesn't carry over when you switch.
  let lastMe = untrack(() => me);
  $effect(() => {
    if (me === lastMe) return;
    lastMe = me;
    spot = null;
    error = '';
  });

  $effect(() => {
    if (game?.status === 'open') world.setDusk(game.elapsed / game.durationSec);
  });

  // New clue: banner, jingle, and the music steps up.
  let seenClues = untrack(() => game?.clues.length ?? 0);
  $effect(() => {
    const count = game?.clues.length ?? 0;
    if (count <= seenClues || !game) return;
    seenClues = count;
    // A round ended early rolls its remaining clues at once, and those aren't news.
    if (game.status !== 'open') return;
    untrack(() => {
      const bonusNow = RULES.clueSchedule[count - 1].bonus;
      showBanner('New clue!', `Digs now count ${bonus(bonusNow)}`);
      buzz(20);
      audio.newClue();
      audio.playMusic('hunt', count - 1);
      world.flash();
    });
  });

  // The final ten seconds tick.
  let lastSecond = Infinity;
  $effect(() => {
    if (game?.status !== 'open') return;
    const whole = Math.ceil(secondsLeft(game));
    if (whole !== lastSecond && whole <= 10 && whole > 0) audio.tick(whole <= 3);
    lastSecond = whole;
  });

  let alive = true;
  let lastStatus = untrack(() => game?.status);

  $effect(() => {
    const g = game;
    const status = g?.status;
    if (lastStatus === 'open' && status && status !== 'open') {
      untrack(() => {
        spot = null;
        moreOpen = false;
        ui.cameraReset++;
        if (status === 'finished') void reveal();
        else {
          audio.stopMusic(0.4);
          audio.refund();
          phase = 'done';
          setTimeout(() => alive && audio.playMusic('lobby'), 1500);
        }
      });
    }
    lastStatus = status;
  });

  async function reveal() {
    const g = game;
    const result = g?.result;
    if (!g || !result?.treasure) return;
    // Hold the header balance back, so a win isn't given away before the chest lands.
    const prize = (result.winner === me ? result.prize : 0) + (g.host === me ? result.hostCut : 0);
    ui.heldBalance = backend.balanceOf(me) - prize;

    audio.stopMusic(0.2);
    dramatic = true;
    phase = 'rolling';
    world.setDusk(1);
    audio.drumroll(2.7);
    await world.rollCandidates([...g.candidateIds], result.treasure.landmarkId);
    if (!alive) return;

    phase = 'chest';
    ui.focus = { x: result.treasure.x, y: result.treasure.y };
    await world.dropChest(result.treasure);
    if (!alive) return;
    await world.drawLines(result.winner);
    if (!alive) return;

    phase = 'scores';
  }

  function revealDone() {
    ui.heldBalance = null;
    phase = 'done';
    setTimeout(() => alive && audio.playMusic('lobby'), 2600);
  }

  onDestroy(() => {
    alive = false;
    ui.heldBalance = null;
    ui.focus = null;
    world.onPick = null;
  });

  function pick(point: Point, quiet = false) {
    if (!game || game.status !== 'open' || myDig || busy) return;
    if (!isLand(point)) {
      if (quiet) return;
      error = 'That spot is water. Pick a spot on land.';
      audio.error();
      return;
    }
    error = '';
    spot = point;
    if (!quiet) audio.pick();
  }

  async function dig() {
    if (!game || !spot) return;
    error = '';
    busy = true;
    try {
      await backend.dig(game.id, spot);
      spot = null;
    } catch (e) {
      error = (e as Error).message;
      audio.error();
    } finally {
      busy = false;
    }
  }

  const clueNow = $derived(game ? game.clues[game.clues.length - 1] : undefined);
  const earlier = $derived(game ? game.clues.slice(0, -1) : []);
  const nextIn = $derived(game ? secondsToNextClue(game) : null);
  const nextBonus = $derived(game ? RULES.clueSchedule[game.clues.length]?.bonus : undefined);
  const payout = $derived(splitPot(Math.round(pot.current), game?.hostCutBps ?? 0));
  const urgent = $derived(game?.status === 'open' && secondsLeft(game) <= 10);

  // How much of the current bonus window is left, as a fraction for the draining bar.
  const windowLeft = $derived.by(() => {
    if (!game) return 0;
    const schedule = RULES.clueSchedule;
    const index = game.clues.length - 1;
    const start = schedule[index].startsAt * game.durationSec;
    const end = (schedule[index + 1]?.startsAt ?? 1) * game.durationSec;
    return Math.max(0, Math.min(1, (end - game.elapsed) / (end - start)));
  });
</script>

{#if !game}
  <div class="top">
    <Parrot text="This game no longer exists. Squawk." />
    <a class="btn gap" href="#/">See open games</a>
  </div>
{:else if phase === 'playing'}
  <div class="top">
    <div class="where">
      <p class="crumb"><a href="#/">Open games</a> / {game.name}</p>
      <p class="count">Clue {game.clues.length} of {RULES.clueSchedule.length}</p>
    </div>
    <Parrot text={clueNow?.text ?? ''} plain={clueNow?.plain ?? ''} />
    {#if earlier.length}
      <ul class="earlier">
        {#each earlier as c}<li>{c.plain}</li>{/each}
      </ul>
    {/if}
  </div>

  <div class="bottom">
    <div class="stats">
      <div class="clock" class:urgent role="timer">
        <strong>{clock(secondsLeft(game))}</strong>
        <span>left to dig</span>
      </div>
      <div class="bonus">
        <strong>{bonus(currentBonus(game))}</strong>
        <span>{nextIn !== null && nextBonus ? `Drops to ${bonus(nextBonus)} in ${clock(nextIn)}` : 'Last clue'}</span>
      </div>
    </div>
    <div class="meter" aria-hidden="true"><div class="fill" style:width="{windowLeft * 100}%"></div></div>

    <div class="action">
      {#if error}<p class="error" role="alert">{error}</p>{/if}
      {#if myDig}
        <p class="locked">You dug at {bonus(myDig.bonus)}. Your score is decided when the treasure lands.</p>
      {:else if spot}
        <button class="btn" onclick={dig} disabled={busy}>
          {busy ? 'Digging…' : `Dig here for ${near(game.fee)}`}
        </button>
        {#if ui.coarse}<p class="hint">Drag the X to fine-tune it.</p>{/if}
      {:else}
        <p class="prompt">{ui.coarse ? 'Tap the map to choose your spot.' : 'Choose your spot on the map.'} You get one dig.</p>
      {/if}
    </div>

    <button class="more-toggle" aria-expanded={moreOpen} onclick={() => (moreOpen = true)}>
      <span>Pot {near(Math.round(pot.current))}, {game.digs.length} {game.digs.length === 1 ? 'dig' : 'digs'}</span>
      <span aria-hidden="true">Details</span>
    </button>
  </div>

  {#if ui.compact && moreOpen}
    <button class="scrim" aria-label="Close details" onclick={() => (moreOpen = false)}></button>
  {/if}

  <div class="more" class:open={moreOpen} inert={ui.compact && !moreOpen}>
    <button class="close" onclick={() => (moreOpen = false)}>Close</button>
    <dl class="pot">
      <div><dt>Pot</dt><dd>{near(Math.round(pot.current))}</dd></div>
      <div><dt>Winner gets</dt><dd>{near(payout.prize)}</dd></div>
      <div><dt>Host keeps {percent(game.hostCutBps)}</dt><dd>{near(payout.hostCut)}</dd></div>
    </dl>

    <h2>{game.digs.length} {game.digs.length === 1 ? 'dig' : 'digs'} so far</h2>
    <ul class="diggers">
      {#each [...game.digs].reverse() as d (d.account)}
        <li class:me={d.account === me} in:fly={{ x: 16, duration: 200 }} animate:flip={{ duration: 180 }}>
          <span>{d.account === me ? 'You' : d.account}</span>
          <span>{bonus(d.bonus)}</span>
        </li>
      {:else}
        <li class="empty">Nobody has dug yet. An early dig counts double.</li>
      {/each}
    </ul>

    <Playtest gameId={game.id} />
  </div>
{:else if phase === 'rolling' || phase === 'chest'}
  <div class="top">
    <Parrot text={phase === 'rolling' ? "Time's up! Where will it land?" : 'There it is!'} />
  </div>
{:else if game.result}
  <div class="bottom results-panel">
    <Results {game} {me} {dramatic} ondone={revealDone} />
  </div>
{/if}

<style>
  .gap {
    margin-top: 1rem;
  }
  .where {
    margin-bottom: 0.1rem;
  }
  .hint {
    margin: 0.35rem 0 0;
    color: var(--mist);
    font-size: 1.15rem;
    line-height: 1;
    text-align: center;
  }
  .more-toggle,
  .close,
  .scrim {
    display: none;
  }
  .more {
    margin-top: 0.8rem;
  }
  .crumb {
    margin: 0 0 0.5rem;
    color: var(--mist);
    font-size: 1.2rem;
    line-height: 1.1;
  }
  /* Roomier to tap than it looks. */
  .crumb a {
    display: inline-block;
    padding: 0.6rem 0;
    margin: -0.6rem 0;
    color: inherit;
  }
  .count {
    margin: 0 0 0.35rem;
    font-size: 1.3rem;
    line-height: 1;
  }
  .earlier {
    list-style: none;
    margin: 0.5rem 0 0;
    padding: 0;
    color: var(--mist);
    font-size: 1.15rem;
    line-height: 1.15;
  }
  .earlier li {
    text-decoration: line-through;
  }
  .stats {
    display: grid;
    grid-template-columns: auto 1fr;
    gap: 1.25rem;
    margin-top: 0.8rem;
  }
  .stats strong {
    display: block;
    font-family: var(--display);
    font-weight: 400;
    font-size: 3.4rem;
    line-height: 0.85;
    font-variant-numeric: tabular-nums;
  }
  .stats span {
    display: block;
    color: var(--mist);
    font-size: 1.2rem;
    line-height: 1.1;
  }
  .bonus strong {
    color: var(--sun);
  }
  .urgent strong {
    color: #ff8a8a;
    animation: throb 0.5s steps(2) infinite alternate;
  }
  .meter {
    height: 9px;
    margin-top: 0.45rem;
    background: var(--deep);
  }
  .fill {
    height: 100%;
    background: var(--sun);
    transition: width 0.25s linear;
  }
  .action {
    margin-top: 0.8rem;
  }
  .prompt,
  .locked {
    margin: 0;
    padding: 0.5rem 0.75rem;
    background: var(--deep);
    font-size: 1.3rem;
    line-height: 1.15;
  }
  .locked {
    box-shadow: inset 6px 0 0 var(--pink);
    padding-left: 1rem;
    animation: stamp 0.28s cubic-bezier(0.3, 1.6, 0.6, 1);
  }
  .pot {
    margin: 0;
    font-size: 1.3rem;
    line-height: 1.15;
  }
  .pot div {
    display: flex;
    justify-content: space-between;
    gap: 1rem;
  }
  .pot dt {
    color: var(--mist);
  }
  .pot dd {
    margin: 0;
    font-variant-numeric: tabular-nums;
  }
  h2 {
    font-size: 1.4rem;
    font-weight: 400;
    line-height: 1;
    margin: 1rem 0 0.3rem;
  }
  .diggers {
    list-style: none;
    margin: 0;
    padding: 0;
    font-size: 1.25rem;
    line-height: 1.15;
  }
  .diggers li {
    display: flex;
    justify-content: space-between;
    font-variant-numeric: tabular-nums;
  }
  .diggers .me {
    color: #ffb3d1;
  }
  .diggers .empty {
    color: var(--mist);
  }
  @keyframes throb {
    to { transform: scale(1.06); }
  }
  @keyframes stamp {
    from { transform: scale(1.1); opacity: 0.4; }
  }
  /* Phone held upright: everything fits around the map, and the details slide up on request. */
  :global(.stage.compact.game) .top {
    order: 1;
    padding: 0 0.75rem 0.35rem;
  }
  :global(.stage.compact.game) .where {
    display: flex;
    justify-content: space-between;
    gap: 1rem;
    margin-bottom: 0.2rem;
  }
  :global(.stage.compact.game) .crumb {
    margin: 0;
    min-width: 0;
    overflow: hidden;
    white-space: nowrap;
    text-overflow: ellipsis;
  }
  :global(.stage.compact.game) .count {
    margin: 0;
    flex: none;
    font-size: 1.2rem;
    line-height: 1.1;
  }
  :global(.stage.compact.game) .earlier {
    display: none;
  }
  :global(.stage.compact.game) .bottom {
    order: 3;
    padding: 0.4rem 0.75rem calc(0.4rem + env(safe-area-inset-bottom));
    box-shadow: 0 -3px 0 var(--ink);
  }
  :global(.stage.compact.game) .results-panel {
    box-shadow: none;
    max-height: 56%;
    overflow-y: auto;
    overscroll-behavior: contain;
    padding-top: 0.6rem;
  }
  :global(.stage.compact.game) .stats {
    margin-top: 0;
    align-items: center;
    gap: 0.9rem;
  }
  :global(.stage.compact.game) .stats strong {
    font-size: 2.6rem;
  }
  :global(.stage.compact.game) .stats span {
    font-size: 1.1rem;
  }
  :global(.stage.compact.game) .clock,
  :global(.stage.compact.game) .bonus {
    display: flex;
    align-items: center;
    gap: 0.45rem;
  }
  :global(.stage.compact.game) .clock span {
    width: 3rem;
    line-height: 0.95;
  }
  :global(.stage.compact.game) .bonus span {
    line-height: 0.95;
  }
  :global(.stage.compact.game) .meter {
    margin-top: 0.15rem;
    height: 6px;
  }
  :global(.stage.compact.game) .action {
    margin-top: 0.4rem;
  }
  :global(.stage.compact.game) .action .error {
    margin: 0 0 0.35rem;
  }
  :global(.stage.compact.game) .action .btn {
    width: calc(100% - 6px);
    margin: 0 3px;
  }
  :global(.stage.compact.game) .prompt,
  :global(.stage.compact.game) .locked {
    font-size: 1.25rem;
    min-height: 3.25rem;
    display: flex;
    align-items: center;
  }
  :global(.stage.compact.game) .more-toggle {
    display: flex;
    justify-content: space-between;
    width: 100%;
    min-height: 2.5rem;
    margin-top: 0.35rem;
    padding: 0 0.1rem;
    align-items: center;
    font: inherit;
    font-size: 1.2rem;
    color: var(--foam);
    background: none;
    border: 0;
  }
  :global(.stage.compact.game) .more-toggle span:last-child {
    color: var(--sun);
  }
  :global(.stage.compact.game) .scrim {
    display: block;
    position: fixed;
    inset: 0;
    z-index: 9;
    padding: 0;
    border: 0;
    background: rgb(20 27 60 / 0.55);
    animation: fade 0.18s ease-out;
  }
  :global(.stage.compact.game) .more {
    position: fixed;
    left: 0;
    right: 0;
    bottom: 0;
    z-index: 10;
    margin: 0;
    max-height: 72%;
    overflow-y: auto;
    overscroll-behavior: contain;
    padding: 0.75rem 0.9rem calc(1rem + env(safe-area-inset-bottom));
    background: var(--ink);
    box-shadow: 0 -3px 0 var(--foam);
    transform: translateY(102%);
    visibility: hidden;
    transition: transform 0.24s cubic-bezier(0.2, 0.9, 0.25, 1), visibility 0.24s;
  }
  :global(.stage.compact.game) .more.open {
    transform: none;
    visibility: visible;
  }
  :global(.stage.compact.game) .close {
    display: block;
    margin: 0 0 0.5rem auto;
    min-height: 2.5rem;
    padding: 0 0.75rem;
    font: inherit;
    color: var(--sun);
    background: none;
    border: 0;
  }
  /* Very short phones: give the map every spare pixel. */
  @media (max-height: 620px) {
    :global(.stage.compact.game) .where,
    :global(.stage.compact.game) .hint {
      display: none;
    }
    :global(.stage.compact.game) .top {
      padding-top: 0.15rem;
    }
    :global(.stage.compact.game) .stats strong {
      font-size: 2.2rem;
    }
    :global(.stage.compact.game) .prompt,
    :global(.stage.compact.game) .locked {
      min-height: 2.6rem;
      padding-top: 0.3rem;
      padding-bottom: 0.3rem;
      font-size: 1.15rem;
    }
    :global(.stage.compact.game) .more-toggle {
      min-height: 2.25rem;
      margin-top: 0.1rem;
    }
  }
  /* Phone held sideways: the button stays reachable as the rail scrolls. */
  :global(.stage.short) .stats strong {
    font-size: 2.6rem;
  }
  :global(.stage.short) .action {
    position: sticky;
    bottom: 0.5rem;
    z-index: 2;
  }
  @keyframes fade {
    from { opacity: 0; }
  }
</style>
