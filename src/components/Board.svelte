<script lang="ts">
  import { untrack } from 'svelte';
  import { cubicOut } from 'svelte/easing';
  import { Tween } from 'svelte/motion';
  import { audio } from '../lib/audio/audio.svelte';
  import { MAP_H, MAP_W } from '../lib/game/map';
  import type { Point } from '../lib/game/types';
  import { buzz, ui } from '../lib/ui.svelte';
  import { H, UNIT, W } from '../lib/world/terrain';
  import { world } from '../lib/world/world';
  import type { Hover } from '../lib/world/world';

  type Props = {
    pickable?: boolean;
    spot?: Point | null;
    label?: string;
    /** Fingers can pan and zoom this map. */
    camera?: boolean;
    /** The map takes whatever space its parent gives it, instead of sizing itself. */
    fill?: boolean;
  };
  let { pickable = false, spot = null, label = 'Map of the island', camera = false, fill = false }: Props = $props();

  // The island itself, in art pixels. On a phone the empty sea around it can be cropped.
  const ISLAND_W = 280;
  const ISLAND_H = 196;
  /** Tall enough that sprites on the north shore aren't cut off when nothing can pan. */
  const LOBBY_H = 214;
  const TAP_SLOP = 9;
  const GRAB_RADIUS = 32;
  /** How far above the finger the X sits while dragging, so the finger doesn't hide it. */
  const DRAG_LIFT = 44;

  let canvas = $state<HTMLCanvasElement>();
  let frame = $state<HTMLDivElement>();
  let hover = $state<Hover>(null);

  let frameW = $state(0);
  let frameH = $state(0);
  let sizedW = $state<number | null>(null);
  let sizedH = $state<number | null>(null);
  let minK = $state(3);
  let dpr = $state(window.devicePixelRatio || 1);

  // Zoom is in whole device pixels at rest, so every art pixel is the same size and stays crisp.
  const calm = matchMedia('(prefers-reduced-motion: reduce)').matches;
  const view = new Tween({ s: 3, cx: W / 2, cy: H / 2 }, { duration: calm ? 0 : 170, easing: cubicOut });
  let target = $state({ k: 3, cx: W / 2, cy: H / 2 });
  const zoomed = $derived(view.target.s * dpr > minK + 0.01);

  function clampCenter(s: number, cx: number, cy: number) {
    const halfW = frameW / 2 / s;
    const halfH = frameH / 2 / s;
    return {
      cx: W <= halfW * 2 ? W / 2 : Math.min(W - halfW, Math.max(halfW, cx)),
      cy: H <= halfH * 2 ? H / 2 : Math.min(H - halfH, Math.max(halfH, cy)),
    };
  }

  function setView(k: number, cx: number, cy: number, duration?: number) {
    const s = k / dpr;
    const center = clampCenter(s, cx, cy);
    target = { k, ...center };
    void view.set({ s, ...center }, duration === undefined ? undefined : { duration });
  }

  const restX = () => (ui.focus ? ui.focus.x / UNIT : W / 2);
  const restY = () => (ui.focus ? ui.focus.y / UNIT : H / 2);

  function measure() {
    dpr = window.devicePixelRatio || 1;
    const vw = window.innerWidth;
    const vh = window.innerHeight;
    const wasFit = target.k <= minK;

    if (fill && frame) {
      sizedW = sizedH = null;
      frameW = frame.clientWidth;
      frameH = frame.clientHeight;
      // Never below one art pixel per screen pixel. Smaller than that, sprites get too small to
      // read, so a tiny phone crops the edge of the island and lets you pan to it.
      const fit = Math.floor(Math.min((frameW * dpr) / ISLAND_W, (frameH * dpr) / ISLAND_H));
      minK = Math.max(Math.ceil(dpr), fit);
    } else if (ui.compact) {
      minK = Math.max(1, Math.floor((vw * dpr) / ISLAND_W));
      sizedW = frameW = vw;
      sizedH = frameH = Math.round((LOBBY_H * minK) / dpr);
    } else {
      const availableW = ui.short ? vw - 260 - 24 : vw - 320 - 56;
      const availableH = ui.short ? vh - 56 : vh - 76;
      minK = Math.max(1, Math.floor(Math.min((availableW * dpr) / W, (availableH * dpr) / H)));
      sizedW = frameW = (W * minK) / dpr;
      sizedH = frameH = (H * minK) / dpr;
    }

    if (wasFit || !camera) setView(minK, restX(), restY(), 0);
    else setView(target.k, target.cx, target.cy, 0);
  }

  $effect(() => {
    if (!canvas) return;
    world.attach(canvas);
    world.onHover = (h) => (hover = h);
    return () => world.detach();
  });

  $effect(() => {
    // Re-measure when the layout changes shape, as well as on resize.
    fill;
    ui.compact;
    ui.short;
    camera;
    if (!frame) return;
    untrack(measure);
    if (!fill) return;
    const observer = new ResizeObserver(() => measure());
    observer.observe(frame);
    return () => observer.disconnect();
  });

  $effect(() => {
    ui.cameraReset;
    untrack(() => setView(minK, restX(), restY()));
  });

  $effect(() => {
    if (!ui.focus) return;
    const { x, y } = ui.focus;
    untrack(() => setView(target.k, x / UNIT, y / UNIT));
  });

  const place = $derived.by(() => {
    const { s, cx, cy } = view.current;
    const round = (n: number) => Math.round(n * dpr) / dpr;
    const fitW = W * s <= frameW;
    const fitH = H * s <= frameH;
    const tx = fitW ? (frameW - W * s) / 2 : Math.min(0, Math.max(frameW - W * s, frameW / 2 - cx * s));
    const ty = fitH ? (frameH - H * s) / 2 : Math.min(0, Math.max(frameH - H * s, frameH / 2 - cy * s));
    return { s, tx: round(tx), ty: round(ty) };
  });

  function toArt(clientX: number, clientY: number) {
    const box = canvas!.getBoundingClientRect();
    const s = box.width / W;
    return { x: (clientX - box.left) / s, y: (clientY - box.top) / s };
  }

  // Touch gestures: one finger pans or taps, or drags the X; two fingers pinch.
  type Gesture =
    | { kind: 'press'; startX: number; startY: number; grabbedSpot: boolean }
    | { kind: 'pan'; lastX: number; lastY: number }
    | { kind: 'drag' }
    | { kind: 'pinch'; startDistance: number; startS: number; artX: number; artY: number };

  const touches = new Map<number, { x: number; y: number }>();
  let gesture: Gesture | null = null;
  let touchedRecently = false;
  /** A pinch happened, so the zoom needs snapping to a crisp size when the last finger lifts. */
  let needsSnap = false;

  function nearSpot(clientX: number, clientY: number) {
    if (!spot || !pickable) return false;
    const box = canvas!.getBoundingClientRect();
    const s = box.width / W;
    const x = box.left + (spot.x / UNIT) * s;
    const y = box.top + (spot.y / UNIT) * s;
    return Math.hypot(clientX - x, clientY - y) < GRAB_RADIUS;
  }

  function startPinch() {
    const [a, b] = [...touches.values()];
    const box = canvas!.getBoundingClientRect();
    const midX = (a.x + b.x) / 2;
    const midY = (a.y + b.y) / 2;
    const art = toArt(midX, midY);
    gesture = {
      kind: 'pinch',
      startDistance: Math.max(1, Math.hypot(a.x - b.x, a.y - b.y)),
      startS: box.width / W,
      artX: art.x,
      artY: art.y,
    };
  }

  function onpointerdown(event: PointerEvent) {
    if (!camera || event.pointerType === 'mouse') return;
    touchedRecently = true;
    canvas!.setPointerCapture(event.pointerId);
    touches.set(event.pointerId, { x: event.clientX, y: event.clientY });
    if (touches.size === 1) {
      gesture = { kind: 'press', startX: event.clientX, startY: event.clientY, grabbedSpot: nearSpot(event.clientX, event.clientY) };
    } else if (touches.size === 2) {
      startPinch();
    }
  }

  function onpointermove(event: PointerEvent) {
    if (event.pointerType === 'mouse') {
      const { x, y } = toArt(event.clientX, event.clientY);
      world.pointerMove(x, y);
      return;
    }
    if (!touches.has(event.pointerId) || !gesture) return;
    touches.set(event.pointerId, { x: event.clientX, y: event.clientY });

    if (gesture.kind === 'press') {
      if (Math.hypot(event.clientX - gesture.startX, event.clientY - gesture.startY) < TAP_SLOP) return;
      gesture = gesture.grabbedSpot ? { kind: 'drag' } : { kind: 'pan', lastX: event.clientX, lastY: event.clientY };
    }

    if (gesture.kind === 'pan') {
      const s = view.current.s;
      const cx = view.current.cx - (event.clientX - gesture.lastX) / s;
      const cy = view.current.cy - (event.clientY - gesture.lastY) / s;
      gesture.lastX = event.clientX;
      gesture.lastY = event.clientY;
      setView(target.k, cx, cy, 0);
    } else if (gesture.kind === 'drag') {
      const art = toArt(event.clientX, event.clientY - DRAG_LIFT);
      world.dragSpot(art.x, art.y);
    } else if (gesture.kind === 'pinch' && touches.size >= 2) {
      const [a, b] = [...touches.values()];
      const ratio = Math.hypot(a.x - b.x, a.y - b.y) / gesture.startDistance;
      const s = Math.min((minK * 3) / dpr, Math.max((minK * 0.85) / dpr, gesture.startS * ratio));
      const midX = (a.x + b.x) / 2 - frame!.getBoundingClientRect().left;
      const midY = (a.y + b.y) / 2 - frame!.getBoundingClientRect().top;
      // Keep the point under the fingers under the fingers.
      const center = clampCenter(s, gesture.artX + (frameW / 2 - midX) / s, gesture.artY + (frameH / 2 - midY) / s);
      target = { k: s * dpr, ...center };
      void view.set({ s, ...center }, { duration: 0 });
    }
  }

  function onpointerup(event: PointerEvent) {
    if (!touches.has(event.pointerId)) return;
    const wasGesture = gesture;
    touches.delete(event.pointerId);

    if (wasGesture?.kind === 'pinch') needsSnap = true;
    if (touches.size === 0) {
      gesture = null;
      if (needsSnap) {
        needsSnap = false;
        setView(Math.max(minK, Math.min(minK * 3, Math.round(target.k))), target.cx, target.cy);
      }
    } else if (wasGesture?.kind === 'pinch') {
      // One finger stayed down, so the pinch carries on as a pan.
      const [only] = [...touches.values()];
      gesture = { kind: 'pan', lastX: only.x, lastY: only.y };
      return;
    }
    if (wasGesture?.kind === 'press' && event.type === 'pointerup') {
      const { x, y } = toArt(event.clientX, event.clientY);
      audio.unlock();
      world.touchTap(x, y);
    }
  }

  function onclick(event: MouseEvent) {
    // A touch already did its work on pointerup, and browsers follow it with a click.
    if (touchedRecently) {
      touchedRecently = false;
      return;
    }
    if (!pickable) return;
    const { x, y } = toArt(event.clientX, event.clientY);
    world.pointerClick(x, y);
  }

  function onkeydown(event: KeyboardEvent) {
    if (!pickable) return;
    const step = event.shiftKey ? 40 : 12;
    const move: Record<string, [number, number]> = {
      ArrowUp: [0, -step], ArrowDown: [0, step], ArrowLeft: [-step, 0], ArrowRight: [step, 0],
    };
    const delta = move[event.key];
    if (!delta) return;
    event.preventDefault();
    audio.unlock();
    const from = spot ?? { x: MAP_W / 2, y: MAP_H / 2 };
    world.onPick?.({ x: from.x + delta[0], y: from.y + delta[1] });
  }

  function zoom(direction: 1 | -1) {
    const steps = [minK, Math.round(minK * 1.5), minK * 2, minK * 3];
    const now = Math.round(target.k);
    const next = direction > 0 ? steps.find((k) => k > now) : [...steps].reverse().find((k) => k < now);
    if (next === undefined) return;
    buzz(8);
    const onSpot = direction > 0 && spot;
    setView(next, onSpot ? spot.x / UNIT : target.cx, onSpot ? spot.y / UNIT : target.cy);
  }

  const tip = $derived.by(() => {
    if (!hover) return null;
    const left = hover.x * place.s + place.tx;
    const top = hover.y * place.s + place.ty;
    return { text: hover.text, left: Math.min(frameW - 60, Math.max(60, left)), top: Math.max(26, top) };
  });
