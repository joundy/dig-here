// Paying for a move when the game balance is short: the wallet attaches the coins, after the player has seen how much.
import { backend } from './backend';
import { openWallet, ui } from './ui.svelte';

/**
 * How much the move should attach: 0 when the balance covers it, or null if they backed out. The playtest has no
 * wallet to approve anything, so it still sends people to its own top-up form.
 */
export function attachFor(what: string, cost: number, perRound: number): Promise<number | null> {
  const short = cost - backend.balanceOf(backend.account);
  if (short <= 0) return Promise.resolve(0);
  if (backend.identity.kind !== 'wallet') {
    openWallet(short);
    return Promise.resolve(null);
  }
  return new Promise((resolve) => {
    ui.topUp = { what, cost, perRound, answer: resolve };
  });
}
