import { log } from './log.ts';
import { toNear } from './units.ts';

const totals = new Map<string, { burnt: bigint; txs: number }>();
const startedMs = Date.now();

/** Counts what each role really burned, from the receipts, so the coin rate in the notes is measured. */
export function addBurn(role: string, yocto: bigint): void {
  const entry = totals.get(role) ?? { burnt: 0n, txs: 0 };
  entry.burnt += yocto;
  entry.txs++;
  totals.set(role, entry);
}

export function burnReport() {
  const hours = (Date.now() - startedMs) / 3_600_000;
  const roles: Record<string, { near: string; txs: number; near_per_hour: string }> = {};
  for (const [role, { burnt, txs }] of totals) {
    const perHour = hours > 0 ? (burnt * 3_600_000n) / BigInt(Math.max(1, Date.now() - startedMs)) : 0n;
    roles[role] = { near: toNear(burnt, 5), txs, near_per_hour: toNear(perHour, 5) };
  }
  return { since_minutes: Math.round(hours * 60), roles };
}

export function startBurnLog(intervalMs = 600_000): void {
  setInterval(() => log('burn', 'gas burned since start', burnReport()), intervalMs).unref();
}
