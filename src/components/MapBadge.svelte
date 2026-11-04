<script lang="ts">
  import { mapName } from '../lib/game/copy';
  import type { MapId } from '../lib/game/types';
  import type { SpriteName } from '../lib/world/sprites';
  import Sprite from './Sprite.svelte';

  let { mapId, compact = false }: { mapId: MapId; compact?: boolean } = $props();

  const ICONS: Record<MapId, SpriteName> = { tropical: 'palm', snowy: 'penguin', desert: 'camel' };

  const name = $derived(mapName(mapId));
</script>

<span class="badge" class:compact>
  <Sprite name={ICONS[mapId]} scale={compact ? 1 : 2} />
  <span>{compact ? name.split(' ')[0] : name}</span>
</span>

<style>
  .badge {
    display: inline-flex;
    align-items: center;
    gap: 0.35rem;
    line-height: 1;
    white-space: nowrap;
  }
  .compact {
    gap: 0.2rem;
    color: var(--mist);
  }
</style>
