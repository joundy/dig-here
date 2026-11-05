// A browser's clock can be seconds off, and only block time decides anything on chain.
const WINDOW_MS = 60_000;
const MAX_SAMPLES = 20;
/**
 * The freshest block anyone can read is already at least this old on arrival (measured floor 697 to
 * 811 ms), so block time alone would run the countdown slow by that much.
 */
const BLOCK_AGE_MS = 800;

export class ChainClock {
  #samples: { offset: number; at: number }[] = [];
  #last = 0;

  /** The sample that took the shortest route has the highest offset, so that's the one to believe. */
  sample(chainMs: number, localMs = Date.now()) {
    this.#samples.push({ offset: chainMs - localMs, at: localMs });
    if (this.#samples.length > MAX_SAMPLES) this.#samples.shift();
  }

  get ready() {
    return this.#samples.length > 0;
  }

  /** Chain time now. Never runs backwards, so a countdown can't jump up. */
  now(localMs = Date.now()): number {
    const fresh = this.#samples.filter((s) => localMs - s.at <= WINDOW_MS);
    const samples = fresh.length ? fresh : this.#samples;
    if (!samples.length) return localMs;
    const estimate = localMs + Math.max(...samples.map((s) => s.offset)) + BLOCK_AGE_MS;
    this.#last = Math.max(this.#last, estimate);
    return this.#last;
  }
}
