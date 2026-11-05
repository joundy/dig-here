import { describe, expect, it } from 'vitest';
import { roomFromEvents } from './near/rooms';
import type { ChainRoom } from './near/rooms';
import { overallState, verifyRound } from './verify';
import type { CheckGroup } from './verify';
import { eventsOf, fakeChain, makeRoom, txsOf } from './verify.fixture';
import { headline, trustNotes, verifyOnChain } from './verifyChain';
import type { ChainReader, ProofEvent, RoundProof } from './verifyChain';

/** Everything the screen does with a round our server handed over, ending in the same verdict it would show. */
async function verdict(events: ProofEvent[], reader: ChainReader) {
  const room = roomFromEvents(events);
  if (!room) return { overall: 'fail' as const, groups: [] as CheckGroup[], room };
  const proof: RoundProof = { source: 'events', room, events, links: [] };
  const chain = await verifyOnChain(proof, reader);
  const groups = [...chain.groups, ...verifyRound(room)];
  return { overall: overallState(groups), groups, room };
}

const lines = (groups: CheckGroup[], state: string) => groups.flatMap((g) => g.checks).filter((c) => c.state === state);

function honest() {
  const events = eventsOf(makeRoom());
  const room = roomFromEvents(events)!;
  return { events, room, txs: txsOf(events) };
}

/** Edits what's in a log line, as a forger with their own contract could. */
function editLogs(tx: any, edit: (log: any) => void) {
  const outcome = tx.receipts_outcome[0].outcome;
  outcome.logs = outcome.logs.map((line: string) => {
    const log = JSON.parse(line.slice('EVENT_JSON:'.length));
    edit(log);
    return `EVENT_JSON:${JSON.stringify(log)}`;
  });
}

const eventNamed = (events: ProofEvent[], name: string, step?: number) => events.find((e) => e.event === name && (step === undefined || e.data.step === step))!;

