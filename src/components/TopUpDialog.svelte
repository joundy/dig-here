<script lang="ts">
  import { untrack } from 'svelte';
  import { backend } from '../lib/backend';
  import { near } from '../lib/format';
  import { topUpPlan } from '../lib/near/choices';
  import type { TopUp } from '../lib/ui.svelte';
  import { ui } from '../lib/ui.svelte';
  import WalletHelp from './WalletHelp.svelte';

  let { request }: { request: TopUp } = $props();

  let dialog = $state<HTMLDialogElement>();

  const me = $derived(backend.account);
  const balance = $derived(backend.balanceOf(me));
  const wallet = $derived(backend.walletOf(me));
  const plan = $derived(topUpPlan(request.cost, balance, wallet, backend.setupCost, request.perRound));
  let picked = $state<number | null>(null);
  const choice = $derived(plan.choices[picked ?? plan.picked] ?? plan.choices[0] ?? null);

  $effect(() => {
    const el = dialog;
    el?.showModal();
    return () => el?.close();
  });

  // It may have been a while since the last look, and this is the number that decides what's offered.
  untrack(() => backend.refreshBalances());

  function finish(attach: number | null) {
    const { answer } = request;
    ui.topUp = null;
    answer(attach);
  }
</script>

<!-- svelte-ignore a11y_click_events_have_key_events, a11y_no_noninteractive_element_interactions -->
<dialog
  class="modal"
  bind:this={dialog}
  aria-labelledby="topup-title"
  oncancel={(e) => { e.preventDefault(); finish(null); }}
  onclick={(e) => { if (e.target === dialog) finish(null); }}
>
  <div class="panel body">
    <div class="top">
      <h2 id="topup-title">Add coins</h2>
      <button class="x" aria-label="Close" onclick={() => finish(null)}>×</button>
    </div>

    <dl>
      <div><dt>{request.what}</dt><dd>{near(request.cost)}</dd></div>
      {#if balance > 0}<div><dt>From your game balance</dt><dd>−{near(Math.min(balance, request.cost))}</dd></div>{/if}
      {#if plan.setup}<div><dt>One-time setup (about 0.001, the rest stays yours)</dt><dd>{near(plan.setup)}</dd></div>{/if}
    </dl>

    {#if choice}
      <fieldset>
        <legend>Add extra, so the next games need no popup?</legend>
        {#each plan.choices as option, i}
          <label class="choice" class:on={option === choice}>
            <input type="radio" name="topup" checked={option === choice} onchange={() => (picked = i)} />
            {#if option.extra === 0}
              <span>Just this one</span>
            {:else}
              <span>+{near(option.extra)}<small>&nbsp;· about {option.rounds} games</small></span>
            {/if}
          </label>
        {/each}
      </fieldset>

      <p class="sum">Your wallet will ask you to approve <strong>{near(choice.total)}</strong>. About {near(choice.left)} stays in your wallet. You can withdraw what you don't use.</p>

      <button class="btn" onclick={() => finish(choice.total)}>Approve {near(choice.total)}</button>
      <button class="plain" onclick={() => finish(null)}>Not now</button>
    {:else}
      <p class="error" role="alert">Your wallet has {near(wallet)}, and this needs {near(plan.short)} plus a little for gas.</p>
      <WalletHelp coinsOnly />
      <button class="btn alt" onclick={() => backend.refreshBalances()}>I've got them, check again</button>
    {/if}
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
  dl {
    display: grid;
    gap: 0.15rem;
    margin: 0;
  }
  dl div {
    display: flex;
    justify-content: space-between;
    gap: 0.75rem;
    font-size: 1.25rem;
    line-height: 1.1;
  }
  dd {
    margin: 0;
    white-space: nowrap;
    font-variant-numeric: tabular-nums;
  }
  fieldset {
    display: grid;
    gap: 0.25rem;
    margin: 0;
    padding: 0;
    border: 0;
  }
  legend {
    padding: 0 0 0.25rem;
    font-size: 1.15rem;
    line-height: 1.1;
    color: var(--mist);
  }
  .choice {
    display: flex;
    align-items: center;
    gap: 0.5rem;
    min-height: 2.75rem;
    padding: 0.2rem 0.6rem;
    font-size: 1.4rem;
    background: var(--deep);
    cursor: pointer;
  }
  .choice.on {
    color: var(--ink);
    background: var(--sun);
  }
  small {
    font-size: 1.1rem;
  }
  .sum {
    margin: 0;
    font-size: 1.25rem;
    line-height: 1.15;
  }
  .sum strong {
    color: var(--sun);
    font-weight: 400;
  }
  .error {
    margin: 0;
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
</style>
