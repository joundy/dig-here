import { createHash } from 'node:crypto';
import { gzipSync } from 'node:zlib';
import { errorText, log, sleep } from './log.ts';
import { viewFunction } from './rpc.ts';

export type Live = any;
export type Frame = { version: number; fetched_ms: number; live: Live };
type Encoded = { frame: Frame; json: Buffer; gzip: Buffer; etag: string };

const FAST_MS = 1000;
const IDLE_MS = 5000;

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

  constructor(contract: string, demand: Demand) {
    this.contract = contract;
    this.demand = demand;
  }

  /** Runs on every poll. The oracle and bots use it, since their decisions depend on time as well as state. */
  onPoll(fn: (frame: Frame) => void): void {
    this.#watchers.push(fn);
  }

  /** Runs only when `version` moves. SSE uses this. */
  onChange(fn: (frame: Frame, encoded: Encoded) => void): void {
    this.#changeWatchers.push(fn);
  }

  async run(): Promise<never> {
    for (;;) {
      const began = Date.now();
      try {
        this.#accept(await viewFunction(this.contract, 'live_state'));
        this.lastError = null;
      } catch (e) {
        this.lastError = errorText(e);
        log('live', `poll failed: ${this.lastError}`);
      }
      const open = this.current?.frame.live.rooms.length ?? 0;
      const interval = open > 0 || this.demand.active() ? FAST_MS : IDLE_MS;
      await sleep(Math.max(100, interval - (Date.now() - began)));
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
