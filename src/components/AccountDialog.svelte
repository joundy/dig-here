<script lang="ts">
  import type { AccountPrompt } from '../lib/backend/types';
  import { backend } from '../lib/backend';
  import { shortName } from '../lib/names';
  import Sprite from './Sprite.svelte';
  import WalletHelp from './WalletHelp.svelte';

  let { prompt }: { prompt: AccountPrompt } = $props();

  let dialog = $state<HTMLDialogElement>();
  let help = $state(false);

  // The wallet's windows sit under anything modal, where nobody could click them.
  $effect(() => {
    const el = dialog;
    if (!el) return;
    if (prompt.busy) el.close();
    else if (!el.open) el.showModal();
    return () => el.close();
  });
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

    {#if prompt.noKey}
      <p class="error" role="alert">
        {shortName(backend.account)} connected, but your wallet didn't add the game's key. Every dig would ask for an approval, and that's slow going.
        Meteor Wallet can add it.
      </p>
      <button class="btn" onclick={() => prompt.chooseAgain()}>Try another wallet</button>
      <button class="plain" onclick={() => prompt.carryOn()}>Carry on, approving every move</button>
    {:else}
      <p class="why">One approval to sign in, one to add coins when you join.</p>
      <p class="why">Then digs need no popups.</p>

      {#if prompt.error}<p class="error" role="alert">{prompt.error}</p>{/if}

      <button class="btn" onclick={() => prompt.connect()}><Sprite name="coin" scale={3} /> Connect NEAR wallet</button>

      <button class="plain" aria-expanded={help} onclick={() => (help = !help)}>{help ? 'Hide the steps' : 'No testnet wallet yet?'}</button>
      {#if help}<WalletHelp />{/if}
    {/if}

    <p class="hint">This is NEAR's test network, so the coins are free and have no value. Watching needs no wallet.</p>
  </div>
</dialog>

<style>
  .body {
    display: grid;
    gap: 0.6rem;
    max-height: calc(100dvh - 1rem);
    overflow-y: auto;
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
  .why {
    margin: 0;
    font-size: 1.4rem;
    line-height: 1.1;
  }
  .why + .why {
    margin-top: -0.45rem;
  }
  .error {
    margin: 0;
  }
  .btn {
    display: flex;
    align-items: center;
    justify-content: center;
    gap: 0.4rem;
  }
  .plain {
    justify-self: center;
    min-height: 2.75rem;
    padding: 0.3rem;
    font: inherit;
    font-size: 1.25rem;
    color: var(--foam);
    text-decoration: underline;
    background: none;
    border: 0;
    cursor: pointer;
  }
  .hint {
    margin: 0;
    font-size: 1.1rem;
    line-height: 1.1;
    color: var(--mist);
  }
</style>