</script>

<svelte:window onresize={measure} />

<div
  class="frame"
  class:fill
  bind:this={frame}
  style:width={fill ? undefined : `${sizedW}px`}
  style:height={fill ? undefined : `${sizedH}px`}
>
  <!-- svelte-ignore a11y_no_noninteractive_element_interactions, a11y_no_noninteractive_tabindex -->
  <canvas
    bind:this={canvas}
    class:pickable
    class:camera
    style:width="{W * place.s}px"
    style:height="{H * place.s}px"
    style:transform="translate({place.tx}px, {place.ty}px)"
    role={pickable ? 'application' : 'img'}
    aria-label={label}
    tabindex={pickable ? 0 : undefined}
    {onpointerdown}
    {onpointermove}
    {onpointerup}
    onpointercancel={onpointerup}
    onpointerleave={() => world.pointerLeave()}
    {onclick}
    {onkeydown}
  ></canvas>

  {#if tip}
    <div class="tip" style:left="{tip.left}px" style:top="{tip.top}px">{tip.text}</div>
  {/if}

  {#if camera}
    <div class="zoom">
      <button aria-label="Zoom in" disabled={target.k >= minK * 3 && view.target.s * dpr >= minK * 3} onclick={() => zoom(1)}>+</button>
      <button aria-label="Zoom out" disabled={!zoomed} onclick={() => zoom(-1)}>−</button>
    </div>
  {/if}

  {#if ui.banner}
    {#key ui.banner.id}
      <div class="banner" role="status">
        <p class="title">{ui.banner.title}</p>
        <p class="detail">{ui.banner.detail}</p>
      </div>
    {/key}
  {/if}
</div>

<style>
  .frame {
    position: relative;
    margin: 0 auto;
    overflow: hidden;
  }
  .frame.fill {
    width: 100%;
    height: 100%;
  }
  canvas {
    position: absolute;
    top: 0;
    left: 0;
    display: block;
    image-rendering: crisp-edges;
    image-rendering: pixelated;
    outline-offset: -4px;
    -webkit-tap-highlight-color: transparent;
    -webkit-touch-callout: none;
    user-select: none;
  }
  canvas.pickable:not(.camera) {
    cursor: none;
  }
  canvas.camera {
    touch-action: none;
  }
  .tip {
    position: absolute;
    transform: translate(-50%, -100%);
    padding: 0.05rem 0.4rem;
    background: var(--ink);
    color: var(--foam);
    font-size: 1.1rem;
    line-height: 1.15;
    white-space: nowrap;
    pointer-events: none;
  }
  .zoom {
    position: absolute;
    right: 0.5rem;
    bottom: 0.5rem;
    display: grid;
    gap: 0.35rem;
  }
  .zoom button {
    width: 2.75rem;
    height: 2.75rem;
    padding: 0 0 0.2rem;
    font-family: var(--display);
    font-size: 2.2rem;
    line-height: 1;
    color: var(--foam);
    background: var(--ink);
    border: 0;
    opacity: 0.92;
    -webkit-tap-highlight-color: transparent;
    transition: transform 0.09s cubic-bezier(0.3, 1.6, 0.6, 1);
  }
  .zoom button:active {
    transform: scale(0.9);
  }
  .zoom button:disabled {
    color: var(--mist);
    opacity: 0.45;
  }
  .banner {
    position: absolute;
    left: 0;
    right: 0;
    top: 34%;
    padding: 0.4rem 0 0.6rem;
    text-align: center;
    background: var(--ink);
    box-shadow: 0 -6px 0 var(--sun), 0 6px 0 var(--sun);
    pointer-events: none;
    animation: sweep 2s cubic-bezier(0.2, 0.9, 0.2, 1) both;
  }
  .title {
    margin: 0;
    font-family: var(--display);
    font-size: clamp(2.6rem, 6vw, 4.4rem);
    line-height: 1;
    color: var(--sun);
  }
  .detail {
    margin: 0;
    font-size: clamp(1.2rem, 2vw, 1.6rem);
    color: var(--foam);
  }
  @keyframes sweep {
    0% { transform: translateX(-102%); }
    16% { transform: translateX(0); }
    84% { transform: translateX(0); }
    100% { transform: translateX(102%); }
  }
</style>
