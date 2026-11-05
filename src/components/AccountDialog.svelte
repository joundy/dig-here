<script lang="ts">
  import { audio } from '../lib/audio/audio.svelte';
  import type { AccountPrompt } from '../lib/backend/types';
  import Sprite from './Sprite.svelte';

  let { prompt }: { prompt: AccountPrompt } = $props();

  let dialog = $state<HTMLDialogElement>();

  $effect(() => {
    const el = dialog;
    el?.showModal();
    return () => el?.close();
  });

  function guest() {
    audio.pick();
    prompt.chooseGuest();
  }
</script>

<!-- svelte-ignore a11y_click_events_have_key_events, a11y_no_noninteractive_element_interactions -->
<dialog
  class="modal"
  bind:this={dialog}
  aria-labelledby="account-title"
  oncancel={(e) => { e.preventDefault(); prompt.cancel(); }}
  onclick={(e) => { if (e.target === dialog) prompt.cancel(); }}
>
  <div class="panel body">
    <div class="top">
      <h2 id="account-title">Grab a shovel</h2>
      <button class="x" aria-label="Close" onclick={() => prompt.cancel()}>×</button>
    </div>

    <button class="choice-big" onclick={guest}>
      <span class="title"><Sprite name="coin" scale={3} /> Play as guest</span>
      <span class="line">Right now, with free testnet coins. Nothing to install.</span>
    </button>

    <button class="choice-big alt" onclick={() => prompt.chooseWallet()}>
      <span class="title">Connect NEAR wallet</span>
      <span class="line">Use your own testnet account. Coins and NFTs stay yours to move.</span>
    </button>

    <p class="hint">This is NEAR's test network, so the coins have no value. You can watch without choosing.</p>
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
  h2 {
    margin: 0;
    font-family: var(--display);
    font-size: 2.4rem;
    font-weight: 400;
    line-height: 1;
    color: var(--sun);
  }
  .x {
    width: 2.75rem;
    height: 2.75rem;
    margin: -0.25rem -0.25rem -0.25rem 0;
    padding: 0;
    font-family: var(--display);
    font-size: 2rem;
    line-height: 1;
    color: var(--foam);
    background: var(--deep);
    border: 0;
    cursor: pointer;
  }
  .choice-big {
    display: grid;
    gap: 0.2rem;
    padding: 0.7rem 0.8rem;
    text-align: left;
    font: inherit;
    color: var(--ink);
    background: var(--sun);
    border: 0;
    box-shadow: 0 var(--px) 0 var(--ink);
    cursor: pointer;
    transition: transform 0.09s cubic-bezier(0.3, 1.6, 0.6, 1);
  }
  .choice-big.alt {
    color: var(--foam);
    background: var(--deep);
  }
  @media (hover: hover) {
    .choice-big:hover {
      transform: translateY(-2px);
    }
  }
  .choice-big:active {
    transform: translateY(2px);
  }
  .title {
    display: flex;
    align-items: center;
    gap: 0.4rem;
    font-family: var(--display);
    font-size: 1.9rem;
    line-height: 1;
  }
  .line {
    font-size: 1.25rem;
    line-height: 1.1;
  }
  .hint {
    margin: 0;
    font-size: 1.1rem;
    line-height: 1.1;
    color: var(--mist);
  }
</style>
