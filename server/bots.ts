import { aim, botTarget, designRoom, digPercent, pick } from './bot-brain.ts';
import type { Config } from './config.ts';
import { type Db, ledgerAdd, ledgerTotal } from './db.ts';
import { availableBalance, ensureAccount, type Funding } from './funding.ts';
import { deriveKeyPair } from './keys.ts';
import type { Frame, LiveState } from './live.ts';
import { errorText, log } from './log.ts';
import { loadMaps, type MapData } from './map-data.ts';
import { viewAccount, viewFunction } from './rpc.ts';
import { NearAccount } from './signer.ts';
import { milli, near, toNear } from './units.ts';

// These names sort into the contract's own shard, where sends are reliable and take one block less.
const BOT_NAMES = ['vega', 'willow', 'wren', 'yarrow', 'zinnia', 'umber', 'vesper', 'wisp', 'zephyr', 'ursa'];
const MAPS = ['tropical', 'snowy', 'desert'];
const WAITING_ROOMS_WANTED = 2;
const MAX_BOT_ROOMS = 6;
const MAX_OPEN_ROOMS_BEFORE_BACKING_OFF = 20;
const BUDGET_KIND = 'bots';
const STARTING_WALLET = near('0.3');
const WALLET_LOW = near('0.12');
const WALLET_REFILL = near('0.25');
const GAME_TOP_UP = near('0.06');
const GAS_RESERVE = near('0.08');
const DONOR_MIN = near('0.4');
// Long enough for a player who joined together with a friend, short enough that a lone juror isn't left waiting.
const HUMAN_SETTLE_MS = 2500;
const PRESS_AGAIN_MS = 6000;
const CREATE_TGAS = 60;
const JOIN_TGAS = 10;
const DIG_TGAS = 5;
const MINT_EVERY_MS = 600_000;
const FUNDS_CHECK_MS = 60_000;

type Bot = { account: NearAccount; busy: boolean; balance: bigint; wallet: bigint };
type RoomPlan = { fillAt: number; hurry: number | null; pressedAt: number; joinAt: number; target: number; digs: Map<string, { pct: number; slop: number; done: boolean; tries: number }>; startAt: number | null };

const rand = Math.random;
const between = (lo: number, hi: number) => lo + rand() * (hi - lo);

export class Bots {
  readonly #config: Config;
  readonly #db: Db;
  readonly #state: LiveState;
  readonly #funding: Funding;
  readonly #root: NearAccount;
  readonly #maps: Record<string, MapData>;
  readonly #bots = new Map<string, Bot>();
  readonly #plans = new Map<number, RoomPlan>();
  #parent!: NearAccount;
  #mapTurn = Math.floor(rand() * MAPS.length);
  #hosting = false;
  #lastFunds = 0;
  #lastMint = 0;
  #rootLow = false;
  #startedMs = Date.now();

  constructor(config: Config, db: Db, state: LiveState, funding: Funding, root: NearAccount) {
    this.#config = config;
    this.#db = db;
    this.#state = state;
    this.#funding = funding;
    this.#root = root;
    this.#maps = loadMaps(config.mapDataDir);
  }

