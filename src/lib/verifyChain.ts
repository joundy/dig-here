// "Verify this round", the part that goes to the chain. This is what makes it worth anything: without it the
// browser only knows that a story is consistent, and whoever serves the numbers can write a consistent story.
import { fromBase58ToHex } from './base58';
import { ARCHIVE_HOSTS, CONTRACT, READ_HOSTS } from './near/config';
import type { ChainRoom } from './near/rooms';
import type { Check, CheckGroup, OverallState } from './verify';

export type ProofEvent = {
  event: string;
  standard?: string;
  tx_hash?: string;
  /** Not there yet on every backend, and today's public nodes don't check it. What counts is what comes back. */
  sender?: string;
  data: any;
};
export type TxLink = { label: string; hash: string };

/** Where a round's numbers came from decides what has to be proved about them. */
export type RoundProof =
  | { source: 'contract'; room: ChainRoom; links: TxLink[] }
  | { source: 'events'; room: ChainRoom; events: ProofEvent[]; links: TxLink[] };

/**
 * `gone` is only said by an archival node: those keep everything, so a hash they don't know never existed.
 * `unreachable` is every other way of not finding out, including an ordinary node that has pruned it.
 */
export type TxLookup = { found: any } | { gone: true } | { unreachable: true };
export type BlockRead = { hash: string; random_value: string; timestamp_nanosec: string };

/** Everything this file asks the outside world. Only public nodes stand behind it, never our backend. */
export type ChainReader = {
  tx(hash: string, sender: string): Promise<TxLookup>;
  /** `gone` means an archival node says that height has no block. Null means nobody could say. */
  block(height: number): Promise<BlockRead | 'gone' | null>;
  /** `get_room` from each public node separately, null where it didn't answer. */
  roomOnEachNode(id: number): Promise<(ChainRoom | null)[]>;
  codeHash(): Promise<string | null>;
};

export type BlockLine = { label: string; height: number; hash: string | null };
export type RandomLine = { step: number; height: number; randomValue: string; lockSeed: string; same: boolean };
export type ChainFindings = { groups: CheckGroup[]; blocks: BlockLine[]; randoms: RandomLine[]; codeHash: string | null };

/** Rebuilding a round needs these, so each one has to be on the chain. */
const KEY_EVENTS = new Set(['room_created', 'started', 'dig', 'locked', 'revealed', 'finished', 'refunded']);
const YOCTO_PER_MILLI = 10n ** 21n;

function canonical(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonical);
  if (value && typeof value === 'object') {
    const record = value as Record<string, unknown>;
    return Object.fromEntries(Object.keys(record).sort().map((k) => [k, canonical(record[k])]));
  }
  return value;
}
const sameJson = (a: unknown, b: unknown) => JSON.stringify(canonical(a)) === JSON.stringify(canonical(b));

function eventLabel(e: ProofEvent): string {
  switch (e.event) {
    case 'room_created': return 'Room created';
    case 'started': return 'Round started';
    case 'dig': return `${e.data?.account}'s dig`;
    case 'locked': return `Step ${e.data?.step} locked`;
    case 'revealed': return `Step ${e.data?.step} revealed`;
    case 'finished': return 'Settled';
    case 'refunded': return 'Refunded';
    case 'balance': return 'Payouts';
    default: return e.event;
  }
}

/** Who must have signed, for the events that speak for an account. Pokes and reveals may come from anyone. */
function requiredSigner(e: ProofEvent): string | null {
  if (e.event === 'dig') return e.data?.account ?? null;
  if (e.event === 'room_created') return e.data?.host ?? null;
  return null;
}

/** Only worth anything as a routing hint, since the answer is checked. The oracle sends what anyone else doesn't. */
const senderHint = (e: ProofEvent) => e.sender ?? requiredSigner(e) ?? 'oracle.dighere.testnet';

/** Only logs from a receipt our contract ran, and that didn't fail, can speak for it. Anyone can write the same words. */
function contractLogs(raw: any): { standard?: string; event?: string; data?: unknown }[] {
  const out: { standard?: string; event?: string; data?: unknown }[] = [];
  for (const receipt of raw?.receipts_outcome ?? []) {
    const outcome = receipt?.outcome;
    if (outcome?.executor_id !== CONTRACT || 'Failure' in (outcome?.status ?? {})) continue;
    for (const line of outcome.logs ?? []) {
      if (!String(line).startsWith('EVENT_JSON:')) continue;
      try {
        out.push(JSON.parse(String(line).slice('EVENT_JSON:'.length)));
      } catch {
        // Not an event, whatever it says it is.
      }
    }
  }
  return out;
}

