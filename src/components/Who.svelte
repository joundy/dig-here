<script lang="ts">
  import { backend } from '../lib/backend';
  import { isBot, shortName } from '../lib/names';
  import { explorer } from '../lib/near/config';

  let { account, me = '', you = 'You', link = true }: { account: string; me?: string; you?: string; link?: boolean } = $props();
</script>

{#if account === me && me}{you}{:else}{#if link && backend.testnet}<a class="who" href={explorer.account(account)} target="_blank" rel="noopener" title={account}>{shortName(account)}</a>{:else}{shortName(account)}{/if}{#if isBot(account)}<span class="bot" title="A test bot. Bots can't win season prizes.">bot</span>{/if}{/if}

<style>
  .who {
    color: inherit;
    text-decoration-style: dotted;
  }
  .bot {
    margin-left: 0.3rem;
    padding: 0 0.2rem;
    font-size: 0.85em;
    color: var(--ink);
    background: var(--mist);
  }
</style>
