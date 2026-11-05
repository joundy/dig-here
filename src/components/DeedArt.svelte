<script lang="ts">
  import type { Kind, MapId } from '../lib/game/types';
  import { heroFrames, heroGrid, heroLayers, heroSize } from '../lib/world/heroArt';
  import { paintScene, paintShadow } from '../lib/world/deedScene';

  let { map, kind, scale, live = false, alt = '' }: {
    map: MapId;
    kind: Kind;
    /** Screen pixels per art pixel, at most. A wide or tall landmark comes down a step to fit. */
    scale: number;
    /** Lets a campfire flicker and a windmill turn. Only the big hero does this. */
    live?: boolean;
    alt?: string;
  } = $props();

  const FRAME_MS = 260;
  const calm = matchMedia('(prefers-reduced-motion: reduce)').matches;

  let box = $state<HTMLDivElement>();
  let canvas = $state<HTMLCanvasElement>();
  let width = $state(0);
  let height = $state(0);
  let frame = $state(0);

  $effect(() => {
    if (!box) return;
    const watch = new ResizeObserver(([entry]) => {
      width = Math.round(entry.contentRect.width);
      height = Math.round(entry.contentRect.height);
    });
    watch.observe(box);
    return () => watch.disconnect();
  });

  $effect(() => {
    if (!live || calm || heroFrames(kind) < 2) return;
    const timer = setInterval(() => (frame = (frame + 1) % 6), FRAME_MS);
    return () => clearInterval(timer);
  });

  const size = $derived(heroSize(kind));
  /** The whole landmark has to fit with sky above it, so the art's pixels never land between screen pixels. */
  const fit = $derived(width && height ? Math.max(1, Math.min(scale, Math.floor((width - 8) / size.w), Math.floor((height * 0.88) / size.h))) : scale);
  const wide = $derived(Math.ceil(width / fit));
  const tall = $derived(Math.ceil(height / fit));

  // The scene is the slow part and never changes, so it's drawn once and each frame only lays the sprite on top.
  const scene = $derived.by(() => {
    if (!wide || !tall) return null;
    const off = document.createElement('canvas');
    off.width = wide;
    off.height = tall;
    const ctx = off.getContext('2d')!;
    const paint = (x: number, y: number, w: number, h: number, color: string) => {
      ctx.fillStyle = color;
      ctx.fillRect(x, y, w, h);
    };
    const horizon = Math.floor(tall * 0.66);
    paintScene(paint, map, kind, `${map}:${kind}`, wide, tall, horizon);
    ctx.globalAlpha = 0.28;
    paintShadow(paint, Math.floor((wide - size.w) / 2) - 2, feet() - 2, size.w + 4);
    ctx.globalAlpha = 1;
    return off;
  });

  function feet(): number {
    return tall - Math.max(3, Math.floor(tall * 0.1));
  }

  $effect(() => {
    if (!canvas || !scene) return;
    canvas.width = wide;
    canvas.height = tall;
    const ctx = canvas.getContext('2d')!;
    ctx.drawImage(scene, 0, 0);
    const left = Math.floor((wide - size.w) / 2);
    const bottom = feet();
    for (const layer of heroLayers(kind, frame)) {
      const grid = heroGrid(layer.name);
      const top = bottom - heroGrid(heroLayers(kind)[0].name).length + layer.y;
      grid.forEach((row, y) => row.forEach((color, x) => {
        if (!color) return;
        ctx.fillStyle = color;
        ctx.fillRect(left + layer.x + x, top + y, 1, 1);
      }));
    }
  });
</script>

<div class="art" bind:this={box}>
  <canvas
    bind:this={canvas}
    style:width="{wide * fit}px"
    style:height="{tall * fit}px"
    role={alt ? 'img' : undefined}
    aria-label={alt || undefined}
    aria-hidden={alt ? undefined : 'true'}
  ></canvas>
</div>

<style>
  .art {
    position: relative;
    width: 100%;
    height: 100%;
    overflow: hidden;
    background: var(--deep);
  }
  canvas {
    display: block;
    image-rendering: crisp-edges;
    image-rendering: pixelated;
  }
</style>