function eventAgainstTx(e: ProofEvent, hash: string, raw: any): Check {
  const title = eventLabel(e);
  const fail = (detail: string): Check => ({ state: 'fail', title, detail });
  const tx = raw?.transaction;
  if (tx?.hash !== hash) return fail(`The node answered about a different transaction, ${tx?.hash ?? 'or none'}.`);
  if (tx.receiver_id !== CONTRACT) return fail(`Transaction ${hash} was sent to ${tx.receiver_id}, not our contract.`);
  const signer = requiredSigner(e);
  if (signer && tx.signer_id !== signer) return fail(`Transaction ${hash} was signed by ${tx.signer_id}, not ${signer}.`);
  const wanted = e.standard ?? 'dig-here';
  const matches = contractLogs(raw).some((log) => log.standard === wanted && log.event === e.event && sameJson(log.data, e.data));
  if (!matches) return fail(`The logs of transaction ${hash} don't say what our server said.`);
  return { state: 'pass', title, detail: `Found on chain, sent to our contract${signer ? ` by ${signer}` : ''}, and the logs match.` };
}

/** One of each, all about this room. A real chain can't hold two endings, so a list that does has been edited. */
function shapeChecks(events: ProofEvent[], roomId: number): Check[] {
  const title = "The event list is about this room, with nothing doubled";
  const keys = events.filter((e) => KEY_EVENTS.has(e.event));
  const bad: string[] = [];
  if (keys.some((e) => e.data?.room_id !== roomId)) bad.push('some events are from another room');
  const seen = new Set<string>();
  for (const e of keys) {
    const key = e.event === 'dig' ? `dig:${e.data?.account}` : e.event === 'locked' || e.event === 'revealed' ? `${e.event}:${e.data?.step}` : e.event === 'refunded' ? 'finished' : e.event;
    if (seen.has(key)) bad.push(`${eventLabel(e)} appears twice, or the round ends twice`);
    seen.add(key);
  }
  return [{ state: bad.length ? 'fail' : 'pass', title, detail: bad.length ? `${bad.join('; ')}.` : undefined }];
}

/** The settlement's own balance rows, in the same transaction, must pay what the result says. */
function payoutChecks(events: ProofEvent[], room: ChainRoom): Check[] {
  const end = events.find((e) => e.event === 'finished' || e.event === 'refunded');
  const result = room.result;
  if (!end || !result) return [];
  const title = room.status === 'refunded' ? 'The chain paid everyone back' : 'The chain paid what the result says';
  const paid = new Map<string, bigint>();
  for (const row of events.filter((e) => e.event === 'balance' && e.tx_hash === end.tx_hash)) {
    for (const change of row.data?.changes ?? []) {
      const key = `${change.account}|${change.reason}`;
      paid.set(key, (paid.get(key) ?? 0n) + BigInt(change.delta));
    }
  }
  const wants: [string, string, number][] = [];
  if (room.status === 'refunded') {
    for (const player of room.players) wants.push([player, 'refund', room.fee]);
  } else {
    if (result.winner && result.split) wants.push([result.winner, 'prize', result.split.prize]);
    if (result.split?.host_cut) wants.push([room.host, 'host_cut', result.split.host_cut]);
    if (result.deed_owner && result.split?.deed) wants.push([result.deed_owner, 'deed_share', result.split.deed]);
    if (result.jackpot_win) wants.push([result.jackpot_win.account, 'jackpot', result.jackpot_win.amount]);
  }
  const short = wants.filter(([account, reason, milli]) => (paid.get(`${account}|${reason}`) ?? 0n) !== BigInt(milli) * YOCTO_PER_MILLI);
  return [{
    state: short.length ? 'fail' : 'pass',
    title,
    detail: short.length ? short.map(([account, reason]) => `${account}: ${reason.replace('_', ' ')} doesn't match`).join('; ') : `${wants.length} ${wants.length === 1 ? 'payment' : 'payments'} checked.`,
  }];
}

