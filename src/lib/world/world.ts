// The living island: one small canvas, redrawn every frame and scaled up by whole pixels.
import { audio } from '../audio/audio.svelte';
import { kindName } from '../game/copy';
import { possibleArea } from '../game/engine';
import { getMap, H, W } from '../game/map';
import { RULES } from '../game/rules';
import type { Dig, Kind, Landmark, MapId, Point } from '../game/types';
import { bonus } from '../format';
import { buzz } from '../ui.svelte';
import { PALETTE, sprite, xMark } from './sprites';
import type { SpriteName } from './sprites';
import { buildTerrain } from './terrain';
import type { Terrain } from './terrain';
import { themeOf } from './themes';

const VOICE: Partial<Record<Kind, number>> = {
  horse: 330, cow: 165, sheep: 415, duck: 660, scarecrow: 247, campfire: 196, boat: 294,
  penguin: 587, seal: 220, husky: 370, snowman: 277, sled: 311,
  camel: 139, lizard: 784, vulture: 185, skull: 123, cart: 262, pyramid: 98,
};

const TOY_LINES: Record<Kind, string> = {
  horse: 'Neigh. Legally binding.',
  cow: 'Moo. That was rude.',
  sheep: 'Baa. Have we met? Baa.',
  duck: 'QUACK! Not the face!',
  palm: 'Mind the coconuts.',
  pine: 'I smell like a taxi.',
  apple: 'Ow. Have an apple.',
  hut: 'Nobody home. Go away.',
  windmill: 'Wheeeeeeeee!',
  well: 'No refunds on wishes.',
  lighthouse: 'I see everything. Hi.',
  scarecrow: 'Boo. Please clap.',
  campfire: 'You poked a fire. Bold.',
  boat: 'Parked. Do not tow.',
  penguin: 'Sir, this is formalwear!',
  seal: 'Arf. Clap for me.',
  husky: 'AWOOO! Breakfast?!',
  snowpine: 'Careful. Loaded with snow.',
  birch: 'Hands off my pyjamas.',
  igloo: 'Close the door!',
  cabin: 'Wipe your boots.',
  snowman: 'My nose is a snack.',
  sled: 'No brakes. Never had any.',
  camel: 'Ptoo! Missed. Hold still.',
  lizard: 'I was doing push-ups.',
  vulture: 'No rush. I can wait.',
  cactus: 'Hug me. I dare you.',
  deadtree: 'Not dead. Just resting.',
  tent: 'Occupied! Mostly by sand.',
  pyramid: 'Some assembly required.',
  skull: 'I used to dig here too.',
  cart: 'One wheel left. Ask me how.',
};

const DIZZY_LINE = 'Wheee! I regret this.';
const CAMPFIRE = ['campfire', 'campfire2', 'campfire3'] as const;

const SCOOT_REACH = 22;
const SCOOT_OUT = 0.35;
const SCOOT_TIME = 1.5;
const SPIN_TIME = 1.2;
const TAP_STREAK = 1.2;

const DISSOLVE_TIME = 0.6;
const DISSOLVE_TICK = 1 / 12;
// Little-endian RGBA, ink at about 60%, the same way terrain.ts writes its pixels.
const GLOOM_PIXEL = (153 << 24) | (0x3c << 16) | (0x1b << 8) | 0x14;

const CONFETTI = [PALETTE.y, PALETTE.p, PALETTE.u, PALETTE.g, PALETTE.w, PALETTE.o];

// The sky through a round: day, golden hour, sunset, then dusk for the reveal.
const SKY: [number, [number, number, number]][] = [
  [0, [255, 255, 255]],
  [0.5, [255, 243, 222]],
  [0.85, [255, 190, 150]],
  [1, [150, 125, 215]],
];

type Actor = {
  landmark: Landmark; x: number; y: number; phase: number; hopAt: number; hopStart: number;
  /** Outside the possible area, so it sits back. */
  sunk: boolean; alpha: number;
  pokedAt: number; taps: number; tappedAt: number;
  scootAt: number; scootDir: number; spinAt: number; fastUntil: number;
};
type Particle = { x: number; y: number; vx: number; vy: number; life: number; max: number; color: string; gravity: number; coin?: boolean; floor?: number };
type Mark = { dig: Dig; bornAt: number };
type Gull = { x: number; y: number; vx: number; phase: number };
type Cloud = { x: number; y: number; vx: number; canvas: HTMLCanvasElement };

type Chest = { x: number; y: number; bornAt: number; landed: boolean; open: boolean; finish: (() => void) | null };

export type DeedMark = 'mine' | 'owned' | 'sale';

