// Small decisions about real-chain moves and the host form, kept pure so a test can hold them down.
import { near, percent } from '../format';
import type { BotLimits } from '../backend/types';

const YOCTO_PER_MILLI = 10n ** 21n;
/** A first credit pays for the player's record out of itself: 0.00146 NEAR at most, by the gas doc. */
const RECORD_MILLI = 2;

/**
 * What a wallet attaches to `buy_nft`: the yocto the contract demands, plus what the game balance is short of.
 * With no balance there may be no record yet, and its cost would come out of the top-up.
 */
export function buyDeposit(price: number, balance: number): string {
  const short = Math.max(0, price - balance) + (balance === 0 ? RECORD_MILLI : 0);
  return (1n + BigInt(short) * YOCTO_PER_MILLI).toString();
}

/** From `/api/health`. Anything not understood means no line on the form rather than a wrong one. */
export function botLimitsFrom(health: Record<string, unknown>): BotLimits | null {
  const raw = health.bot_join_limits as { max_fee_milli?: unknown; max_host_cut_bps?: unknown } | null | undefined;
  if (health.bots_enabled === false || !raw) return null;
  const { max_fee_milli: maxFee, max_host_cut_bps: maxHostCutBps } = raw;
  return typeof maxFee === 'number' && typeof maxHostCutBps === 'number' ? { maxFee, maxHostCutBps } : null;
}

export function botLimitNote(limits: BotLimits | null, fee: number, hostCutBps: number): string | null {
  if (!limits || (fee <= limits.maxFee && hostCutBps <= limits.maxHostCutBps)) return null;
  return `Bots only join rooms up to ${near(limits.maxFee)} with a ${percent(limits.maxHostCutBps)} cut, so you'd wait for real players.`;
}

/** The form's starting point: the usual choice, or the nearest one bots would still join. */
export function defaultsWithin(limits: BotLimits | null, feeChoices: readonly number[] | null, fee: number, cutPercent: number) {
  if (!limits) return { fee, cutPercent };
  const within = feeChoices?.filter((choice) => choice <= limits.maxFee) ?? [];
  return {
    fee: fee <= limits.maxFee ? fee : (within[within.length - 1] ?? limits.maxFee),
    cutPercent: Math.min(cutPercent, Math.floor(limits.maxHostCutBps / 100)),
  };
}