async function transactionChecks(events: ProofEvent[], reader: ChainReader, onProgress: (done: number, total: number) => void): Promise<Check[]> {
  const end = events.find((e) => e.event === 'finished' || e.event === 'refunded');
  const worth = (e: ProofEvent) => KEY_EVENTS.has(e.event) || (e.event === 'balance' && !!end && e.tx_hash === end.tx_hash);
  const wanted = events.filter(worth);
  const hashes = [...new Set(wanted.flatMap((e) => (e.tx_hash ? [e.tx_hash] : [])))];
  const lookups = new Map<string, TxLookup>();
  let done = 0;
  for (const hash of hashes) {
    onProgress(done++, hashes.length);
    const first = wanted.find((e) => e.tx_hash === hash)!;
    lookups.set(hash, await reader.tx(hash, senderHint(first)).catch((): TxLookup => ({ unreachable: true })));
  }
  onProgress(hashes.length, hashes.length);
  return wanted.map((e): Check => {
    const title = eventLabel(e);
    if (!e.tx_hash) return { state: 'fail', title, detail: 'Our server gave no transaction for this.' };
    const lookup = lookups.get(e.tx_hash)!;
    if ('gone' in lookup) return { state: 'fail', title, detail: `No node, even an archival one, knows transaction ${e.tx_hash}.` };
    if ('unreachable' in lookup) return { state: 'unchecked', title, detail: "Couldn't check: no public node would serve this transaction just now, so this line rests on our server's word." };
    return eventAgainstTx(e, e.tx_hash, lookup.found);
  });
}

/** `lock_ms` and friends are the block's own time, so a made-up height or a made-up time shows up here. */
async function blockChecks(room: ChainRoom, reader: ChainReader) {
  const wanted: { label: string; height: number; ms: number | null; step?: number; lockSeed?: string | null }[] = [];
  if (room.created_height) wanted.push({ label: 'Room created', height: room.created_height, ms: room.created_ms });
  for (const roll of room.rolls ?? []) {
    if (roll.lock_height) wanted.push({ label: `Step ${roll.step} locked`, height: roll.lock_height, ms: roll.lock_ms, step: roll.step, lockSeed: roll.lock_seed });
    if (roll.reveal_height) wanted.push({ label: `Step ${roll.step} revealed`, height: roll.reveal_height, ms: roll.reveal_ms });
  }
  const checks: Check[] = [];
  const blocks: BlockLine[] = [];
  const randoms: RandomLine[] = [];
  for (const want of wanted) {
    const header = await reader.block(want.height).catch(() => null);
    const title = `${want.label}: block ${want.height} exists at the time the round says`;
    blocks.push({ label: want.label, height: want.height, hash: header && header !== 'gone' ? header.hash : null });
    if (header === 'gone') {
      checks.push({ state: 'fail', title, detail: `No node, even an archival one, has a block at height ${want.height}.` });
    } else if (!header) {
      checks.push({ state: 'unchecked', title, detail: "Couldn't check: no public node would serve that block just now." });
    } else {
      const chainMs = Number(BigInt(header.timestamp_nanosec) / 1_000_000n);
      checks.push(chainMs === want.ms ? { state: 'pass', title } : { state: 'fail', title, detail: `The chain says block ${want.height} was at ${chainMs}, the round says ${want.ms}.` });
      if (want.step !== undefined && want.lockSeed) {
        const randomValue = fromBase58ToHex(header.random_value);
        randoms.push({ step: want.step, height: want.height, randomValue, lockSeed: want.lockSeed, same: randomValue === want.lockSeed });
      }
    }
  }
  return { checks, blocks, randoms };
}

/** Two providers agreeing is much harder to fake than one. One alone isn't a failure, just less to go on. */
async function nodesAgreeChecks(room: ChainRoom, reader: ChainReader): Promise<Check[]> {
  const title = 'Two public nodes gave the same round';
  const answers = (await reader.roomOnEachNode(room.room_id).catch((): (ChainRoom | null)[] => [])).filter((r): r is ChainRoom => r !== null);
  if (answers.length < 2) return [{ state: 'note', title: 'Only one public node answered, so there was no second opinion' }];
  const ended = answers.every((r) => r.status === 'finished' || r.status === 'refunded');
  if (!ended) return [{ state: 'note', title: "A second public node hadn't caught up with this round's end yet, so there was no second opinion" }];
  const agree = answers.every((r) => sameJson(r, room));
  return [{ state: agree ? 'pass' : 'fail', title, detail: agree ? undefined : "They disagree, so at least one isn't telling the truth." }];
}

