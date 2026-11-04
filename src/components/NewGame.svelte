<script lang="ts">
  import { backend } from '../lib/backend';
  import { clock, near } from '../lib/format';
  import { splitPot } from '../lib/game/engine';
  import { RULES } from '../lib/game/rules';
  import Parrot from './Parrot.svelte';

  const EXAMPLE_PLAYERS = 10;

  let name = $state('');
  let feeNear = $state(1);
  let durationSec = $state<number>(180);
  let cutPercent = $state(5);
  let error = $state('');
  let busy = $state(false);

  const feeMilli = $derived(Math.round((Number(feeNear) || 0) * 1000));
  const example = $derived(splitPot(feeMilli * EXAMPLE_PLAYERS, cutPercent * 100));

  async function submit(event: SubmitEvent) {
    event.preventDefault();
    error = '';
    busy = true;
    try {
      const id = await backend.createGame({ name, fee: feeMilli, durationSec, hostCutBps: cutPercent * 100 });
      location.hash = `#/game/${id}`;
    } catch (e) {
      error = (e as Error).message;
    } finally {
      busy = false;
    }
  }
</script>

<form onsubmit={submit}>
  <Parrot text="You set the terms and take a share of the pot." plain="You can't choose where the treasure lands. Nobody can." />

  <label class="field">
    <span>Game name</span>
    <input bind:value={name} maxlength="40" placeholder="Lunch money" />
  </label>

  <label class="field">
    <span>Entry fee in NEAR</span>
    <input type="number" bind:value={feeNear} min="0.001" step="any" inputmode="decimal" />
  </label>

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

  <label class="field">
    <span>You keep {cutPercent}% of the pot</span>
    <input type="range" bind:value={cutPercent} min="0" max={RULES.maxHostCutBps / 100} step="1" />
  </label>

  <p class="example">
    With {EXAMPLE_PLAYERS} players the pot is {near(feeMilli * EXAMPLE_PLAYERS)}: the winner gets
    {near(example.prize)} and you get {near(example.hostCut)}.
  </p>

  {#if error}<p class="error" role="alert">{error}</p>{/if}

  <button class="btn" type="submit" disabled={busy}>{busy ? 'Creating game…' : 'Create game'}</button>
  <a class="back" href="#/">Back to open games</a>
</form>

<style>
  .field {
    display: block;
    border: 0;
    padding: 0;
    margin: 0.9rem 0 0;
  }
  .field > span,
  legend {
    display: block;
    padding: 0;
    font-size: 1.35rem;
    line-height: 1.1;
    margin-bottom: 0.25rem;
  }
  input:not([type='radio']):not([type='range']) {
    width: 100%;
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
  .example {
    margin: 0.9rem 0;
    color: var(--mist);
    font-size: 1.25rem;
    line-height: 1.15;
  }
  .back {
    display: block;
    margin-top: 0.9rem;
    font-size: 1.25rem;
  }
</style>
