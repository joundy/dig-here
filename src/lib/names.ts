// How accounts read on screen. Bots have long, samey names that say nothing to a player.
import { BOT_SUFFIX } from './near/config';

export const isBot = (account: string) => account.endsWith(BOT_SUFFIX);

export function shortName(account: string): string {
  if (isBot(account)) return account.slice(0, -BOT_SUFFIX.length);
  return account;
}
