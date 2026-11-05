<script lang="ts">
  import { onDestroy, untrack } from 'svelte';
  import { audio } from '../lib/audio/audio.svelte';
  import { bonus } from '../lib/format';
  import { kindName } from '../lib/game/copy';
  import { rankDigs, scoreDig, standing } from '../lib/game/engine';
  import { RULES } from '../lib/game/rules';
  import type { Game } from '../lib/game/types';
  import { shortName } from '../lib/names';
  import { buzz } from '../lib/ui.svelte';

  let { game, me }: { game: Game; me: string } = $props();

  const now = $derived(standing(game, me));
  const myDig = $derived(game.digs.find((d) => d.account === me));

  let message = $state<{ id: number; text: string } | null>(null);
  let timer: ReturnType<typeof setTimeout> | undefined;
  let messageId = 0;

  function tell(text: string) {
    clearTimeout(timer);
    message = { id: ++messageId, text };
    timer = setTimeout(() => (message = null), 3000);
  }

  // Starting from what's true now means a reload or a fresh dig raises no false alarm.
  let previous = untrack(() => now?.wins ?? []);

  $effect(() => {
    const wins = now?.wins ?? [];
    const before = previous;
    previous = wins;
    const lost = before.filter((id) => !wins.includes(id));
    if (!lost.length) return;
    untrack(() => {
      if (game.stage !== 'live') return;
      const { landmarks } = game;
      const gone = lost.filter((id) => !game.candidateIds.includes(id));
      if (gone.length) {
        tell(gone.length === 1 ? `Your ${kindName(landmarks[gone[0]].kind)} is gone!` : `Your ${gone.length} spots are gone!`);
        audio.spotGone();
      } else {
        const thief = rankDigs(game.digs.map((d) => scoreDig(d, landmarks[lost[0]])))[0].account;
        tell(`${shortName(thief)} just stole ${lost.length === 1 ? 'a spot' : `${lost.length} spots`} from you!`);
        audio.spotStolen();
      }
      buzz(30);
    });
  });

  onDestroy(() => clearTimeout(timer));

  const wins = $derived(now?.wins.length ?? 0);
  const of = $derived(now?.of ?? 0);
</script>

{#key message?.id}
  <p class="standing" class:none={wins === 0} class:all={of > 0 && wins === of} class:alert={message} aria-live="polite">
    {#if message}
      {message.text}
    {:else}
      You dug at {bonus(myDig?.bonusBps ?? 0)}{myDig?.crowded ? `, crowded ${bonus(RULES.crowdBps)}` : ''}. You'd win on {wins} of {of} {of === 1 ? 'spot' : 'spots'} right now
    {/if}
  </p>
{/key}

<style>
  .standing {
    margin: 0;
    padding: 0.5rem 0.75rem 0.5rem 1rem;
    background: var(--deep);
    box-shadow: inset 6px 0 0 var(--foam);
    font-size: 1.3rem;
    line-height: 1.15;
    display: flex;
    align-items: center;
    min-height: 3.25rem;
    transition: background 0.2s ease-out, box-shadow 0.2s ease-out;
  }
  .none {
    background: #6a2348;
    box-shadow: inset 6px 0 0 var(--pink);
  }
  .all {
    color: var(--ink);
    background: var(--sun);
    box-shadow: inset 6px 0 0 #d98f00;
  }
  .alert {
    color: var(--ink);
    background: #ffc2d9;
    box-shadow: inset 6px 0 0 var(--pink);
    animation: shake 0.4s steps(6);
  }
  @keyframes shake {
    20% { transform: translateX(-6px); }
    40% { transform: translateX(6px); }
    60% { transform: translateX(-4px); }
    80% { transform: translateX(4px); }
  }
  :global(.stage.compact.game) .standing {
    font-size: 1.2rem;
  }
</style>
