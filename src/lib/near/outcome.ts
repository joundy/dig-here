// Reads what the network says happened to a transaction.
export type ChainEvent = { standard: string; event: string; data: any };

export type Outcome = {
  hash: string;
  /** The JSON the method returned, or null if it returned nothing. */
  value: unknown;
  /** The raw failure if the call failed. */
  failure: string | null;
  events: ChainEvent[];
  blockHash: string | null;
};

const fromBase64 = (text: string) => new TextDecoder().decode(Uint8Array.from(atob(text), (c) => c.charCodeAt(0)));

/** True once the transaction has a final answer, rather than just being known to the network. */
export function isDone(raw: any): boolean {
  const status = raw?.status;
  return !!status && typeof status === 'object' && ('SuccessValue' in status || 'Failure' in status);
}

export function readOutcome(raw: any): Outcome {
  const logs: string[] = [raw.transaction_outcome?.outcome?.logs ?? [], ...(raw.receipts_outcome ?? []).map((r: any) => r.outcome?.logs ?? [])].flat();
  const events: ChainEvent[] = [];
  for (const line of logs) {
    if (!line.startsWith('EVENT_JSON:')) continue;
    try {
      events.push(JSON.parse(line.slice('EVENT_JSON:'.length)));
    } catch {
      // Another contract's log shape can't be allowed to break reading our own.
    }
  }
  const status = raw.status ?? {};
  let value: unknown = null;
  if (typeof status.SuccessValue === 'string' && status.SuccessValue) {
    try {
      value = JSON.parse(fromBase64(status.SuccessValue));
    } catch {
      value = null;
    }
  }
  return {
    hash: raw.transaction?.hash ?? raw.transaction_outcome?.id ?? '',
    value,
    failure: status.Failure ? JSON.stringify(status.Failure) : null,
    events,
    blockHash: raw.transaction_outcome?.block_hash ?? null,
  };
}

/** A `balance` event carries the account's new total, so a move's result updates the header with no extra read. */
export function balanceFromEvents(events: ChainEvent[], account: string): bigint | null {
  let found: bigint | null = null;
  for (const event of events) {
    if (event.event !== 'balance') continue;
    for (const change of event.data?.changes ?? []) {
      if (change.account === account) found = BigInt(change.balance);
    }
  }
  return found;
}
