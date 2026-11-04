<script lang="ts">
  import { Tween } from 'svelte/motion';
  import { cubicOut } from 'svelte/easing';
  import { audio } from '../lib/audio/audio.svelte';
  import { backend } from '../lib/backend';
  import { dummy, PLAYABLE_ACCOUNTS } from '../lib/backend/dummy.svelte';
  import { near } from '../lib/format';
  import { ui } from '../lib/ui.svelte';
  import Sprite from './Sprite.svelte';

  const balance = $derived(ui.heldBalance ?? backend.balanceOf(backend.account));
  const shown = new Tween(0, { duration: 500, easing: cubicOut });

  $effect(() => {
    shown.target = balance;
  });
</script>

<header>
  <a class="brand" href="#/">Dig Here</a>
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
    <label class="wallet">
      <span class="sr-only">Playing as</span>
      <select value={backend.account} onchange={(e) => dummy.switchAccount(e.currentTarget.value)}>
        {#each PLAYABLE_ACCOUNTS as account}
          <option value={account}>{account}</option>
        {/each}
      </select>
      <span class="money">
        <Sprite name="coin" scale={3} />
        <span class="amount">{near(Math.round(shown.current))}</span>
      </span>
    </label>
  </div>
</header>

<style>
  header {
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
  .tools {
    display: flex;
    align-items: center;
    flex-wrap: wrap;
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
  @media (hover: hover) {
    .icon:hover {
      transform: translateY(-2px);
    }
  }
  .icon:active {
    transform: translateY(2px);
  }
  select {
    font: inherit;
    font-size: 1.25rem;
    height: 2.25rem;
    color: var(--foam);
    background: var(--deep);
    border: 0;
    padding: 0 0.5rem;
  }
  .wallet {
    position: relative;
    display: flex;
    align-items: center;
    gap: 0.5rem;
  }
  .money {
    display: flex;
    align-items: center;
    gap: 0.4rem;
    font-size: 1.5rem;
    line-height: 1;
  }
  .amount {
    font-variant-numeric: tabular-nums;
    min-width: 5.5rem;
  }
  /* No room for the account menu on a phone: tapping the balance opens it instead. */
  @media (max-width: 960px) {
    header {
      flex-wrap: nowrap;
      padding-bottom: 0.3rem;
    }
    .brand {
      font-size: 2.2rem;
    }
    .tools {
      flex-wrap: nowrap;
      gap: 0.35rem;
    }
    .icon {
      width: 2.5rem;
      height: 2.5rem;
    }
    select {
      position: absolute;
      inset: 0;
      width: 100%;
      height: 100%;
      opacity: 0;
    }
    .money {
      height: 2.5rem;
      padding: 0 0.5rem;
      background: var(--deep);
      font-size: 1.35rem;
    }
    .amount {
      min-width: 0;
    }
  }
</style>
