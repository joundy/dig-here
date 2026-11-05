<script lang="ts">
  import { backend } from '../lib/backend';
  import type { Point } from '../lib/game/types';
  import Parrot from './Parrot.svelte';
  import Room from './Room.svelte';

  type BoardState = { pickable: boolean; spot: Point | null; label: string };
  let { id, onboard }: { id: string; onboard: (b: BoardState) => void } = $props();

  const game = $derived(backend.games.find((g) => g.id === id));
  const here = $derived(!!game?.landmarks.length);
  let looked = $state(false);

  // A Room sets itself up once, from the room as it first sees it. So it waits for the whole room,
  // which after a reload or from a link can take a read or two.
  $effect(() => {
    if (here) return;
    looked = false;
    backend.loadGame(id).finally(() => (looked = true));
  });
</script>

{#if here}
  <Room {id} {onboard} />
{:else if looked && backend.ready}
  <div class="top">
    <Parrot text="This game no longer exists. Squawk." />
    <a class="btn gap" href="#/">See open games</a>
  </div>
{:else}
  <div class="top">
    <Parrot text="Rowing out to that island…" />
  </div>
{/if}

<style>
  .gap {
    margin-top: 0.75rem;
  }
</style>