describe('verify against the chain', () => {
  it('passes an honest round rebuilt from events, every line found on chain', async () => {
    const { events, room, txs } = honest();
    const { overall, groups } = await verdict(events, fakeChain(room, txs));
    expect(lines(groups, 'fail')).toEqual([]);
    expect(lines(groups, 'unchecked')).toEqual([]);
    expect(overall).toBe('pass');
  });

  it('passes an honest round read from the contract, when two nodes agree', async () => {
    const room = makeRoom();
    const chain = await verifyOnChain({ source: 'contract', room, links: [] }, fakeChain(room, new Map()));
    const groups = [...chain.groups, ...verifyRound(room)];
    expect(lines(groups, 'fail')).toEqual([]);
    expect(overallState(groups)).toBe('pass');
    expect(chain.codeHash).toBe('CodeHash111');
  });

  describe('tampering goes red', () => {
    // Our server lies and the chain doesn't: the forged list no longer matches the logs.
    it.each<[string, (events: ProofEvent[]) => void]>([
      ['a forged winner', (e) => { eventNamed(e, 'finished').data.winner = 'forger.testnet'; }],
      ['a changed dig', (e) => { eventNamed(e, 'dig').data.x += 1; }],
      ['a swapped link', (e) => { eventNamed(e, 'revealed', 2).data.link = eventNamed(e, 'revealed', 3).data.link; }],
      ['a null result', (e) => { e.splice(e.indexOf(eventNamed(e, 'finished')), 1); }],
      ['a dropped dig', (e) => { e.splice(e.indexOf(eventNamed(e, 'dig')), 1); }],
      ['a dropped reveal', (e) => { e.splice(e.indexOf(eventNamed(e, 'revealed', 3)), 1); }],
      ['a doubled ending', (e) => { e.push({ ...eventNamed(e, 'finished'), event: 'refunded' }); }],
    ])('%s from our server', async (_name, tamper) => {
      const { events, room, txs } = honest();
      tamper(events);
      const { overall, groups } = await verdict(events, fakeChain(room, txs));
      expect(overall).toBe('fail');
      expect(lines(groups, 'fail').length).toBeGreaterThan(0);
    });

    // The chain really holds the forged words, because someone else's contract wrote them. Same logs, wrong source.
    it('a wrong contract: identical logs from another contract', async () => {
      const { events, room, txs } = honest();
      for (const tx of txs.values()) {
        tx.transaction.receiver_id = 'forger.testnet';
        tx.receipts_outcome[0].outcome.executor_id = 'forger.testnet';
      }
      const { overall, groups } = await verdict(events, fakeChain(room, txs));
      expect(overall).toBe('fail');
      expect(lines(groups, 'fail').some((c) => /sent to forger\.testnet, not our contract/.test(c.detail ?? ''))).toBe(true);
    });

    it('a wrong contract: sent to ours, but the words logged by another', async () => {
      const { events, room, txs } = honest();
      for (const tx of txs.values()) tx.receipts_outcome[0].outcome.executor_id = 'forger.testnet';
      const { overall, groups } = await verdict(events, fakeChain(room, txs));
      expect(overall).toBe('fail');
      expect(lines(groups, 'fail').some((c) => /logs .* don't say/.test(c.detail ?? ''))).toBe(true);
    });

    it('a tx from another account: a dig signed by someone else', async () => {
      const { events, room, txs } = honest();
      txs.get(eventNamed(events, 'dig').tx_hash!).transaction.signer_id = 'forger.testnet';
      const { overall, groups } = await verdict(events, fakeChain(room, txs));
      expect(overall).toBe('fail');
      expect(lines(groups, 'fail').some((c) => /signed by forger\.testnet/.test(c.detail ?? ''))).toBe(true);
    });

    it('logs from a receipt that failed', async () => {
      const { events, room, txs } = honest();
      txs.get(eventNamed(events, 'finished').tx_hash!).receipts_outcome[0].outcome.status = { Failure: {} };
      expect((await verdict(events, fakeChain(room, txs))).overall).toBe('fail');
    });

    it('a hash even an archival node has never seen', async () => {
      const { events, room, txs } = honest();
      txs.delete(eventNamed(events, 'locked', 1).tx_hash!);
      const { overall, groups } = await verdict(events, fakeChain(room, txs));
      expect(overall).toBe('fail');
      expect(lines(groups, 'fail').some((c) => /even an archival one/.test(c.detail ?? ''))).toBe(true);
    });

    it('a real transaction, from a different round', async () => {
      const { events, room, txs } = honest();
      editLogs(txs.get(eventNamed(events, 'revealed', 1).tx_hash!), (log) => { log.data.room_id = 99; });
      expect((await verdict(events, fakeChain(room, txs))).overall).toBe('fail');
    });

    it("another room's digs, real on the chain, served as this room's", async () => {
      const { events, room } = honest();
      for (const e of events) if (e.event === 'dig') e.data.room_id = 99;
      expect((await verdict(events, fakeChain(room, txsOf(events)))).overall).toBe('fail');
    });

    it('an invented round, whole and self-consistent, with invented hashes', async () => {
      const room = makeRoom();
      const events = eventsOf(room);
      expect(verifyRound(roomFromEvents(events)!).flatMap((g) => g.checks).some((c) => c.state === 'fail')).toBe(false);
      const { overall } = await verdict(events, fakeChain(room, new Map()));
      expect(overall).toBe('fail');
    });

    it('a block height with a different time on the chain', async () => {
      const { events, room, txs } = honest();
      const reader = fakeChain(room, txs, { block: async (height) => ({ hash: `b${height}`, random_value: '1', timestamp_nanosec: '1000000' }) });
      const { overall, groups } = await verdict(events, reader);
      expect(overall).toBe('fail');
      expect(lines(groups, 'fail').some((c) => /The chain says block/.test(c.detail ?? ''))).toBe(true);
    });

    it('a block height that never was', async () => {
      const { events, room, txs } = honest();
      const { overall } = await verdict(events, fakeChain(room, txs, { block: async () => 'gone' }));
      expect(overall).toBe('fail');
    });

    it('a settlement that credits someone less than the result says', async () => {
      const { events, room, txs } = honest();
      const end = eventNamed(events, 'finished');
      const row = events.find((e) => e.event === 'balance' && e.tx_hash === end.tx_hash)!;
      row.data.changes[0].delta = '1';
      const tx = txsOf(events).get(end.tx_hash!);
      txs.set(end.tx_hash!, tx);
      const { overall, groups } = await verdict(events, fakeChain(room, txs));
      expect(overall).toBe('fail');
      expect(lines(groups, 'fail').map((c) => c.title)).toContain('The chain paid what the result says');
    });

    it('two public nodes disagreeing about a room', async () => {
      const room = makeRoom();
      const other = { ...makeRoom(), name: 'Another story' } as ChainRoom;
      const chain = await verifyOnChain({ source: 'contract', room, links: [] }, fakeChain(room, new Map(), { roomOnEachNode: async () => [room, other] }));
      expect(overallState(chain.groups)).toBe('fail');
    });
  });

  describe("what we couldn't check", () => {
    const unreachable = (room: ChainRoom, txs: Map<string, any>, hash: string) => {
      const chain = fakeChain(room, txs);
      return { ...chain, tx: async (h: string, s: string) => (h === hash ? { unreachable: true as const } : chain.tx(h, s)) };
    };

    it('shows amber, and the headline does not say all passed', async () => {
      const { events, room, txs } = honest();
      const hash = eventNamed(events, 'dig').tx_hash!;
      const { overall, groups } = await verdict(events, unreachable(room, txs, hash));
      expect(overall).toBe('partial');
      expect(lines(groups, 'unchecked')).toHaveLength(1);
      expect(lines(groups, 'unchecked')[0].detail).toContain("Couldn't check");
      const text = headline(overall, groups, 'events');
      expect(text).not.toMatch(/\bAll\b/);
      expect(text).toContain("isn't a full pass");
    });

    it('treats a block nobody could serve the same way', async () => {
      const { events, room, txs } = honest();
      const { overall } = await verdict(events, fakeChain(room, txs, { block: async () => null }));
      expect(overall).toBe('partial');
    });

    it('still goes red if another line is wrong', async () => {
      const { events, room, txs } = honest();
      const hash = eventNamed(events, 'dig').tx_hash!;
      eventNamed(events, 'finished').data.winner = 'forger.testnet';
      expect((await verdict(events, unreachable(room, txs, hash))).overall).toBe('fail');
    });

    it('only asks once per transaction, and passes on the sender the proof gives', async () => {
      const { events, room, txs } = honest();
      const asked: [string, string][] = [];
      eventNamed(events, 'started').sender = 'poker.testnet';
      const chain = fakeChain(room, txs);
      await verdict(events, { ...chain, tx: (hash, sender) => { asked.push([hash, sender]); return chain.tx(hash, sender); } });
      expect(new Set(asked.map(([hash]) => hash)).size).toBe(asked.length);
      expect(asked).toContainEqual([eventNamed(events, 'started').tx_hash!, 'poker.testnet']);
    });
  });

  describe('what the screen claims', () => {
    const room = makeRoom();
    const groups = verifyRound(room);
    const notOurs = /[Nn]othing here (trusts|rests on) our server/;
    const claims = (proof: RoundProof, overall: 'pass' | 'partial' | 'fail') => trustNotes(proof, overall, 'Hash').map((n) => n.text).join(' ');
    const events: RoundProof = { source: 'events', room, events: [], links: [] };
    const contract: RoundProof = { source: 'contract', room, links: [] };

    it('says the contract path never went through our server', () => {
      expect(claims(contract, 'pass')).toMatch(notOurs);
      expect(claims(contract, 'pass')).toMatch(/directly from public NEAR nodes/);
      expect(claims(contract, 'pass')).toMatch(/never through our server/);
    });

    it('says our server supplied the list when it did, and claims independence only if every line checked out', () => {
      expect(claims(events, 'pass')).toMatch(/our server supplied/);
      expect(claims(events, 'pass')).toMatch(notOurs);
      expect(claims(events, 'partial')).not.toMatch(notOurs);
      expect(claims(events, 'fail')).not.toMatch(notOurs);
      expect(claims(events, 'partial')).toMatch(/rest on our server's word/);
    });

    it("states that seeds are only the contract's word, and differ from the block's random value", () => {
      for (const proof of [contract, events]) {
        const text = claims(proof, 'pass');
        expect(text).toMatch(/block seed and each lock seed/);
        expect(text).toMatch(/aren't the block's public random value/);
        expect(text).toMatch(/could replace that code/);
      }
    });

    it('never says all passed unless it was', () => {
      expect(headline('pass', groups, 'contract')).toMatch(/^All \d+ checks passed/);
      expect(headline('fail', groups, 'contract')).not.toMatch(/passed/);
      expect(headline('partial', [{ title: 'x', checks: [{ state: 'pass', title: 'a' }, { state: 'unchecked', title: 'b' }] }], 'events')).toMatch(/^1 checks passed, and 1 line couldn't/);
    });
  });
});
