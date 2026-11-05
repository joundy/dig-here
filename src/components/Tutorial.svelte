<script lang="ts">
  import { audio } from '../lib/audio/audio.svelte';
  import { bonus } from '../lib/format';
  import { mathRng } from '../lib/game/map';
  import { RULES } from '../lib/game/rules';
  import { setTutorialHidden, tutorialHidden, ui } from '../lib/ui.svelte';
  import Sprite from './Sprite.svelte';

  const CARDS = [
    { title: 'Read the clues', text: 'The first clue is nothing: YOLO, for the biggest bonus. Three more follow, and each one narrows it down.' },
    { title: 'Mark your spot', text: 'Put your X on land. You get one dig per round.' },
    { title: 'Dig early or wait', text: 'Score = closeness × bonus, and the bonus drops with each clue. 90 close at ×1.5 beats a perfect dig at ×1. Don\'t dig right next to someone else.' },
    { title: 'The treasure appears', text: 'Only when the timer ends. Highest score wins the pot. The exact pixel wins the jackpot.' },
    { title: 'Bring a testnet wallet', text: 'Watching is free. To dig, connect a NEAR testnet wallet: one approval to sign in, one to add coins when you join, then no more popups. Wallet and coins are free, and the game shows you how.' },
  ];
  const ROLL_STEPS = 13;

  const calm = matchMedia('(prefers-reduced-motion: reduce)').matches;

  let dialog = $state<HTMLDialogElement>();
  let next = $state<HTMLButtonElement>();
  let card = $state(0);
  let hidden = $state(tutorialHidden());
  let lit = $state(-1);
  let landed = $state<number | null>(null);

  // The native dialog brings focus into itself, keeps it there, and hands it back when it closes.
  $effect(() => {
    const el = dialog;
    el?.showModal();
    // Enter walks through the cards, rather than landing on Skip.
    next?.focus();
    return () => el?.close();
  });

  $effect(() => {
    if (card !== 3) return;
    lit = -1;
    landed = null;
    if (calm) {
      landed = 2;
      return;
    }
    let step = 0;
    let loud = true;
    let timer: ReturnType<typeof setTimeout>;
    const roll = () => {
      if (step < ROLL_STEPS) {
        lit = step % 4;
        landed = null;
        step++;
        if (loud) audio.rollStep(step / ROLL_STEPS);
        // It slows down as it goes, like a wheel running out of spin.
        timer = setTimeout(roll, 110 + step * step * 1.6);
        return;
      }
      lit = -1;
      landed = mathRng(4);
      if (loud) audio.chestLands();
      loud = false;
      step = 0;
      timer = setTimeout(roll, 2200);
    };
    timer = setTimeout(roll, 400);
    return () => clearTimeout(timer);
  });

  function close() {
    ui.tutorial = false;
  }

  function toggleHidden(value: boolean) {
    hidden = value;
    setTutorialHidden(value);
  }
</script>

<!-- svelte-ignore a11y_click_events_have_key_events, a11y_no_noninteractive_element_interactions -->
<dialog
  class="modal"
  bind:this={dialog}
  aria-labelledby="tutorial-title"
  onclose={close}
  onclick={(e) => { if (e.target === dialog) close(); }}
