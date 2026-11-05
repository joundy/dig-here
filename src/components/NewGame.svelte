<script lang="ts">
  import { untrack } from 'svelte';
  import { backend } from '../lib/backend';
  import { botLimitNote, defaultsWithin } from '../lib/near/choices';
  import { audio } from '../lib/audio/audio.svelte';
  import { clock, near, percent } from '../lib/format';
  import { splitPot } from '../lib/game/engine';
  import { MAP_IDS, mathRng } from '../lib/game/map';
  import { RULES } from '../lib/game/rules';
  import type { MapId } from '../lib/game/types';
  import { attachFor } from '../lib/pay';
  import { ui } from '../lib/ui.svelte';
  import { world } from '../lib/world/world';
  import MapBadge from './MapBadge.svelte';
  import Parrot from './Parrot.svelte';

  const EXAMPLE_PLAYERS = 10;
  const FLOOR = RULES.minPlayersFloor;
  const CAP = RULES.hostFormMaxPlayers;
  const NAME_BYTES = 40;
  const NAMES = ['Lunch money', 'Sunday dig', 'Finders keepers', 'X marks the spot', 'Beginner\'s luck', 'Low tide', 'Shovel party'];

  // Asking a stranger to name a room is one more thing between them and a game. Theirs wins if they type one.
  const suggested = NAMES[mathRng(NAMES.length)];
  let name = $state('');
  const feeChoices = backend.prices.feeChoices;
  const USUAL_FEE = feeChoices ? feeChoices[1] : 1000;
  const USUAL_CUT = 5;
  let feeNear = $state(USUAL_FEE / 1000);
  let durationSec = $state<number>(180);
  let cutPercent = $state(USUAL_CUT);
  let mapChoice = $state<MapId | 'surprise'>('tropical');
  let minPlayers = $state(2);
  let maxPlayers = $state(10);
  /** Off means the host presses Start, which beats any countdown when it's only them and the bots. */
  let countdownSec = $state<number>(0);
  let play = $state(true);
  let error = $state('');
  let busy = $state(false);

  const feeMilli = $derived(Math.round((Number(feeNear) || 0) * 1000));
  const players = $derived(Math.min(maxPlayers, Math.max(minPlayers, EXAMPLE_PLAYERS)));
  const example = $derived(splitPot(feeMilli * players, cutPercent * 100));
  const penalty = $derived(percent(RULES.expiredBondPenaltyBps));
  const botNote = $derived(botLimitNote(backend.botLimits, feeMilli, cutPercent * 100));

  // The limits arrive a moment after the form opens. Move only what's still at its usual choice.
  $effect(() => {
    const limits = backend.botLimits;
    if (!limits) return;
    untrack(() => {
      const within = defaultsWithin(limits, feeChoices, USUAL_FEE, USUAL_CUT);
      if (feeMilli === USUAL_FEE) feeNear = within.fee / 1000;
      if (cutPercent === USUAL_CUT) cutPercent = within.cutPercent;
    });
  });

  // Whatever room was open last leaves its map behind, so this always sets one. Surprise keeps
  // the last preview rather than giving the secret away. Phones hide the board, so skip the work.
  let previewed: MapId | null = null;
  $effect(() => {
    const wanted = mapChoice !== 'surprise' && !ui.compact ? mapChoice : (previewed ?? 'tropical');
    if (wanted === previewed) return;
    previewed = wanted;
    world.showMap(wanted);
  });

  function setMin(value: number) {
    minPlayers = value;
    if (maxPlayers < value) maxPlayers = value;
  }

  function setMax(value: number) {
    maxPlayers = value;
    if (minPlayers > value) minPlayers = value;
  }

  async function submit(event: SubmitEvent) {
    event.preventDefault();
    error = '';
    const roomName = name.trim() || suggested;
    if (new TextEncoder().encode(roomName).length > NAME_BYTES) {
      error = "That name is too long. Emoji count double, so try a shorter one.";
      audio.error();
      return;
    }
    busy = true;
    try {
      await backend.ensureAccount();
      const bond = backend.prices.hostBond;
      const what = play ? 'Hosting bond, back when the room ends, plus your entry fee' : 'Hosting bond, back when the room ends';
      const attach = await attachFor(what, play ? bond + feeMilli : bond, feeMilli);
      if (attach === null) return;
      const mapId = mapChoice === 'surprise' ? MAP_IDS[mathRng(MAP_IDS.length)] : mapChoice;
      const id = await backend.createGame({
        name: roomName,
        mapId,
        fee: feeMilli,
        durationSec,
        hostCutBps: cutPercent * 100,
        minPlayers,
        maxPlayers,
        countdownSec,
      }, attach);
      // The room exists whatever happens next, and its own page offers Join if this fails.
      if (play) await backend.join(id).catch(() => undefined);
      location.hash = `#/game/${id}`;
    } catch (e) {
      error = (e as Error).message;
      audio.error();
    } finally {
      busy = false;
    }
  }
