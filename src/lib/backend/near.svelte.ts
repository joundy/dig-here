// The real thing: rooms from the contract on testnet, moves signed in the browser.
// Reading needs no account and no signing code. Everything that signs is loaded on first use.
import { currentBonus, isCrowded, isOpen, secondsLeft } from '../game/engine';
import type { Deed, DeedEvent, HostRecord, Season } from '../game/economy';
import { near } from '../format';
import { RULES } from '../game/rules';
import { GameError } from '../game/types';
import type { Dig, Game, NewGameInput, Point } from '../game/types';
import { ChainClock } from '../near/clock';
import { botLimitsFrom, RECORD_MILLI, spendable } from '../near/choices';
import { APPROVE_DEPOSIT, CONTRACT, FEE_CHOICES, GAS_TGAS, MARKET } from '../near/config';
import { CLUE_REFUSAL } from '../digButton';
import { activityOf, deedsFrom } from '../near/deeds';
import type { ActivityRow, ListingRow, MarketFrame, NftRow } from '../near/deeds';
import { isMissingKey, isOutOfAllowance, isSignedOut, plainError } from '../near/errors';
import { LiveFeed } from '../near/feed';
import type { StateBody } from '../near/feed';
import { balanceFromEvents, readOutcome } from '../near/outcome';
import type { Outcome } from '../near/outcome';
import { clocksOf, digsOf, displayName, gameFromSummary, gameOf, resultOf, roomFromEvents } from '../near/rooms';
import type { ChainRoom, FinishedSummary, LiveState } from '../near/rooms';
import { isGoneRoom, marketView, RpcError, view, viewAccount } from '../near/rpc';
import { loadSession, saveSession, walletKey } from '../near/session';
import type { Session } from '../near/session';
import type { Call, KeySender } from '../near/signer';
import type { ProofEvent, RoundProof, TxLink } from '../verifyChain';
import type { AccountPrompt, BotLimits, GameBackend, Identity, PlaytestControls, Prices } from './types';

const TICK_MS = 250;
const BALANCE_MS = 30_000;
const HOST_RECORD_MS = 120_000;
const DEEDS_MS = 20_000;
const NEWS_MS = 30_000;
/** A history is worth a look when someone opens it, and rarely changes while they read it. */
const HISTORY_MS = 60_000;
/** A read can be a block or two behind the wallet's answer, so a just-landed sale gets a few looks. */
const SALE_CHECKS = 6;
const SALE_CHECK_GAP_MS = 800;
/** Asked for again on every redraw, a refused read would otherwise come back round at once. */
const RETRY_READ_MS = 15_000;
const CHAIN_TIME_MS = 20_000;
const SETTLE_RETRY_MS = 1500;
const SETTLE_TRIES = 40;
const FINISHED_KEPT = 40;
const FIRST_READ_TRIES = 5;
const FIRST_READ_GAP_MS = 800;
/** How long a move of ours outranks a frame that doesn't show it yet, since reads lag a move by up to 2 s or so. */
const LOCAL_MOVE_MS = 15_000;
/** Past this overdue, anyone can nudge the contract, so coins stay refundable even if the backend is gone. */
const POKE_AFTER_MS = 20_000;
const POKE_GAP_MS = 15_000;

/** Long enough for the reveal that normally follows within 4 s, if no frame has told us otherwise by then. */
const CLUE_HINT_MS = 6000;
const HEALTH_MS = 60_000;

const YOCTO_PER_MILLI = 10n ** 21n;
const toMilli = (yocto: string | bigint) => Number(BigInt(yocto) / YOCTO_PER_MILLI);
const milliToYocto = (milli: number) => (BigInt(milli) * YOCTO_PER_MILLI).toString();

type Timing = Pick<ChainRoom, 'created_ms' | 'start_at_ms' | 'started_ms' | 'ends_at_ms' | 'duration_sec' | 'deadline_ms' | 'reveal_deadline_ms' | 'next_due_ms' | 'next_step' | 'locked'>;
type LocalPlayer = { add: boolean; at: number };

function proofLinks(events: ProofEvent[]): TxLink[] {
  const label = (e: ProofEvent): string | null => {
    switch (e.event) {
      case 'room_created': return 'Room created';
      case 'started': return 'Round started';
      case 'locked': return `Step ${e.data.step} locked`;
      case 'revealed': return `Step ${e.data.step} revealed`;
      case 'finished': return 'Settled';
      case 'refunded': return 'Refunded';
      default: return null;
    }
  };
  return events.flatMap((e) => {
    const text = label(e);
    return text && e.tx_hash ? [{ label: text, hash: e.tx_hash }] : [];
  });
}

async function getJson<T>(path: string, timeoutMs = 3000): Promise<T> {
  const res = await fetch(path, { signal: AbortSignal.timeout(timeoutMs), headers: { accept: 'application/json' } });
  if (!res.ok) throw new Error(`${path} answered ${res.status}`);
  return (await res.json()) as T;
}

