<script lang="ts">
  import { audio } from '../lib/audio/audio.svelte';
  import { backend } from '../lib/backend';
  import { FAUCET_URL, NEAR_HELP_URL, WALLET_LIST_URL, WALLET_URL } from '../lib/near/config';

  /** Someone already connected only needs the coins step. */
  let { coinsOnly = false }: { coinsOnly?: boolean } = $props();

  let refused = $state(false);
  let asking = $state(false);
  let faucetNote = $state('');
  let faucetError = $state('');

  async function askFaucet() {
    asking = true;
    faucetNote = faucetError = '';
    try {
      await backend.askFaucet();
      faucetNote = '2 test NEAR are on their way to your wallet.';
      audio.coin();
    } catch (e) {
      faucetError = (e as Error).message;
    } finally {
      asking = false;
    }
  }
</script>

<ol class="steps">
  {#if !coinsOnly}
    <li>
      <strong>Make a free wallet.</strong>
      Open <a href={WALLET_URL} target="_blank" rel="noopener">Meteor Wallet</a>, which runs in your browser with nothing to install.
      Choose <em>testnet</em> and create an account. Its name ends in <em>.testnet</em>. Keep the recovery phrase safe.
    </li>
  {/if}
  <li>
    <strong>Get free test coins.</strong>
    Open the <a href={FAUCET_URL} target="_blank" rel="noopener">NEAR faucet</a>, paste your account name and press Request Tokens. A game costs about 0.05 NEAR, so one request lasts a long time.
    <button class="more" type="button" aria-expanded={refused} onclick={() => (refused = !refused)}>It says "Rate limit exceeded"?</button>
    {#if refused}
      <div class="refused">
        <p>Each internet connection gets about 10 requests every 12 hours, and an office or shared wifi can use those up together. The message says when it opens again. Until then:</p>
        <ul>
          <li><strong>Ask someone.</strong> Anyone with testnet coins can send you 0.2 NEAR, and your account name is all they need.</li>
          {#if backend.canAskFaucet}
            <li>
              <strong>Your wallet has a little left</strong>, enough to ask a public faucet contract for 2 NEAR. Your wallet will ask you to approve the call.
              <button class="ask" type="button" disabled={asking} onclick={askFaucet}>{asking ? 'Asking…' : 'Ask for 2 test NEAR'}</button>
              {#if faucetNote}<span class="said" role="status">{faucetNote}</span>{/if}
              {#if faucetError}<span class="said" role="alert">{faucetError}</span>{/if}
            </li>
          {/if}
          <li><strong>Faucet broken?</strong> NEAR's page sends people to <a href={NEAR_HELP_URL} target="_blank" rel="noopener">their Telegram</a>.</li>
          <li><strong>Watch meanwhile.</strong> Live rounds and Verify need no coins and no wallet.</li>
        </ul>
      </div>
    {/if}
  </li>
  {#if !coinsOnly}
    <li><strong>Come back here</strong> and press Connect NEAR wallet.</li>
  {/if}
</ol>
{#if !coinsOnly}
  <p class="other">Meteor not working for you? <a href={WALLET_LIST_URL} target="_blank" rel="noopener">NEAR's wallet list</a> has others. Any that does testnet is fine.</p>
{/if}

<style>
  .steps {
    display: grid;
    gap: 0.45rem;
    margin: 0;
    padding-left: 1.5rem;
    font-size: 1.25rem;
    line-height: 1.15;
  }
  strong {
    color: var(--sun);
    font-weight: 400;
  }
  em {
    font-style: normal;
    color: var(--sun);
  }
  a {
    color: var(--foam);
  }
  .more,
  .ask {
    display: block;
    min-height: 2.5rem;
    padding: 0.3rem 0;
    font: inherit;
    color: var(--sun);
    text-align: left;
    text-decoration: underline;
    background: none;
    border: 0;
    cursor: pointer;
  }
  .ask {
    padding: 0.3rem 0.6rem;
    margin-top: 0.25rem;
    color: var(--ink);
    text-decoration: none;
    background: var(--sun);
  }
  .said {
    display: block;
    margin-top: 0.25rem;
    color: var(--mist);
  }
  .refused {
    padding: 0.35rem 0.5rem;
    font-size: 1.15rem;
    background: var(--deep);
  }
  .refused p {
    margin: 0 0 0.3rem;
  }
  .refused ul {
    display: grid;
    gap: 0.3rem;
    margin: 0;
    padding-left: 1rem;
  }
  .other {
    margin: 0;
    font-size: 1.1rem;
    line-height: 1.1;
    color: var(--mist);
  }
</style>