export type Hover = { text: string; x: number; y: number } | null;

const clamp = (n: number, low: number, high: number) => Math.min(high, Math.max(low, n));

const rings = new Map<string, HTMLCanvasElement>();

// Baked once per size and colour: rings get drawn many times a frame on a phone.
function ringImage(radius: number, color: string, between = color): HTMLCanvasElement {
  const key = `${radius}${color}${between}`;
  let canvas = rings.get(key);
  if (canvas) return canvas;
  canvas = document.createElement('canvas');
  canvas.width = canvas.height = radius * 2 + 1;
  const ctx = canvas.getContext('2d')!;
  const dot = (dx: number, dy: number) => ctx.fillRect(radius + dx, radius + dy, 1, 1);
  let x = radius;
  let y = 0;
  let err = 1 - radius;
  while (x >= y) {
    ctx.fillStyle = y % 2 === 0 ? color : between;
    dot(x, y); dot(y, x); dot(-x, y); dot(-y, x);
    dot(x, -y); dot(y, -x); dot(-x, -y); dot(-y, -x);
    y++;
    if (err < 0) err += 2 * y + 1;
    else {
      x--;
      err += 2 * (y - x) + 1;
    }
  }
  rings.set(key, canvas);
  return canvas;
}

let dissolveOrder: Uint8Array | null = null;

function dissolveHash(): Uint8Array {
  if (dissolveOrder) return dissolveOrder;
  dissolveOrder = new Uint8Array(W * H);
  for (let i = 0; i < dissolveOrder.length; i++) {
    let h = Math.imul(i + 1, 2654435761);
    h ^= h >>> 15;
    h = Math.imul(h, 2246822519);
    h ^= h >>> 13;
    dissolveOrder[i] = h >>> 24;
  }
  return dissolveOrder;
}

