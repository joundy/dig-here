import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest';
import { rollLayout, rosterOf, spotsOf } from '../game/map';
import { fromBase58ToHex } from '../base58';
import { sha256, streamRng, toHex } from '../game/random';
import { ChainClock } from './clock';
import { isMissingKey, panicMessage, plainError } from './errors';
import { LiveFeed } from './feed';
import type { EventSourceLike, FeedDeps } from './feed';
import { balanceFromEvents, isDone, readOutcome } from './outcome';
import { clocksOf, gameFromSummary, landmarksOf, roomFromEvents } from './rooms';
import type { LiveState } from './rooms';
import { sendReliably, STOP_WAITING_MS } from './send';
import type { SendDeps } from './send';
import { RpcError } from './rpc';

describe('rooms', () => {
  it('expands compact landmarks into what the layout roll makes', () => {
    const seed = sha256(new Uint8Array([1, 2, 3]));
    const rolled = rollLayout('snowy', streamRng(seed));
    const spots = spotsOf('snowy');
    const roster = rosterOf('snowy');
    const compact = rolled.map((l): [number, number, number] => [spots.findIndex((s) => s[0] === l.x && s[1] === l.y), roster.indexOf(l.kind), l.flip ? 1 : 0]);
    expect(landmarksOf('snowy', compact)).toEqual(rolled);
  });

  it('passes full landmarks through, and tolerates a room with none', () => {
    expect(landmarksOf('tropical', undefined)).toEqual([]);
    const full = [{ id: 0, kind: 'cow', category: 'animal', x: 5, y: 6, tags: ['north'], flip: true }] as const;
    expect(landmarksOf('tropical', full as never)).toEqual(full);
  });

  it('closes the visible clock 2.5 s before the on-chain end', () => {
    const times = { created_ms: 0, start_at_ms: null, started_ms: 10_000, ends_at_ms: 70_000, duration_sec: 60 };
    expect(clocksOf(times, 10_000).elapsed).toBe(0);
    expect(clocksOf(times, 70_000 - 2500).elapsed).toBe(60);
    expect(clocksOf(times, 69_000).elapsed).toBe(60);
    expect(clocksOf(times, 40_000).elapsed).toBeCloseTo((30_000 / 57_500) * 60, 5);
  });

  it('counts a waiting room down from chain time', () => {
    const times = { created_ms: 1000, start_at_ms: 31_000, started_ms: null, ends_at_ms: null, duration_sec: 60 };
    expect(clocksOf(times, 11_000)).toEqual({ waited: 10, startIn: 20, elapsed: 0 });
    expect(clocksOf(times, 40_000).startIn).toBe(0);
  });

  it('never makes a summary read as joined, even when nobody is signed in', () => {
    const game = gameFromSummary({ room_id: 3, name: 'x', host: 'h', map: 'desert', fee: 10, pot: 30, players: 3, digs: 2, status: 'finished', ended_ms: 1, refund_reason: null, treasure: { x: 1, y: 2, landmark_id: 3 }, winner: 'w' });
    expect(game.players).toHaveLength(3);
    expect(game.players).not.toContain('');
    expect(game.fee * game.players.length).toBe(30);
  });

  it('rebuilds a room from its events', () => {
    const landmarks = [{ id: 0, kind: 'cow', category: 'animal', x: 1, y: 2, tags: [], flip: false }];
    const room = roomFromEvents([
      { event: 'room_created', data: { room_id: 9, name: 'n', host: 'h', map: 'tropical', fee: 10, bond: 100, duration_sec: 60, host_cut_bps: 0, min_players: 2, max_players: 3, countdown_sec: 0, created_ms: 1, deadline_ms: 2, block_height: 5, tip_index: 7, tip: 'aa', block_seed: 'bb', layout_seed: 'cc', landmarks } },
      { event: 'joined', data: { room_id: 9, account: 'a' } },
      { event: 'joined', data: { room_id: 9, account: 'b' } },
      { event: 'left', data: { room_id: 9, account: 'b' } },
      { event: 'started', data: { room_id: 9, started_ms: 10, ends_at_ms: 70, players: ['a'], pot: 10 } },
      { event: 'locked', data: { room_id: 9, step: 1, lock_seed: 'ls', digs_hash: 'dh', lock_ms: 20, lock_height: 6, due_ms: 19 } },
      { event: 'revealed', data: { room_id: 9, step: 1, link: 'lk', roll_seed: 'rs', clue: { level: 'category', category: 'animal' }, candidates_after: [0], reveal_ms: 21, reveal_height: 7 } },
      { event: 'refunded', data: { room_id: 9, reason: 'too-few-digs', players: ['a'], pot: 10, ended_ms: 80, jackpot_after: 4 } },
    ]);
    expect(room?.status).toBe('refunded');
    expect(room?.players).toEqual(['a']);
    expect(room?.tip).toBe('aa');
    expect(room?.rolls?.[0]).toMatchObject({ step: 1, link: 'lk', lock_height: 6, reveal_height: 7 });
    expect(room?.clues).toHaveLength(2);
    expect(room?.result?.refund_reason).toBe('too-few-digs');
    expect(roomFromEvents([])).toBeNull();
  });
});

