// Where live state comes from. The backend first; if it goes quiet, straight from the chain, and back.
import type { LiveState } from './rooms';

const QUIET_MS = 5000;
const RPC_POLL_MS = 2000;
const PROBE_MS = 5000;
const STALE_MS = 15_000;
const WATCH_MS = 500;
const REOPEN_MS = 5000;

export type FeedMode = 'backend' | 'chain';
export type StateBody = { version: number; fetched_ms: number; live: LiveState };

export type EventSourceLike = {
  readyState: number;
  addEventListener(type: string, listener: (event: any) => void): void;
  close(): void;
};

export type FeedDeps = {
  openStream(): EventSourceLike;
  /** The backend's latest, or a throw if it can't be reached. */
  fetchState(): Promise<StateBody>;
  /** The contract's own `live_state`, read directly. */
  readChain(): Promise<LiveState>;
  /** Chain time, to tell a backend that answers but has stopped reading the chain. */
  chainNow(): number;
  onState(live: LiveState): void;
  onMode(mode: FeedMode): void;
};

/**
 * SSE only speaks when something changed, and its heartbeat comments aren't visible to the browser's
 * EventSource. So five quiet seconds can just mean nothing happened: the backend gets asked directly,
 * and only a failed or stale answer moves the player onto the chain.
 */
export class LiveFeed {
  #deps: FeedDeps;
  #mode: FeedMode = 'backend';
  #stream: EventSourceLike | null = null;
  #lastFrame = 0;
  #lastPoll = 0;
  #lastProbe = 0;
  #lastOpen = 0;
  #probing = false;
  #polling = false;
  #timer: ReturnType<typeof setInterval> | null = null;

  constructor(deps: FeedDeps) {
    this.#deps = deps;
  }

  get mode() {
    return this.#mode;
  }

  start() {
    this.#open();
    void this.#probe();
    this.#timer = setInterval(() => this.#watch(), WATCH_MS);
  }

  stop() {
    if (this.#timer) clearInterval(this.#timer);
    this.#stream?.close();
    this.#stream = null;
  }

  /** Asks for fresh state now, as after the player's own move, without waiting for the next frame. */
  async refresh(): Promise<void> {
    await this.#poll();
  }

  #setMode(mode: FeedMode) {
    if (mode === this.#mode) return;
    this.#mode = mode;
    this.#deps.onMode(mode);
  }

  #open() {
    this.#lastOpen = Date.now();
    this.#stream?.close();
    const stream = this.#deps.openStream();
    this.#stream = stream;
    stream.addEventListener('state', (event) => {
      try {
        const body = JSON.parse(event.data) as StateBody;
        this.#lastFrame = Date.now();
        this.#setMode('backend');
        this.#deps.onState(body.live);
      } catch {
        // A bad frame is the same as no frame: the watchdog handles it.
      }
    });
  }

  #watch() {
    const now = Date.now();
    const quiet = now - this.#lastFrame;
    if (this.#mode === 'backend') {
      if (quiet >= QUIET_MS && now - this.#lastProbe >= QUIET_MS) void this.#probe();
      return;
    }
    if (now - this.#lastPoll >= RPC_POLL_MS) void this.#poll();
    if (now - this.#lastProbe >= PROBE_MS) void this.#probe();
    // A proxy's error page closes an EventSource for good, so it needs reopening by hand.
    if (this.#stream?.readyState === 2 && now - this.#lastOpen >= REOPEN_MS) this.#open();
  }

  async #probe() {
    if (this.#probing) return;
    this.#probing = true;
    this.#lastProbe = Date.now();
    try {
      const body = await this.#deps.fetchState();
      if (this.#deps.chainNow() - body.fetched_ms > STALE_MS) throw new Error('The backend has stopped reading the chain');
      this.#lastFrame = Date.now();
      this.#setMode('backend');
      this.#deps.onState(body.live);
      if (!this.#stream || this.#stream.readyState === 2) this.#open();
    } catch {
      this.#setMode('chain');
      if (Date.now() - this.#lastPoll >= RPC_POLL_MS) void this.#poll();
    } finally {
      this.#probing = false;
    }
  }

  async #poll() {
    if (this.#polling) return;
    this.#polling = true;
    this.#lastPoll = Date.now();
    try {
      this.#deps.onState(await this.#deps.readChain());
    } catch {
      // Every endpoint refused. The next round of the watchdog tries again.
    } finally {
      this.#polling = false;
    }
  }
}