function kindLabel(kind: Kind): string {
  const name = kindName(kind);
  return name[0].toUpperCase() + name.slice(1);
}

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
  onLandmark: ((id: number) => void) | null = null;

  #canvas: HTMLCanvasElement | null = null;
  #ctx: CanvasRenderingContext2D | null = null;
  #mapId: MapId = 'tropical';
  #terrains = new Map<MapId, Terrain>();
  #terrain: Terrain | null = null;
  #landmarks: Landmark[] = [];
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
  /** Back to front, kept ready so the frame loop doesn't sort. */
  #markOrder: Mark[] = [];
  #me: string | undefined;
  #spot: Point | null = null;
  #spotBornAt = 0;
  #pickable = false;
  #crowdRings = false;

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
  #skyMap: MapId | null = null;
  #skyDusk = 0;
  #skyDim = 0;
  #shadowLayer: HTMLCanvasElement | null = null;

  // The land nobody can win on: a whole layer, repainted only while it dissolves.
  #possibleIds: number[] | null = null;
  #possibleKey: string | null = null;
  #gloomCtx: CanvasRenderingContext2D | null = null;
  #gloomLayer: HTMLCanvasElement | null = null;
  #gloomImage: ImageData | null = null;
  #gloomPixels: Uint32Array | null = null;
  #gloomFrom = new Uint8Array(W * H);
  #gloomTo = new Uint8Array(W * H);
  #gloomNow = new Uint8Array(W * H);
  #dissolveAt = -1;
  #dissolveClock = 0;

  #tension = 0;
  #tensionBeat = -1;
  #highlightId: number | null = null;
  #deedMarks: Map<number, DeedMark> | null = null;

  #roll: {
    order: number[]; at: number; nextAt: number; final: number; total: number; startedAt: number;
    candidates: number[]; finish: () => void; landedAt: number;
  } | null = null;
  #chest: Chest | null = null;
  #lines: { startedAt: number; winner: string | null; finish: (() => void) | null } | null = null;
  #confettiUntil = 0;
  #confettiClock = 0;
  #fountain: { x: number; y: number; until: number; clock: number } | null = null;

  attach(canvas: HTMLCanvasElement) {
    this.#canvas = canvas;
    canvas.width = W;
    canvas.height = H;
    this.#ctx = canvas.getContext('2d')!;
    this.#ctx.imageSmoothingEnabled = false;
    this.#calm = matchMedia('(prefers-reduced-motion: reduce)').matches;
    if (!this.#terrain) this.#build(this.#mapId);
    this.#last = performance.now();
    cancelAnimationFrame(this.#raf);
    this.#raf = requestAnimationFrame((t) => this.#frame(t));
  }

  detach() {
    cancelAnimationFrame(this.#raf);
    this.#canvas = null;
  }

  #build(mapId: MapId) {
    this.#mapId = mapId;
    let terrain = this.#terrains.get(mapId);
    if (!terrain) {
      terrain = buildTerrain(mapId);
      this.#terrains.set(mapId, terrain);
    }
    this.#terrain = terrain;
    this.#waterClock = 1e3;
    this.#landmarks = getMap(mapId).landmarks;
    this.#particles.length = 0;
    const landmarks = [...this.#landmarks].sort((a, b) => a.y - b.y);
    this.#actors = landmarks.map((landmark) => ({
      landmark,
      x: landmark.x,
      y: landmark.y,
      phase: landmark.id * 1.7,
      hopAt: 2 + Math.random() * 14,
      hopStart: -9,
      sunk: false,
      alpha: 1,
      pokedAt: -9,
      taps: 0,
      tappedAt: -9,
      scootAt: -9,
      scootDir: 1,
      spinAt: -9,
      fastUntil: -9,
    }));
    if (!this.#clouds.length) {
      this.#clouds = [
        { x: 30, y: 40, vx: 2.4, canvas: makeCloudShadow(72, 30, 1) },
        { x: 190, y: 120, vx: 1.7, canvas: makeCloudShadow(96, 36, 4) },
        { x: -60, y: 170, vx: 2.1, canvas: makeCloudShadow(60, 26, 7) },
      ];
    }
  }

  /** Puts the island of this map on screen, doing nothing in particular. */
  showMap(mapId: MapId) {
    this.idle();
    if (mapId !== this.#mapId || !this.#terrain) this.#build(mapId);
  }

  /** Clears the round-specific layers, leaving the island itself running. */
  idle() {
    this.#marks.clear();
    this.#markOrder.length = 0;
    this.#spot = null;
    this.#pickable = false;
    this.#crowdRings = false;
    this.#duskTarget = 0;
    this.#finishPending();
    this.#roll = null;
    this.#chest = null;
    this.#lines = null;
    this.#confettiUntil = 0;
    this.#fountain = null;
    this.#tension = 0;
    this.#highlightId = null;
    this.#deedMarks = null;
    this.setPossible(null, false);
    this.#tapLabelUntil = 0;
    this.#emitHover(null);
  }

  #finishPending() {
    this.#roll?.finish();
    this.#chest?.finish?.();
    this.#lines?.finish?.();
  }

  /** Starts showing a room, without playing effects for digs that already happened. */
  enterGame(mapId: MapId, digs: Dig[], candidateIds: number[] | null) {
    this.showMap(mapId);
    for (const dig of digs) this.#marks.set(dig.account, { dig: { ...dig }, bornAt: -9 });
    this.#sortMarks();
    this.setPossible(candidateIds, false);
  }

  /** Called whenever the round's state changes. New digs get their entrance here. */
  sync(state: { digs: Dig[]; me: string | undefined; spot: Point | null; pickable: boolean; crowdRings?: boolean }) {
    this.#me = state.me;
    this.#pickable = state.pickable;
    this.#crowdRings = state.crowdRings ?? false;

    // Only a real jump gets the pop. A dragged X moves in small steps and just follows the finger.
    if (state.spot && (!this.#spot || Math.hypot(state.spot.x - this.#spot.x, state.spot.y - this.#spot.y) > 12)) {
      this.#spotBornAt = this.#time;
    }
    this.#spot = state.spot;

    let added = false;
    for (const dig of state.digs) {
      if (this.#marks.has(dig.account)) continue;
      added = true;
      this.#marks.set(dig.account, { dig: { ...dig }, bornAt: this.#time });
      const mine = dig.account === state.me;
      this.#dirtBurst(dig.x, dig.y, mine ? 22 : 7);
      if (mine) {
        this.#swing = this.#time;
        this.#swingAt = { x: dig.x, y: dig.y };
        this.#kick(3);
        buzz(35);
        audio.dig();
      } else {
        audio.botDig();
      }
    }
    if (added) this.#sortMarks();
  }

  #sortMarks() {
    this.#markOrder = [...this.#marks.values()].sort((a, b) => a.dig.y - b.dig.y);
  }

  /** Darkens land the treasure can't be on, and sits back the landmarks it can't be near. Null clears it. */
  setPossible(candidateIds: number[] | null, animate = true) {
    const key = candidateIds ? candidateIds.join(',') : null;
    if (key === this.#possibleKey && (animate || this.#dissolveAt < 0)) return;
    this.#possibleKey = key;
    this.#possibleIds = candidateIds;

    const land = getMap(this.#mapId).land;
    const keep = candidateIds ? possibleArea(this.#mapId, candidateIds) : null;
    const to = this.#gloomTo;
    for (let i = 0; i < to.length; i++) to[i] = keep && land[i] && !keep[i] ? 1 : 0;
    this.#gloomFrom.set(this.#gloomNow);

    const instant = !animate || this.#calm;
    for (const actor of this.#actors) {
      actor.sunk = candidateIds !== null && !candidateIds.includes(actor.landmark.id);
      if (instant) actor.alpha = actor.sunk ? 0.55 : 1;
    }

    if (instant) {
      this.#dissolveAt = -1;
      this.#paintGloom(1);
    } else {
      this.#dissolveAt = this.#time;
      this.#dissolveClock = DISSOLVE_TICK;
    }
  }

  // Each cell flips at its own hashed moment, so the change crumbles across the land.
  #paintGloom(progress: number) {
    if (!this.#gloomLayer) {
      this.#gloomLayer = document.createElement('canvas');
      this.#gloomLayer.width = W;
      this.#gloomLayer.height = H;
      this.#gloomCtx = this.#gloomLayer.getContext('2d')!;
      this.#gloomImage = this.#gloomCtx.createImageData(W, H);
      this.#gloomPixels = new Uint32Array(this.#gloomImage.data.buffer);
    }
    const order = dissolveHash();
    const threshold = progress * 256;
    const from = this.#gloomFrom;
    const to = this.#gloomTo;
    const now = this.#gloomNow;
    const pixels = this.#gloomPixels!;
    for (let i = 0; i < now.length; i++) {
      const dark = order[i] < threshold ? to[i] : from[i];
      now[i] = dark;
      pixels[i] = dark ? GLOOM_PIXEL : 0;
    }
    this.#gloomCtx!.putImageData(this.#gloomImage!, 0, 0);
  }

  /** 0 is normal. In the final seconds it rings the spots still possible, and at 1 the ground thumps. */
  setTension(amount: number) {
    this.#tension = amount;
  }

  /** A gold ring on one landmark, for the Deed Market. */
  /** Little flags over landmarks in the Deed Market: yours, someone else's, or for sale. */
  setDeedMarks(marks: Map<number, DeedMark> | null) {
    this.#deedMarks = marks;
  }

  highlight(landmarkId: number | null) {
    this.#highlightId = landmarkId;
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
      this.#chest = { x: point.x, y: point.y, bornAt: this.#time, landed: false, open: false, finish: resolve };
    });
  }

  drawLines(winner: string | null): Promise<void> {
    return new Promise((resolve) => {
      this.#lines = { startedAt: this.#time, winner, finish: resolve };
    });
  }

  /** Puts a finished round straight into its end state, for when you open one later. */
  showFinal(treasure: Point, winner: string | null) {
    this.#chest = { x: treasure.x, y: treasure.y, bornAt: -9, landed: true, open: true, finish: null };
    this.#lines = { startedAt: -9, winner, finish: null };
  }

  celebrate() {
    this.#confettiUntil = this.#time + (this.#calm ? 0 : 3.5);
    if (!this.#chest) return;
    for (let i = 0; i < 30; i++) this.#coinBurst(this.#chest.x, this.#chest.y - 6);
  }

  /** The jackpot paying out: the biggest thing the island can do. */
  jackpotBurst() {
    const x = this.#chest ? this.#chest.x : W / 2;
    const y = (this.#chest ? this.#chest.y : H / 2) - 8;
    buzz([60, 40, 120]);
    this.#kick(9);
    for (let i = 0; i < (this.#calm ? 20 : 60); i++) this.#coinBurst(x, y, 1.7);
    if (this.#calm) return;
    this.#fountain = { x, y, until: this.#time + 1.6, clock: 0 };
    this.#confettiUntil = this.#time + 4;
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
    this.#tapLabelUntil = 0;
    this.#emitHover(null);
  }

  pointerClick(x: number, y: number) {
    const actor = this.#actorAt(x, y, 11);
    this.#pick(x, y);
    if (actor) this.onLandmark?.(actor.landmark.id);
  }

  /** A click while no spot can be picked: whatever is under it gets a surprise. */
  pokeAt(x: number, y: number) {
    const actor = this.#actorAt(x, y, 11);
    if (!actor) return;
    this.#poke(actor, x);
    this.onLandmark?.(actor.landmark.id);
  }

  /** A finger tap: picks the spot if digging is open, and pokes the nearest landmark if not. */
  touchTap(x: number, y: number) {
    const actor = this.#actorAt(x, y, 14);
    if (!actor) {
      this.#tapLabelUntil = 0;
      this.#emitHover(null);
    } else if (this.#pickable) {
      if (!this.#calm) actor.hopStart = this.#time;
      this.#say(actor, kindLabel(actor.landmark.kind));
    } else {
      this.#poke(actor, x);
    }
    if (this.#pickable) this.#pick(x, y);
    if (actor) this.onLandmark?.(actor.landmark.id);
  }

  dragSpot(x: number, y: number) {
    this.#emitHover(null);
    this.#pick(x, y, true);
  }

  #pick(x: number, y: number, quiet?: boolean) {
    const point = { x: clamp(Math.floor(x), 0, W - 1), y: clamp(Math.floor(y), 0, H - 1) };
    if (quiet) this.onPick?.(point, true);
    else this.onPick?.(point);
  }

  #actorAt(x: number, y: number, reach: number): Actor | null {
    let nearest: Actor | null = null;
    let best = reach;
    for (const actor of this.#actors) {
      const d = Math.hypot(actor.x - x, actor.y - 6 - y);
      if (d < best) {
        nearest = actor;
        best = d;
      }
    }
    return nearest;
  }

  #say(actor: Actor, text: string) {
    this.#emitHover({ text, x: actor.x, y: actor.y - sprite(actor.landmark.kind).h - 2 });
    this.#tapLabelUntil = this.#time + 1.4;
  }

  #poke(actor: Actor, fromX: number) {
    const t = this.#time;
    const { kind } = actor.landmark;
    actor.taps = t - actor.tappedAt < TAP_STREAK ? actor.taps + 1 : 1;
    actor.tappedAt = t;

    const spins = (kind === 'scarecrow' || kind === 'snowman') && actor.taps >= 3;
    if (spins) actor.taps = 0;

    buzz(10);
    audio.critter(VOICE[kind] ?? 440);
    this.#say(actor, spins ? DIZZY_LINE : TOY_LINES[kind]);
    if (this.#calm) return;

    actor.hopStart = t;
    actor.pokedAt = t;
    if (spins) actor.spinAt = t;
    if (kind === 'duck' || kind === 'penguin') this.#scoot(actor, fromX);
    else if (kind === 'windmill') actor.fastUntil = t + 3;
    else if (kind === 'campfire') this.#sparks(actor.x, actor.y - 8);
  }

  // Runs from the finger, unless that way is the sea.
  #scoot(actor: Actor, fromX: number) {
    const land = getMap(this.#mapId).land;
    const open = (dir: number) => {
      const x = actor.x + dir * SCOOT_REACH;
      return x >= 0 && x < W && land[actor.y * W + x] === 1;
    };
    let dir = fromX <= actor.x ? 1 : -1;
    if (!open(dir)) dir = -dir;
    if (!open(dir)) return;
    actor.scootDir = dir;
    actor.scootAt = this.#time;
  }

  #sparks(x: number, y: number) {
    const colors = [PALETTE.y, PALETTE.o, PALETTE.r];
    for (let i = 0; i < 18; i++) {
      this.#particles.push({
        x: x - 2 + Math.random() * 4, y, vx: (Math.random() - 0.5) * 34, vy: -22 - Math.random() * 42,
        life: 0, max: 0.5 + Math.random() * 0.5, color: colors[i % 3], gravity: 60,
      });
    }
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

  #coinBurst(x: number, y: number, power = 1) {
    const angle = -Math.PI * (0.15 + Math.random() * 0.7);
    const speed = (50 + Math.random() * 80) * power;
    this.#particles.push({
      x, y, vx: Math.cos(angle) * speed, vy: Math.sin(angle) * speed,
      life: 0, max: (1 + Math.random() * 0.7) * Math.sqrt(power), color: PALETTE.y, gravity: 200, coin: true, floor: y + 8 + Math.random() * 8 * power * power,
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

    if (this.#tension >= 1 && Math.floor(t) !== this.#tensionBeat) {
      this.#tensionBeat = Math.floor(t);
      this.#kick(1);
    }

    this.#updateDissolve(dt);

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

    const fade = Math.min(1, dt * 4);
    for (const actor of this.#actors) {
      const goal = actor.sunk ? 0.55 : 1;
      if (actor.alpha !== goal) actor.alpha = Math.abs(goal - actor.alpha) < 0.01 ? goal : actor.alpha + (goal - actor.alpha) * fade;
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

    const fountain = this.#fountain;
    if (fountain) {
      fountain.clock += dt;
      while (fountain.clock > 0.016) {
        fountain.clock -= 0.016;
        this.#coinBurst(fountain.x, fountain.y, 1.7);
      }
      if (t > fountain.until) this.#fountain = null;
    }

    // In place: this list is rewritten every frame, and a fresh array each time adds up on a phone.
    const particles = this.#particles;
    let kept = 0;
    for (let i = 0; i < particles.length; i++) {
      const p = particles[i];
      p.life += dt;
      p.vy += p.gravity * dt;
      p.x += p.vx * dt;
      p.y += p.vy * dt;
      if (p.floor !== undefined && p.y > p.floor) {
        p.y = p.floor;
        p.vy *= -0.4;
        p.vx *= 0.6;
      }
      if (p.life < p.max) particles[kept++] = p;
    }
    particles.length = kept;

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

  #updateDissolve(dt: number) {
    if (this.#dissolveAt < 0) return;
    this.#dissolveClock += dt;
    if (this.#dissolveClock < DISSOLVE_TICK) return;
    this.#dissolveClock = 0;
    const progress = Math.min(1, (this.#time - this.#dissolveAt) / DISSOLVE_TIME);
    this.#paintGloom(progress);
    if (progress >= 1) this.#dissolveAt = -1;
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
    let keptGulls = 0;
    for (const gull of this.#gulls) {
      gull.x += gull.vx * dt;
      if (gull.x > -12 && gull.x < W + 12) this.#gulls[keptGulls++] = gull;
    }
    this.#gulls.length = keptGulls;

    this.#smokeClock += dt;
    if (this.#smokeClock > 0.32) {
      this.#smokeClock = 0;
      for (const actor of this.#actors) {
        const { kind } = actor.landmark;
        if (kind !== 'campfire' && kind !== 'hut' && kind !== 'cabin') continue;
        if (Math.random() > 0.55) continue;
        const fire = kind === 'campfire';
        this.#particles.push({
          x: actor.x + (fire ? 0 : kind === 'hut' ? 4 : 3), y: actor.y - (fire ? 11 : kind === 'hut' ? 15 : 18), vx: 2 + Math.random() * 3, vy: -7 - Math.random() * 5,
          life: 0, max: 1.3, color: fire ? PALETTE.d : PALETTE.c, gravity: 0,
        });
      }
    }
  }

  #updateHover() {
    const { x, y } = this.#pointer!;
    const best = this.#actorAt(x, y, 11);

    let digHover: Mark | null = null;
    for (const mark of this.#markOrder) {
      if (Math.hypot(mark.dig.x - x, mark.dig.y - y) < 5) digHover = mark;
    }

    // A poke's line stays up for its moment, even with the mouse still sitting on the landmark.
    if (!this.#tapLabelUntil) {
      if (digHover) {
        const { dig } = digHover;
        const who = dig.account === this.#me ? 'You' : dig.account;
        this.#emitHover({ text: `${who} ${bonus(dig.bonusBps)}${dig.crowded ? ' crowded' : ''}`, x: dig.x, y: dig.y - 8 });
      } else if (best) {
        this.#emitHover({ text: kindLabel(best.landmark.kind), x: best.x, y: best.y - sprite(best.landmark.kind).h - 2 });
      } else {
        this.#emitHover(null);
      }
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
    if (this.#mapId === this.#skyMap && Math.abs(this.#dusk - this.#skyDusk) < 0.002 && Math.abs(this.#dim - this.#skyDim) < 0.002) return;
    this.#skyMap = this.#mapId;
    this.#skyDusk = this.#dusk;
    this.#skyDim = this.#dim;
    const theme = themeOf(this.#mapId);
    const sky = this.#skyColor();
    const mix = (base: readonly number[]) => `rgb(${base.map((c, i) => Math.round((c * sky[i]) / 255)).join(' ')})`;
    const sea = mix(theme.sea);
    if (sea === this.#seaApplied) return;
    this.#seaApplied = sea;
    const root = document.documentElement.style;
    root.setProperty('--sea', sea);
    root.setProperty('--deep', mix(theme.deep));
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
    // Under the sky effects, which multiply over whatever is here, so #dim still works on top.
    if (this.#gloomLayer && (this.#possibleIds || this.#dissolveAt >= 0)) ctx.drawImage(this.#gloomLayer, 0, 0);

    this.#drawLines(ctx);
    this.#drawScene(ctx, t);
    this.#drawParticles(ctx, t);
    this.#drawGulls(ctx, t);

    this.#drawSky(ctx);
    this.#drawLights(ctx, t);
    this.#drawTension(ctx, t);
    this.#drawRoll(ctx, t);
    this.#drawDeedMarks(ctx);
    this.#drawHighlight(ctx, t);
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
    for (const actor of this.#actors) {
      ctx.globalAlpha = actor.alpha;
      this.#drawActor(ctx, actor, t);
    }
    ctx.globalAlpha = 1;

    if (this.#crowdRings && this.#pickable) this.#drawCrowdRings(ctx);

    // Digs and the chest go on top of everything: a player must always be able to see them.
    const marks = this.#markOrder;
    for (const mark of marks) if (mark.dig.account !== this.#me) this.#drawMark(ctx, mark, t);
    for (const mark of marks) if (mark.dig.account === this.#me) this.#drawMark(ctx, mark, t);
    if (this.#chest) this.#drawChest(ctx, this.#chest, t);
  }

  #drawCrowdRings(ctx: CanvasRenderingContext2D) {
    const radius = RULES.crowdRadius;
    // Two-tone, because one colour vanishes on either snow or the darkened land.
    const image = ringImage(radius, PALETTE.k, PALETTE.w);
    ctx.globalAlpha = 0.6;
    for (const { dig } of this.#markOrder) ctx.drawImage(image, dig.x - radius, dig.y - radius);
    ctx.globalAlpha = 1;
  }

  #drawActor(ctx: CanvasRenderingContext2D, actor: Actor, t: number) {
    const { kind, flip, category } = actor.landmark;
    const animal = category === 'animal';
    let name: SpriteName = kind;
    if (kind === 'campfire') name = CAMPFIRE[Math.floor(t * 7 + actor.phase) % 3];
    const s = sprite(name);
    let flipped = flip && animal;

    let cx = actor.x;
    let waddle = 0;
    const scootAge = t - actor.scootAt;
    if (scootAge < SCOOT_TIME) {
      const out = scootAge < SCOOT_OUT;
      const reach = out ? 1 - (1 - scootAge / SCOOT_OUT) ** 2 : 1 - (scootAge - SCOOT_OUT) / (SCOOT_TIME - SCOOT_OUT);
      cx += Math.round(actor.scootDir * SCOOT_REACH * reach);
      waddle = Math.round(Math.abs(Math.sin(scootAge * (out ? 26 : 13))) * 2);
      // The art faces right.
      flipped = out ? actor.scootDir < 0 : actor.scootDir > 0;
    }

    const spinAge = t - actor.spinAt;
    if (spinAge < SPIN_TIME) flipped = Math.floor(spinAge * 10) % 2 === 1;

    const image = flipped ? s.flipped : s.canvas;
    const x = cx - Math.floor(s.w / 2);

    const hopAge = t - (animal ? actor.hopStart : actor.pokedAt);
    const hopping = hopAge >= 0 && hopAge < 0.34;
    const lift = Math.max(waddle, hopping ? Math.round(Math.sin((hopAge / 0.34) * Math.PI) * (animal ? 5 : 3)) : 0);
    let y = actor.y - s.h - lift;

    // Soft ground shadow, which shrinks as the sprite leaves the ground.
    ctx.fillStyle = 'rgba(20, 27, 60, 0.22)';
    const shadowW = s.w - 2 - lift;
    ctx.fillRect(cx - Math.floor(shadowW / 2), actor.y - 1, shadowW, 2);

    if (category === 'tree') {
      // Trees lean in the breeze: the top half slides sideways, the trunk stays put.
      const split = Math.floor(s.h * 0.6);
      const sway = Math.round(Math.sin(t * 1.4 + actor.phase) * 1.2);
      ctx.drawImage(image, 0, 0, s.w, split, x + sway, y, s.w, split);
      ctx.drawImage(image, 0, split, s.w, s.h - split, x, y + split, s.w, s.h - split);
      return;
    }

    if (animal) {
      // Animals breathe: everything above the legs lifts one pixel, then settles.
      const split = s.h - 4;
      const breathe = Math.sin(t * 2.4 + actor.phase) > 0.55 ? 1 : 0;
      ctx.drawImage(image, 0, 0, s.w, split, x, y - breathe, s.w, split);
      ctx.drawImage(image, 0, split, s.w, s.h - split, x, y + split, s.w, s.h - split);
      return;
    }

    if (kind === 'boat') y += Math.round(Math.sin(t * 1.5 + actor.phase));
    ctx.drawImage(image, x, y);

    if (kind === 'windmill') {
      const rate = t < actor.fastUntil ? 30 : 6;
      const blades = sprite(Math.floor(t * rate + actor.phase) % 2 === 0 ? 'bladesPlus' : 'bladesCross');
      ctx.drawImage(blades.canvas, cx - 8, y - 2);
    }
  }

  #drawMark(ctx: CanvasRenderingContext2D, mark: Mark, t: number) {
    const { dig } = mark;
    const mine = dig.account === this.#me;
    const { x, y } = dig;
    const color = mine ? PALETTE.p : dig.bonusBps >= 25000 ? PALETTE.y : dig.bonusBps >= 15000 ? PALETTE.w : PALETTE.l;
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
      this.#pixelLine(ctx, dig.x, dig.y, chest.x, chest.y - 3, reach, march, mine ? PALETTE.p : PALETTE.k, false);
    }
    const win = lines.winner ? this.#marks.get(lines.winner) : null;
    if (win) this.#pixelLine(ctx, win.dig.x, win.dig.y, chest.x, chest.y - 3, reach, march, PALETTE.y, true);
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
        ctx.fillRect(actor.x - 6, actor.y - 5, 2, 2);
        ctx.fillRect(actor.x + 4, actor.y - 5, 2, 2);
      } else if (kind === 'cabin') {
        this.#glow(ctx, actor.x - 4, actor.y - 4, 3, `rgba(255, 200, 80, ${0.3 * strength})`);
      } else if (kind === 'tent' || kind === 'igloo') {
        this.#glow(ctx, actor.x, actor.y - 3, 5, `rgba(255, 170, 70, ${0.2 * strength})`);
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
    ctx.drawImage(ringImage(radius, color), cx - radius, cy - radius);
  }

  // The rings run outward from each spot still possible, faster as time runs out.
  #drawTension(ctx: CanvasRenderingContext2D, t: number) {
    if (this.#tension <= 0 || !this.#possibleIds || this.#roll) return;
    const speed = 1 + this.#tension * 1.5;
    for (const id of this.#possibleIds) {
      const landmark = this.#landmarks[id];
      if (!landmark) continue;
      const wave = this.#calm ? 0.3 : (t * speed + id * 0.37) % 1;
      ctx.globalAlpha = 1 - wave * 0.75;
      this.#ring(ctx, landmark.x, landmark.y - 6, 9 + Math.round(wave * 7), PALETTE.y);
    }
    ctx.globalAlpha = 1;
  }

  #drawDeedMarks(ctx: CanvasRenderingContext2D) {
    if (!this.#deedMarks) return;
    const colors: Record<DeedMark, string> = { mine: PALETTE.p, owned: PALETTE.c, sale: PALETTE.y };
    for (const actor of this.#actors) {
      const mark = this.#deedMarks.get(actor.landmark.id);
      if (!mark) continue;
      const top = actor.y - sprite(actor.landmark.kind).h - 5;
      ctx.fillStyle = PALETTE.k;
      ctx.fillRect(actor.x - 1, top - 1, 7, 6);
      ctx.fillRect(actor.x - 1, top + 5, 2, 3);
      ctx.fillStyle = colors[mark];
      ctx.fillRect(actor.x, top, 5, 4);
    }
  }

  #drawHighlight(ctx: CanvasRenderingContext2D, t: number) {
    if (this.#highlightId === null) return;
    const landmark = this.#landmarks[this.#highlightId];
    if (!landmark) return;
    const radius = 13 + (this.#calm ? 0 : Math.round(Math.sin(t * 6)));
    this.#ring(ctx, landmark.x, landmark.y - 6, radius, PALETTE.y);
    this.#ring(ctx, landmark.x, landmark.y - 6, radius + 1, PALETTE.Y);
  }

  // While rolling, the sky is dimmed and only the spots still in play stand out.
  #drawRoll(ctx: CanvasRenderingContext2D, t: number) {
    const roll = this.#roll;
    if (!roll) return;
    for (let i = 0; i < roll.candidates.length; i++) {
      const landmark = this.#landmarks[roll.candidates[i]];
      const { x, y } = landmark;
      const active = roll.order[roll.at] === landmark.id;
      if (active) {
        const s = sprite(landmark.kind);
        const flipped = landmark.flip && landmark.category === 'animal';
        ctx.drawImage(flipped ? s.flipped : s.canvas, x - Math.floor(s.w / 2), y - s.h - 1);
      }
      this.#ring(ctx, x, y - 6, active ? 14 + (roll.landedAt >= 0 ? Math.round(Math.sin(t * 16)) : 0) : 11, active ? PALETTE.y : PALETTE.w);
      if (active) this.#ring(ctx, x, y - 6, 15, PALETTE.y);
    }
  }

  #drawSpot(ctx: CanvasRenderingContext2D, t: number) {
    if (!this.#spot) return;
    const { x, y } = this.#spot;
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
