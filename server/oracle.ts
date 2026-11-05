import { chainFor, findChain } from './commitments.ts';
import type { Config } from './config.ts';
import type { Funding } from './funding.ts';
import type { Frame, LiveState } from './live.ts';
import { errorText, log, sleep } from './log.ts';
import { nextStep, pokeDue } from './oracle-plan.ts';
import { finalBlock, viewAccount, viewFunction } from './rpc.ts';
import type { NearAccount } from './signer.ts';
import { near, toNear } from './units.ts';

// A previous process's last upload could still be landing, and uploading on top of it would shift every tip's index.
const POOL_SETTLE_MS = 8000;
const COOL_AFTER_SEND_MS = 1500;
const COOL_AFTER_FAILURE_MS = 300;
// Landing a poke takes about 1.3 s after sending, and this is on top of the view's own age. Early ones cost 0.0002 NEAR.
const FIRE_LEAD_MS = Number(process.env.ORACLE_FIRE_LEAD_MS ?? 1600);
const TOO_EARLY_RETRY_MS = 250;
const TOO_EARLY_TRIES = 10;
const SCHEDULE_WINDOW_MS = 1500;
const POKE_TGAS = 30;
const REVEAL_TGAS = 30;
const POOL_TGAS = 30;
const LOW_BALANCE = near('0.5');
const TOP_UP = near('1');
// Both calls are harmless to repeat, and a clue that waits costs every player in the room.
const SEND_FAST = { patienceMs: 5000 };

function lockEvent(logs: string[]): { step: number; lock_height: number } | null {
  for (const line of logs) {
    if (!line.startsWith('EVENT_JSON:')) continue;
    const parsed = JSON.parse(line.slice('EVENT_JSON:'.length));
    if (parsed.event === 'locked') return parsed.data;
  }
  return null;
}

export const oracleStats = { pokes: 0, pokes_too_early: 0, reveals: 0, send_failures: 0 };

export class Oracle {
  readonly #config: Config;
  readonly #oracle: NearAccount;
  readonly #runner: NearAccount;
  readonly #state: LiveState;
  readonly #funding: Funding;
  readonly #busy = new Map<number, number>();
  readonly #chains = new Map<number, string[]>();
  readonly #fetching = new Set<number>();
  readonly #timers = new Set<string>();
  readonly #ages: number[] = [];
  #uploading = false;
  #started = Date.now();
  #lastFundCheck = 0;

  constructor(config: Config, oracle: NearAccount, runner: NearAccount, state: LiveState, funding: Funding) {
    this.#config = config;
    this.#oracle = oracle;
    this.#runner = runner;
    this.#state = state;
    this.#funding = funding;
  }

  start(): void {
    this.#started = Date.now();
    this.#state.onPoll((frame) => this.#tick(frame));
  }