describe('clock', () => {
  it('believes the sample with the shortest delivery, plus a block age', () => {
    const clock = new ChainClock();
    clock.sample(10_000, 20_000); // -10 s
    clock.sample(11_500, 20_500); // -9 s, the freshest
    clock.sample(10_000, 21_000); // a slow delivery
    expect(clock.now(21_000)).toBe(21_000 - 9000 + 800);
  });

  it('never runs backwards, whatever new samples say', () => {
    const clock = new ChainClock();
    clock.sample(10_000, 10_000);
    const first = clock.now(10_000);
    clock.sample(5000, 70_500 + 60_000); // the old sample has aged out, and this one says we're far behind
    expect(clock.now(10_001)).toBeGreaterThanOrEqual(first);
  });

  it('forgets old samples, so a phone clock that jumped stops counting', () => {
    const clock = new ChainClock();
    clock.sample(100_000, 100_000); // offset 0
    clock.sample(100_000, 200_000); // offset -100 s, 100 s later: the first sample is outside the window
    expect(clock.now(200_000)).toBeLessThanOrEqual(100_000 + 800 + 1);
  });
});

describe('errors', () => {
  const panic = JSON.stringify({ ActionError: { index: 0, kind: { FunctionCallError: { ExecutionError: 'Smart contract panicked: This game is full.' } } } });

  it('hands the contract\'s own sentence to the player', () => {
    expect(panicMessage(panic)).toBe('This game is full.');
    expect(plainError(panic)).toBe('This game is full.');
  });

  it('says plain things for network and gas failures, with no jargon', () => {
    for (const raw of ['Exceeded the prepaid gas.', 'NotEnoughAllowance', 'Failed to fetch', 'TIMEOUT_ERROR', 'something odd']) {
      expect(plainError(raw)).not.toMatch(/nonce|gas|rpc|tx|transaction|allowance/i);
    }
  });

  it('spots a key that has gone', () => {
    expect(isMissingKey('{"InvalidTxError":{"InvalidAccessKeyError":{"AccessKeyNotFound":{}}}}')).toBe(true);
    expect(isMissingKey('UNKNOWN_ACCESS_KEY')).toBe(true);
    expect(isMissingKey('This game is full.')).toBe(false);
  });
});

describe('outcome', () => {
  const ok = {
    status: { SuccessValue: btoa('7') },
    transaction: { hash: 'H' },
    transaction_outcome: { block_hash: 'B', outcome: { logs: [] } },
    receipts_outcome: [{ outcome: { logs: ['plain log', 'EVENT_JSON:{"standard":"dig-here","event":"balance","data":{"changes":[{"account":"me","delta":"-1","balance":"5000000000000000000000"}]}}'] } }],
  };

  it('reads the value and the events', () => {
    const outcome = readOutcome(ok);
    expect(outcome.value).toBe(7);
    expect(outcome.hash).toBe('H');
    expect(outcome.failure).toBeNull();
    expect(balanceFromEvents(outcome.events, 'me')).toBe(5000000000000000000000n);
    expect(balanceFromEvents(outcome.events, 'someone')).toBeNull();
  });

  it('knows a finished transaction from one the network has only heard of', () => {
    expect(isDone(ok)).toBe(true);
    expect(isDone({ status: { Failure: {} } })).toBe(true);
    expect(isDone({ status: 'Unknown' })).toBe(false);
    expect(isDone({ final_execution_status: 'INCLUDED' })).toBe(false);
  });
});

