// Small decisions about real-chain moves and the host form, kept pure so a test can hold them down.
import { near, percent } from '../format';
import type { BotLimits } from '../backend/types';

const YOCTO_PER_MILLI = 10n ** 21n;
/** A first credit pays for the player's record out of itself: 0.00146 NEAR at most, by the gas doc. */
export const RECORD_MILLI = 2;
/** A top-up choice leaves at least this in the wallet, for gas and whatever else they use it for. */
const WALLET_KEEP_MILLI = 100;
/** Below this left over, the wallet couldn't pay the gas for the moves that follow. */
const WALLET_MIN_LEFT_MILLI = 20;
const TOP_UP_ROUNDS = [5, 20];

/** Testnet names end in `.testnet`. Implicit accounts are 64 hex characters, and exist on every network. */
export function isTestnetAccount(account: string): boolean {
  return account.endsWith('.testnet') || /^[0-9a-f]{64}$/.test(account);
}

/** What the account could actually send, in milliNEAR. Storage past the free 770 bytes has to stay put. */
export function spendable(account: { amount: string; storage_usage: number }): number {
  const locked = BigInt(Math.max(0, account.storage_usage - 770)) * 10n ** 19n;
  const free = BigInt(account.amount) - locked;
  return free > 0n ? Number(free / YOCTO_PER_MILLI) : 0;
}

export type TopUpChoice = { extra: number; rounds: number; total: number; left: number };
export type TopUpPlan = { short: number; setup: number; choices: TopUpChoice[]; picked: number };

/**
 * What a wallet could attach to pay for a move, never more than leaves it able to carry on. No choices means it
 * can't afford this at all. `perRound` is the entry fee the extra is counted in, so the offer reads as games.
 */
export function topUpPlan(cost: number, balance: number, wallet: number, setup: number, perRound: number): TopUpPlan {
  const short = Math.max(0, cost - balance) + setup;
  const choices: TopUpChoice[] = [];
  if (wallet - short >= WALLET_MIN_LEFT_MILLI) choices.push({ extra: 0, rounds: 0, total: short, left: wallet - short });
  for (const rounds of TOP_UP_ROUNDS) {
    const extra = rounds * perRound;
    if (wallet - short - extra >= WALLET_KEEP_MILLI) choices.push({ extra, rounds, total: short + extra, left: wallet - short - extra });
  }
  return { short, setup, choices, picked: Math.min(1, choices.length - 1) };
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