class NearBackend implements GameBackend {
  games = $state<Game[]>([]);
  jackpot = $state(0);
  season = $state<Season>({ number: 1, endsAt: 0, pool: 0, points: {}, lastWinners: [] });
  ready = $state(false);
  offline = $state(false);
  identity = $state<Identity>({ kind: 'none' });
  accountPrompt = $state<AccountPrompt | null>(null);
  prices = $state<Prices>({
    hostBond: 100,
    mintPrice: 500,
    feeChoices: FEE_CHOICES,
    feeFilters: [50, 100],
    walletAmounts: [100, 500, 1000],
  });
  #top = $state<{ account: string; points: number }[]>([]);
  #balance = $state(0);
  #wallet = $state(0);
  walletKnown = $state(false);
  /** Assumed until a read says otherwise, so a slow read can't add a setup line that isn't owed. */
  #hasRecord = $state(true);
  #hosts = $state<Record<string, HostRecord>>({});
  #deeds = $state<Record<string, Deed>>({});
  #deedsReady = $state(false);
  deedsError = $state('');
  marketClaim = $state(0);
  #news = $state<DeedEvent[] | null>(null);
  #histories = $state<Record<string, DeedEvent[] | null>>({});
  /** Rooms with a roll locked and not yet revealed, when the contract turns digs away. */
  #clueArriving = $state<Record<string, boolean>>({});
  #botLimits = $state<BotLimits | null>(null);
  #healthAsked = 0;

  readonly lastDigSec = 0;
  readonly testnet = true;
  readonly playtest: PlaytestControls | null = null;

  #clock = new ChainClock();
  #feed: LiveFeed;
  #session: Session | null = null;
  #sender: Promise<KeySender> | null = null;
  #signer: Promise<typeof import('../near/signer')> | null = null;
  #version = -1;
  #timing = new Map<string, Timing>();
  #roomVersions = new Map<string, number>();
  #chainDigs = new Map<string, Dig[]>();
  /** Our own dig between the tap and the chain showing it. */
  #pendingDigs = new Map<string, Dig>();
  #localPlayers = new Map<string, LocalPlayer>();
  #settling = new Set<string>();
  #loading = new Map<string, Promise<void>>();
  #hostsAsked = new Map<string, number>();
  #deedsAsked = 0;
  #marketSeen = 0;
  #marketVersion: string | null = null;
  /** The exact price of each listing. Milli is for screens, and rounding it would fail or overpay a buy. */
  #listingYocto = new Map<string, string>();
  /** Our own move, which outranks a read that doesn't show it yet. */
  #localDeeds = new Map<string, { deed: Partial<Deed>; yocto?: string; at: number }>();
  #newsAsked = 0;
  #historyAsked = new Map<string, number>();
  #pokedAt = new Map<string, number>();
  #accountChoice: Promise<void> | null = null;
  #firstRead: Promise<void> = Promise.resolve();

