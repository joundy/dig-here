<script lang="ts">
  import type { Kind, MapId } from '../lib/game/types';
  import { toGrid } from '../lib/world/heroArt';
  import { paintScene } from '../lib/world/deedScene';
  import { SPRITE_ART } from '../lib/world/sprites';

  let { map, kinds, found }: {
    map: MapId;
    kinds: readonly Kind[];
    /** The kinds someone owns. The rest stand in shadow until they're minted. */
    found: (kind: Kind) => boolean;
  } = $props();

  const SCALE = 3;
  const GAP = 2;
  const SHADOW: Record<MapId, string> = { tropical: '#1f6a4a', snowy: '#6f8dad', desert: '#a9683a' };

  let box = $state<HTMLDivElement>();
  let canvas = $state<HTMLCanvasElement>();
  let width = $state(0);

  $effect(() => {
    if (!box) return;
    const watch = new ResizeObserver(([entry]) => (width = Math.round(entry.contentRect.width)));
    watch.observe(box);
    return () => watch.disconnect();
  });

  const footprint = $derived(kinds.map((kind) => ({ kind, grid: toGrid(SPRITE_ART[kind]) })));
  const oneRow = $derived(footprint.reduce((sum, s) => sum + s.grid[0].length + GAP, 0));
  /** Everyone on one line when there's room, and a back row and a front row, like a team photo, when there isn't. */
  const rows = $derived(width && Math.ceil(width / SCALE) >= oneRow ? 1 : 2);
  const tall = $derived(rows === 1 ? 36 : 44);

  $effect(() => {
    if (!canvas || !width) return;
    const wide = Math.ceil(width / SCALE);
    canvas.width = wide;
    canvas.height = tall;
    const ctx = canvas.getContext('2d')!;
    const paint = (x: number, y: number, w: number, h: number, color: string) => {
      ctx.fillStyle = color;
      ctx.fillRect(x, y, w, h);
    };
    const horizon = rows === 1 ? 24 : 18;
    paintScene(paint, map, null, `line-up:${map}`, wide, tall, horizon, 1);

    const lines = rows === 1 ? [footprint] : [footprint.filter((_, i) => i % 2 === 0), footprint.filter((_, i) => i % 2 === 1)];
    lines.forEach((line, row) => {
      const bottom = rows === 1 ? tall - 3 : row === 0 ? tall - 15 : tall - 2;
      const total = line.reduce((sum, s) => sum + s.grid[0].length, 0);
      const spacing = Math.min(GAP + 2, Math.floor((wide - total) / Math.max(1, line.length)));
      let x = Math.floor((wide - total - spacing * (line.length - 1)) / 2);
      for (const { kind, grid } of line) {
        const lit = found(kind);
        const top = bottom - grid.length;
        grid.forEach((cells, y) => cells.forEach((color, cx) => {
          if (!color) return;
          ctx.fillStyle = lit ? color : SHADOW[map];
          ctx.fillRect(x + cx, top + y, 1, 1);
        }));
        x += grid[0].length + spacing;
      }
    });
  });
</script>

<div class="line-up" bind:this={box} style:height="{tall * SCALE}px">
  <canvas bind:this={canvas} style:width="{Math.ceil(width / SCALE) * SCALE}px" style:height="{tall * SCALE}px" aria-hidden="true"></canvas>
</div>

<style>
  .line-up {
    overflow: hidden;
    background: var(--deep);
  }
  canvas {
    display: block;
    image-rendering: crisp-edges;
    image-rendering: pixelated;
  }
</style>
