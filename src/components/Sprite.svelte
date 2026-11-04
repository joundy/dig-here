<script lang="ts">
  import { sprite } from '../lib/world/sprites';
  import type { SpriteName } from '../lib/world/sprites';

  let { name, scale = 3, alt = '' }: { name: SpriteName; scale?: number; alt?: string } = $props();

  let canvas = $state<HTMLCanvasElement>();

  const size = $derived(sprite(name));

  $effect(() => {
    if (!canvas) return;
    const { canvas: art, w, h } = size;
    canvas.width = w;
    canvas.height = h;
    const ctx = canvas.getContext('2d')!;
    ctx.clearRect(0, 0, w, h);
    ctx.drawImage(art, 0, 0);
  });
</script>

<canvas
  bind:this={canvas}
  style:width="{size.w * scale}px"
  style:height="{size.h * scale}px"
  role={alt ? 'img' : undefined}
  aria-label={alt || undefined}
  aria-hidden={alt ? undefined : 'true'}
></canvas>

<style>
  canvas {
    display: block;
    image-rendering: crisp-edges;
    image-rendering: pixelated;
  }
</style>