  #tick(frame: Frame): void {
    const live = frame.live;
    void this.#keepPoolFull(live.commitments_left);
    void this.#keepFunded();
    this.#noteClock(frame);
    if (!live.rooms.length) return;
    for (const room of live.rooms) {
      this.#schedule(room);
      if (room.status === 'live') void this.#prefetch(room);
    }
    const waitForFinal = this.#config.oracleRevealFinal && live.rooms.some((r: any) => r.locked);
    void (waitForFinal ? finalBlock().then((b) => b.height) : Promise.resolve(null))
      .catch(() => null)
      .then((height) => {
        for (const room of live.rooms) this.#act(room, live.now_ms, height);
      });
  }

  /** The lowest age seen is the best estimate of how far a fresh view trails real chain time. */
  #noteClock(frame: Frame): void {
    this.#ages.push(frame.fetched_ms - frame.live.now_ms);
    if (this.#ages.length > 30) this.#ages.shift();
  }

  /** Waiting for the next poll adds half a second on average, so a due time inside the next poll gets its own timer. */
  #schedule(room: any): void {
    const due = pokeDue(room);
    if (due === null || room.locked || !this.#ages.length) return;
    const fireAt = due + Math.min(...this.#ages) - FIRE_LEAD_MS;
    const wait = fireAt - Date.now();
    if (wait > SCHEDULE_WINDOW_MS) return;
    const key = `${room.room_id}:${due}`;
    if (this.#timers.has(key)) return;
    this.#timers.add(key);
    if (this.#timers.size > 500) this.#timers.delete(this.#timers.values().next().value!);
    setTimeout(() => this.#claim(room, () => this.#lockThenReveal(room)), Math.max(0, wait));
  }

  #claim(room: any, work: () => Promise<void>): void {
    if ((this.#busy.get(room.room_id) ?? 0) > Date.now()) return;
    this.#busy.set(room.room_id, Number.MAX_SAFE_INTEGER);
    let cool = COOL_AFTER_SEND_MS;
    void work()
      .catch((e) => {
        cool = COOL_AFTER_FAILURE_MS;
        oracleStats.send_failures++;
        log('oracle', `room ${room.room_id}: ${errorText(e)}`);
      })
      // The poll that saw this state is out of date by now. Leave room for
      // the view to catch up, or the same action gets sent again for nothing.
      .finally(() => this.#busy.set(room.room_id, Date.now() + cool));
  }

  /** The poll is the safety net, and what picks up a room after a restart. Normally the timer has already handled it. */
  #act(room: any, nowMs: number, finalHeight: number | null): void {
    const step = nextStep(room, nowMs, finalHeight, this.#config.oracleRevealFinal);
    if (!step || step.type === 'wait-final') return;
    if (step.type === 'poke') this.#claim(room, () => this.#lockThenReveal(room));
    else this.#claim(room, () => this.#reveal(room.room_id, step.step, step.tip_index));
  }

  async #prefetch(room: any): Promise<void> {
    if (this.#chains.has(room.room_id) || this.#fetching.has(room.room_id)) return;
    this.#fetching.add(room.room_id);
    await this.#linksFor(room.room_id, room.tip_index).catch(() => {});
    this.#fetching.delete(room.room_id);
  }

  /**
   * The link goes out only after this poke's answer says the lock landed, so the lock's block is always earlier,
   * and the seed is fixed before anyone can see the link. Never send them together: a lost lock would expose the link.
   */
  async #lockThenReveal(room: any): Promise<void> {
    const roomId = room.room_id;
    for (let tries = 0; tries < TOO_EARLY_TRIES; tries++) {
      const r = await this.#runner.call(this.#config.contract, 'poke', { room_id: roomId }, POKE_TGAS, 0n, SEND_FAST);
      if (!r.ok) throw new Error(`poke: ${r.failure}`);
      oracleStats.pokes++;
      if (r.value === 'none') {
        oracleStats.pokes_too_early++;
        await sleep(TOO_EARLY_RETRY_MS);
        continue;
      }
      log('oracle', `room ${roomId}: poke ${r.value}`, { hash: r.hash });
      this.#state.wake();
      if (r.value !== 'locked') return;
      const lock = lockEvent(r.logs);
      if (!lock) return; // The poll path will see the lock and reveal it.
      if (this.#config.oracleRevealFinal) await this.#untilFinal(lock.lock_height);
      return this.#reveal(roomId, lock.step, room.tip_index);
    }
  }

  async #untilFinal(height: number): Promise<void> {
    for (let i = 0; i < 60; i++) {
      if ((await finalBlock(0).catch(() => ({ height: 0 }))).height >= height) return;
      await sleep(250);
    }
  }

  /** One extra read per room, and only for its first reveal in this process. */
  async #linksFor(roomId: number, tipIndex: number): Promise<string[]> {
    const known = this.#chains.get(roomId);
    if (known) return known;
    const { tip } = await viewFunction<{ tip: string }>(this.#config.contract, 'get_room', { id: roomId });
    const chain = findChain(this.#config.oracleSecret, tip, tipIndex);
    if (!chain) throw new Error(`no secret found for tip ${tip} near index ${tipIndex}, so this room will refund`);
    if (chain.index !== tipIndex) log('oracle', `room ${roomId}: tip sits at index ${tipIndex} but was made for ${chain.index}`);
    this.#chains.set(roomId, chain.links);
    if (this.#chains.size > 200) this.#chains.delete(this.#chains.keys().next().value!);
    return chain.links;
  }

  async #reveal(roomId: number, step: number, tipIndex: number): Promise<void> {
    const link = (await this.#linksFor(roomId, tipIndex))[step - 1];
    const r = await this.#runner.call(this.#config.contract, 'reveal', { room_id: roomId, link }, REVEAL_TGAS, 0n, SEND_FAST);
    // Two polls can both see a pending lock, and the later one then finds it already revealed. That's harmless.
    if (!r.ok) throw new Error(`reveal: ${r.failure}`);
    oracleStats.reveals++;
    log('oracle', `room ${roomId}: revealed step ${step}`, { hash: r.hash });
    this.#state.wake();
  }

  async #keepPoolFull(left: number): Promise<void> {
    if (this.#uploading || left >= this.#config.poolTarget) return;
    if (Date.now() - this.#started < POOL_SETTLE_MS) return;
    this.#uploading = true;
    try {
      const contract = this.#config.contract;
      const first = await viewFunction<number>(contract, 'commitments_next_index', {}, 'final');
      // Different answers mean a send is still landing, so the index can't be trusted yet.
      const newest = await viewFunction<number>(contract, 'commitments_next_index', {}, 'optimistic');
      if (first !== newest) {
        await sleep(2000);
        return;
      }
      const count = Math.max(this.#config.poolBatch, this.#config.poolTarget - left);
      const tips = Array.from({ length: Math.min(count, 100) }, (_, i) => chainFor(this.#config.oracleSecret, first + i).tip);
      const r = await this.#oracle.call(contract, 'add_commitments', { tips }, POOL_TGAS, 0n, { wait: 'FINAL', giveUpMs: 60_000, resign: false });
      if (!r.ok) throw new Error(r.failure);
      log('oracle', `uploaded ${tips.length} commitments from index ${first}`, { pool: r.value, hash: r.hash });
    } catch (e) {
      log('oracle', `pool top-up failed: ${errorText(e)}`);
      await sleep(5000);
    } finally {
      this.#uploading = false;
    }
  }

  async #keepFunded(): Promise<void> {
    if (Date.now() - this.#lastFundCheck < 300_000) return;
    this.#lastFundCheck = Date.now();
    try {
      for (const id of [this.#config.oracleAccount, this.#config.runnerAccount]) {
        const account = await viewAccount(id);
        if (account) log('oracle', `${id} holds ${toNear(account.amount)} NEAR`);
        await this.#funding.topUp(id, id === this.#config.runnerAccount ? near('0.2') : LOW_BALANCE, id === this.#config.runnerAccount ? near('0.5') : TOP_UP, 'oracle');
      }
    } catch (e) {
      log('oracle', `balance check failed: ${errorText(e)}`);
    }
  }
}