export async function verifyOnChain(proof: RoundProof, reader: ChainReader, onProgress: (done: number, total: number) => void = () => {}): Promise<ChainFindings> {
  const groups: CheckGroup[] = [];
  if (proof.source === 'contract') {
    groups.push({ title: 'Where this came from', checks: await nodesAgreeChecks(proof.room, reader) });
  } else {
    const checks = await transactionChecks(proof.events, reader, onProgress);
    groups.push({ title: 'Transactions on the chain', checks: [...shapeChecks(proof.events, proof.room.room_id), ...checks] });
    // Credits only mean something once the rows they read are matched to the chain, which the lines above do.
    const payouts = payoutChecks(proof.events, proof.room);
    if (payouts.length) groups.push({ title: 'Payouts', checks: payouts });
  }
  const { checks, blocks, randoms } = await blockChecks(proof.room, reader);
  if (checks.length) groups.push({ title: 'Blocks', checks });
  return { groups, blocks, randoms, codeHash: await reader.codeHash().catch(() => null) };
}

/** The headline. It may only claim what was actually done, so it's written here where a test can hold it to that. */
export function headline(overall: OverallState, groups: CheckGroup[], source: RoundProof['source']): string {
  const count = (state: Check['state']) => groups.reduce((sum, g) => sum + g.checks.filter((c) => c.state === state).length, 0);
  if (overall === 'fail') return "Something doesn't add up. See the red lines below.";
  if (overall === 'partial') {
    const left = count('unchecked');
    return `${count('pass')} checks passed, and ${left} ${left === 1 ? 'line' : 'lines'} couldn't be checked. This isn't a full pass: see the amber ${left === 1 ? 'line' : 'lines'} below.`;
  }
  return source === 'contract'
    ? `All ${count('pass')} checks passed. Your browser read this round straight from the contract, redid it, and got the same answers.`
    : `All ${count('pass')} checks passed. Your browser found every transaction on the chain, redid the round, and got the same answers.`;
}

export type TrustNote = { who: string; text: string };

/** Who vouches for what, in plain words. "Nothing rests on our server" appears only when that's so. */
export function trustNotes(proof: RoundProof, overall: OverallState, codeHash: string | null): TrustNote[] {
  const nodes = READ_HOSTS.join(' and ');
  const notes: TrustNote[] = [
    { who: 'Your browser', text: 'Redid the map, every roll and clue, the treasure, the scores and the pot split, using the same rules the contract is tested against.' },
  ];
  if (proof.source === 'contract') {
    notes.push({ who: 'The chain', text: `This round was read with get_room directly from public NEAR nodes (${nodes}), never through our server. Nothing here trusts our server. You are trusting those nodes to report the contract honestly, which is why they're compared.` });
  } else {
    const tail = overall === 'pass'
      ? 'Every line checked out, so nothing here rests on our server\'s word.'
      : overall === 'partial'
        ? "Until a node will serve them, the amber lines rest on our server's word."
        : 'Red lines mean what our server said and what the chain says differ.';
    notes.push({ who: 'The chain', text: `The contract only keeps its last 30 rooms, and this one has gone. So our server supplied the list of events and their transaction hashes, then your browser looked up each transaction on public NEAR nodes (${[...READ_HOSTS, ...ARCHIVE_HOSTS].join(', ')}) and compared its logs. ${tail}` });
  }
  notes.push({
    who: "Only the contract's word",
    text: "The room's block seed and each lock seed. The contract took them from the network's randomness as it ran, and nothing outside can recompute them. They aren't the block's public random value: NEAR hands a contract its own value for each call, so a block's value can't confirm a seed. It's shown below only so you can see the difference.",
  });
  notes.push({
    who: "The contract's code",
    text: `${codeHash ? `Its code hash on the chain is ${codeHash}. ` : ''}This is testnet, and whoever deployed it still holds a key that could replace that code. Every line above assumes the code is the one we published. That key goes before mainnet.`,
  });
  return notes;
}
