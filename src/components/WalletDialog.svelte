<script lang="ts">
  import { audio } from '../lib/audio/audio.svelte';
  import { backend } from '../lib/backend';
  import { dummy, PLAYABLE_ACCOUNTS } from '../lib/backend/dummy.svelte';
  import { near } from '../lib/format';
  import { ui } from '../lib/ui.svelte';
  import Sprite from './Sprite.svelte';

  const QUICK = [1, 5, 10];

  const need = ui.wallet?.need ?? null;

  let dialog = $state<HTMLDialogElement>();
  let mode = $state<'deposit' | 'withdraw'>('deposit');
  let amount = $state<number | null>(need ? need / 1000 : 1);
  let busy = $state(false);
  let error = $state('');
  let note = $state('');

  // During a reveal the real balance would give the result away.
  const balance = $derived(ui.heldBalance ?? backend.balanceOf(backend.account));
  const wallet = $derived(backend.walletOf(backend.account));
  const milli = $derived(Math.round((Number(amount) || 0) * 1000));

  // The native dialog brings focus into itself, keeps it there, and hands it back when it closes.
  $effect(() => {
    const el = dialog;
    el?.showModal();
    return () => el?.close();
  });

  function close() {
    ui.wallet = null;
  }

  function switchMode(next: 'deposit' | 'withdraw') {
    mode = next;
    amount = next === 'deposit' ? 1 : null;
    error = note = '';
  }

  async function submit(event: SubmitEvent) {
    event.preventDefault();
    error = note = '';
    busy = true;
    try {
      if (mode === 'deposit') {
        await backend.deposit(milli);
        audio.deposit();
        if (need) return close();
        note = `${near(milli)} in. Time to dig.`;
      } else {
        await backend.withdraw(milli);
        audio.coin();
        note = `${near(milli)} back in your wallet.`;
        amount = null;
      }
    } catch (e) {
      error = (e as Error).message;
      audio.error();
    } finally {
      busy = false;
    }
  }
</script>

<!-- svelte-ignore a11y_click_events_have_key_events, a11y_no_noninteractive_element_interactions -->
<dialog
  class="modal"
  bind:this={dialog}
  aria-labelledby="wallet-title"
  oncancel={(e) => { e.preventDefault(); if (!busy) close(); }}
  onclose={close}
  onclick={(e) => { if (e.target === dialog && !busy) close(); }}
>
  <div class="panel body">
    <div class="top">
      <h2 id="wallet-title">Wallet</h2>
      <button class="x" aria-label="Close" onclick={close}>×</button>
    </div>

    <div class="pots">
      <div class="pot game">
        <span class="label">Game balance</span>
        <span class="value"><Sprite name="coin" scale={3} /> {near(balance)}</span>
      </div>
      <div class="pot">
        <span class="label">Wallet</span>
        <span class="value">{near(wallet)}</span>
      </div>
    </div>
    <p class="hint">Balance leaves out coins locked in rooms. They come back when the room ends.</p>

    {#if need}
      <p class="need">You need {near(need)} more for that.</p>
    {/if}

    <div class="modes" role="tablist">
      <button type="button" role="tab" aria-selected={mode === 'deposit'} class:on={mode === 'deposit'} onclick={() => switchMode('deposit')}>Deposit</button>
      <button type="button" role="tab" aria-selected={mode === 'withdraw'} class:on={mode === 'withdraw'} onclick={() => switchMode('withdraw')}>Withdraw</button>
    </div>

    <form onsubmit={submit}>
      <div class="quick">
        {#each QUICK as q}
          <button type="button" class:on={amount === q} disabled={busy} onclick={() => (amount = q)}>{q}</button>
        {/each}
        {#if mode === 'withdraw'}
          <button type="button" disabled={busy} onclick={() => (amount = backend.balanceOf(backend.account) / 1000)}>All</button>
        {/if}
      </div>
      <label class="custom">
        <span>Amount in NEAR</span>
        <input class="input" type="number" bind:value={amount} min="0" step="any" inputmode="decimal" placeholder="0" disabled={busy} />
      </label>
      {#if error}<p class="error" role="alert">{error}</p>{/if}
      {#if note}<p class="note" role="status">{note}</p>{/if}
      <button class="btn" type="submit" disabled={busy}>
        {#if busy}
          Asking your wallet…
        {:else}
          {mode === 'deposit' ? 'Deposit' : 'Withdraw'}{milli > 0 ? ` ${near(milli)}` : ''}
        {/if}
      </button>
    </form>

    <label class="playtest">
      <span>Playtest only: play as</span>
      <select class="select" value={backend.account} disabled={busy} onchange={(e) => dummy.switchAccount(e.currentTarget.value)}>
        {#each PLAYABLE_ACCOUNTS as account}
          <option value={account}>{account}</option>
        {/each}
      </select>
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
  .pots {
    display: grid;
    grid-template-columns: 1fr 1fr;
    gap: 0.4rem;
  }
  .pot {
    display: grid;
    gap: 0.2rem;
    padding: 0.4rem 0.6rem;
    background: var(--deep);
  }
  .pot.game .value {
    color: var(--sun);
  }
  .label {
    font-size: 1.1rem;
    line-height: 1;
    color: var(--mist);
  }
  .value {
    display: flex;
    align-items: center;
    gap: 0.3rem;
    font-size: 1.45rem;
    line-height: 1.1;
    font-variant-numeric: tabular-nums;
  }
  .hint {
    margin: 0;
    font-size: 1.1rem;
    line-height: 1.1;
    color: var(--mist);
  }
  .need {
    margin: 0;
    padding: 0.3rem 0.6rem;
    font-size: 1.35rem;
    line-height: 1.1;
    color: var(--ink);
    background: var(--sun);
  }
  .modes {
    display: grid;
    grid-template-columns: 1fr 1fr;
    gap: 0.2rem;
    margin-top: 0.2rem;
  }
  .modes button,
  .quick button {
    min-height: 2.75rem;
    font: inherit;
    font-size: 1.4rem;
    color: var(--foam);
    background: var(--deep);
    border: 0;
    cursor: pointer;
    transition: transform 0.09s cubic-bezier(0.3, 1.6, 0.6, 1);
  }
  .modes button.on,
  .quick button.on {
    color: var(--ink);
    background: var(--sun);
  }
  .quick button:active {
    transform: translateY(2px);
  }
  form {
    display: grid;
    gap: 0.5rem;
  }
  .quick {
    display: flex;
    gap: 0.3rem;
  }
  .quick button {
    flex: 1;
  }
  .custom {
    display: grid;
    gap: 0.2rem;
    font-size: 1.15rem;
    color: var(--mist);
  }
  .note {
    margin: 0;
    color: var(--sun);
    font-size: 1.25rem;
    line-height: 1.1;
  }
  .error {
    margin: 0;
  }
  .playtest {
    display: grid;
    gap: 0.2rem;
    margin-top: 0.3rem;
    padding-top: 0.5rem;
    border-top: var(--px) dashed var(--deep);
    font-size: 1.1rem;
    color: var(--mist);
  }
</style>
