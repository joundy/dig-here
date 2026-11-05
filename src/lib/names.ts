// How accounts read on screen. Guests and bots have long, samey names that say nothing to a player.
import { BOT_SUFFIX, GUEST_SUFFIX } from './near/config';

export const isBot = (account: string) => account.endsWith(BOT_SUFFIX);
export const isGuest = (account: string) => account.endsWith(GUEST_SUFFIX);

export function shortName(account: string): string {
  if (isBot(account)) return account.slice(0, -BOT_SUFFIX.length);
  if (isGuest(account)) return `guest ${account.slice(0, -GUEST_SUFFIX.length).replace(/^g-/, '')}`;
  return account;
}