describe('sends', () => {
  const done = { status: { SuccessValue: '' }, transaction: { hash: 'x' } };

  function deps(overrides: Partial<SendDeps>) {
    const nonces: bigint[] = [];
    let nonce = 10n;
    const base: SendDeps = {
      nextNonce: async () => ++nonce,
      sign: async (n) => {
        nonces.push(n);
        return { hash: `h${n}`, base64: `b${n}`, nonce: n };
      },
      send: async () => done,
      status: async () => null,
      sleep: async () => undefined,
    };
    return { deps: { ...base, ...overrides }, nonces };
  }

  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it('returns straight away when the send answers', async () => {
    const { deps: d, nonces } = deps({});
    await expect(sendReliably(d)).resolves.toBe(done);
    expect(nonces).toEqual([11n]);
  });

  it('stops waiting at 8 s, finds it landed, and never signs again', async () => {
    const onSlow = vi.fn();
    const { deps: d, nonces } = deps({
      send: (_b, signal) => new Promise((_, reject) => signal.addEventListener('abort', () => reject(new Error('aborted')))),
      status: async () => done,
    });
    const run = sendReliably(d, onSlow);
    await vi.advanceTimersByTimeAsync(STOP_WAITING_MS + 10);
    await expect(run).resolves.toBe(done);
    expect(nonces).toEqual([11n]);
    expect(onSlow).toHaveBeenCalledOnce();
  });

  it('signs again with a new nonce only when the hash truly never landed', async () => {
    let calls = 0;
    const { deps: d, nonces } = deps({
      send: async () => {
        calls++;
        if (calls === 1) throw new RpcError('Timeout', 'TIMEOUT_ERROR');
        return done;
      },
    });
    await expect(sendReliably(d)).resolves.toBe(done);
    expect(nonces).toEqual([11n, 12n]);
  });

  it('gives up after three lost sends rather than spending forever', async () => {
    const { deps: d, nonces } = deps({ send: async () => { throw new RpcError('Timeout', 'TIMEOUT_ERROR'); } });
    await expect(sendReliably(d)).rejects.toMatchObject({ code: 'LOST' });
    expect(nonces).toHaveLength(3);
  });

  it('resends the same bytes when the endpoint is only busy', async () => {
    const bytes: string[] = [];
    let calls = 0;
    const { deps: d, nonces } = deps({
      send: async (b) => {
        bytes.push(b);
        if (++calls < 3) throw new RpcError('429', 'BUSY');
        return done;
      },
    });
    await expect(sendReliably(d)).resolves.toBe(done);
    expect(new Set(bytes).size).toBe(1);
    expect(nonces).toHaveLength(1);
  });

  it('re-reads the nonce and signs again straight away when it was refused as stale', async () => {
    const fresh: boolean[] = [];
    let calls = 0;
    let nonce = 10n;
    const { deps: d } = deps({
      nextNonce: async (f) => {
        fresh.push(f);
        return ++nonce;
      },
      send: async () => {
        if (++calls === 1) throw new RpcError('bad', 'INVALID_TRANSACTION', { TxExecutionError: { InvalidTxError: { InvalidNonce: {} } } });
        return done;
      },
    });
    await expect(sendReliably(d)).resolves.toBe(done);
    expect(fresh).toEqual([false, true]);
  });

  it('lets a contract panic through without retrying', async () => {
    const { deps: d, nonces } = deps({ send: async () => { throw new RpcError('nope', 'SOME_OTHER_ERROR'); } });
    await expect(sendReliably(d)).rejects.toMatchObject({ code: 'SOME_OTHER_ERROR' });
    expect(nonces).toHaveLength(1);
  });
});

