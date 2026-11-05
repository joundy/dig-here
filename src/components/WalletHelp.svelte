<script lang="ts">
  import { FAUCET_URL, WALLET_LIST_URL, WALLET_URL } from '../lib/near/config';

  /** Someone already connected only needs the coins step. */
  let { coinsOnly = false }: { coinsOnly?: boolean } = $props();
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
    Open the <a href={FAUCET_URL} target="_blank" rel="noopener">NEAR faucet</a>, paste your account name and press Request.
    If it says you've asked too often, try again later.
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
  .other {
    margin: 0;
    font-size: 1.1rem;
    line-height: 1.1;
    color: var(--mist);
  }
</style>
