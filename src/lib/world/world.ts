// The living island: one small canvas, redrawn every frame and scaled up by whole pixels.
import { audio } from '../audio/audio.svelte';
import { MAP } from '../game/map';
import type { Dig, Kind, Landmark, Point } from '../game/types';
import { buzz } from '../ui.svelte';
import { PALETTE, sprite, xMark } from './sprites';
import type { SpriteName } from './sprites';
import { buildTerrain, H, UNIT, W } from './terrain';
import type { Terrain } from './terrain';

const SPRITE_FOR: Record<Kind, SpriteName> = {
  horse: 'horse', cow: 'cow', sheep: 'sheep', duck: 'duck', palm: 'palm', pine: 'pine', apple: 'apple',
  hut: 'hut', windmill: 'windmill', well: 'well', lighthouse: 'lighthouse', scarecrow: 'scarecrow',
  campfire: 'campfire', boat: 'boat',
};

const VOICE: Partial<Record<Kind, number>> = {
  horse: 330, cow: 165, sheep: 415, duck: 660, scarecrow: 247, campfire: 196, boat: 294,
};

const KIND_LABEL: Record<Kind, string> = {
  horse: 'Horse', cow: 'Cow', sheep: 'Sheep', duck: 'Duck', palm: 'Palm tree', pine: 'Pine tree', apple: 'Apple tree',
  hut: 'Hut', windmill: 'Windmill', well: 'Well', lighthouse: 'Lighthouse', scarecrow: 'Scarecrow', campfire: 'Campfire', boat: 'Boat',
};

const CONFETTI = [PALETTE.y, PALETTE.p, PALETTE.u, PALETTE.g, PALETTE.w, PALETTE.o];

// The sky through a round: day, golden hour, sunset, then dusk for the reveal.
const SKY: [number, [number, number, number]][] = [
  [0, [255, 255, 255]],
  [0.5, [255, 243, 222]],
  [0.85, [255, 190, 150]],
  [1, [150, 125, 215]],
];

const SEA = [0x15, 0x5f, 0xc4];
const DEEP = [0x12, 0x3f, 0x9a];

type Actor = { landmark: Landmark; x: number; y: number; phase: number; hopAt: number; hopStart: number };
type Particle = { x: number; y: number; vx: number; vy: number; life: number; max: number; color: string; gravity: number; coin?: boolean; floor?: number };
type Mark = { dig: Dig; bornAt: number };
type Gull = { x: number; y: number; vx: number; phase: number };
type Cloud = { x: number; y: number; vx: number; canvas: HTMLCanvasElement };

type Chest = { x: number; y: number; bornAt: number; landed: boolean; open: boolean; finish: (() => void) | null };

export type Hover = { text: string; x: number; y: number } | null;

const toArt = (u: number) => Math.round(u / UNIT);

function makeCloudShadow(w: number, h: number, seed: number): HTMLCanvasElement {
  const canvas = document.createElement('canvas');
  canvas.width = w;
  canvas.height = h;
  const ctx = canvas.getContext('2d')!;
  ctx.fillStyle = PALETTE.k;
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const dx = (x - w / 2) / (w / 2);
      const dy = (y - h / 2) / (h / 2);
      const bump = 0.15 * Math.sin(x * 0.35 + seed) + 0.1 * Math.sin(y * 0.7 + seed * 2);
      if (dx * dx + dy * dy < 0.85 + bump && (x + y) % 2 === 0) ctx.fillRect(x, y, 1, 1);
    }
  }
  return canvas;
}

class World {
  /** `quiet` is for a dragged X: the spot follows the finger, with no sound or water warning. */
  onPick: ((point: Point, quiet?: boolean) => void) | null = null;
  onHover: ((hover: Hover) => void) | null = null;

  #canvas: HTMLCanvasElement | null = null;
  #ctx: CanvasRenderingContext2D | null = null;
  #terrain: Terrain | null = null;
  #raf = 0;
  #last = 0;
  #time = 0;
  #waterClock = 0;
  #calm = false;

  #actors: Actor[] = [];
  #particles: Particle[] = [];
  #gulls: Gull[] = [];
  #clouds: Cloud[] = [];
  #nextGull = 2;
  #smokeClock = 0;

  #marks = new Map<string, Mark>();
  #me: string | undefined;
  #spot: Point | null = null;
  #spotBornAt = 0;
  #pickable = false;

  #pointer: { x: number; y: number } | null = null;
  #cursor = { x: 0, y: 0 };
  #hoverId = -1;
  #swing = -1;
  #swingAt = { x: 0, y: 0 };
  #tapLabelUntil = 0;

  #shake = 0;
  #dusk = 0;
  #duskTarget = 0;
  #dim = 0;
  #seaApplied = '';
  #shadowLayer: HTMLCanvasElement | null = null;