>
  <div class="panel body">
    <div class="top">
      <span class="count">{card + 1} of {CARDS.length}</span>
      <button class="skip" onclick={close}>Skip</button>
    </div>

    <div class="show" aria-hidden="true">
      {#if card === 0}
        <div class="face"><Sprite name="parrot" scale={3} /></div>
        <div class="trail">
          {#each RULES.clueSchedule as stop, i}
            <span class="stop" class:yolo={i === 0}>{i === 0 ? 'YOLO' : `Clue ${i + 1}`}<b>{bonus(stop.bonusBps)}</b></span>
          {/each}
        </div>
      {:else if card === 1}
        <span class="x">X</span>
        <Sprite name="shovel" scale={4} />
      {:else if card === 2}
        <div class="sums">
          <span class="sum win">90 × 1.5 = 135</span>
          <span class="vs">beats a perfect late dig</span>
          <span class="sum">100 × 1 = 100</span>
        </div>
      {:else if card === 4}
        <div class="face"><Sprite name="coin" scale={4} /></div>
      {:else}
        <div class="trees">
          {#each [0, 1, 2, 3] as tree}
            <span class="tree" class:lit={lit === tree} class:landed={landed === tree} class:out={landed !== null && landed !== tree}>
              <Sprite name="palm" scale={3} />
              {#if landed === tree}
                <Sprite name="chest" scale={2} />
              {:else}
                <span class="chance">{landed === null ? '25%' : '0%'}</span>
              {/if}
            </span>
          {/each}
        </div>
      {/if}
    </div>

    {#key card}
      <div class="words">
        <h2 id="tutorial-title">{CARDS[card].title}</h2>
        <p>{CARDS[card].text}</p>
      </div>
    {/key}

    <div class="nav">
      <button class="step" disabled={card === 0} onclick={() => card--}>Back</button>
      <div class="dots">
        {#each CARDS as item, i}
          <button class="dot" class:on={i === card} aria-label="Card {i + 1}: {item.title}" aria-current={i === card ? 'step' : undefined} onclick={() => (card = i)}><span></span></button>
        {/each}
      </div>
      <button class="step next" bind:this={next} onclick={() => (card < CARDS.length - 1 ? card++ : close())}>
        {card < CARDS.length - 1 ? 'Next' : 'Dig!'}
      </button>
    </div>

    <label class="again">
      <input type="checkbox" checked={hidden} onchange={(e) => toggleHidden(e.currentTarget.checked)} />
      Don't show again
    </label>
  </div>
</dialog>

<style>
  .body {
    display: grid;
    gap: 0.6rem;
  }
  .top {
    display: flex;
    align-items: center;
    justify-content: space-between;
  }
  .count {
    color: var(--mist);
    font-size: 1.2rem;
  }
  .skip {
    min-height: 2.5rem;
    padding: 0 0.75rem;
    font: inherit;
    font-size: 1.3rem;
    color: var(--foam);
    background: var(--deep);
    border: 0;
    cursor: pointer;
  }
  .show {
    display: flex;
    align-items: center;
    justify-content: center;
    gap: 0.75rem;
    height: 7.5rem;
    background: var(--deep);
  }
  .face {
    padding: var(--px);
    background: #4fb8ea;
  }
  .trail {
    display: grid;
    grid-template-columns: 1fr 1fr;
    gap: 0.25rem;
  }
  .stop {
    display: flex;
    justify-content: space-between;
    gap: 0.5rem;
    padding: 0.1rem 0.4rem;
    font-size: 1.1rem;
    line-height: 1.2;
    background: var(--ink);
  }
  .stop b {
    font-weight: 400;
    color: var(--sun);
  }
  .stop.yolo {
    color: var(--ink);
    background: var(--pink);
  }
  .stop.yolo b {
    color: var(--ink);
  }
  .x {
    font-family: var(--display);
    font-size: 5rem;
    line-height: 1;
    color: var(--pink);
    text-shadow: 3px 3px 0 var(--ink);
  }
  .sums {
    display: grid;
    justify-items: center;
    gap: 0.15rem;
    line-height: 1;
  }
  .sum {
    font-family: var(--display);
    font-size: 2rem;
    color: var(--mist);
  }
  .sum.win {
    font-size: 2.6rem;
    color: var(--sun);
  }
  .vs {
    font-size: 1.1rem;
    color: var(--foam);
  }
  .trees {
    display: flex;
    gap: clamp(0.4rem, 3vw, 1rem);
  }
  .tree {
    display: grid;
    justify-items: center;
    align-content: start;
    gap: 0.2rem;
    height: 6.5rem;
    padding: 0.2rem;
    opacity: 0.55;
  }
  .tree.lit {
    opacity: 1;
    background: var(--ink);
  }
  .tree.landed {
    opacity: 1;
    background: var(--sun);
    animation: thump 0.3s steps(3);
  }
  .tree.out {
    opacity: 0.25;
  }
  .chance {
    font-size: 1.2rem;
    line-height: 1;
  }
  @keyframes thump {
    40% { transform: translateY(-6px); }
  }
  .words {
    min-height: 8.6rem;
    animation: slide 0.16s steps(3);
  }
  @keyframes slide {
    from { transform: translateX(12px); opacity: 0; }
  }
  h2 {
    margin: 0 0 0.25rem;
    font-family: var(--display);
    font-size: 2.2rem;
    font-weight: 400;
    line-height: 1;
    color: var(--sun);
  }
  p {
    margin: 0;
    font-size: 1.35rem;
    line-height: 1.15;
  }
  .nav {
    display: grid;
    grid-template-columns: 1fr auto 1fr;
    align-items: center;
    gap: 0.3rem;
  }
  .step {
    min-height: 2.75rem;
    font: inherit;
    font-size: 1.4rem;
    color: var(--foam);
    background: var(--deep);
    border: 0;
    cursor: pointer;
    transition: transform 0.09s cubic-bezier(0.3, 1.6, 0.6, 1);
  }
  .step:disabled {
    opacity: 0.35;
    cursor: default;
  }
  .step.next {
    color: var(--ink);
    background: var(--sun);
  }
  .step:not(:disabled):active {
    transform: translateY(2px);
  }
  .dots {
    display: flex;
  }
  .dot {
    display: grid;
    place-items: center;
    width: 1.6rem;
    height: 2.75rem;
    padding: 0;
    background: none;
    border: 0;
    cursor: pointer;
  }
  .dot span {
    width: 0.65rem;
    height: 0.65rem;
    background: var(--deep);
  }
  .dot.on span {
    background: var(--sun);
  }
  .again {
    display: flex;
    align-items: center;
    gap: 0.4rem;
    min-height: 2rem;
    font-size: 1.2rem;
    color: var(--mist);
    cursor: pointer;
  }
  .again input {
    width: 1.2rem;
    height: 1.2rem;
    margin: 0;
    accent-color: var(--sun);
  }
</style>