  spent(): bigint {
    return ledgerTotal(this.#db, BUDGET_KIND);
  }

  #isBot = (id: string) => id.endsWith(`.${this.#config.botsParent}`);

  async start(): Promise<void> {
    const parentId = this.#config.botsParent;
    const parentKey = deriveKeyPair(this.#config.keySeed, `${parentId}:lane:0`);
    if (await ensureAccount(this.#root, parentId, near('0.1'), [parentKey])) ledgerAdd(this.#db, BUDGET_KIND, parentId, near('0.1'));
    this.#parent = new NearAccount(parentId, 'bots', [parentKey]);

    for (const name of BOT_NAMES.slice(0, this.#config.botCount)) {
      const id = `${name}.${parentId}`;
      const key = deriveKeyPair(this.#config.keySeed, `bot:${id}`);
      if (!(await viewAccount(id, 'optimistic'))) {
        // The parent pays a child's opening balance itself, so it needs those coins first.
        await this.#root.transfer(parentId, STARTING_WALLET + near('0.01'));
        ledgerAdd(this.#db, BUDGET_KIND, id, STARTING_WALLET + near('0.01'));
        await ensureAccount(this.#parent, id, STARTING_WALLET, [key]);
      }
      this.#bots.set(id, { account: new NearAccount(id, 'bots', [key]), busy: false, balance: 0n, wallet: 0n });
    }
    await this.#refreshFunds();
    log('bots', `${this.#bots.size} bots ready`, { spent: toNear(this.spent()), budget: toNear(this.#config.botsBudget) });
    this.#state.onPoll((frame) => this.#tick(frame));
  }

  async #refreshFunds(): Promise<void> {
    this.#lastFunds = Date.now();
    for (const [id, bot] of this.#bots) {
      const [record, account] = await Promise.all([viewFunction<any>(this.#config.contract, 'get_account', { id }), viewAccount(id)]);
      bot.balance = BigInt(record?.balance ?? 0);
      bot.wallet = availableBalance(account);
      if (bot.wallet < WALLET_LOW) await this.#refill(bot);
    }
    this.#rootLow = !(await this.#funding.rootCanSpend(0n, 'bots'));
    if (this.#rootLow) log('bots', 'root is below its floor, bots are pausing');
  }

  /** Winners pile up coins while losers run dry. Moving them around first keeps the root's coins for last. */
  async #refill(bot: Bot): Promise<void> {
    const donor = [...this.#bots.values()].filter((b) => b !== bot && !b.busy).sort((a, b) => (b.balance > a.balance ? 1 : -1))[0];
    if (donor && donor.balance >= DONOR_MIN) {
      donor.busy = true;
      try {
        const out = await donor.account.call(this.#config.contract, 'withdraw', { amount: WALLET_REFILL.toString() }, 10, 1n, { wait: 'FINAL' });
        if (out.ok && out.value !== false) {
          donor.balance -= WALLET_REFILL;
          const sent = await donor.account.transfer(bot.account.id, WALLET_REFILL);
          if (sent.ok) {
            bot.wallet += WALLET_REFILL;
            return void log('bots', `${donor.account.id} passed ${toNear(WALLET_REFILL)} NEAR to ${bot.account.id}`);
          }
        }
      } finally {
        donor.busy = false;
      }
    }
    // The one place bots get new coins, and it can't go past the budget even after a restart.
    if (this.spent() + WALLET_REFILL > this.#config.botsBudget) {
      log('bots', `budget used up, ${bot.account.id} not refilled`, { spent: toNear(this.spent()) });
      return;
    }
    const sent = await this.#funding.topUp(bot.account.id, WALLET_LOW, WALLET_REFILL, 'bots');
    if (sent) {
      ledgerAdd(this.#db, BUDGET_KIND, bot.account.id, sent);
      bot.wallet += sent;
    }
  }

  #tick(frame: Frame): void {
    if (!this.#bots.size) return;
    const live = frame.live;
    const active = this.#state.demand.active();
    if (active && Date.now() - this.#lastFunds > FUNDS_CHECK_MS) void this.#refreshFunds().catch((e) => log('bots', `funds check failed: ${errorText(e)}`));

    const open = new Set<number>();
    for (const room of live.rooms) {
      open.add(room.room_id);
      if (room.status === 'waiting') this.#tendWaiting(room, live.now_ms, active);
      else if (room.status === 'live') this.#tendLive(room, live.now_ms);
    }
    for (const id of this.#plans.keys()) if (!open.has(id)) this.#plans.delete(id);

    if (active && !this.#rootLow) {
      this.#maybeHost(live);
      this.#maybeMint();
    }
  }

  #planFor(room: any): RoomPlan {
    let plan = this.#plans.get(room.room_id);
    if (!plan) {
      plan = { fillAt: Date.now() + between(this.#config.botHoldMinSec, this.#config.botHoldMaxSec) * 1000, hurry: null, pressedAt: 0, joinAt: 0, target: 0, digs: new Map(), startAt: null };
      this.#plans.set(room.room_id, plan);
    }
    return plan;
  }

  #tendWaiting(room: any, nowMs: number, active: boolean): void {
    const plan = this.#planFor(room);
    const hostBot = this.#isBot(room.host);
    const humanPlayer = room.players.some((p: string) => !this.#isBot(p));
    const humanHere = !hostBot || humanPlayer;
    const nearlyOver = nowMs > room.deadline_ms - 180_000;

    // Someone's sitting in a bot's room, so it shouldn't make them wait out a countdown. Pressing Start early is allowed.
    if (hostBot && humanPlayer) {
      plan.hurry ??= Date.now();
      if (room.players.length >= room.min_players && Date.now() - plan.hurry >= HUMAN_SETTLE_MS) return this.#pressStart(room, plan);
    }

    // With nobody watching, a bot room left waiting would cost its host part of the bond when it expires. Finishing it is cheaper.
    const wantsPlayers = humanHere ? active : hostBot && (Date.now() > plan.fillAt || !active || nearlyOver);
    const hurrying = plan.hurry !== null && room.players.length < room.min_players;
    if (wantsPlayers && (!room.start_at_ms || hurrying)) {
      const botsNow = room.players.filter(this.#isBot).length;
      if (!plan.target || botsNow >= plan.target) {
        plan.target = Math.max(plan.target, botTarget(room, this.#isBot, this.#bots.size, rand));
      }
      if (botsNow < plan.target && room.players.length < room.max_players && Date.now() >= plan.joinAt) {
        const candidate = this.#freeBot((id) => !room.players.includes(id));
        if (candidate) {
          // A lone visitor should see someone arrive within seconds, so humans get quick joins.
          plan.joinAt = Date.now() + (humanHere ? between(800, 2500) : between(4000, 12_000));
          void this.#join(candidate, room);
        }
      }
    }

    if (hostBot && !humanPlayer && room.countdown_sec === 0 && room.players.length >= room.min_players && !room.start_at_ms) {
      plan.startAt ??= Date.now() + between(5000, 20_000);
      if (Date.now() >= plan.startAt) this.#pressStart(room, plan);
    }
  }

  #pressStart(room: any, plan: RoomPlan): void {
    if (Date.now() < plan.pressedAt + PRESS_AGAIN_MS) return;
    const host = this.#bots.get(room.host);
    if (!host || host.busy) return;
    plan.pressedAt = Date.now();
    void this.#send(host, 'start', { room_id: room.room_id }, JOIN_TGAS);
  }

  #tendLive(room: any, nowMs: number): void {
    const plan = this.#planFor(room);
    const pctDone = ((nowMs - room.started_ms) / (room.duration_sec * 1000)) * 100;
    const dug = new Set(room.digs.map((d: any) => d.account));
    for (const player of room.players as string[]) {
      if (!this.#isBot(player) || dug.has(player)) continue;
      let dig = plan.digs.get(player);
      if (!dig) {
        dig = { pct: digPercent(rand), slop: 1 + Math.floor(rand() * 12), done: false, tries: 0 };
        plan.digs.set(player, dig);
      }
      if (dig.done || pctDone < dig.pct || nowMs >= room.ends_at_ms - 2500) continue;
      const bot = this.#bots.get(player);
      if (!bot || bot.busy) continue;
      dig.done = true;
      const spot = aim(room, this.#maps[room.map], dig.slop, rand);
      bot.busy = true;
      void bot.account
        .call(this.#config.contract, 'dig', { room_id: room.room_id, x: spot.x, y: spot.y, seen_clue: room.clues.length }, DIG_TGAS)
        .then((r) => {
          if (r.ok) return;
          // Racing a new clue is the one expected refusal. Look again at the next poll, with the new clue.
          if (++dig.tries < 4 && /new clue/.test(r.failure ?? '')) dig.done = false;
          else log('bots', `${player} dig failed: ${r.failure}`);
        })
        .catch((e) => log('bots', `${player} dig failed: ${errorText(e)}`))
        .finally(() => (bot.busy = false));
    }
  }

  #freeBot(accept: (id: string) => boolean): Bot | null {
    const free = [...this.#bots.entries()].filter(([id, b]) => !b.busy && accept(id));
    return free.length ? pick(free)[1] : null;
  }

  async #join(bot: Bot, room: any): Promise<void> {
    const need = milli(room.fee);
    await this.#send(bot, 'join', { room_id: room.room_id }, JOIN_TGAS, this.#topUpFor(bot, need));
  }

  /** Payable methods take the difference from the wallet, so one transaction covers a low game balance too. */
  #topUpFor(bot: Bot, need: bigint): bigint {
    if (bot.balance >= need) {
      bot.balance -= need;
      return 0n;
    }
    // What's left must still pay for gas, which is bought at ten times its price.
    const spare = bot.wallet - GAS_RESERVE;
    const short = need - bot.balance;
    const attach = spare < short ? 0n : spare < short + GAME_TOP_UP ? spare : short + GAME_TOP_UP;
    bot.wallet -= attach;
    bot.balance += attach - need;
    if (bot.balance < 0n) bot.balance = 0n;
    return attach;
  }

  async #send(bot: Bot, method: string, args: unknown, tgas: number, deposit = 0n): Promise<any> {
    bot.busy = true;
    try {
      const r = await bot.account.call(this.#config.contract, method, args, tgas, deposit);
      if (!r.ok) log('bots', `${bot.account.id} ${method} refused: ${r.failure}`);
      return r;
    } catch (e) {
      log('bots', `${bot.account.id} ${method} failed: ${errorText(e)}`);
      return null;
    } finally {
      bot.busy = false;
    }
  }

  #maybeHost(live: any): void {
    if (this.#hosting) return;
    const waiting = live.rooms.filter((r: any) => r.status === 'waiting' && r.players.length < r.max_players && !r.start_at_ms);
    if (waiting.length >= WAITING_ROOMS_WANTED) return;
    const botRooms = live.rooms.filter((r: any) => this.#isBot(r.host));
    if (botRooms.length >= MAX_BOT_ROOMS || live.rooms.length >= MAX_OPEN_ROOMS_BEFORE_BACKING_OFF || live.commitments_left < 1) return;
    const hosting = (id: string) => botRooms.filter((r: any) => r.host === id).length;
    const host = this.#freeBot((id) => hosting(id) < 2);
    if (!host) return;
    const design = designRoom(MAPS[this.#mapTurn++ % MAPS.length], rand);
    const bond = milli(100);
    this.#hosting = true;
    void this.#send(host, 'create_room', design, CREATE_TGAS, this.#topUpFor(host, bond))
      .then((r) => r?.ok && log('bots', `${host.account.id} opened room ${r.value}`, { map: design.map, fee: design.fee, sec: design.duration_sec, hash: r.hash }))
      .finally(() => (this.#hosting = false));
  }

  /** A few for-sale deeds so the market isn't empty, each one paid for out of the same hard budget. */
  #maybeMint(): void {
    if (Date.now() - this.#lastMint < MINT_EVERY_MS || Date.now() - this.#startedMs < 60_000) return;
    this.#lastMint = Date.now();
    void this.#mintOne().catch((e) => log('bots', `mint failed: ${errorText(e)}`));
  }

  async #mintOne(): Promise<void> {
    const nfts = await viewFunction<any[]>(this.#config.contract, 'get_nfts', { from: 0, limit: 36 });
    const owned = nfts.filter((n) => n.owner && this.#isBot(n.owner)).length;
    if (owned >= this.#config.botNftMints) return;
    const free = nfts.filter((n) => !n.owner);
    if (!free.length) return;
    const config: any = await viewFunction(this.#config.contract, 'get_config');
    const price = milli(config.mint_price);
    const coins = price + near('0.05');
    if (this.spent() + coins > this.#config.botsBudget || !(await this.#funding.rootCanSpend(coins, 'bots'))) return;
    const bot = this.#freeBot(() => true);
    if (!bot) return;
    const token = pick(free).token_id;
    const funded = await this.#root.transfer(bot.account.id, coins);
    if (!funded.ok) return;
    ledgerAdd(this.#db, BUDGET_KIND, bot.account.id, coins);
    const minted = await this.#send(bot, 'mint_nft', { token_id: token }, 30, price);
    if (!minted?.ok) return;
    const listPrice = Math.round(config.mint_price * between(1.1, 1.6));
    await this.#send(bot, 'list_nft', { token_id: token, price: listPrice }, 10);
    log('bots', `${bot.account.id} minted and listed ${token}`, { price: listPrice });
  }
}

