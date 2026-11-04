// A stand-in chain that lives in one browser tab: fake wallets, fake money, bot players.
import * as economy from '../game/economy';
import type { Ledger } from '../game/economy';
import { advance, finishAt, isCrowded, isOpen, placeDig, secondsToNextClue, startGame } from '../game/engine';
import { getMap, isLand, MAP_IDS, mathRng } from '../game/map';
import { RULES } from '../game/rules';
import { GameError } from '../game/types';
import type { Game, NewGameInput, Point } from '../game/types';
import type { GameBackend } from './types';

const STORAGE_KEY = 'dig-here-dummy-v2';
const TICK_MS = 250;
const MAX_FINISHED = 40;

export const PLAYABLE_ACCOUNTS = ['you.near', 'friend.near', 'rival.near'];
const STARTING_WALLET = 50_000;

const BOT_NAMES = [
  'salty.near', 'mabel.near', 'shovel_guy.near', 'goose.near', 'dr_dig.near', 'nana.near', 'lucky_kev.near', 'mudlark.near',
  'barnacle.near', 'tilda.near', 'hole_in_one.near', 'ferris.near', 'pickaxe_pam.near', 'dune_buggy.near', 'frostbite.near',
  'sir_digs_a_lot.near', 'marigold.near', 'old_pete.near', 'captain_crab.near', 'wobble.near', 'tinpot.near', 'gritty.near',
  'bumble.near', 'orla.near', 'snowdrift.near', 'cactus_jack.near', 'pebble.near', 'moss.near', 'quill.near', 'yarrow.near',
];
const HOST_NAMES = ['captain.near', 'goose.near', 'mabel.near', 'old_pete.near', 'tilda.near', 'dr_dig.near', 'marigold.near', 'orla.near'];
const SPAM_HOSTS = ['free_money_4u.near', 'click_me_now.near', 'aaaaaaaaaaaa.near'];
const ROOM_NAMES = [
  'Lunch money', 'Big digs', 'Horse whisperers', 'High rollers only', 'Shovel Sunday', 'Quick hole', 'Sand in my socks', 'X marks my mum',
  'Ducks welcome', 'Coin toss', 'No crying', 'Treasure taxi', 'Bring a spade', 'Friendly dig', 'Dig or die', 'The usual',
  'Pocket change', 'Mud club', 'Hot shovels', 'Late night dig',
];
const SPAM_NAMES = ['FREE NEAR CLICK', 'aaaaaaa', 'test123', '$$$ WIN BIG $$$', 'asdfgh', 'best game real'];

type BotPlan = { account: string; joinAfter: number; digPct: number; slop: number; joined: boolean; dug: boolean };
type RoomBots = { plans: BotPlan[]; /** A bot host presses Start after this long, once the room can. */ hostStartAfter: number | null };

type Persisted = {
  account: string;
  ledger: Ledger;
  games: Game[];
  bots: Record<string, RoomBots>;
  nextId: number;
};

const pickFrom = <T>(items: readonly T[]) => items[mathRng(items.length)];

function shuffled<T>(items: readonly T[]): T[] {
  const copy = [...items];
  for (let i = copy.length - 1; i > 0; i--) {
    const j = mathRng(i + 1);
    [copy[i], copy[j]] = [copy[j], copy[i]];
  }
  return copy;
}

function load(): Persisted | null {
  try {
    const saved = localStorage.getItem(STORAGE_KEY);
    return saved ? JSON.parse(saved) : null;
  } catch {
    return null;
  }
}

function freshAccounts(ledger: Ledger): void {
  for (const account of PLAYABLE_ACCOUNTS) ledger.wallets[account] = STARTING_WALLET;
}

// A mix of early gamblers and late, careful players, so the bonus trade-off shows up in play.
function botDigPct(): number {
  const style = Math.random();
  if (style < 0.18) return 3 + Math.random() * 24;
  if (style < 0.5) return 32 + Math.random() * 26;
  if (style < 0.84) return 62 + Math.random() * 21;
  return 86 + Math.random() * 11;
}

