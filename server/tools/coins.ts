// Where every coin is: each account's wallet and game balance, plus what the contract says it owes.
import { viewAccount, viewFunction } from '../rpc.ts';
import { toNear } from '../units.ts';
import { c, config } from './lib.ts';

const fixed = [config.rootAccount, config.oracleAccount, config.runnerAccount, config.botsParent, `treasury.${config.rootAccount}`, c];
const bots = ['vega', 'willow', 'wren', 'yarrow', 'zinnia', 'umber', 'vesper', 'wisp'].map((n) => `${n}.${config.botsParent}`);
let botWallets = 0n;
let botGame = 0n;
for (const id of [...fixed, ...bots]) {
  const [a, g] = await Promise.all([viewAccount(id), id === c ? null : viewFunction<any>(c, 'get_account', { id })]);
  const wallet = BigInt(a?.amount ?? 0);
  const game = BigInt(g?.balance ?? 0);
  if (bots.includes(id)) {
    botWallets += wallet;
    botGame += game;
  }
  console.log(id.padEnd(34), 'wallet', toNear(wallet).padStart(9), 'game', toNear(game).padStart(9));
}
console.log('bots total', toNear(botWallets), 'wallets +', toNear(botGame), 'game');
console.log('contract owes', await viewFunction(c, 'get_totals'));
