import { chainFor } from './commitments.ts';
import type { Config } from './config.ts';
import type { Funding } from './funding.ts';
import type { Frame, LiveState } from './live.ts';
import { errorText, log, sleep } from './log.ts';
import { nextStep } from './oracle-plan.ts';
import { finalBlock, viewAccount, viewFunction } from './rpc.ts';
import type { NearAccount } from './signer.ts';
import { near, toNear } from './units.ts';

// A previous process's last upload could still be landing, and uploading on top of it would shift every tip's index.
const POOL_SETTLE_MS = 8000;
const RETRY_AFTER_NONE_MS = 1500;
const POKE_TGAS = 30;
const REVEAL_TGAS = 30;
const POOL_TGAS = 30;
const LOW_BALANCE = near('0.5');
const TOP_UP = near('1');
// Both calls are harmless to repeat, and a clue that waits costs every player in the room.
const SEND_FAST = { patienceMs: 5000 };

export class Oracle {
  readonly #config: Config;
  readonly #oracle: NearAccount;
  readonly #runner: NearAccount;
  readonly #state: LiveState;
  readonly #funding: Funding;
  readonly #busy = new Map<number, number>();
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
    if (!live.rooms.length) return;
    const needsFinal = live.rooms.some((r: any) => r.locked);
    void (needsFinal ? finalBlock().then((b) => b.height) : Promise.resolve(null))
      .catch(() => null)
      .then((height) => {
        for (const room of live.rooms) this.#act(room, live.now_ms, height);
      });
  }

  #act(room: any, nowMs: number, finalHeight: number | null): void {
    const step = nextStep(room, nowMs, finalHeight);
    if (!step || step.type === 'wait-final') return;
    if ((this.#busy.get(room.room_id) ?? 0) > Date.now()) return;
    this.#busy.set(room.room_id, Number.MAX_SAFE_INTEGER);
    const send = step.type === 'poke' ? this.#poke(room.room_id) : this.#reveal(room.room_id, step.step, step.tip_index);
    void send
      .catch((e) => log('oracle', `room ${room.room_id}: ${step.type} failed: ${errorText(e)}`))
      // The poll that saw this state is out of date by the time the send returns. Leave
      // room for the view to catch up, or the same action gets sent again for nothing.
      .finally(() => this.#busy.set(room.room_id, Date.now() + RETRY_AFTER_NONE_MS));
  }

  async #poke(roomId: number): Promise<void> {
    const r = await this.#runner.call(this.#config.contract, 'poke', { room_id: roomId }, POKE_TGAS, 0n, SEND_FAST);
    if (!r.ok) throw new Error(r.failure);
    if (r.value !== 'none') log('oracle', `room ${roomId}: poke ${r.value}`, { hash: r.hash });
  }

  async #reveal(roomId: number, step: number, tipIndex: number): Promise<void> {
    const link = chainFor(this.#config.oracleSecret, tipIndex).links[step - 1];
    const r = await this.#runner.call(this.#config.contract, 'reveal', { room_id: roomId, link }, REVEAL_TGAS, 0n, SEND_FAST);
    // Two polls can both see a pending lock, and the later one then finds it already revealed. That's harmless.
    if (!r.ok) throw new Error(r.failure);
    log('oracle', `room ${roomId}: revealed step ${step}`, { hash: r.hash });
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
        await this.#funding.topUp(id, id === this.#config.runnerAccount ? near('0.2') : LOW_BALANCE, id === this.#config.runnerAccount ? near('0.5') : TOP_UP);
      }
    } catch (e) {
      log('oracle', `balance check failed: ${errorText(e)}`);
    }
  }
}