function planBots(count: number, exclude: string | null, joinGap: number): BotPlan[] {
  let joinAfter = 1 + Math.random() * joinGap;
  return shuffled(BOT_NAMES.filter((n) => n !== exclude)).slice(0, count).map((account) => {
    const plan = { account, joinAfter, digPct: botDigPct(), slop: 1 + mathRng(12), joined: false, dug: false };
    joinAfter += 1 + Math.random() * joinGap;
    return plan;
  });
}

class DummyBackend implements GameBackend {
  #state = $state<Persisted>(load() ?? this.#fresh());
  speed = $state(1);

  constructor() {
    if (this.#state.games.length === 0) this.#seed();
    setInterval(() => this.#tick(TICK_MS / 1000), TICK_MS);
    setInterval(() => this.#save(), 2000);
  }

  #fresh(): Persisted {
    const ledger = economy.newLedger(Date.now());
    freshAccounts(ledger);
    return { account: PLAYABLE_ACCOUNTS[0], ledger, games: [], bots: {}, nextId: 1 };
  }

  get account() { return this.#state.account; }
  get games() { return this.#state.games; }
  get jackpot() { return this.#state.ledger.jackpot; }
  get season() { return this.#state.ledger.season; }

  walletOf(account: string) { return economy.walletOf(this.#state.ledger, account); }
  balanceOf(account: string) { return economy.balanceOf(this.#state.ledger, account); }
  hostRecord(account: string) { return economy.hostRecord(this.#state.ledger, account); }
  deedOf(id: string) { return economy.deedOf(this.#state.ledger, id); }
  seasonRanking() { return economy.seasonRanking(this.#state.ledger); }

  // Whoever signed is fixed at the moment of the click, as with a real wallet.
  async #tx<T>(action: (account: string) => T): Promise<T> {
    const account = this.account;
    await new Promise((resolve) => setTimeout(resolve, 300 + Math.random() * 1200));
    const result = action(account);
    this.#save();
    return result;
  }

  deposit(amount: number) { return this.#tx((a) => economy.deposit(this.#state.ledger, a, amount)); }
  withdraw(amount: number) { return this.#tx((a) => economy.withdraw(this.#state.ledger, a, amount)); }

  createGame(input: Omit<NewGameInput, 'host'>) {
    return this.#tx((host) => {
      const id = this.#open({ ...input, host });
      // Other players turn up in a hosted room, so a playtest doesn't wait alone.
      const count = Math.min(input.maxPlayers - 1, input.minPlayers + mathRng(5));
      this.#state.bots[id] = { plans: planBots(count, host, 5), hostStartAfter: null };
      return id;
    });
  }

  join(gameId: string) { return this.#tx((a) => economy.joinRoom(this.#state.ledger, this.#find(gameId), a)); }
  leave(gameId: string) { return this.#tx((a) => economy.leaveRoom(this.#state.ledger, this.#find(gameId), a)); }
  start(gameId: string) { return this.#tx((a) => startGame(this.#find(gameId), a, mathRng)); }

  dig(gameId: string, spot: Point, seenClue: number) {
    return this.#tx((a) => { placeDig(this.#find(gameId), a, spot, seenClue); });
  }

  buyDeed(id: string, seenPrice: number) { return this.#tx((a) => economy.buyDeed(this.#state.ledger, a, id, seenPrice)); }
  listDeed(id: string, price: number | null) { return this.#tx((a) => economy.listDeed(this.#state.ledger, a, id, price)); }

  // Playtest controls. These exist only on the dummy and aren't part of GameBackend.

  switchAccount(account: string) {
    this.#state.account = account;
    this.#save();
  }

  /** Brings a waiting room up to its minimum with bots. */
  fillRoom(gameId: string) {
    const game = this.#find(gameId);
    if (game.stage !== 'waiting') return;
    const needed = Math.max(1, game.minPlayers - game.players.length);
    const room = (this.#state.bots[gameId] ??= { plans: [], hostStartAfter: null });
    const taken = new Set([...game.players, ...room.plans.map((p) => p.account)]);
    const extra = shuffled(BOT_NAMES.filter((n) => !taken.has(n))).slice(0, needed);
    room.plans.push(...extra.map((account) => ({ account, joinAfter: 0, digPct: botDigPct(), slop: 1 + mathRng(12), joined: false, dug: false })));
    for (const plan of room.plans.filter((p) => !p.joined).slice(0, needed)) this.#botJoin(game, plan);
  }

  startNow(gameId: string) {
    const game = this.#find(gameId);
    if (game.stage !== 'waiting') return;
    if (game.players.length < game.minPlayers) this.fillRoom(gameId);
    startGame(game, game.host, mathRng);
  }

  skipToNextClue(gameId: string) {
    const game = this.#find(gameId);
    if (game.stage !== 'live') return this.startNow(gameId);
    const wait = secondsToNextClue(game);
    this.#advanceGame(game, wait === null ? game.durationSec - game.elapsed : Math.max(wait, 0.01));
  }

  endNow(gameId: string) {
    const game = this.#find(gameId);
    if (game.stage === 'waiting') this.startNow(gameId);
    this.#advanceGame(game, game.durationSec - game.elapsed);
  }

  /** Ends the round with the treasure on this player's exact pixel, to show off a jackpot win. */
  forceJackpot(gameId: string) {
    const game = this.#find(gameId);
    if (game.stage === 'waiting') this.startNow(gameId);
    if (game.stage !== 'live') return;
    const me = this.account;
    const { landmarks } = getMap(game.mapId);
    if (game.players.includes(me) && !game.digs.some((d) => d.account === me)) {
      const l = landmarks[game.candidateIds[0]];
      placeDig(game, me, { x: l.x, y: l.y });
    }
    this.#botsDigAll(game);
    if (game.digs.length < RULES.minDigs) return;
    const target = game.digs.find((d) => d.account === me) ?? game.digs[0];
    const nearest = game.candidateIds
      .map((id) => ({ id, d: Math.hypot(landmarks[id].x - target.x, landmarks[id].y - target.y) }))
      .sort((a, b) => a.d - b.d)[0].id;
    finishAt(game, { x: target.x, y: target.y, landmarkId: nearest });
    economy.payRoom(this.#state.ledger, game);
    this.#save();
  }

  endSeason() {
    economy.closeSeason(this.#state.ledger, Date.now());
    this.#save();
  }

  reset() {
    this.#state = this.#fresh();
    this.#seed();
    this.#save();
  }

  #find(gameId: string): Game {
    const game = this.#state.games.find((g) => g.id === gameId);
    if (!game) throw new GameError('That game no longer exists.');
    return game;
  }

  #open(input: NewGameInput): string {
    const id = String(this.#state.nextId++);
    const game = economy.openRoom(this.#state.ledger, this.#state.games, id, input);
    this.#state.games.unshift(game);
    return this.#state.games[0].id;
  }

  /** Bots always have enough, so their rooms never stall. Only the dummy can create coins like this. */
  #fundBot(account: string, need: number) {
    const { ledger } = this.#state;
    if (economy.balanceOf(ledger, account) >= need) return;
    ledger.wallets[account] = economy.walletOf(ledger, account) + need + 20_000;
    economy.deposit(ledger, account, need + 20_000);
  }

  #botHostRoom(spam: boolean) {
    const { games } = this.#state;
    const hosts = spam ? SPAM_HOSTS : HOST_NAMES;
    const free = hosts.filter((h) => games.filter((g) => g.host === h && isOpen(g)).length < RULES.maxOpenRoomsPerHost);
    if (!free.length) return;
    const host = pickFrom(free);
    const mapId = pickFrom(MAP_IDS);
    this.#fundBot(host, RULES.hostBond);

    if (spam) {
      const id = this.#open({
        name: pickFrom(SPAM_NAMES), host, mapId, fee: pickFrom([1, 10, 9000]), durationSec: 600, hostCutBps: RULES.maxHostCutBps,
        minPlayers: 20, maxPlayers: 30, countdownSec: 0,
      });
      this.#state.bots[id] = { plans: [], hostStartAfter: null };
      return;
    }

    const minPlayers = 2 + mathRng(4);
    const maxPlayers = minPlayers + 2 + mathRng(12);
    const countdownSec = pickFrom(RULES.countdownChoices);
    const id = this.#open({
      name: pickFrom(ROOM_NAMES), host, mapId, fee: pickFrom([100, 250, 500, 1000, 1000, 2000, 5000]),
      durationSec: pickFrom(RULES.timerChoices.slice(0, 3)), hostCutBps: pickFrom([0, 200, 500, 500, 1000, 1500]),
      minPlayers, maxPlayers, countdownSec,
    });
    const count = Math.min(maxPlayers, minPlayers + mathRng(maxPlayers - minPlayers + 1));
    this.#state.bots[id] = {
      plans: planBots(count, null, 3 + Math.random() * 18),
      hostStartAfter: countdownSec === 0 ? 20 + Math.random() * 60 : null,
    };
  }

  #seed() {
    const { ledger, games } = this.#state;
    for (const host of HOST_NAMES) ledger.hosts[host] = { finished: 4 + mathRng(40), expired: mathRng(2) };
    for (const host of SPAM_HOSTS) ledger.hosts[host] = { finished: 0, expired: 3 + mathRng(10) };

    // Bots own about a third of the deeds, which is also what fills the jackpot at the start.
    for (const mapId of MAP_IDS) {
      for (const kind of economy.deedKinds(mapId)) {
        if (Math.random() < 0.34) this.#botBuyDeed(economy.deedId(mapId, kind));
      }
    }

    // Some finished rounds, for the Finished tab and the season table.
    for (let i = 0; i < 8; i++) {
      this.#botHostRoom(false);
      const game = games[0];
      this.#fastForward(game, 1);
    }
    // Rooms at every stage, so the board looks busy from the first second.
    for (let i = 0; i < 7; i++) {
      this.#botHostRoom(false);
      this.#fastForward(games[0], 0.1 + Math.random() * 0.7);
    }
    for (let i = 0; i < 9; i++) {
      this.#botHostRoom(false);
      this.#advanceGame(games[0], Math.random() * 25);
    }
    for (let i = 0; i < 4; i++) this.#botHostRoom(true);
  }

  /** A bot buys a deed if it can, and sometimes lists it straight away for more than it paid. */
  #botBuyDeed(id: string) {
    const { ledger } = this.#state;
    const buyer = pickFrom(BOT_NAMES);
    const deed = economy.deedOf(ledger, id);
    const cost = economy.deedCost(deed);
    if (deed.owner === buyer || cost === null) return;
    this.#fundBot(buyer, cost);
    economy.buyDeed(ledger, buyer, id);
    if (Math.random() < 0.55) economy.listDeed(ledger, buyer, id, Math.round(cost * (1.1 + Math.random() * 1.4) / 100) * 100);
  }

  /** Runs a bot room through its waiting stage and part of its round. */
  #fastForward(game: Game, fraction: number) {
    const room = this.#state.bots[game.id];
    for (const plan of room?.plans ?? []) if (!plan.joined) this.#botJoin(game, plan);
    if (game.players.length < game.minPlayers) this.fillRoom(game.id);
    if (game.stage === 'waiting') startGame(game, game.host, mathRng);
    this.#advanceGame(game, fraction * game.durationSec + (fraction >= 1 ? 1 : 0));
  }

  #tick(realSeconds: number) {
    const seconds = realSeconds * this.speed;
    for (const game of this.#state.games) {
      if (isOpen(game)) this.#advanceGame(game, seconds);
    }
    const { games, ledger } = this.#state;
    if (games.filter((g) => g.stage === 'waiting').length < 9) this.#botHostRoom(games.filter((g) => g.stage === 'waiting' && g.host.includes('_')).length < 2 && Math.random() < 0.3);

    const finished = games.filter((g) => !isOpen(g));
    if (finished.length > MAX_FINISHED) {
      const drop = new Set(finished.slice(MAX_FINISHED).map((g) => g.id));
      this.#state.games = games.filter((g) => !drop.has(g.id));
      for (const id of drop) delete this.#state.bots[id];
    }
    if (Date.now() >= ledger.season.endsAt) economy.closeSeason(ledger, Date.now());

    // Now and then a bot buys a deed, so the market keeps moving on its own.
    if (Math.random() < 0.002 * this.speed) {
      const mapId = pickFrom(MAP_IDS);
      this.#botBuyDeed(economy.deedId(mapId, pickFrom(economy.deedKinds(mapId))));
    }
  }

  #advanceGame(game: Game, seconds: number) {
    if (!isOpen(game)) return;
    // Step through a jump so bots still act under the clue they would have seen.
    let left = seconds;
    while (left > 0 && isOpen(game)) {
      const step = Math.min(left, 1);
      this.#runBots(game);
      advance(game, step, mathRng);
      left -= step;
    }
    if (!isOpen(game)) economy.payRoom(this.#state.ledger, game);
  }

  #botJoin(game: Game, plan: BotPlan) {
    plan.joined = true;
    if (game.stage !== 'waiting' || game.players.length >= game.maxPlayers || game.players.includes(plan.account)) return;
    this.#fundBot(plan.account, game.fee);
    economy.joinRoom(this.#state.ledger, game, plan.account);
  }

  #botDig(game: Game, plan: BotPlan) {
    plan.dug = true;
    if (game.players.includes(plan.account)) placeDig(game, plan.account, this.#botSpot(game, plan.slop));
  }

  #botsDigAll(game: Game) {
    for (const plan of this.#state.bots[game.id]?.plans ?? []) {
      if (!plan.dug && plan.joined) this.#botDig(game, plan);
    }
  }

  #runBots(game: Game) {
    const room = this.#state.bots[game.id];
    if (!room) return;
    if (game.stage === 'waiting') {
      for (const plan of room.plans) if (!plan.joined && plan.joinAfter <= game.waited) this.#botJoin(game, plan);
      if (room.hostStartAfter !== null && game.waited >= room.hostStartAfter && game.players.length >= game.minPlayers) {
        startGame(game, game.host, mathRng);
      }
      return;
    }
    const pct = (game.elapsed / game.durationSec) * 100;
    for (const plan of room.plans) {
      if (!plan.dug && plan.digPct <= pct) this.#botDig(game, plan);
    }
  }

  // Bots only use the public clues: a landmark that still fits, plus some sloppiness.
  #botSpot(game: Game, slop: number): Point {
    const { landmarks } = getMap(game.mapId);
    const landmark = landmarks[game.candidateIds[mathRng(game.candidateIds.length)]];
    let fallback: Point = { x: landmark.x, y: landmark.y };
    for (let attempt = 0; attempt < 30; attempt++) {
      const spot = { x: landmark.x + mathRng(slop * 2 + 1) - slop, y: landmark.y + mathRng(slop * 2 + 1) - slop };
      if (!isLand(game.mapId, spot)) continue;
      fallback = spot;
      if (!isCrowded(game.digs, spot)) return spot;
    }
    return fallback;
  }

  #save() {
    try {
      localStorage.setItem(STORAGE_KEY, JSON.stringify($state.snapshot(this.#state)));
    } catch {
      // Private browsing can refuse storage. The game still runs, it just won't survive a reload.
    }
  }
}

export const dummy = new DummyBackend();

