<script lang="ts">
  import { Tween } from 'svelte/motion';
  import { cubicOut } from 'svelte/easing';
  import { audio } from '../lib/audio/audio.svelte';
  import { backend } from '../lib/backend';
  import { near } from '../lib/format';
  import { shortName } from '../lib/names';
  import { openWallet, ui } from '../lib/ui.svelte';
  import Sprite from './Sprite.svelte';

  let { current }: { current: string } = $props();

  const NAV = [
    { name: 'lobby', href: '#/', label: 'Games' },
    { name: 'deeds', href: '#/nfts', label: 'NFTs' },
    { name: 'season', href: '#/season', label: 'Season' },
  ];

  const balance = $derived(ui.heldBalance ?? backend.balanceOf(backend.account));
  const watching = $derived(backend.identity.kind === 'none');
  const shown = new Tween(0, { duration: 500, easing: cubicOut });

  $effect(() => {
    shown.target = balance;
  });

  // Nothing to show a watcher yet. This is one of the places that can ask how they'd like to play.
  function money() {
    if (watching) backend.ensureAccount().then(() => openWallet()).catch(() => {});
    else openWallet();
  }
</script>

<header>
  <a class="brand" href="#/">Dig Here</a>
  {#if backend.testnet}<span class="testnet" title="Everything here runs on NEAR's test network. These coins have no value.">Testnet</span>{/if}
  <nav aria-label="Pages">
    {#each NAV as link}
      <a href={link.href} class:here={current === link.name} aria-current={current === link.name ? 'page' : undefined}>{link.label}</a>
    {/each}
  </nav>
  <div class="tools">
    <button
      class="icon"
      aria-pressed={audio.settings.music}
      aria-label="Music"
      title={audio.settings.music ? 'Music on' : 'Music off'}
      onclick={() => audio.toggleMusic()}
    >
      <Sprite name={audio.settings.music ? 'noteOn' : 'noteOff'} scale={2} />
    </button>
    <button
      class="icon"
      aria-pressed={audio.settings.sfx}
      aria-label="Sound effects"
      title={audio.settings.sfx ? 'Sound effects on' : 'Sound effects off'}
      onclick={() => audio.toggleSfx()}
    >
      <Sprite name={audio.settings.sfx ? 'speakerOn' : 'speakerOff'} scale={2} />
    </button>
    <button class="icon help" aria-label="How to play" title="How to play" onclick={() => (ui.tutorial = true)}>?</button>
    <button class="money" aria-label={watching ? 'Connect a wallet to play' : `${backend.account}, balance ${near(balance)}. Open wallet`} title={watching ? 'Connect a wallet' : backend.account} onclick={money}>
      <Sprite name="coin" scale={3} />
      {#if watching}
        <span class="amount">Play</span>
      {:else}
        <span class="held">
          <span class="who">{shortName(backend.account)}</span>
          <span class="amount">{near(Math.round(shown.current)).replace(' NEAR', '')}<span class="unit">{' NEAR'}</span></span>
        </span>
        <span class="plus" aria-hidden="true">+</span>
      {/if}
    </button>
  </div>
</header>

<style>
  header {
    position: relative;
    z-index: 2;
    display: flex;
    align-items: center;
    justify-content: space-between;
    flex-wrap: wrap;
    gap: 0.25rem 1rem;
    padding: calc(0.5rem + env(safe-area-inset-top)) clamp(0.75rem, 1.5vw, 1.25rem) 0.5rem;
  }
  .brand {
    font-family: var(--display);
    font-size: 2.8rem;
    line-height: 1;
    color: var(--sun);
    text-decoration: none;
    white-space: nowrap;
    text-shadow: 3px 3px 0 var(--ink);
  }
  .testnet {
    padding: 0.05rem 0.35rem;
    font-size: 1.05rem;
    line-height: 1.1;
    color: var(--ink);
    background: var(--pink);
  }
  nav {
    display: flex;
    gap: 0.35rem;
    margin-right: auto;
  }
  nav a {
    padding: 0.2rem 0.6rem;
    font-size: 1.4rem;
    line-height: 1.2;
    text-decoration: none;
    background: var(--deep);
    transition: transform 0.09s cubic-bezier(0.3, 1.6, 0.6, 1);
  }
  nav a.here {
    background: var(--ink);
    color: var(--sun);
  }
  @media (hover: hover) {
    nav a:hover {
      transform: translateY(-2px);
    }
  }
  .tools {
    display: flex;
    align-items: center;
    gap: 0.5rem;
  }
  .icon {
    display: grid;
    place-items: center;
    width: 2.25rem;
    height: 2.25rem;
    padding: 0;
    background: var(--deep);
    border: 0;
    cursor: pointer;
    transition: transform 0.09s cubic-bezier(0.3, 1.6, 0.6, 1);
  }
  .help {
    font-family: var(--display);
    font-size: 1.9rem;
    line-height: 1;
    color: var(--sun);
  }
  .money {
    display: flex;
    align-items: center;
    gap: 0.4rem;
    height: 2.25rem;
    padding: 0 0.5rem;
    font: inherit;
    font-size: 1.5rem;
    line-height: 1;
    color: var(--foam);
    background: var(--deep);
    border: 0;
    cursor: pointer;
    transition: transform 0.09s cubic-bezier(0.3, 1.6, 0.6, 1);
  }
  .amount {
    font-variant-numeric: tabular-nums;
    white-space: nowrap;
  }
  .held {
    display: grid;
    justify-items: start;
    line-height: 0.95;
  }
  /* Testnet names run long, and the name only has to be enough to know whose wallet this is. */
  .who {
    max-width: 9rem;
    overflow: hidden;
    font-size: 1rem;
    color: var(--mist);
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  .plus {
    font-family: var(--display);
    color: var(--sun);
  }
  @media (hover: hover) {
    .icon:hover,
    .money:hover {
      transform: translateY(-2px);
    }
  }
  .icon:active,
  .money:active {
    transform: translateY(2px);
  }
  /* A phone has room for the essentials only. The Game Board links to the other pages. */
  @media (max-width: 960px) {
    header {
      flex-wrap: nowrap;
      padding-bottom: 0.3rem;
    }
    nav {
      display: none;
    }
    .brand {
      font-size: 2.2rem;
    }
    .tools {
      gap: 0.3rem;
    }
    .icon {
      width: 2.5rem;
      height: 2.5rem;
    }
    .money {
      height: 2.5rem;
      font-size: 1.35rem;
    }
    .unit {
      display: none;
    }
  }
  @media (max-width: 400px) {
    header {
      gap: 0.25rem 0.3rem;
      padding-left: 0.4rem;
      padding-right: 0.4rem;
    }
    .brand {
      font-size: 1.55rem;
    }
    .testnet {
      font-size: 0.9rem;
      padding: 0 0.15rem;
    }
    .tools {
      gap: 0.2rem;
    }
    .icon {
      width: 2.5rem;
    }
    .money {
      gap: 0.25rem;
      padding: 0 0.35rem;
    }
    .who {
      max-width: 4.2rem;
    }
    .plus {
      display: none;
    }
  }
  /* The smallest phones still in use: the sound buttons give way, since the name and balance matter more. */
  @media (max-width: 345px) {
    .icon {
      width: 2.1rem;
    }
    .testnet {
      display: none;
    }
    .money {
      min-width: 0;
    }
  }
</style>