  #roll: {
    order: number[]; at: number; nextAt: number; final: number; total: number; startedAt: number;
    candidates: number[]; finish: () => void; landedAt: number;
  } | null = null;
  #chest: Chest | null = null;
  #lines: { startedAt: number; winner: string | null; finish: (() => void) | null } | null = null;
  #confettiUntil = 0;
  #confettiClock = 0;

  attach(canvas: HTMLCanvasElement) {
    this.#canvas = canvas;
    canvas.width = W;
    canvas.height = H;
    this.#ctx = canvas.getContext('2d')!;
    this.#ctx.imageSmoothingEnabled = false;
    this.#calm = matchMedia('(prefers-reduced-motion: reduce)').matches;
    if (!this.#terrain) this.#build();
    this.#last = performance.now();
    cancelAnimationFrame(this.#raf);
    this.#raf = requestAnimationFrame((t) => this.#frame(t));
  }

  detach() {
    cancelAnimationFrame(this.#raf);
    this.#canvas = null;
  }

  #build() {
    this.#terrain = buildTerrain();
    const landmarks = [...MAP.landmarks].sort((a, b) => a.y - b.y);
    this.#actors = landmarks.map((landmark) => ({
      landmark,
      x: toArt(landmark.x),
      y: toArt(landmark.y),
      phase: landmark.id * 1.7,
      hopAt: 2 + Math.random() * 14,
      hopStart: -9,
    }));
    this.#clouds = [
      { x: 30, y: 40, vx: 2.4, canvas: makeCloudShadow(72, 30, 1) },
      { x: 190, y: 120, vx: 1.7, canvas: makeCloudShadow(96, 36, 4) },
      { x: -60, y: 170, vx: 2.1, canvas: makeCloudShadow(60, 26, 7) },
    ];
  }

  /** Clears the round-specific layers, leaving the island itself running. */
  idle() {
    this.#marks.clear();
    this.#spot = null;
    this.#pickable = false;
    this.#duskTarget = 0;
    this.#finishPending();
    this.#roll = null;
    this.#chest = null;
    this.#lines = null;
    this.#confettiUntil = 0;
    this.#emitHover(null);
  }

  #finishPending() {
    this.#roll?.finish();
    this.#chest?.finish?.();
    this.#lines?.finish?.();
  }

  /** Starts showing a round, without playing effects for digs that already happened. */
  enterGame(digs: Dig[]) {
    this.idle();
    for (const dig of digs) this.#marks.set(dig.account, { dig: { ...dig }, bornAt: -9 });
  }

  /** Called whenever the round's state changes. New digs get their entrance here. */
  sync(state: { digs: Dig[]; me: string | undefined; spot: Point | null; pickable: boolean }) {
    this.#me = state.me;
    this.#pickable = state.pickable;
    if (!state.pickable) this.#hoverId = -1;

    // Only a real jump gets the pop. A dragged X moves in small steps and just follows the finger.
    if (state.spot && (!this.#spot || Math.hypot(state.spot.x - this.#spot.x, state.spot.y - this.#spot.y) > 40)) {
      this.#spotBornAt = this.#time;
    }
    this.#spot = state.spot;

    for (const dig of state.digs) {
      if (this.#marks.has(dig.account)) continue;
      this.#marks.set(dig.account, { dig: { ...dig }, bornAt: this.#time });
      const mine = dig.account === state.me;
      this.#dirtBurst(toArt(dig.x), toArt(dig.y), mine ? 22 : 7);
      if (mine) {
        this.#swing = this.#time;
        this.#swingAt = { x: toArt(dig.x), y: toArt(dig.y) };
        this.#kick(3);
        buzz(35);
        audio.dig();
      } else {
        audio.botDig();
      }
    }
  }

  setDusk(fraction: number) {
    this.#duskTarget = fraction;
  }

  /** Spots light up in turn, slot-machine style, and slow down onto the winning one. */
  rollCandidates(candidates: number[], final: number): Promise<void> {
    return new Promise((resolve) => {
      const total = this.#calm ? 0.3 : candidates.length > 1 ? 2.6 : 1.1;
      this.#roll = {
        order: candidates, at: 0, nextAt: this.#time, final, total, startedAt: this.#time,
        candidates, finish: resolve, landedAt: -1,
      };
    });
  }

  dropChest(point: Point): Promise<void> {
    return new Promise((resolve) => {
      this.#roll = null;
      this.#chest = { x: toArt(point.x), y: toArt(point.y), bornAt: this.#time, landed: false, open: false, finish: resolve };
    });
  }

  drawLines(winner: string | null): Promise<void> {
    return new Promise((resolve) => {
      this.#lines = { startedAt: this.#time, winner, finish: resolve };
    });
  }

  /** Puts a finished round straight into its end state, for when you open one later. */
  showFinal(treasure: Point, winner: string | null) {
    this.#chest = { x: toArt(treasure.x), y: toArt(treasure.y), bornAt: -9, landed: true, open: true, finish: null };
    this.#lines = { startedAt: -9, winner, finish: null };
  }

  celebrate() {
    this.#confettiUntil = this.#time + (this.#calm ? 0 : 3.5);
    if (!this.#chest) return;
    for (let i = 0; i < 30; i++) this.#coinBurst(this.#chest.x, this.#chest.y - 6);
  }

  flash() {
    this.#kick(1);
  }

  /** Pointer events, in canvas-element CSS pixels already scaled to art pixels. */
  pointerMove(x: number, y: number) {
    if (!this.#pointer) {
      this.#cursor = { x, y };
    }
    this.#pointer = { x, y };
  }

  pointerLeave() {
    this.#pointer = null;
    this.#hoverId = -1;
    this.#emitHover(null);
  }

  pointerClick(x: number, y: number) {
    this.onPick?.({ x: (Math.floor(x) + 0.5) * UNIT, y: (Math.floor(y) + 0.5) * UNIT });
  }

  /** A finger tap: names and wakes the nearest landmark, and picks the spot if digging is open. */
  touchTap(x: number, y: number) {
    let nearest: Actor | null = null;
    let bestDistance = 14;
    for (const actor of this.#actors) {
      const d = Math.hypot(actor.x - x, actor.y - 6 - y);
      if (d < bestDistance) {
        nearest = actor;
        bestDistance = d;
      }
    }
    if (nearest) {
      if (!this.#calm) nearest.hopStart = this.#time;
      this.#emitHover({ text: KIND_LABEL[nearest.landmark.kind], x: nearest.x, y: nearest.y - sprite(SPRITE_FOR[nearest.landmark.kind]).h - 2 });
      this.#tapLabelUntil = this.#time + 1.4;
    } else {
      this.#emitHover(null);
    }
    this.pointerClick(x, y);
  }

  dragSpot(x: number, y: number) {
    this.#emitHover(null);
    this.onPick?.({ x: (Math.floor(x) + 0.5) * UNIT, y: (Math.floor(y) + 0.5) * UNIT }, true);
  }

  #kick(amount: number) {
    if (!this.#calm) this.#shake = Math.max(this.#shake, amount);
  }

  #dirtBurst(x: number, y: number, count: number) {
    const colors = [PALETTE.B, PALETTE.b, PALETTE.t];
    for (let i = 0; i < count; i++) {
      const angle = -Math.PI * (0.1 + Math.random() * 0.8);
      const speed = 25 + Math.random() * 55;
      this.#particles.push({
        x, y, vx: Math.cos(angle) * speed, vy: Math.sin(angle) * speed,
        life: 0, max: 0.45 + Math.random() * 0.4, color: colors[i % 3], gravity: 190, floor: y + 2,
      });
    }
  }

  #coinBurst(x: number, y: number) {
    const angle = -Math.PI * (0.15 + Math.random() * 0.7);
    const speed = 50 + Math.random() * 80;
    this.#particles.push({
      x, y, vx: Math.cos(angle) * speed, vy: Math.sin(angle) * speed,
      life: 0, max: 1 + Math.random() * 0.7, color: PALETTE.y, gravity: 200, coin: true, floor: y + 8 + Math.random() * 8,
    });
  }

  #frame(now: number) {
    this.#raf = requestAnimationFrame((t) => this.#frame(t));
    const dt = Math.min(0.05, (now - this.#last) / 1000);
    this.#last = now;
    this.#time += dt;
    this.#update(dt);
    this.#draw();
  }

  #update(dt: number) {
    const t = this.#time;

    this.#waterClock += dt;
    if (this.#waterClock > (this.#calm ? 1 : 0.11)) {
      this.#waterClock = 0;
      this.#terrain!.paintWater(t);
    }

    this.#dusk += (this.#duskTarget - this.#dusk) * Math.min(1, dt * 1.6);
    this.#dim += ((this.#roll ? 1 : 0) - this.#dim) * Math.min(1, dt * 7);
    this.#applyPageSky();

    this.#shake = Math.max(0, this.#shake - dt * 14);

    if (this.#tapLabelUntil && t > this.#tapLabelUntil) {
      this.#tapLabelUntil = 0;
      this.#emitHover(null);
    }

    if (this.#pointer) {
      const ease = Math.min(1, dt * 22);
      this.#cursor.x += (this.#pointer.x - this.#cursor.x) * ease;
      this.#cursor.y += (this.#pointer.y - this.#cursor.y) * ease;
      this.#updateHover();
    }

    if (!this.#calm) {
      for (const actor of this.#actors) {
        if (t >= actor.hopAt) {
          actor.hopStart = t;
          actor.hopAt = t + 4 + Math.random() * 18;
        }
      }
      this.#updateAmbient(dt);
    }

    for (const p of this.#particles) {
      p.life += dt;
      p.vy += p.gravity * dt;
      p.x += p.vx * dt;
      p.y += p.vy * dt;
      if (p.floor !== undefined && p.y > p.floor) {
        p.y = p.floor;
        p.vy *= -0.4;
        p.vx *= 0.6;
      }
    }
    this.#particles = this.#particles.filter((p) => p.life < p.max);

    if (t < this.#confettiUntil) {
      this.#confettiClock += dt;
      while (this.#confettiClock > 0.012) {
        this.#confettiClock -= 0.012;
        this.#particles.push({
          x: Math.random() * W, y: -2, vx: (Math.random() - 0.5) * 18, vy: 30 + Math.random() * 35,
          life: 0, max: 3.4, color: CONFETTI[Math.floor(Math.random() * CONFETTI.length)], gravity: 6,
        });
      }
    }

    this.#updateRoll();
    this.#updateChest();
    this.#updateLines();
  }

  #updateAmbient(dt: number) {
    const t = this.#time;
    for (const cloud of this.#clouds) {
      cloud.x += cloud.vx * dt;
      if (cloud.x > W + 20) cloud.x = -cloud.canvas.width - 20;
    }

    if (t > this.#nextGull) {
      this.#nextGull = t + 5 + Math.random() * 11;
      const fromLeft = Math.random() < 0.5;
      this.#gulls.push({ x: fromLeft ? -8 : W + 8, y: 6 + Math.random() * 60, vx: (fromLeft ? 1 : -1) * (22 + Math.random() * 14), phase: Math.random() * 6 });
    }
    for (const gull of this.#gulls) gull.x += gull.vx * dt;
    this.#gulls = this.#gulls.filter((g) => g.x > -12 && g.x < W + 12);

    this.#smokeClock += dt;
    if (this.#smokeClock > 0.32) {
      this.#smokeClock = 0;
      for (const actor of this.#actors) {
        if (actor.landmark.kind !== 'campfire' && actor.landmark.kind !== 'hut') continue;
        if (Math.random() > 0.55) continue;
        const fire = actor.landmark.kind === 'campfire';
        this.#particles.push({
          x: actor.x + (fire ? 0 : 4), y: actor.y - (fire ? 11 : 15), vx: 2 + Math.random() * 3, vy: -7 - Math.random() * 5,
          life: 0, max: 1.3, color: fire ? PALETTE.d : PALETTE.c, gravity: 0,
        });
      }
    }
  }

  #updateHover() {
    const { x, y } = this.#pointer!;
    let best: Actor | null = null;
    let bestDistance = 11;
    for (const actor of this.#actors) {
      const d = Math.hypot(actor.x - x, actor.y - 6 - y);
      if (d < bestDistance) {
        best = actor;
        bestDistance = d;
      }
    }

    let digHover: Mark | null = null;
    for (const mark of this.#marks.values()) {
      if (Math.hypot(toArt(mark.dig.x) - x, toArt(mark.dig.y) - y) < 5) digHover = mark;
    }

    if (digHover) {
      const { dig } = digHover;
      this.#emitHover({ text: `${dig.account === this.#me ? 'You' : dig.account} ×${dig.bonus}`, x: toArt(dig.x), y: toArt(dig.y) - 8 });
    } else if (best) {
      this.#emitHover({ text: KIND_LABEL[best.landmark.kind], x: best.x, y: best.y - sprite(SPRITE_FOR[best.landmark.kind]).h - 2 });
    } else {
      this.#emitHover(null);
    }

    const id = best ? best.landmark.id : -1;
    if (id !== this.#hoverId) {
      this.#hoverId = id;
      if (best && !this.#calm) {
        best.hopStart = this.#time;
        const voice = VOICE[best.landmark.kind];
        audio.critter(voice ?? 440);
      }
    }
  }

  #lastHoverText = '';

  #emitHover(hover: Hover) {
    const text = hover ? `${hover.text}@${hover.x},${hover.y}` : '';
    if (text === this.#lastHoverText) return;
    this.#lastHoverText = text;
    this.onHover?.(hover);
  }

  #updateRoll() {
    const roll = this.#roll;
    if (!roll) return;
    const t = this.#time;
    const progress = Math.min(1, (t - roll.startedAt) / roll.total);

    if (progress < 1 && t >= roll.nextAt) {
      roll.at = (roll.at + 1) % roll.order.length;
      if (roll.order[roll.at] === roll.final && roll.order.length > 1 && progress > 0.97) roll.at = (roll.at + 1) % roll.order.length;
      roll.nextAt = t + 0.07 + progress * progress * 0.36;
      audio.rollStep(progress);
    } else if (progress >= 1 && roll.landedAt < 0) {
      roll.at = roll.order.indexOf(roll.final);
      roll.landedAt = t;
      audio.rollStep(1);
    } else if (roll.landedAt >= 0 && t - roll.landedAt > 0.5) {
      const finish = roll.finish;
      roll.finish = () => {};
      finish();
    }
  }

  #updateChest() {
    const chest = this.#chest;
    if (!chest) return;
    const age = this.#time - chest.bornAt;
    if (!chest.landed && age > 0.55) {
      chest.landed = true;
      this.#kick(7);
      buzz(70);
      audio.chestLands();
      this.#dirtBurst(chest.x, chest.y, 34);
    }
    if (chest.landed && !chest.open && age > 1) {
      chest.open = true;
      audio.chestOpens();
      for (let i = 0; i < 22; i++) this.#coinBurst(chest.x, chest.y - 8);
    }
    if (chest.open && chest.finish && age > 1.5) {
      const finish = chest.finish;
      chest.finish = null;
      finish();
    }
  }

  #updateLines() {
    const lines = this.#lines;
    if (lines?.finish && this.#time - lines.startedAt > 0.8) {
      const finish = lines.finish;
      lines.finish = null;
      finish();
    }
  }

  #skyColor(): [number, number, number] {
    const [r, g, b] = this.#daylight();
    const lit = 1 - 0.5 * this.#dim;
    return [r * lit, g * lit, b * lit];
  }

  #daylight(): [number, number, number] {
    const d = this.#dusk;
    for (let i = 1; i < SKY.length; i++) {
      const [to, b] = SKY[i];
      const [from, a] = SKY[i - 1];
      if (d <= to) {
        const f = (d - from) / (to - from);
        return [a[0] + (b[0] - a[0]) * f, a[1] + (b[1] - a[1]) * f, a[2] + (b[2] - a[2]) * f];
      }
    }
    return SKY[SKY.length - 1][1];
  }

  // The page is the same sea as the canvas, so it has to change with the sky or a seam shows.
  #applyPageSky() {
    const sky = this.#skyColor();
    const mix = (base: number[]) => `rgb(${base.map((c, i) => Math.round((c * sky[i]) / 255)).join(' ')})`;
    const sea = mix(SEA);
    if (sea === this.#seaApplied) return;
    this.#seaApplied = sea;
    const root = document.documentElement.style;
    root.setProperty('--sea', sea);
    root.setProperty('--deep', mix(DEEP));
    // On a phone this colours the browser's own bar, so the sea reaches the top of the screen.
    document.querySelector('meta[name="theme-color"]')?.setAttribute('content', sea);
  }

  #draw() {
    const ctx = this.#ctx!;
    const t = this.#time;
    const shakeX = this.#shake > 0 ? Math.round((Math.random() - 0.5) * this.#shake * 2) : 0;
    const shakeY = this.#shake > 0 ? Math.round((Math.random() - 0.5) * this.#shake * 2) : 0;

    ctx.clearRect(0, 0, W, H);
    ctx.save();
    ctx.translate(shakeX, shakeY);
    ctx.drawImage(this.#terrain!.water, 0, 0);
    ctx.drawImage(this.#terrain!.land, 0, 0);

    this.#drawCloudShadows(ctx);

    this.#drawLines(ctx);
    this.#drawScene(ctx, t);
    this.#drawParticles(ctx, t);
    this.#drawGulls(ctx, t);

    this.#drawSky(ctx);
    this.#drawLights(ctx, t);
    this.#drawRoll(ctx, t);
    this.#drawSpot(ctx, t);
    this.#drawCursor(ctx, t);
    ctx.restore();
  }

  // Shadows fall only on land, so they never get cut off at the edge of the canvas over the sea.
  #drawCloudShadows(ctx: CanvasRenderingContext2D) {
    if (!this.#shadowLayer) {
      this.#shadowLayer = document.createElement('canvas');
      this.#shadowLayer.width = W;
      this.#shadowLayer.height = H;
    }
    const layer = this.#shadowLayer.getContext('2d')!;
    layer.globalCompositeOperation = 'source-over';
    layer.clearRect(0, 0, W, H);
    for (const cloud of this.#clouds) layer.drawImage(cloud.canvas, Math.round(cloud.x), Math.round(cloud.y));
    layer.globalCompositeOperation = 'destination-in';
    layer.drawImage(this.#terrain!.land, 0, 0);
    ctx.globalAlpha = 0.16;
    ctx.drawImage(this.#shadowLayer, 0, 0);
    ctx.globalAlpha = 1;
  }

  #drawScene(ctx: CanvasRenderingContext2D, t: number) {
    // The actors are already sorted back to front by where their feet are.
    for (const actor of this.#actors) this.#drawActor(ctx, actor, t);

    // Digs and the chest go on top of everything: a player must always be able to see them.
    const marks = [...this.#marks.values()].sort((a, b) => a.dig.y - b.dig.y);
    for (const mark of marks) if (mark.dig.account !== this.#me) this.#drawMark(ctx, mark, t);
    for (const mark of marks) if (mark.dig.account === this.#me) this.#drawMark(ctx, mark, t);
    if (this.#chest) this.#drawChest(ctx, this.#chest, t);
  }

  #drawActor(ctx: CanvasRenderingContext2D, actor: Actor, t: number) {
    const { kind, flip, category } = actor.landmark;
    let name = SPRITE_FOR[kind];
    if (kind === 'campfire') name = (['campfire', 'campfire2', 'campfire3'] as const)[Math.floor(t * 7 + actor.phase) % 3];
    const s = sprite(name);
    const flipThis = flip && category === 'animal';
    const image = flipThis ? s.flipped : s.canvas;
    const x = actor.x - Math.floor(s.w / 2);
    let y = actor.y - s.h;

    const hopAge = t - actor.hopStart;
    const hopping = category === 'animal' && hopAge >= 0 && hopAge < 0.34;
    const lift = hopping ? Math.round(Math.sin((hopAge / 0.34) * Math.PI) * 5) : 0;

    // Soft ground shadow, which shrinks as the sprite leaves the ground.
    ctx.fillStyle = 'rgba(20, 27, 60, 0.22)';
    const shadowW = s.w - 2 - lift;
    ctx.fillRect(actor.x - Math.floor(shadowW / 2), actor.y - 1, shadowW, 2);

    if (category === 'tree') {
      // Trees lean in the breeze: the top half slides sideways, the trunk stays put.
      const split = Math.floor(s.h * 0.6);
      const sway = Math.round(Math.sin(t * 1.4 + actor.phase) * 1.2);
      ctx.drawImage(image, 0, 0, s.w, split, x + sway, y, s.w, split);
      ctx.drawImage(image, 0, split, s.w, s.h - split, x, y + split, s.w, s.h - split);
      return;
    }

    if (category === 'animal') {
      // Animals breathe: everything above the legs lifts one pixel, then settles.
      const split = s.h - 4;
      const breathe = Math.sin(t * 2.4 + actor.phase) > 0.55 ? 1 : 0;
      y -= lift;
      ctx.drawImage(image, 0, 0, s.w, split, x, y - breathe, s.w, split);
      ctx.drawImage(image, 0, split, s.w, s.h - split, x, y + split, s.w, s.h - split);
      return;
    }

    if (kind === 'boat') y += Math.round(Math.sin(t * 1.5 + actor.phase));
    ctx.drawImage(image, x, y);

    if (kind === 'windmill') {
      const blades = sprite(Math.floor(t * 6 + actor.phase) % 2 === 0 ? 'bladesPlus' : 'bladesCross');
      ctx.drawImage(blades.canvas, actor.x - 8, actor.y - s.h - 2);
    }
  }

  #drawMark(ctx: CanvasRenderingContext2D, mark: Mark, t: number) {
    const { dig } = mark;
    const mine = dig.account === this.#me;
    const x = toArt(dig.x);
    const y = toArt(dig.y);
    const color = mine ? PALETTE.p : dig.bonus >= 2 ? PALETTE.y : dig.bonus >= 1.5 ? PALETTE.w : PALETTE.l;
    const s = xMark(mine ? 4 : 2, color);

    const age = t - mark.bornAt;
    let drop = 0;
    if (age < 0.32 && !this.#calm) {
      const p = age / 0.32;
      drop = Math.round(-14 * (1 - p) * (1 - p) + Math.sin(p * Math.PI) * -3);
    }

    ctx.fillStyle = PALETTE.B;
    ctx.fillRect(x - 3, y + Math.floor(s.h / 2) - 1, 7, 2);
    ctx.drawImage(s.canvas, x - Math.floor(s.w / 2), y - Math.floor(s.h / 2) + drop);

    if (mine && !this.#calm) {
      this.#ring(ctx, x, y, 7 + Math.round(Math.sin(t * 4) * 1), PALETTE.p);
    }
  }

  #drawChest(ctx: CanvasRenderingContext2D, chest: Chest, t: number) {
    const age = t - chest.bornAt;
    const s = sprite(chest.open ? 'chestOpen' : 'chest');
    const p = Math.min(1, age / 0.55);
    const fall = chest.landed ? 0 : Math.round((1 - p * p) * -150);
    const squash = chest.landed && age < 0.7 ? Math.round((1 - (age - 0.55) / 0.15) * 2) : 0;

    ctx.fillStyle = 'rgba(20, 27, 60, 0.3)';
    const shadowW = Math.round(6 + p * 12);
    ctx.fillRect(chest.x - Math.floor(shadowW / 2), chest.y - 1, shadowW, 3);

    ctx.drawImage(s.canvas, chest.x - 8, chest.y - s.h + fall + squash, s.w, s.h - squash);

    if (chest.open && !this.#calm && Math.random() < 0.18) {
      this.#particles.push({
        x: chest.x - 7 + Math.random() * 14, y: chest.y - s.h + 4, vx: 0, vy: -14 - Math.random() * 10,
        life: 0, max: 0.6, color: Math.random() < 0.5 ? PALETTE.w : PALETTE.y, gravity: 0,
      });
    }
  }

  #drawLines(ctx: CanvasRenderingContext2D) {
    const lines = this.#lines;
    const chest = this.#chest;
    if (!lines || !chest) return;
    const age = this.#time - lines.startedAt;
    const reach = Math.min(1, age / 0.7);
    const march = Math.floor(this.#time * 12);

    for (const { dig } of this.#marks.values()) {
      const winner = dig.account === lines.winner;
      const mine = dig.account === this.#me;
      if (winner) continue;
      this.#pixelLine(ctx, toArt(dig.x), toArt(dig.y), chest.x, chest.y - 3, reach, march, mine ? PALETTE.p : PALETTE.k, false);
    }
    const win = lines.winner ? this.#marks.get(lines.winner) : null;
    if (win) this.#pixelLine(ctx, toArt(win.dig.x), toArt(win.dig.y), chest.x, chest.y - 3, reach, march, PALETTE.y, true);
  }

  #pixelLine(ctx: CanvasRenderingContext2D, x0: number, y0: number, x1: number, y1: number, reach: number, march: number, color: string, thick: boolean) {
    const steps = Math.max(Math.abs(x1 - x0), Math.abs(y1 - y0));
    ctx.fillStyle = color;
    const end = Math.floor(steps * reach);
    for (let i = 0; i <= end; i++) {
      if (!thick && (i - march) % 6 > 2 && (i - march) % 6 >= -3) continue;
      const x = Math.round(x0 + ((x1 - x0) * i) / (steps || 1));
      const y = Math.round(y0 + ((y1 - y0) * i) / (steps || 1));
      if (thick) ctx.fillRect(x - 1, y - 1, 3, 3);
      else ctx.fillRect(x, y, 1, 1);
    }
    if (thick) {
      ctx.fillStyle = PALETTE.k;
      for (let i = 0; i <= end; i += 1) {
        if ((i + march) % 8 !== 0) continue;
        const x = Math.round(x0 + ((x1 - x0) * i) / (steps || 1));
        const y = Math.round(y0 + ((y1 - y0) * i) / (steps || 1));
        ctx.fillRect(x, y, 1, 1);
      }
    }
  }

  #drawParticles(ctx: CanvasRenderingContext2D, t: number) {
    for (const p of this.#particles) {
      const x = Math.round(p.x);
      const y = Math.round(p.y);
      if (p.coin) {
        const s = sprite(Math.floor(t * 12 + p.max * 10) % 2 === 0 ? 'coin' : 'coin2');
        ctx.drawImage(s.canvas, x - 3, y - 3);
      } else {
        ctx.fillStyle = p.color;
        ctx.fillRect(x, y, 1, 1);
      }
    }
  }

  #drawGulls(ctx: CanvasRenderingContext2D, t: number) {
    for (const gull of this.#gulls) {
      const s = sprite(Math.floor(t * 5 + gull.phase) % 2 === 0 ? 'gull' : 'gull2');
      ctx.drawImage(gull.vx > 0 ? s.canvas : s.flipped, Math.round(gull.x), Math.round(gull.y + Math.sin(t + gull.phase) * 2));
    }
  }

  #drawSky(ctx: CanvasRenderingContext2D) {
    if (this.#dusk < 0.005 && this.#dim < 0.005) return;
    const [r, g, b] = this.#skyColor();
    ctx.save();
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.globalCompositeOperation = 'multiply';
    ctx.fillStyle = `rgb(${Math.round(r)} ${Math.round(g)} ${Math.round(b)})`;
    ctx.fillRect(0, 0, W, H);
    ctx.restore();
  }

  // At sunset the fires and lamps come on, which makes the island feel alive as time runs out.
  #drawLights(ctx: CanvasRenderingContext2D, t: number) {
    const strength = Math.max(0, (this.#dusk - 0.55) / 0.45);
    if (strength <= 0) return;
    ctx.save();
    ctx.globalCompositeOperation = 'lighter';
    for (const actor of this.#actors) {
      const { kind } = actor.landmark;
      if (kind === 'campfire') {
        const flicker = 0.75 + Math.sin(t * 11 + actor.phase) * 0.15;
        this.#glow(ctx, actor.x, actor.y - 5, 12, `rgba(255, 140, 40, ${0.16 * strength * flicker})`);
      } else if (kind === 'lighthouse') {
        const flash = Math.max(0, Math.sin(t * 1.6 + actor.phase));
        this.#glow(ctx, actor.x, actor.y - 16, 6 + Math.round(flash * 4), `rgba(255, 230, 130, ${0.14 * strength * (0.4 + flash * 0.6)})`);
      } else if (kind === 'hut') {
        ctx.fillStyle = `rgba(255, 200, 80, ${0.7 * strength})`;
        ctx.fillRect(actor.x - 7, actor.y - 5, 2, 3);
        ctx.fillRect(actor.x + 5, actor.y - 5, 2, 3);
      }
    }
    ctx.restore();
  }

  #glow(ctx: CanvasRenderingContext2D, cx: number, cy: number, radius: number, color: string) {
    ctx.fillStyle = color;
    for (let band = radius; band > 0; band -= 3) {
      for (let y = -band; y <= band; y++) {
        const half = Math.round(Math.sqrt(band * band - y * y));
        ctx.fillRect(cx - half, cy + y, half * 2 + 1, 1);
      }
    }
  }

  #ring(ctx: CanvasRenderingContext2D, cx: number, cy: number, radius: number, color: string) {
    ctx.fillStyle = color;
    let x = radius;
    let y = 0;
    let err = 1 - radius;
    while (x >= y) {
      for (const [dx, dy] of [[x, y], [y, x], [-x, y], [-y, x], [x, -y], [y, -x], [-x, -y], [-y, -x]]) {
        ctx.fillRect(cx + dx, cy + dy, 1, 1);
      }
      y++;
      if (err < 0) err += 2 * y + 1;
      else {
        x--;
        err += 2 * (y - x) + 1;
      }
    }
  }

  // While rolling, the sky is dimmed and only the spots still in play stand out.
  #drawRoll(ctx: CanvasRenderingContext2D, t: number) {
    const roll = this.#roll;
    if (!roll) return;
    for (let i = 0; i < roll.candidates.length; i++) {
      const landmark = MAP.landmarks[roll.candidates[i]];
      const x = toArt(landmark.x);
      const y = toArt(landmark.y);
      const active = roll.order[roll.at] === landmark.id;
      if (active) {
        const s = sprite(SPRITE_FOR[landmark.kind]);
        ctx.drawImage(s.canvas, x - Math.floor(s.w / 2), y - s.h - 1);
      }
      this.#ring(ctx, x, y - 6, active ? 14 + (roll.landedAt >= 0 ? Math.round(Math.sin(t * 16)) : 0) : 11, active ? PALETTE.y : PALETTE.w);
      if (active) this.#ring(ctx, x, y - 6, 15, PALETTE.y);
    }
  }

  #drawSpot(ctx: CanvasRenderingContext2D, t: number) {
    if (!this.#spot) return;
    const x = toArt(this.#spot.x);
    const y = toArt(this.#spot.y);
    const age = t - this.#spotBornAt;
    const pop = age < 0.14 && !this.#calm ? Math.round((1 - age / 0.14) * 5) : 0;
    this.#ring(ctx, x, y, 8 + pop + (this.#calm ? 0 : Math.round(Math.sin(t * 6))), PALETTE.w);
    const s = xMark(4, PALETTE.p);
    ctx.drawImage(s.canvas, x - Math.floor(s.w / 2), y - Math.floor(s.h / 2));
  }

  #drawCursor(ctx: CanvasRenderingContext2D, t: number) {
    const s = sprite('shovel');
    const swingAge = this.#swing >= 0 ? t - this.#swing : 99;

    // With no mouse there is no cursor, so the shovel just appears for the dig itself.
    if (!this.#pointer && swingAge < 0.45) {
      const stab = Math.round(Math.sin((swingAge / 0.45) * Math.PI) * -6);
      ctx.drawImage(s.canvas, this.#swingAt.x - Math.floor(s.w / 2), this.#swingAt.y - s.h + 1 + stab);
      return;
    }

    if (!this.#pointer || !this.#pickable) return;
    const stab = swingAge < 0.2 ? Math.round(Math.sin((swingAge / 0.2) * Math.PI) * 5) : 0;
    const x = Math.round(this.#cursor.x) - Math.floor(s.w / 2);
    const y = Math.round(this.#cursor.y) - s.h + 1 + stab;
    ctx.drawImage(s.canvas, x, y);
  }
}

export const world = new World();
