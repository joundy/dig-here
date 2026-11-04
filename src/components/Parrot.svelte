<script lang="ts">
  import { audio } from '../lib/audio/audio.svelte';
  import { ui } from '../lib/ui.svelte';
  import Sprite from './Sprite.svelte';

  type Props = {
    text: string;
    plain?: string;
    /** Small phones: a tiny parrot and a single small line. */
    compact?: boolean;
    /** Skip the typing, for a line the player has already been shown. */
    instant?: boolean;
  };

  // The game's host character. It reads every clue out loud, one letter at a time.
  let { text, plain = '', compact = false, instant = false }: Props = $props();

  let shown = $state(0);
  let timer: ReturnType<typeof setInterval> | undefined;

  const calm = matchMedia('(prefers-reduced-motion: reduce)').matches;
  const talking = $derived(shown < text.length);
  const mouthOpen = $derived(talking && Math.floor(shown / 2) % 2 === 0);
  const scale = $derived(compact ? 1 : ui.compact || ui.short ? 2 : 3);

  $effect(() => {
    const line = text;
    clearInterval(timer);
    if (calm || instant) {
      shown = line.length;
      return;
    }
    shown = 0;
    timer = setInterval(() => {
      if (shown >= line.length) {
        clearInterval(timer);
        return;
      }
      shown++;
      if (shown % 2 === 0 && shown < line.length && line[shown] !== ' ') audio.blip(620 + (line.charCodeAt(shown) % 7) * 34);
    }, 24);
    return () => clearInterval(timer);
  });

  function skip() {
    shown = text.length;
  }
</script>

<!-- svelte-ignore a11y_click_events_have_key_events, a11y_no_static_element_interactions -->
<div class="speech" class:compact onclick={skip}>
  <div class="face" class:talking><Sprite name={mouthOpen ? 'parrotTalk' : 'parrot'} {scale} /></div>
  <div class="words">
    <span class="sr-only" aria-live="polite">{text}{plain ? `${/[.!?]$/.test(text) ? '' : '.'} ${plain}` : ''}</span>
    <!-- The unseen remainder holds the box at its final size, so nothing jumps while it types. -->
    <p class="line" aria-hidden="true">{text.slice(0, shown)}<span class="unseen">{text.slice(shown)}</span></p>
    {#if plain}
      <p class="plain" class:ready={!talking} aria-hidden="true">{plain}</p>
    {/if}
  </div>
</div>

<style>
  .speech {
    display: grid;
    grid-template-columns: auto 1fr;
    gap: 0.75rem;
    padding: 0.8rem 0.9rem;
    background: var(--ink);
    box-shadow:
      0 calc(-1 * var(--px)) 0 0 var(--foam),
      0 var(--px) 0 0 var(--foam),
      calc(-1 * var(--px)) 0 0 0 var(--foam),
      var(--px) 0 0 0 var(--foam);
    margin: var(--px);
    cursor: default;
  }
  .face {
    align-self: start;
    padding: var(--px);
    background: #4fb8ea;
  }
  .face.talking {
    animation: bob 0.18s steps(2) infinite alternate;
  }
  .line {
    margin: 0;
    font-family: var(--display);
    color: var(--sun);
    font-size: clamp(1.9rem, 2.5vw, 2.5rem);
    line-height: 1;
    letter-spacing: 0.01em;
  }
  .unseen {
    visibility: hidden;
  }
  .plain {
    margin: 0.5rem 0 0;
    font-size: 1.35rem;
    line-height: 1.1;
    color: var(--foam);
    opacity: 0;
    transform: translateY(4px);
    transition: opacity 0.2s ease-out, transform 0.2s ease-out;
  }
  .plain.ready {
    opacity: 1;
    transform: none;
  }
  @media (max-width: 960px) {
    .speech {
      gap: 0.6rem;
      padding: 0.5rem 0.6rem;
    }
    .line {
      font-size: 1.75rem;
    }
    .plain {
      margin-top: 0.3rem;
      font-size: 1.2rem;
    }
  }
  @media (max-width: 960px) and (max-height: 620px) {
    .line {
      font-size: 1.5rem;
    }
  }
  /* After the media queries, so a compact parrot stays small on every screen. */
  .speech.compact {
    gap: 0.4rem;
    padding: 0.15rem 0.35rem;
    align-items: center;
  }
  .speech.compact .face {
    padding: 0;
  }
  .speech.compact .line {
    font-family: var(--body);
    font-size: 1.15rem;
    line-height: 1.05;
    letter-spacing: 0;
  }
  @keyframes bob {
    to { transform: translateY(-3px); }
  }
</style>
