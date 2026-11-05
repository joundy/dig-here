import { createHash } from 'node:crypto';
import { gzipSync } from 'node:zlib';
import { errorText, log } from './log.ts';
import { viewFunction } from './rpc.ts';

export type Live = any;
export type Frame = { version: number; fetched_ms: number; live: Live };
type Encoded = { frame: Frame; json: Buffer; gzip: Buffer; etag: string };

const FAST_MS = 1000;
const IDLE_MS = 5000;
// The oracle can ask for a read right after its own transaction, and never more often than this.
const WAKE_GAP_MS = 500;

/** Tracks whether anyone is watching. Bots and the poller slow down when nobody is. */
export class Demand {
  readonly windowMs: number;
  sseClients = 0;
  lastSeenMs = 0;

  constructor(windowMs = 300_000) {
    this.windowMs = windowMs;
  }

  touch(): void {
    this.lastSeenMs = Date.now();
  }

  active(): boolean {
    return this.sseClients > 0 || Date.now() - this.lastSeenMs < this.windowMs;
  }
}

/** One poller reads the chain, and everyone else reads this object. That's what keeps RPC load flat as players grow. */
export class LiveState {
  readonly contract: string;
  readonly demand: Demand;
  current: Encoded | null = null;
  lastError: string | null = null;
  #watchers: Array<(frame: Frame) => void> = [];
  #changeWatchers: Array<(frame: Frame, encoded: Encoded) => void> = [];
  #wake: () => void = () => {};
  #running = false;
  #woken = false;
  #lastReadMs = 0;

  constructor(contract: string, demand: Demand) {
    this.contract = contract;
    this.demand = demand;
  }

  /**
   * For the oracle's own transactions, so the clue it just revealed reaches everyone sooner. Nothing a client does
   * may lead here: browsers reconnecting once multiplied the RPC reads by 40, and the oracle lives on these reads.
   */
  wake(): void {
    if (Date.now() - this.#lastReadMs < WAKE_GAP_MS) return;
    this.#woken = true;
    this.#wake();
  }

  /** Runs on every poll. The oracle and bots use it, since their decisions depend on time as well as state. */
  onPoll(fn: (frame: Frame) => void): void {
    this.#watchers.push(fn);
  }

  /** Runs only when `version` moves. SSE uses this. */
  onChange(fn: (frame: Frame, encoded: Encoded) => void): void {
    this.#changeWatchers.push(fn);
  }

  /** Checks once a second whether a read is due, so a new arrival is noticed at once without being able to cause one. */
  async run(): Promise<never> {
    if (this.#running) throw new Error('LiveState has one poller, and it is already running');
    this.#running = true;
    for (;;) {
      const began = Date.now();
      if (this.#readDue(began)) await this.#read(began);
      await new Promise<void>((resolve) => {
        const timer = setTimeout(resolve, Math.max(100, FAST_MS - (Date.now() - began)));
        // The HTTP server is what keeps the process running, so tests can end without stopping this loop.
        timer.unref();
        this.#wake = () => {
          clearTimeout(timer);
          resolve();
        };
      });
    }
  }

  #readDue(now: number): boolean {
    const open = this.current?.frame.live.rooms.length ?? 0;
    return this.#woken || open > 0 || this.demand.active() || now - this.#lastReadMs >= IDLE_MS;
  }

  async #read(now: number): Promise<void> {
    this.#woken = false;
    this.#lastReadMs = now;
    try {
      this.#accept(await viewFunction(this.contract, 'live_state'));
      this.lastError = null;
    } catch (e) {
      this.lastError = errorText(e);
      log('live', `poll failed: ${this.lastError}`);
    }
  }

  #accept(live: Live): void {
    const previous = this.current?.frame;
    // Load-balanced nodes can answer from a block or two behind, and the board must never step backwards.
    if (previous && live.version < previous.version) return;
    const frame: Frame = { version: live.version, fetched_ms: Date.now(), live };
    const changed = !previous || previous.version !== live.version;
    const json = Buffer.from(JSON.stringify(frame));
    const encoded = { frame, json, gzip: gzipSync(json, { level: 6 }), etag: etagOf(live) };
    this.current = encoded;
    for (const fn of this.#watchers) guard(fn, frame);
    if (changed) for (const fn of this.#changeWatchers) guard(() => fn(frame, encoded), frame);
  }
}

// now_ms moves every block, so it stays out of the tag or nothing would ever match.
export function etagOf(live: Live): string {
  const stable = `${live.version}:${live.commitments_left}:${live.missed_reveals}:${live.jackpot}:${live.season?.number}`;
  return `"${createHash('sha256').update(stable).digest('hex').slice(0, 16)}"`;
}

function guard<T>(fn: (arg: T) => void, arg: T): void {
  try {
    fn(arg);
  } catch (e) {
    log('live', `watcher threw: ${errorText(e)}`);
  }
}