  constructor() {
    this.#feed = new LiveFeed({
      openStream: () => new EventSource('/api/live'),
      fetchState: () => getJson<StateBody>('/api/state', 2500),
      readChain: () => view<LiveState>('live_state'),
      chainNow: () => this.#clock.now(),
      onState: (live) => this.#applyLive(live),
      onMarket: (market) => this.#applyMarketFrame(market),
      onMode: (mode) => {
        this.offline = mode === 'chain';
        if (mode === 'chain') void this.#feed.refresh();
      },
    });
    this.#feed.start();
    this.#restoreSession();
    void this.#loadConfig();
    void this.#loadHistory();
    void this.#readChainTime();
    setInterval(() => this.#tick(), TICK_MS);
    setInterval(() => void this.#readChainTime(), CHAIN_TIME_MS);
    setInterval(() => { if (!document.hidden) this.refreshBalances(); }, BALANCE_MS);
    document.addEventListener('visibilitychange', () => {
      if (document.hidden) return;
      this.refreshBalances();
      void this.#readChainTime();
    });
  }

  get account() {
    return this.identity.kind === 'none' ? '' : this.identity.accountId;
  }

  get canTransferDeeds() {
    return this.identity.kind === 'wallet';
  }

  get setupCost() {
    return this.#hasRecord ? 0 : RECORD_MILLI;
  }

  nowMs() {
    return this.#clock.now();
  }

  // Reading.

  async #readChainTime() {
    try {
      this.#clock.sample(await view<number>('get_now_ms'));
    } catch {
      // Frames carry the same number, so missing one of these costs nothing.
    }
  }

  async #loadConfig() {
    try {
      const config = await view<{ mint_price: number; host_bond: number }>('get_config');
      this.prices.mintPrice = config.mint_price;
      this.prices.hostBond = config.host_bond;
    } catch {
      setTimeout(() => void this.#loadConfig(), 5000);
    }
  }

  #applyLive(live: LiveState) {
    this.#clock.sample(live.now_ms);
    // Two sources can answer out of order. An older world must never overwrite a newer one.
    if (live.version < this.#version) return;
    const changed = live.version !== this.#version;
    this.#version = live.version;
    this.ready = true;
    this.jackpot = live.jackpot;
    this.season.number = live.season.number;
    this.season.endsAt = live.season.ends_at_ms;
    this.season.pool = live.season.pool;
    this.season.lastWinners = live.season.last_winners;
    if (!changed && this.games.length) return;
    this.#top = live.season.top;
    this.season.points = Object.fromEntries(live.season.top.map((row) => [row.account, row.points]));

    const now = this.#clock.now();
    const open = new Set<string>();
    for (const room of live.rooms) {
      open.add(String(room.room_id));
      this.#upsert(room, now);
    }
    for (const game of this.games) {
      if (isOpen(game) && !open.has(game.id)) void this.#settle(game.id);
    }
  }

  #find(id: string): Game | undefined {
    return this.games.find((g) => g.id === id);
  }

  #upsert(room: ChainRoom, now: number) {
    const id = String(room.room_id);
    this.#clueArriving[id] = room.status === 'live' && room.locked;
    const existing = this.#find(id);
    if (existing && this.#roomVersions.get(id) === room.version && isOpen(existing)) return;
    this.#timing.set(id, room);
    this.#roomVersions.set(id, room.version);
    const digs = digsOf(room);
    this.#chainDigs.set(id, digs);
    if (digs.some((d) => d.account === this.account)) this.#pendingDigs.delete(id);

    if (!existing) {
      const game = gameOf(room, now);
      game.digs = this.#digsWithPending(id);
      game.players = this.#playersWithLocal(id, game.players);
      this.games.unshift(game);
      return;
    }
    // Field by field, so a new dig doesn't redraw what only depends on the clue, and the like.
    existing.stage = room.status;
    existing.name = displayName(room.name);
    const players = this.#playersWithLocal(id, room.players);
    if (players.join() !== existing.players.join()) existing.players = players;
    if (room.clues.length !== existing.clues.length) existing.clues = room.clues;
    if (room.candidates.length !== existing.candidateIds.length) existing.candidateIds = room.candidates;
    existing.digs = this.#digsWithPending(id);
    existing.durationSec = room.duration_sec;
    Object.assign(existing, this.#clocks(id, now));
    if (!existing.landmarks.length && room.landmarks?.length) existing.landmarks = gameOf(room, now).landmarks;
  }

  #clocks(id: string, now: number) {
    const timing = this.#timing.get(id);
    return timing ? clocksOf(timing, now) : null;
  }

  #digsWithPending(id: string): Dig[] {
    const chain = this.#chainDigs.get(id) ?? [];
    const pending = this.#pendingDigs.get(id);
    return pending ? [...chain, pending] : chain;
  }

  #playersWithLocal(id: string, players: string[]): string[] {
    const local = this.#localPlayers.get(id);
    const me = this.account;
    if (!local || !me) return [...players];
    if (Date.now() - local.at > LOCAL_MOVE_MS || players.includes(me) === local.add) {
      this.#localPlayers.delete(id);
      return [...players];
    }
    return local.add ? [...players, me] : players.filter((p) => p !== me);
  }

  /** The clock keeps moving between frames, from chain time. */
  #tick() {
    if (!this.#clock.ready) return;
    const now = this.#clock.now();
    for (const game of this.games) {
      if (!isOpen(game)) continue;
      const clocks = this.#clocks(game.id, now);
      if (!clocks) continue;
      game.waited = clocks.waited;
      game.startIn = clocks.startIn;
      game.elapsed = clocks.elapsed;
    }
    this.#nudgeOverdue(now);
  }

  /** When a room has gone past what its helper should have done, a player can poke it themselves. */
  #nudgeOverdue(now: number) {
    // A nudge is a favour to everyone, not worth a wallet popup nobody asked for.
    if (!this.#session || !this.#keyFor(this.#session)) return;
    for (const game of this.games) {
      if (!isOpen(game) || !game.players.includes(this.account)) continue;
      const timing = this.#timing.get(game.id);
      if (!timing) continue;
      const due = (game.stage === 'waiting'
        ? [timing.start_at_ms, timing.deadline_ms]
        : [game.digs.length < RULES.minDigs ? timing.ends_at_ms : null, timing.reveal_deadline_ms]
      ).filter((t): t is number => t !== null && t !== undefined);
      if (!due.length || now - Math.min(...due) < POKE_AFTER_MS) continue;
      const last = this.#pokedAt.get(game.id) ?? 0;
      if (Date.now() - last < POKE_GAP_MS) continue;
      this.#pokedAt.set(game.id, Date.now());
      void this.#call({ method: 'poke', args: { room_id: Number(game.id) }, gasTgas: GAS_TGAS.poke }).catch(() => undefined);
    }
  }

  /** A room left the open list: it ended. Stays on screen as it was until the details are in. */
  async #settle(id: string) {
    if (this.#settling.has(id)) return;
    this.#settling.add(id);
    try {
      for (let attempt = 0; attempt < SETTLE_TRIES; attempt++) {
        const room = await this.#fetchRoom(id);
        if (room && (room.status === 'finished' || room.status === 'refunded')) {
          this.#finish(id, room);
          return;
        }
        // A read can lag the frame that dropped the room, and a dropped frame can be behind the room.
        if (room && this.#timing.get(id)?.started_ms !== room.started_ms) this.#upsert(room, this.#clock.now());
        await new Promise((resolve) => setTimeout(resolve, SETTLE_RETRY_MS));
      }
    } finally {
      this.#settling.delete(id);
    }
  }

  async #fetchRoom(id: string): Promise<ChainRoom | null> {
    try {
      return await view<ChainRoom>('get_room', { id: Number(id) });
    } catch {
      // Deleted from the contract's ring, or the network's having a moment. The indexer may still know it.
    }
    try {
      const proof = await getJson<{ events: ProofEvent[] }>(`/api/games/${id}/proof`);
      return roomFromEvents(proof.events);
    } catch {
      return null;
    }
  }

  #finish(id: string, room: ChainRoom) {
    const now = this.#clock.now();
    const game = this.#find(id);
    if (!game) {
      this.games.push(gameOf(room, now));
      this.#trimFinished();
      return;
    }
    const wasOpen = isOpen(game);
    const whole = gameOf(room, now);
    // Results first: the Room reacts to `stage`, and reads the result as soon as it does.
    game.result = resultOf(room);
    game.paid = true;
    game.hostCutBps = room.host_cut_bps;
    game.durationSec = room.duration_sec;
    game.maxPlayers = room.max_players;
    game.players = whole.players;
    game.digs = whole.digs;
    game.clues = whole.clues;
    game.candidateIds = whole.candidateIds;
    if (!game.landmarks.length) game.landmarks = whole.landmarks;
    game.elapsed = room.duration_sec;
    game.startIn = null;
    game.stage = room.status;
    this.#chainDigs.delete(id);
    this.#pendingDigs.delete(id);
    delete this.#clueArriving[id];
    if (wasOpen) {
      // Newest first in the finished tab, which keeps the array's order.
      this.games.splice(this.games.indexOf(game), 1);
      this.games.unshift(game);
      this.#trimFinished();
      const me = this.account;
      if (me && (room.players.includes(me) || room.host === me || room.result?.deed_owner === me)) this.refreshBalances();
      this.#deedsAsked = 0;
      delete this.#hosts[room.host];
      this.#hostsAsked.delete(room.host);
    }
  }

  #trimFinished() {
    let kept = 0;
    this.games = this.games.filter((g) => isOpen(g) || ++kept <= FINISHED_KEPT);
  }

  async #loadHistory() {
    let rows: FinishedSummary[] | null = null;
    try {
      rows = (await getJson<{ games: FinishedSummary[] }>('/api/finished-games?limit=30')).games;
    } catch {
      // The indexer is optional. The contract keeps the last 30 by itself.
    }
    if (!rows?.length) rows = await view<FinishedSummary[]>('get_recent_finished').catch(() => null);
    if (!rows) return;
    for (const row of rows) {
      if (!this.#find(String(row.room_id))) this.games.push(gameFromSummary(row));
    }
    this.#trimFinished();
  }

  loadGame(id: string): Promise<void> {
    const existing = this.#find(id);
    if (existing?.landmarks.length) return Promise.resolve();
    const running = this.#loading.get(id);
    if (running) return running;
    const run = this.#fetchRoom(id).then((room) => {
      if (!room) return;
      if (room.status === 'finished' || room.status === 'refunded') this.#finish(id, room);
      else this.#upsert(room, this.#clock.now());
    }).finally(() => this.#loading.delete(id));
    this.#loading.set(id, run);
    return run;
  }

  /**
   * The contract's own record where it still has one, straight from a public node. Our server's proof only
   * stands in once the contract says the room is gone, and then every line of it gets looked up on the chain.
   * Failing to reach a node isn't the contract saying that, so it never falls back to our server.
   */
  async proofOf(id: string): Promise<RoundProof | null> {
    const fromServer = getJson<{ events: ProofEvent[] }>(`/api/games/${id}/proof`).then((p) => p.events).catch((): ProofEvent[] => []);
    try {
      const room = await view<ChainRoom>('get_room', { id: Number(id) });
      return { source: 'contract', room, links: proofLinks(await fromServer) };
    } catch (e) {
      if (!isGoneRoom(e)) throw e;
    }
    const events = await fromServer;
    const room = roomFromEvents(events);
    return room && { source: 'events', room, events, links: proofLinks(events) };
  }

  // Records read lazily, by what's on screen.

  hostRecord(account: string): HostRecord {
    const asked = this.#hostsAsked.get(account) ?? 0;
    if (Date.now() - asked > HOST_RECORD_MS) {
      this.#hostsAsked.set(account, Date.now());
      queueMicrotask(() => void this.#loadHost(account));
    }
    return this.#hosts[account] ?? { finished: 0, expired: 0 };
  }

  async #loadHost(account: string) {
    try {
      const record = await view<HostRecord & { open_rooms: number }>('get_host', { id: account });
      this.#hosts[account] = { finished: record.finished, expired: record.expired };
    } catch {
      this.#hostsAsked.set(account, Date.now() - HOST_RECORD_MS + RETRY_READ_MS);
    }
  }

  /** A frame from the backend carries all of this, so only a quiet backend sends us to the nodes. */
  #askForDeeds() {
    const fresh = Date.now() - this.#marketSeen < DEEDS_MS;
    if (!fresh && Date.now() - this.#deedsAsked > DEEDS_MS) {
      this.#deedsAsked = Date.now();
      queueMicrotask(() => void this.#loadDeeds());
    }
  }

  // A market page waits on this before it looks at any NFT, so this has to do the asking too.
  get deedsReady() {
    this.#askForDeeds();
    return this.#deedsReady;
  }

  deedOf(id: string): Deed {
    this.#askForDeeds();
    return this.#deeds[id] ?? { owner: null, price: null, earned: 0, landings: 0 };
  }

  reloadDeeds() {
    this.#deedsAsked = Date.now();
    void this.#loadDeeds();
  }

  refreshDeeds(openId?: string) {
    this.#askForDeeds();
    void this.deedNews;
    if (openId) void this.deedHistory(openId);
  }

  /** Straight from the two contracts. A market that can't be read shows owners with no prices, and says so. */
  async #loadDeeds(): Promise<void> {
    const began = Date.now();
    try {
      const [nfts, listings] = await Promise.all([
        view<NftRow[] | null>('get_nfts', { from: 0, limit: 36 }),
        marketView<ListingRow[] | null>('get_listings', { from: 0, limit: 36 }).catch(() => null),
      ]);
      // A frame that landed meanwhile is as new or newer, and its version wouldn't get it applied a second time.
      if (this.#marketSeen >= began) return;
      this.#applyDeeds(nfts ?? [], listings ?? []);
      this.#deedsReady = true;
      this.deedsError = listings ? '' : "Can't read the market's prices right now, so nothing shows as for sale. Coins are safe.";
    } catch {
      if (this.#marketSeen >= began) return;
      this.#deedsAsked = Date.now() - DEEDS_MS + RETRY_READ_MS;
      this.deedsError = this.#deedsReady
        ? "Can't reach the market right now, so this may be a little out of date."
        : "Can't reach the market right now. It tries again by itself.";
    }
  }

  #applyMarketFrame(market: MarketFrame) {
    this.#marketSeen = Date.now();
    this.#deedsReady = true;
    this.deedsError = '';
    if (market.version === this.#marketVersion) return;
    this.#marketVersion = market.version;
    this.#applyDeeds(market.nfts, market.listings);
    this.#newsAsked = 0;
  }

  #applyDeeds(nfts: NftRow[], listings: ListingRow[]) {
    const { deeds, yocto } = deedsFrom(nfts, listings);
    let waitingOnRead = false;
    for (const [id, local] of this.#localDeeds) {
      const read = deeds[id];
      const shown = read && Object.entries(local.deed).every(([field, value]) => (read as Record<string, unknown>)[field] === value);
      if (shown || Date.now() - local.at > LOCAL_MOVE_MS) {
        this.#localDeeds.delete(id);
      } else {
        deeds[id] = { ...(read ?? { owner: null, price: null, earned: 0, landings: 0 }), ...local.deed };
        if (local.yocto) yocto.set(id, local.yocto);
        else if (local.deed.price === null) yocto.delete(id);
        waitingOnRead = true;
      }
    }
    this.#deeds = deeds;
    this.#listingYocto = yocto;
    if (waitingOnRead) setTimeout(() => void this.#loadDeeds(), SALE_CHECK_GAP_MS * 2);
  }

  /** Shows our own move at once. The next read that agrees takes over from it. */
  #movedDeed(id: string, deed: Partial<Deed>, yocto?: string) {
    this.#localDeeds.set(id, { deed, yocto, at: Date.now() });
    this.#deeds[id] = { ...(this.#deeds[id] ?? { owner: null, price: null, earned: 0, landings: 0 }), ...deed };
    if (yocto) this.#listingYocto.set(id, yocto);
    else if (deed.price === null) this.#listingYocto.delete(id);
    delete this.#histories[id];
    this.#historyAsked.delete(id);
    this.#newsAsked = 0;
    void this.#loadDeeds();
  }

  get deedNews(): DeedEvent[] | null {
    if (Date.now() - this.#newsAsked > NEWS_MS) {
      this.#newsAsked = Date.now();
      queueMicrotask(() => void this.#loadNews());
    }
    return this.#news;
  }

  async #loadNews() {
    try {
      const body = await getJson<{ activity: ActivityRow[] }>('/api/market-activity?limit=30');
      this.#news = body.activity.flatMap(activityOf);
    } catch {
      // Keeping what we had beats wiping it for one missed read, and no backend at all stays as "can't say".
    }
  }

  deedHistory(id: string): DeedEvent[] | null {
    if (Date.now() - (this.#historyAsked.get(id) ?? 0) > HISTORY_MS) {
      this.#historyAsked.set(id, Date.now());
      queueMicrotask(() => void this.#loadHistoryOf(id));
    }
    return this.#histories[id] ?? null;
  }

  async #loadHistoryOf(id: string) {
    try {
      const body = await getJson<{ activity: ActivityRow[] }>(`/api/nfts/${id}/activity?limit=30`);
      this.#histories[id] = body.activity.flatMap(activityOf);
    } catch {
      // As above. The chain facts on the page don't depend on this.
    }
  }

  seasonRanking() {
    return this.#top;
  }

  clueArriving(gameId: string): boolean {
    return this.#clueArriving[gameId] === true;
  }

  get botLimits(): BotLimits | null {
    if (Date.now() - this.#healthAsked > HEALTH_MS) {
      this.#healthAsked = Date.now();
      queueMicrotask(() => void this.#loadBotLimits());
    }
    return this.#botLimits;
  }

  async #loadBotLimits() {
    try {
      this.#botLimits = botLimitsFrom(await getJson<Record<string, unknown>>('/api/health'));
    } catch {
      // Without the backend there are no bots to wait for, so no line is the right answer.
    }
  }

  walletOf(account: string) {
    return account === this.account ? this.#wallet : 0;
  }

  balanceOf(account: string) {
    return account === this.account ? this.#balance : 0;
  }

  refreshBalances() {
    void this.#readBalances();
  }

  async #readBalances(): Promise<boolean> {
    const session = this.#session;
    if (!session) return true;
    try {
      const record = await view<{ balance: string } | null>('get_account', { id: session.accountId });
      if (this.#session === session) {
        this.#balance = record ? toMilli(record.balance) : 0;
        this.#hasRecord = record !== null;
      }
      const account = await viewAccount(session.accountId);
      if (this.#session === session) {
        this.#wallet = account ? spendable(account) : 0;
        this.walletKnown = true;
      }
      // A separate look, because the game must carry on working if the market can't be read.
      void marketView<string | null>('get_unclaimed', { account_id: session.accountId }).then(
        (held) => { if (this.#session === session) this.marketClaim = held ? toMilli(held) : 0; },
        () => undefined,
      );
      return true;
    } catch {
      return false;
    }
  }

  /** A failed read must not read as "you have nothing", or the next click tells them they're short of coins. */
  async #readBalancesPatiently() {
    for (let attempt = 0; attempt < FIRST_READ_TRIES; attempt++) {
      if (await this.#readBalances()) return;
      await new Promise((resolve) => setTimeout(resolve, FIRST_READ_GAP_MS));
    }
  }

  // Who's playing.

  #setSession(session: Session | null) {
    this.#session = session;
    this.#sender = null;
    this.#balance = 0;
    this.#wallet = 0;
    this.walletKnown = false;
    this.#hasRecord = true;
    this.marketClaim = 0;
    saveSession(session);
    this.identity = session ? { kind: session.kind, accountId: session.accountId } : { kind: 'none' };
    this.#firstRead = session ? this.#readBalancesPatiently() : Promise.resolve();
  }

  #restoreSession() {
    this.#setSession(loadSession());
  }

  ensureAccount(): Promise<void> {
    // Waits for the first balance read too: right after a reload, "0" would look like being short of coins.
    if (this.#session) return this.#firstRead;
    if (this.#accountChoice) return this.#accountChoice;
    this.#accountChoice = new Promise<void>((resolve, reject) => {
      const finish = (settle: () => void) => {
        this.accountPrompt = null;
        this.#accountChoice = null;
        settle();
      };
      this.accountPrompt = {
        error: '',
        busy: false,
        noKey: false,
        connect: () => {
          const prompt = this.accountPrompt;
          if (!prompt) return;
          prompt.busy = true;
          prompt.error = '';
          this.#signInWallet().then(
            (keyAdded) => {
              prompt.busy = false;
              if (keyAdded) finish(resolve);
              else prompt.noKey = true;
            },
            (e) => {
              prompt.busy = false;
              prompt.error = (e as Error).message;
            },
          );
        },
        carryOn: () => finish(() => this.#firstRead.then(resolve, reject)),
        chooseAgain: () => {
          const prompt = this.accountPrompt;
          void this.disconnectWallet().finally(() => {
            if (prompt) prompt.noKey = false;
          });
        },
        cancel: () => {
          const leaving = this.#session ? this.disconnectWallet() : Promise.resolve();
          void leaving.finally(() => finish(() => reject(new GameError(''))));
        },
      };
    });
    return this.#accountChoice;
  }

  #signerCode() {
    this.#signer ??= import('../near/signer');
    return this.#signer;
  }

  /** Whether the game's key made it onto the account. */
  async #signInWallet(): Promise<boolean> {
    try {
      const wallet = await import('../near/wallet');
      const { accountId, keyAdded } = await wallet.connectWallet();
      this.#setSession({ kind: 'wallet', accountId });
      await this.#firstRead;
      return keyAdded;
    } catch (e) {
      throw new GameError(plainError(errorText(e)));
    }
  }

  async disconnectWallet() {
    const session = this.#session;
    // Forgetting comes first, so a wallet that never answers can't leave this browser signed in.
    this.#setSession(null);
    if (!session) return;
    const wallet = await import('../near/wallet');
    await wallet.disconnectWallet(session.accountId);
  }

  // Moving.

  #keyFor(session: Session): string | null {
    return walletKey(session.accountId)?.secretKey ?? null;
  }

  #senderFor(session: Session, secretKey: string): Promise<KeySender> {
    this.#sender ??= this.#signerCode().then(({ KeySender: Sender }) => new Sender(session.accountId, secretKey));
    return this.#sender;
  }

  /**
   * One contract call with nothing attached. Everything goes through a key this browser holds, so the
   * player is never asked anything. Without one, a wallet user's wallet signs instead.
   */
  async #call(call: Call, onSlow?: () => void): Promise<Outcome> {
    const session = this.#session;
    if (!session) throw new GameError('Connect a wallet first.');
    const secretKey = this.#keyFor(session);
    let raw: any;
    try {
      if (secretKey) {
        raw = await (await this.#senderFor(session, secretKey)).send(call, onSlow);
      } else {
        raw = await this.#walletCall(session.accountId, call, '0');
      }
    } catch (e) {
      const text = errorText(e);
      if (e instanceof GameError) throw e;
      // The key is spent or gone, and the wallet can still sign, with an approval each time.
      if (!secretKey || !(isOutOfAllowance(text) || isMissingKey(text))) throw new GameError(plainError(text));
      raw = await this.#walletCall(session.accountId, call, '0');
    }
    return this.#finishCall(session, raw);
  }

  /** A move that attaches coins, which only the wallet can sign. Whatever the move doesn't cost stays in the balance. */
  async #callPaying(call: Call, attach: number): Promise<Outcome> {
    const session = this.#session;
    if (!session) throw new GameError('Connect a wallet first.');
    const outcome = this.#finishCall(session, await this.#walletCall(session.accountId, call, milliToYocto(attach)));
    this.refreshBalances();
    return outcome;
  }

  async #walletCall(accountId: string, call: Call, deposit: string, receiver: string = CONTRACT) {
    const wallet = await import('../near/wallet');
    try {
      return await wallet.callWithDeposit(accountId, call.method, call.args, call.gasTgas, deposit, receiver);
    } catch (e) {
      const text = errorText(e);
      // The wallet has forgotten this site. Holding on to the session would fail the same way every time.
      if (isSignedOut(text)) await this.disconnectWallet().catch(() => undefined);
      throw new GameError(plainError(text));
    }
  }

  #finishCall(session: Session, raw: any): Outcome {
    const outcome = readOutcome(raw);
    if (outcome.failure) throw new GameError(plainError(outcome.failure));
    const balance = balanceFromEvents(outcome.events, session.accountId);
    if (balance !== null && this.#session === session) this.#balance = toMilli(balance);
    return outcome;
  }

  async #needAccount(): Promise<Session> {
    await this.ensureAccount();
    if (!this.#session) throw new GameError('Connect a wallet first.');
    return this.#session;
  }

  async deposit(amount: number): Promise<void> {
    if (!Number.isInteger(amount) || amount <= 0) throw new GameError('Enter an amount above 0.');
    const session = await this.#needAccount();
    const raw = await this.#walletCall(session.accountId, { method: 'deposit', args: {}, gasTgas: GAS_TGAS.deposit }, milliToYocto(amount));
    this.#finishCall(session, raw);
    this.refreshBalances();
  }

  async withdraw(amount: number): Promise<void> {
    if (!Number.isInteger(amount) || amount <= 0) throw new GameError('Enter an amount above 0.');
    const session = await this.#needAccount();
    const raw = await this.#walletCall(session.accountId, { method: 'withdraw', args: { amount: milliToYocto(amount) }, gasTgas: GAS_TGAS.withdraw }, '1');
    const outcome = this.#finishCall(session, raw);
    if (outcome.value === false) throw new GameError("The transfer didn't go through. Your coins are back in your balance.");
    this.refreshBalances();
  }

  async createGame(input: Omit<NewGameInput, 'host'>, attach = 0): Promise<string> {
    await this.#needAccount();
    if (!input.name.trim()) throw new GameError('Give the game a name.');
    const call: Call = {
      method: 'create_room',
      args: {
        name: input.name.trim(),
        map: input.mapId,
        fee: input.fee,
        duration_sec: input.durationSec,
        host_cut_bps: input.hostCutBps,
        min_players: input.minPlayers,
        max_players: input.maxPlayers,
        countdown_sec: input.countdownSec,
      },
      gasTgas: GAS_TGAS.create_room,
    };
    const outcome = attach > 0 ? await this.#callPaying(call, attach) : await this.#call(call);
    const id = String(outcome.value);
    await this.loadGame(id);
    void this.#feed.refresh();
    this.refreshBalances();
    return id;
  }

  async join(gameId: string, attach = 0): Promise<void> {
    await this.#needAccount();
    const call: Call = { method: 'join', args: { room_id: Number(gameId) }, gasTgas: GAS_TGAS.join };
    try {
      await (attach > 0 ? this.#callPaying(call, attach) : this.#call(call));
    } catch (e) {
      // A lost send that landed after all, then signed again.
      if (!/already joined/i.test((e as Error).message)) throw e;
    }
    this.#movedPlayer(gameId, true);
  }

  async leave(gameId: string): Promise<void> {
    await this.#needAccount();
    await this.#call({ method: 'leave', args: { room_id: Number(gameId) }, gasTgas: GAS_TGAS.leave });
    this.#movedPlayer(gameId, false);
  }

  #movedPlayer(gameId: string, add: boolean) {
    this.#localPlayers.set(gameId, { add, at: Date.now() });
    const game = this.#find(gameId);
    if (game) {
      const me = this.account;
      const players = game.players.filter((p) => p !== me);
      game.players = add ? [...players, me] : players;
    }
    void this.#feed.refresh();
  }

  async start(gameId: string): Promise<void> {
    await this.#needAccount();
    await this.#call({ method: 'start', args: { room_id: Number(gameId) }, gasTgas: GAS_TGAS.start });
    void this.#feed.refresh();
  }

  /** The X and the dirt happen at once. The chain catches up behind them, or it all rolls back. */
  async dig(gameId: string, spot: Point, seenClue: number): Promise<void> {
    await this.#needAccount();
    const game = this.#find(gameId);
    if (!game) throw new GameError('That game no longer exists.');
    if (secondsLeft(game) <= 0) throw new GameError("Time's up for digging.");
    if (this.clueArriving(gameId)) throw new GameError('A new clue is arriving. Try again in a moment.');
    const me = this.account;
    const pending: Dig = {
      account: me,
      x: spot.x,
      y: spot.y,
      clueIndex: game.clues.length - 1,
      bonusBps: currentBonus(game),
      crowded: isCrowded(game.digs, spot),
      dugAt: game.elapsed,
    };
    this.#pendingDigs.set(gameId, pending);
    game.digs = this.#digsWithPending(gameId);
    try {
      const outcome = await this.#call({ method: 'dig', args: { room_id: Number(gameId), x: spot.x, y: spot.y, seen_clue: seenClue }, gasTgas: GAS_TGAS.dig });
      const event = outcome.events.find((e) => e.event === 'dig');
      if (event && this.#pendingDigs.has(gameId)) {
        // The contract's own answer, in case the crowding or the clue moved under us.
        pending.bonusBps = event.data.bonus_bps;
        pending.crowded = event.data.crowded;
        pending.clueIndex = event.data.clue_index;
        const live = this.#find(gameId);
        if (live) live.digs = this.#digsWithPending(gameId);
      }
      void this.#feed.refresh();
    } catch (e) {
      const message = (e as Error).message;
      // A lost send that landed after all, then signed again: the first one counted.
      if (/already dug/i.test(message)) return;
      this.#pendingDigs.delete(gameId);
      const live = this.#find(gameId);
      if (live) live.digs = this.#digsWithPending(gameId);
      // Our last frame was a moment behind the chain. Close the button now rather than at the next one.
      if (CLUE_REFUSAL.test(message)) this.#expectClue(gameId);
      throw e;
    }
  }

  #expectClue(gameId: string) {
    this.#clueArriving[gameId] = true;
    void this.#feed.refresh();
    setTimeout(() => {
      if (!this.#timing.get(gameId)?.locked) this.#clueArriving[gameId] = false;
    }, CLUE_HINT_MS);
  }

  /** Minting needs a yocto so a browser key can't spend a balance on it, so the wallet always signs. */
  async mintDeed(id: string, attach = 0): Promise<void> {
    const session = await this.#needAccount();
    const deposit = attach > 0 ? milliToYocto(attach) : '1';
    const raw = await this.#walletCall(session.accountId, { method: 'mint_nft', args: { token_id: id }, gasTgas: GAS_TGAS.mint_nft }, deposit);
    this.#finishCall(session, raw);
    this.refreshBalances();
    this.#movedDeed(id, { owner: session.accountId, price: null });
  }

  /**
   * Wallet to wallet: the buyer attaches the listing's exact price and the seller is paid directly, so the game
   * balance plays no part. A price raised meanwhile fails on the contract, and one lowered refunds the difference.
   */
  async buyDeed(id: string, seenPrice: number): Promise<void> {
    const session = await this.#needAccount();
    // The page can be 20 seconds old, and approving a purchase that's bound to fail is a waste of a wallet window.
    await this.#loadDeeds();
    const deed = this.#deeds[id];
    if (deed && deed.owner === session.accountId) throw new GameError('You already own this NFT.');
    if (!deed || deed.owner === null || deed.price === null) throw new GameError('That listing has just ended, so nothing was spent.');
    if (deed.saleInProgress) throw new GameError("Someone else's purchase is on its way. Try again in a moment.");
    if (deed.price !== seenPrice) throw new GameError(`The price just changed to ${near(deed.price)}, so nothing was spent. Check it and try again.`);
    const yocto = this.#listingYocto.get(id);
    if (!yocto) throw new GameError('That listing has just ended, so nothing was spent.');

    let outcome: Outcome;
    try {
      const raw = await this.#walletCall(session.accountId, { method: 'buy', args: { token_id: id }, gasTgas: GAS_TGAS.market_buy }, yocto, MARKET);
      outcome = this.#finishCall(session, raw);
    } catch (e) {
      void this.#loadDeeds();
      throw e;
    }
    this.refreshBalances();
    if (outcome.events.some((e) => e.event === 'nft_sale_failed')) {
      void this.#loadDeeds();
      throw new GameError('The seller no longer has this NFT, so the sale fell through. All your coins came back to your wallet.');
    }
    if (!outcome.events.some((e) => e.event === 'nft_sold') && !(await this.#ownsAfterAll(id, session.accountId))) {
      throw new GameError("The sale didn't go through. If any coins left your wallet they're on their way back.");
    }
    this.#movedDeed(id, { owner: session.accountId, price: null, saleInProgress: false });
  }

  /** Not every wallet hands back the logs, so the chain's own record is the fallback for how a sale went. */
  async #ownsAfterAll(id: string, account: string): Promise<boolean> {
    for (let check = 0; check < SALE_CHECKS; check++) {
      if (check) await new Promise((resolve) => setTimeout(resolve, SALE_CHECK_GAP_MS));
      await this.#loadDeeds();
      if (this.#deeds[id]?.owner === account) return true;
    }
    return false;
  }

  #needPrice(price: number) {
    if (!Number.isInteger(price) || price <= 0) throw new GameError('Set a price above 0.');
  }

  /** NEP-178: the owner approves the market on the NFT contract, and `msg` tells the market what to ask. */
  async listDeed(id: string, price: number): Promise<void> {
    const session = await this.#needAccount();
    this.#needPrice(price);
    const yocto = milliToYocto(price);
    const args = { token_id: id, account_id: MARKET, msg: JSON.stringify({ price: yocto }) };
    this.#finishCall(session, await this.#walletCall(session.accountId, { method: 'nft_approve', args, gasTgas: GAS_TGAS.nft_approve }, APPROVE_DEPOSIT));
    this.#movedDeed(id, { price }, yocto);
  }

  async changeDeedPrice(id: string, price: number): Promise<void> {
    const session = await this.#needAccount();
    this.#needPrice(price);
    const yocto = milliToYocto(price);
    this.#finishCall(session, await this.#walletCall(session.accountId, { method: 'update_price', args: { token_id: id, price: yocto }, gasTgas: GAS_TGAS.market_update_price }, '1', MARKET));
    this.#movedDeed(id, { price }, yocto);
  }

  async delistDeed(id: string): Promise<void> {
    const session = await this.#needAccount();
    this.#finishCall(session, await this.#walletCall(session.accountId, { method: 'delist', args: { token_id: id }, gasTgas: GAS_TGAS.market_delist }, '1', MARKET));
    this.#movedDeed(id, { price: null });
  }

  async claimFromMarket(): Promise<void> {
    const session = await this.#needAccount();
    this.#finishCall(session, await this.#walletCall(session.accountId, { method: 'claim_unclaimed', args: {}, gasTgas: GAS_TGAS.market_claim }, '1', MARKET));
    this.marketClaim = 0;
    this.refreshBalances();
  }

  async transferDeed(id: string, to: string): Promise<void> {
    const session = await this.#needAccount();
    const raw = await this.#walletCall(session.accountId, { method: 'nft_transfer', args: { receiver_id: to.trim(), token_id: id }, gasTgas: GAS_TGAS.nft_transfer }, '1');
    this.#finishCall(session, raw);
    this.#movedDeed(id, { owner: to.trim(), price: null });
  }
}

function errorText(e: unknown): string {
  if (e instanceof RpcError) return `${e.code} ${e.message} ${JSON.stringify(e.data ?? '')}`;
  const message = (e as Error)?.message;
  if (typeof message === 'string') return message;
  // Wallets answer across an iframe, and some send a bare object rather than an Error.
  return typeof e === 'object' ? JSON.stringify(e) : String(e);
}

export const backend = new NearBackend();