</script>

{#snippet stepper(label: string, value: number, change: (value: number) => void)}
  <div class="stepper">
    <span class="step-label">{label}</span>
    <div class="step-row">
      <button type="button" aria-label="Fewer: {label}" disabled={value <= FLOOR} onclick={() => change(value - 1)}>−</button>
      <output>{value}</output>
      <button type="button" aria-label="More: {label}" disabled={value >= CAP} onclick={() => change(value + 1)}>+</button>
    </div>
  </div>
{/snippet}

<form onsubmit={submit}>
  <h1 class="sr-only">Host a game</h1>
  <Parrot text="You set the terms and take a share of the pot." plain="You can't choose where the treasure lands. Nobody can." />

  <label class="field">
    <span>Game name</span>
    <input bind:value={name} maxlength="40" placeholder={suggested} autocomplete="off" />
  </label>

  <fieldset class="field">
    <legend>Map</legend>
    <div class="maps">
      {#each MAP_IDS as id}
        <label class="choice map" class:picked={mapChoice === id}>
          <input type="radio" name="map" value={id} bind:group={mapChoice} />
          <MapBadge mapId={id} />
        </label>
      {/each}
      <label class="choice map" class:picked={mapChoice === 'surprise'}>
        <input type="radio" name="map" value="surprise" bind:group={mapChoice} />
        <span class="surprise"><b>?</b> Surprise me</span>
      </label>
    </div>
  </fieldset>

  {#if feeChoices}
    <fieldset class="field">
      <legend>Entry fee, in test NEAR</legend>
      <div class="choices">
        {#each feeChoices as fee}
          <label class="choice" class:picked={feeMilli === fee}>
            <input type="radio" name="fee" value={fee / 1000} bind:group={feeNear} />
            {fee / 1000}
          </label>
        {/each}
      </div>
    </fieldset>
  {:else}
    <label class="field">
      <span>Entry fee in NEAR</span>
      <input type="number" bind:value={feeNear} min="0.001" step="any" inputmode="decimal" />
    </label>
  {/if}

  <div class="field steppers">
    {@render stepper('Minimum players', minPlayers, setMin)}
    {@render stepper('Maximum players', maxPlayers, setMax)}
  </div>

  <fieldset class="field">
    <legend>Timer</legend>
    <div class="choices">
      {#each RULES.timerChoices as seconds}
        <label class="choice" class:picked={durationSec === seconds}>
          <input type="radio" name="timer" value={seconds} bind:group={durationSec} />
          {clock(seconds)}
        </label>
      {/each}
    </div>
  </fieldset>

  <fieldset class="field">
    <legend>Starting</legend>
    <div class="choices">
      {#each RULES.countdownChoices as seconds}
        <label class="choice" class:picked={countdownSec === seconds}>
          <input type="radio" name="countdown" value={seconds} bind:group={countdownSec} />
          {seconds === 0 ? 'By hand' : clock(seconds)}
        </label>
      {/each}
    </div>
    <p class="hint">
      {#if countdownSec === 0}
        You press Start once {minPlayers} {minPlayers === 1 ? 'player is' : 'players are'} in. {backend.botLimits && !botNote ? 'Bots join within seconds if nobody else is around.' : ''}
      {:else}
        Starts by itself {clock(countdownSec)} after {minPlayers} players are in. You can still press Start sooner.
      {/if}
    </p>
  </fieldset>

  <label class="play">
    <input type="checkbox" bind:checked={play} />
    I'll play too, for the {near(feeMilli)} entry fee
  </label>

  <label class="field">
    <span>You keep {cutPercent}% of the pot</span>
    <input type="range" bind:value={cutPercent} min="0" max={RULES.maxHostCutBps / 100} step="1" />
  </label>

  {#if botNote}<p class="hint bots" role="status">{botNote}</p>{/if}

  <div class="example">
    <p>With {players} players the pot is {near(feeMilli * players)}:</p>
    <dl>
      <div class="win"><dt>Winner</dt><dd>{near(example.prize)}</dd></div>
      <div><dt>You</dt><dd>{near(example.hostCut)}</dd></div>
      <div><dt>Jackpot</dt><dd>{near(example.jackpot)}</dd></div>
      <div><dt>NFT owner</dt><dd>{near(example.deed)}</dd></div>
      <div><dt>Season</dt><dd>{near(example.season)}</dd></div>
    </dl>
  </div>

  <p class="bond">
    Hosting locks a <b>{near(backend.prices.hostBond)}</b> bond. You get it back when the room ends, minus {penalty} if it expires short of players.
  </p>

  {#if error}<p class="error" role="alert">{error}</p>{/if}

  <button class="btn" type="submit" disabled={busy}>{busy ? 'Creating game…' : 'Create game'}</button>
  <a class="back" href="#/">Back to games</a>
</form>

<style>
  .play {
    display: flex;
    align-items: center;
    gap: 0.5rem;
    min-height: 2.75rem;
    margin-top: 0.5rem;
    font-size: 1.35rem;
    line-height: 1.1;
    cursor: pointer;
  }
  .play input {
    flex: none;
    width: 1.4rem;
    height: 1.4rem;
    margin: 0;
    accent-color: var(--sun);
  }
  .field {
    display: block;
    border: 0;
    padding: 0;
    margin: 0.9rem 0 0;
  }
  .field > span,
  legend,
  .step-label {
    display: block;
    padding: 0;
    font-size: 1.35rem;
    line-height: 1.1;
    margin-bottom: 0.25rem;
  }
  input:not([type='radio']):not([type='range']):not([type='checkbox']) {
    width: 100%;
    min-height: 2.75rem;
    font: inherit;
    font-size: 1.5rem;
    color: var(--ink);
    background: var(--foam);
    border: 0;
    box-shadow: inset 0 3px 0 var(--mist);
    padding: 0.3rem 0.6rem;
  }
  input::placeholder {
    color: #51658a;
  }
  input[type='range'] {
    width: 100%;
    height: 2.5rem;
    margin: 0;
    accent-color: var(--sun);
  }
  .maps {
    display: grid;
    grid-template-columns: 1fr 1fr;
    gap: 0.4rem;
  }
  .choice.map {
    display: grid;
    place-items: center;
    min-height: 3.25rem;
    padding: 0.35rem 0.25rem;
    font-size: 1.3rem;
  }
  .surprise {
    display: inline-flex;
    align-items: center;
    gap: 0.35rem;
    white-space: nowrap;
  }
  .surprise b {
    font-family: var(--display);
    font-size: 2rem;
    font-weight: 400;
    line-height: 1;
    color: var(--pink);
  }
  .choices {
    display: flex;
    gap: 0.4rem;
  }
  .choice {
    flex: 1;
    text-align: center;
    padding: 0.5rem 0;
    background: var(--deep);
    font-size: 1.5rem;
    font-variant-numeric: tabular-nums;
    cursor: pointer;
    transition: transform 0.1s cubic-bezier(0.3, 1.6, 0.6, 1);
  }
  .choice:active {
    transform: translateY(2px);
  }
  @media (hover: hover) {
    .choice:hover {
      transform: translateY(-2px);
    }
  }
  .choice.picked {
    background: var(--sun);
    color: var(--ink);
  }
  .choice.picked .surprise b {
    color: var(--ink);
  }
  .choice:focus-within {
    outline: 3px solid var(--foam);
    outline-offset: 2px;
  }
  .choice input {
    position: absolute;
    opacity: 0;
    width: 0;
    height: 0;
  }
  .steppers {
    display: grid;
    grid-template-columns: 1fr 1fr;
    gap: 0.6rem;
  }
  .step-row {
    display: grid;
    grid-template-columns: 2.75rem 1fr 2.75rem;
    align-items: center;
  }
  .step-row button {
    height: 2.75rem;
    padding: 0;
    font-family: var(--display);
    font-size: 1.9rem;
    line-height: 1;
    color: var(--foam);
    background: var(--deep);
    border: 0;
    cursor: pointer;
    transition: transform 0.09s cubic-bezier(0.3, 1.6, 0.6, 1);
  }
  .step-row button:not(:disabled):active {
    transform: translateY(2px);
  }
  .step-row button:disabled {
    opacity: 0.35;
    cursor: default;
  }
  output {
    font-size: 1.7rem;
    text-align: center;
    font-variant-numeric: tabular-nums;
  }
  .hint {
    margin: 0.25rem 0 0;
    color: var(--mist);
    font-size: 1.15rem;
    line-height: 1.1;
  }
  .example {
    margin: 0.9rem 0 0;
    padding: 0.4rem 0.6rem;
    background: var(--deep);
    font-size: 1.25rem;
    line-height: 1.15;
  }
  .example p {
    margin: 0 0 0.2rem;
    color: var(--mist);
  }
  dl {
    margin: 0;
  }
  dl div {
    display: flex;
    justify-content: space-between;
    gap: 1rem;
  }
  dt {
    color: var(--mist);
  }
  dd {
    margin: 0;
    font-variant-numeric: tabular-nums;
  }
  .win dt,
  .win dd {
    color: var(--sun);
  }
  .bond {
    margin: 0.7rem 0 0.9rem;
    color: var(--foam);
    font-size: 1.2rem;
    line-height: 1.15;
  }
  .bond b {
    font-weight: 400;
  }
  .back {
    display: block;
    padding: 0.6rem 0;
    margin-top: 0.3rem;
    font-size: 1.25rem;
  }
</style>
