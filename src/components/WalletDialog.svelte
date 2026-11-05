<script lang="ts">
  import { audio } from '../lib/audio/audio.svelte';
  import { backend } from '../lib/backend';
  import { near } from '../lib/format';
  import { shortName } from '../lib/names';
  import { explorer } from '../lib/near/config';
  import { tabArrows } from '../lib/tabs';
  import { ui } from '../lib/ui.svelte';
  import Sprite from './Sprite.svelte';
  import WalletHelp from './WalletHelp.svelte';

  /** A move's gas is bought at ten times its burn price, so a wallet needs some spare to do anything. */
  const GAS_ROOM = 20;
  const need = ui.wallet?.need ?? null;
  const quick = backend.prices.walletAmounts;
  const controls = backend.playtest;

  let dialog = $state<HTMLDialogElement>();
  let mode = $state<'deposit' | 'withdraw'>('deposit');
  let amount = $state<number | null>(need ? need / 1000 : quick[1] / 1000);
  let busy = $state(false);
  let error = $state('');
  let note = $state('');

  // During a reveal the real balance would give the result away.
  const balance = $derived(ui.heldBalance ?? backend.balanceOf(backend.account));
  const wallet = $derived(backend.walletOf(backend.account));
  const milli = $derived(Math.round((Number(amount) || 0) * 1000));
  const identity = $derived(backend.identity);
  const onChain = $derived(identity.kind === 'wallet');

  /** `close` fires a moment after closing, by when a quick failure may have already cleared `busy`. */
  let steppingAside = false;

  // The native dialog brings focus into itself, keeps it there, and hands it back when it closes. It steps aside
  // while the wallet is asking, because the wallet's own windows sit under anything modal, where nobody could click them.
  $effect(() => {
    const el = dialog;
    if (!el) return;
    if (busy) {
      if (el.open) steppingAside = true;
      el.close();
    } else if (!el.open) el.showModal();
    return () => el.close();
  });

  // Winnings may have landed since the last look.
  $effect(() => {
    backend.refreshBalances();
  });

  function close() {
    ui.wallet = null;
  }

  function switchMode(next: 'deposit' | 'withdraw') {
    mode = next;
    amount = next === 'deposit' ? quick[1] / 1000 : null;
    error = note = '';
  }

  async function submit(event: SubmitEvent) {
    event.preventDefault();
    error = note = '';
    if (milli <= 0) {
      error = 'Enter an amount above 0.';
      audio.error();
      return;
    }
    // Plain words now, rather than a wallet window or a contract refusal a moment later.
    if (mode === 'deposit' && onChain && backend.walletKnown && milli > wallet - GAS_ROOM) {
      error = `Your wallet has ${near(wallet)}, and needs a little left over for gas. Try a smaller amount.`;
      audio.error();
      return;
    }
    if (mode === 'withdraw' && onChain && milli > backend.balanceOf(backend.account)) {
      error = `Your game balance is ${near(backend.balanceOf(backend.account))}, so you can withdraw up to that.`;
      audio.error();
      return;
    }
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

  /** Asking first, because taking the key off the account costs a wallet window that not everyone wants. */
  let leaving = $state<'ask' | 'working' | 'done' | null>(null);
  let keyIs = $state<'removed' | 'left' | 'none'>('none');
  let walletRefused = $state(false);
  let needCoins = $state(false);

  function startLeaving() {
    if (backend.hasGameKey) leaving = 'ask';
    else void disconnect(false);
  }

  async function disconnect(removeKey: boolean) {
    error = note = '';
    keyIs = backend.hasGameKey ? 'left' : 'none';
    leaving = 'working';
    busy = removeKey;
    if (removeKey) {
      try {
        if (await backend.removeGameKey()) keyIs = 'removed';
      } catch {
        walletRefused = true;
      }
    }
    busy = false;
    await backend.disconnectWallet().catch(() => undefined);
    leaving = 'done';
  }
</script>

<!-- svelte-ignore a11y_click_events_have_key_events, a11y_no_noninteractive_element_interactions -->
<dialog
  class="modal"
  bind:this={dialog}
  aria-labelledby="wallet-title"
  oncancel={(e) => { e.preventDefault(); if (!busy) close(); }}
  onclose={() => { if (steppingAside) steppingAside = false; else if (!busy) close(); }}
  onclick={(e) => { if (e.target === dialog && !busy) close(); }}
>
  <div class="panel body">
    <div class="top">
      <h2 id="wallet-title">Wallet</h2>
      <button class="x" aria-label="Close" onclick={close}>×</button>
    </div>

    {#if leaving === 'done'}
      <p class="note" role="status">You've disconnected, and this browser has forgotten the game's key.</p>
      {#if keyIs === 'left'}
        <p class="hint">
          {walletRefused ? "Your wallet didn't remove the key, so it's" : 'The key is'} still listed on your account. It can only play this game: it can't withdraw, touch NFTs or spend your wallet's coins, and nobody holds a copy of it now.
          To remove it, look under your wallet's security or access key settings. Your game balance stays yours, ready for next time.
        </p>
      {:else if keyIs === 'removed'}
        <p class="hint">The key is off your account too. Your game balance stays yours, ready for next time.</p>
      {:else}
        <p class="hint">Your game balance stays yours, ready for next time.</p>
      {/if}
      <button class="btn" onclick={close}>Close</button>
    {:else}
    {#if backend.testnet}
      <p class="testnet">NEAR testnet. These are test coins with no real value.</p>
    {/if}

    {#if identity.kind === 'wallet'}
      <p class="who">
        Playing as <a href={explorer.account(identity.accountId)} target="_blank" rel="noopener" title={identity.accountId}>{shortName(identity.accountId)}</a>
      </p>
    {/if}

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

    <div class="modes" role="tablist" aria-label="Move coins" tabindex="-1" onkeydown={tabArrows}>
      <button type="button" role="tab" aria-selected={mode === 'deposit'} class:on={mode === 'deposit'} onclick={() => switchMode('deposit')}>Top up</button>
      <button type="button" role="tab" aria-selected={mode === 'withdraw'} class:on={mode === 'withdraw'} onclick={() => switchMode('withdraw')}>Withdraw</button>
    </div>

    <form onsubmit={submit}>
      <div class="quick">
        {#each quick as q}
          <button type="button" class:on={milli === q} disabled={busy} onclick={() => (amount = q / 1000)}>{q / 1000}</button>
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
          {mode === 'deposit' ? 'Top up' : 'Withdraw'}{milli > 0 ? ` ${near(milli)}` : ''}
        {/if}
      </button>
    </form>

    {#if onChain && backend.walletKnown && mode === 'deposit'}
      <button class="plain-link" aria-expanded={needCoins} onclick={() => (needCoins = !needCoins)}>{needCoins ? 'Hide' : 'Need test coins?'}</button>
      {#if needCoins}<WalletHelp coinsOnly />{/if}
    {/if}

    {#if onChain}
      {#if leaving === 'ask'}
        <div class="leave" role="group" aria-label="Disconnect">
          <p>Sign-in added a limited key to your account so digs need no popup. Remove it too? Your wallet will ask once.</p>
          <button class="btn alt" disabled={busy} onclick={() => disconnect(true)}>Remove the key and disconnect</button>
          <button class="plain-link" disabled={busy} onclick={() => disconnect(false)}>Disconnect, and leave the key</button>
          <button class="plain-link" disabled={busy} onclick={() => (leaving = null)}>Stay connected</button>
        </div>
      {:else}
        <button class="plain-link" onclick={startLeaving}>Disconnect this wallet</button>
      {/if}
    {/if}

    {#if controls}
      <label class="playtest">
        <span>Playtest only: play as</span>
        <select class="select" value={backend.account} disabled={busy} onchange={(e) => controls.switchAccount(e.currentTarget.value)}>
          {#each controls.playableAccounts as account}
            <option value={account}>{account}</option>
          {/each}
        </select>
      </label>
    {/if}
    {/if}
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
  .testnet {
    margin: 0;
    padding: 0.2rem 0.5rem;
    font-size: 1.15rem;
    line-height: 1.1;
    color: var(--ink);
    background: var(--pink);
  }
  .who {
    margin: 0;
    font-size: 1.2rem;
    line-height: 1.1;
    color: var(--mist);
    overflow-wrap: anywhere;
  }
  .who a {
    color: var(--foam);
  }
  .leave {
    display: grid;
    gap: 0.35rem;
    padding: 0.5rem 0.6rem;
    background: var(--deep);
  }
  .leave p {
    margin: 0;
    font-size: 1.2rem;
    line-height: 1.15;
  }
  .plain-link {
    justify-self: center;
    padding: 0.3rem;
    font: inherit;
    font-size: 1.15rem;
    color: var(--mist);
    text-decoration: underline;
    background: none;
    border: 0;
    cursor: pointer;
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