describe('live feed', () => {
  const live = (version: number): LiveState => ({ version, now_ms: Date.now(), jackpot: 0, season: { number: 1, ends_at_ms: 0, pool: 0, top: [], last_winners: [] }, commitments_left: 1, missed_reveals: 0, max_open_rooms: 30, rooms: [] });

  class FakeStream implements EventSourceLike {
    readyState = 1;
    listeners: ((e: any) => void)[] = [];
    addEventListener(_type: string, listener: (e: any) => void) { this.listeners.push(listener); }
    close() { this.readyState = 2; }
    frame(version: number) { for (const l of this.listeners) l({ data: JSON.stringify({ version, fetched_ms: Date.now(), live: live(version) }) }); }
  }

  function setup(backendUp: () => boolean, fetchedAt: () => number = () => Date.now()) {
    const streams: FakeStream[] = [];
    const seen: number[] = [];
    const chainReads = vi.fn(async () => live(100));
    const states = vi.fn(async () => {
      if (!backendUp()) throw new Error('down');
      return { version: 50, fetched_ms: fetchedAt(), live: live(50) };
    });
    const modes: string[] = [];
    const deps: FeedDeps = {
      openStream: () => {
        const stream = new FakeStream();
        streams.push(stream);
        return stream;
      },
      fetchState: states,
      readChain: chainReads,
      chainNow: () => Date.now(),
      onState: (l) => seen.push(l.version),
      onMode: (m) => modes.push(m),
    };
    return { feed: new LiveFeed(deps), streams, seen, chainReads, states, modes };
  }

  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it('stays on the backend through a quiet spell, when it still answers', async () => {
    const { feed, chainReads, modes } = setup(() => true);
    feed.start();
    await vi.advanceTimersByTimeAsync(30_000);
    expect(chainReads).not.toHaveBeenCalled();
    expect(modes).toEqual([]);
    feed.stop();
  });

  it('falls back to polling the chain every 2 s, then returns when a frame arrives', async () => {
    let up = true;
    const { feed, streams, chainReads, seen, modes } = setup(() => up);
    feed.start();
    await vi.advanceTimersByTimeAsync(1000);
    streams[0].frame(50);
    up = false;
    await vi.advanceTimersByTimeAsync(5600);
    expect(modes).toEqual(['chain']);
    chainReads.mockClear();
    await vi.advanceTimersByTimeAsync(10_000);
    expect(chainReads.mock.calls.length).toBeGreaterThanOrEqual(4);
    expect(chainReads.mock.calls.length).toBeLessThanOrEqual(6);
    expect(seen).toContain(100);

    up = true;
    streams[streams.length - 1].frame(101);
    expect(modes).toEqual(['chain', 'backend']);
    chainReads.mockClear();
    await vi.advanceTimersByTimeAsync(4000);
    expect(chainReads).not.toHaveBeenCalled();
    feed.stop();
  });

  it('comes back by itself once the backend answers again, with no frame needed', async () => {
    let up = false;
    const { feed, modes } = setup(() => up);
    feed.start();
    await vi.advanceTimersByTimeAsync(1000);
    expect(modes).toEqual(['chain']);
    up = true;
    await vi.advanceTimersByTimeAsync(6000);
    expect(modes).toEqual(['chain', 'backend']);
    feed.stop();
  });

  it('treats a backend that answers with old news as down', async () => {
    const { feed, modes } = setup(() => true, () => Date.now() - 60_000);
    feed.start();
    await vi.advanceTimersByTimeAsync(1000);
    expect(modes).toEqual(['chain']);
    feed.stop();
  });

  it('reopens a stream the browser gave up on', async () => {
    let up = false;
    const { feed, streams } = setup(() => up);
    feed.start();
    await vi.advanceTimersByTimeAsync(1000);
    streams[0].readyState = 2;
    await vi.advanceTimersByTimeAsync(6000);
    expect(streams.length).toBeGreaterThan(1);
    feed.stop();
  });
});

describe('base58', () => {
  it('decodes a block value to the hex a seed is written in', () => {
    expect(fromBase58ToHex('11111111111111111111111111111111')).toBe('0'.repeat(64));
    expect(toHex(sha256(new Uint8Array(0)))).toHaveLength(64);
  });
});
