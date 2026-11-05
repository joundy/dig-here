<script lang="ts">
  import { untrack } from 'svelte';
  import { Tween } from 'svelte/motion';
  import { fly } from 'svelte/transition';
  import { flip } from 'svelte/animate';
  import { cubicOut } from 'svelte/easing';
  import { audio } from '../lib/audio/audio.svelte';
  import { backend } from '../lib/backend';
  import { bonus, near, percent } from '../lib/format';
  import { clueText } from '../lib/game/copy';
  import { currentBonus, isCrowded, isOpen, potOf, secondsLeft, splitPot } from '../lib/game/engine';
  import { isLand, W } from '../lib/game/map';
  import { RULES } from '../lib/game/rules';
  import type { Game, Point } from '../lib/game/types';
  import { buzz, showBanner, ui } from '../lib/ui.svelte';
  import { world } from '../lib/world/world';
  import '../round.css';
  import ClueTrail from './ClueTrail.svelte';
  import Parrot from './Parrot.svelte';
  import Playtest from './Playtest.svelte';
  import Results from './Results.svelte';
  import Standing from './Standing.svelte';
  import Who from './Who.svelte';
  import WaitingRoom from './WaitingRoom.svelte';

  /** Tension builds over the last ten seconds and is at full strength for the last three. */
  const TENSE_SEC = 10;
  const PEAK_SEC = 3;
  /** A dig normally confirms in 1.4 to 2.6 s. Past this the player should hear why it's taking longer. */
  const SLOW_DIG_MS = 4000;

  type BoardState = { pickable: boolean; spot: Point | null; label: string };
  let { id, onboard }: { id: string; onboard: (b: BoardState) => void } = $props();

  const game = $derived(backend.games.find((g) => g.id === id));
  const me = $derived(backend.account);
  const joined = $derived(!!game?.players.includes(me));
  const myDig = $derived(game?.digs.find((d) => d.account === me));
  const canPick = $derived(game?.stage === 'live' && joined && !myDig);

  let spot = $state.raw<Point | null>(null);
  let error = $state('');
  let busy = $state(false);
  let slowDig = $state(false);
  /** On a phone, the pot, the player list and the test controls live in a slide-up sheet. */
  let moreOpen = $state(false);

  /** 'round' while the room is open, then 'rolling', 'chest', 'scores' through the reveal, then 'done'. */
  let phase = $state<'round' | 'rolling' | 'chest' | 'scores' | 'done'>(untrack(() => (game && !isOpen(game) ? 'done' : 'round')));
  let dramatic = $state(false);

  const pot = new Tween(untrack(() => (game ? potOf(game) : 0)), { duration: 350, easing: cubicOut });
  $effect(() => {
    pot.target = game ? potOf(game) : 0;
  });

  let alive = true;

  // In an effect, because going from one room straight to another builds the new Room before the
  // old one is torn down. The old teardown has to finish before this claims the shared island.
  $effect(() => {
    untrack(enterRoom);
    world.onPick = pick;
    return () => {
      alive = false;
      world.onPick = null;
      world.setTension(0);
      ui.heldBalance = null;
      ui.focus = null;
    };
  });

  function enterRoom() {
    const g = game;
    if (!g) return;
    world.enterGame(g.mapId, $state.snapshot(g.digs), $state.snapshot(g.landmarks));
    audio.setMapMusic(g.mapId);
    if (g.stage === 'waiting') {
      audio.playMusic('lobby');
    } else if (g.stage === 'live') {
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
  }

  $effect(() => {
    onboard({
      pickable: !!canPick,
      spot,
      label: canPick ? 'Island map. Click a spot, or use the arrow keys, to choose where to dig.' : 'Island map',
    });
  });

  $effect(() => {
    if (!game) return;
    world.sync({ digs: $state.snapshot(game.digs), me, spot, pickable: !!canPick, crowdRings: !!canPick });
  });

  // Each account makes its own choice, so a half-made one doesn't carry over when you switch.
  let lastMe = untrack(() => me);
  $effect(() => {
    if (me === lastMe) return;
    lastMe = me;
    spot = null;
    error = '';
    ui.heldBalance = null;
  });

  $effect(() => {
    if (game?.stage === 'live') world.setDusk(game.elapsed / game.durationSec);
  });

  // Winnings arrive in the same tick the round ends, so the balance to hold back during the reveal
  // has to be remembered while the round is still going.
  let balanceBefore = untrack(() => backend.balanceOf(me));
  $effect(() => {
    if (game && isOpen(game)) balanceBefore = backend.balanceOf(me);
  });

  let lastStage = untrack(() => game?.stage);
  $effect(() => {
    const g = game;
    const stage = g?.stage;
    const was = lastStage;
    lastStage = stage;
    if (!g || stage === was) return;
    untrack(() => {
      if (stage === 'live') startRound(g);
      else if (stage === 'finished' && (was === 'waiting' || was === 'live')) void reveal(g);
      else if (stage === 'refunded') refunded();
    });
  });

  function startRound(g: Game) {
    spot = null;
    error = '';
    if (joined) showBanner('Dig!', `Digs count ${bonus(currentBonus(g))} right now`);
    else showBanner('Dig!', "You're watching this one");
    buzz(30);
    audio.roundStart();
    audio.stopMusic(0.15);
    audio.playMusic('hunt', g.clues.length - 1);
  }

  // New clue: banner, jingle, and the music steps up.
  let seenClues = untrack(() => game?.clues.length ?? 0);
  $effect(() => {
    const g = game;
    const count = g?.clues.length ?? 0;
    if (!g || count <= seenClues) return;
    const was = seenClues;
    seenClues = count;
    // The first clue is the round starting. A round ended early rolls its last clues at once, and those aren't news.
    if (was === 0 || g.stage !== 'live') return;
    untrack(() => {
      showBanner(clueText(g.mapId, g.clues[count - 1]).plain, `Digs now count ${bonus(RULES.clueSchedule[count - 1].bonusBps)}`);
      buzz(20);
      audio.newClue();
      audio.playMusic('hunt', count - 1);
      world.flash();
    });
  });

  // The final seconds tick and the island gets nervous.
  let lastSecond = untrack(() => (game?.stage === 'live' ? Math.ceil(secondsLeft(game)) : Infinity));
  $effect(() => {
    if (game?.stage !== 'live') return;
    const left = secondsLeft(game);
    const whole = Math.ceil(left);
    if (whole !== lastSecond && whole <= TENSE_SEC && whole > 0) audio.tick(whole <= PEAK_SEC);
    lastSecond = whole;
    if (left <= TENSE_SEC) world.setTension(left <= 0 ? 0.6 : Math.min(1, (TENSE_SEC - left) / (TENSE_SEC - PEAK_SEC)), [...game.candidateIds]);
  });

  function clearRound() {
    spot = null;
    error = '';
    moreOpen = false;
    ui.cameraReset++;
    world.setTension(0);
  }

  function refunded() {
    clearRound();
    audio.stopMusic(0.4);
    audio.refund();
    phase = 'done';
    setTimeout(() => alive && audio.playMusic('lobby'), 1500);
  }

  async function reveal(g: Game) {
    const result = g.result;
    if (!result?.treasure) return;
    clearRound();
    // Hold the header balance back, so a win isn't given away before the chest lands.
    ui.heldBalance = balanceBefore;

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

  function pick(point: Point, quiet = false) {
    if (!game || !canPick || busy) return;
    if (!isLand(game.mapId, point)) {
      if (quiet) return;
      error = 'That spot is water. Pick a spot on land.';
      audio.error();
      return;
    }
    error = '';
    spot = point;
    if (!quiet) audio.pick();
  }

  const tooLate = $derived(game?.stage === 'live' && secondsLeft(game) <= backend.lastDigSec);
  /** On a real chain the round's last roll takes a few seconds after the clock runs out. */
  const rolling = $derived(game?.stage === 'live' && secondsLeft(game) <= 0);

  async function dig() {
    if (!game || !spot || busy || tooLate) return;
    // The count at the moment of the tap: a clue landing while this is on its way must turn it down.
    const seenClue = game.clues.length;
    const signer = me;
    error = '';
    busy = true;
    const slow = setTimeout(() => (slowDig = true), SLOW_DIG_MS);
    try {
      await backend.dig(game.id, spot, seenClue);
      if (backend.account === signer) spot = null;
    } catch (e) {
      if (alive && game?.stage === 'live') {
        error = (e as Error).message;
        audio.error();
      }
    } finally {
      clearTimeout(slow);
      slowDig = false;
      busy = false;
    }
  }

  const crowded = $derived(!!game && !!spot && isCrowded(game.digs, spot));
  const warning = $derived(game?.stage === 'live' && joined && !myDig && !tooLate && secondsLeft(game) <= RULES.noDigWarningSec);
  const payout = $derived(splitPot(Math.round(pot.current), game?.hostCutBps ?? 0));
</script>

{#if !game}
  <div class="top">
    <Parrot text="This game no longer exists. Squawk." />
    <a class="btn gap" href="#/">See open games</a>
  </div>
{:else if game.stage === 'waiting'}
  <WaitingRoom {game} {me} />
{:else if phase === 'round'}
  <!-- Stage and phase change a moment apart when a round ends. In between, show nothing rather than a half-ended round. -->
  {#if game.stage === 'live'}
    <div class="top">
      <p class="round-crumb"><a href="#/">Game board</a> / {game.name}</p>
      <ClueTrail {game} />
    </div>

    <div class="bottom">
      <div class="action">
        {#if error}<p class="error" role="alert">{error}</p>{/if}
        {#if busy && myDig}<p class="note confirming" role="status">{slowDig ? 'Still digging. The ground is tough here…' : 'Shovel in the ground…'}</p>{/if}
        {#if rolling}
          <p class="prompt">Time's up! The treasure is on its way…</p>
        {:else if !joined}
          <p class="prompt">This round has started. You're watching.</p>
        {:else if myDig}
          {#key me}<Standing {game} {me} />{/key}
        {:else}
          <div class="choosing">
            <div class="notes">
              {#if warning}<p class="note warn" role="alert">Dig now, or your fee stays in the pot!</p>{/if}
              {#if spot && crowded}<p class="note crowded">Crowded: {bonus(RULES.crowdBps)}</p>{/if}
              {#if spot && ui.coarse && !crowded}<p class="note">Drag the X to fine-tune it.</p>{/if}
            </div>
            {#if spot}
              <button class="btn" onclick={dig} disabled={busy || tooLate}>
                {busy ? 'Digging…' : tooLate ? 'Too late!' : `Dig here at ${bonus(currentBonus(game))}`}
              </button>
            {:else}
              <p class="prompt">{ui.coarse ? 'Tap the map to choose your spot.' : 'Choose your spot on the map.'} You get one dig.</p>
            {/if}
          </div>
        {/if}
      </div>

      <button class="more-toggle" aria-expanded={moreOpen} onclick={() => (moreOpen = true)}>
        <span>Pot {near(Math.round(pot.current))}, {game.digs.length} of {game.players.length} dug</span>
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

      <h2>{game.digs.length} of {game.players.length} dug</h2>
      <ul class="diggers">
        {#each [...game.digs].reverse() as d (d.account)}
          <li class:me={d.account === me} in:fly={{ x: 16, duration: 200 }} animate:flip={{ duration: 180 }}>
            <span><Who account={d.account} {me} /></span>
            <span>{bonus(d.bonusBps)}{d.crowded ? ` ${bonus(RULES.crowdBps)}` : ''}</span>
          </li>
        {:else}
          <li class="empty">Nobody has dug yet. Early digs score more.</li>
        {/each}
      </ul>

      <Playtest gameId={game.id} />
    </div>
  {/if}
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
  .more-toggle,
  .close,
  .scrim {
    display: none;
  }
  .more {
    margin-top: 0.8rem;
  }
  .action {
    margin-top: 0.8rem;
  }
  .notes {
    display: grid;
    gap: 0.15rem;
    margin-bottom: 0.45rem;
  }
  .notes:empty {
    display: none;
  }
  .note {
    margin: 0;
    color: var(--mist);
    font-size: 1.2rem;
    line-height: 1.05;
  }
  .note.crowded {
    color: #ff8a8a;
  }
  .note.warn {
    color: var(--sun);
    animation: warn 0.5s steps(2) infinite alternate;
  }
  .prompt {
    margin: 0;
    padding: 0.5rem 0.75rem;
    background: var(--deep);
    font-size: 1.3rem;
    line-height: 1.15;
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
  @keyframes warn {
    to { opacity: 0.55; }
  }
  /* Phone held upright: the details slide up on request. */
  :global(.stage.compact.game) .action {
    margin-top: 0;
  }
  :global(.stage.compact.game) .action .error {
    margin: 0 0 0.35rem;
  }
  /* A fixed height, so a note appearing doesn't resize the map under a dragging finger. */
  :global(.stage.compact.game) .choosing {
    display: flex;
    flex-direction: column;
    justify-content: flex-end;
    min-height: 6rem;
  }
  :global(.stage.compact.game) .notes {
    margin-bottom: 0.3rem;
  }
  :global(.stage.compact.game) .action .btn {
    width: calc(100% - 6px);
    margin: 0 3px;
  }
  :global(.stage.compact.game) .prompt {
    flex: 1;
    font-size: 1.25rem;
    display: flex;
    align-items: center;
    min-height: 3rem;
    padding-top: 0.2rem;
    padding-bottom: 0.2rem;
    line-height: 1.05;
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
    :global(.stage.compact.game) .choosing {
      min-height: 5rem;
    }
    :global(.stage.compact.game) .prompt {
      min-height: 2.6rem;
      font-size: 1.15rem;
    }
    :global(.stage.compact.game) .more-toggle {
      min-height: 2.25rem;
      margin-top: 0.1rem;
    }
  }
  /* Phone held sideways: the button stays reachable as the rail scrolls. */
  :global(.stage.short) .action {
    position: sticky;
    bottom: 0.5rem;
    z-index: 2;
  }
  @keyframes fade {
    from { opacity: 0; }
  }
</style>
