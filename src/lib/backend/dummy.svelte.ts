// A stand-in chain that lives in one browser tab: fake wallets, fake money, bot players.
import { advance, createGame, placeDig, secondsToNextClue } from '../game/engine';
import { isLand, MAP } from '../game/map';
import { GameError } from '../game/types';
import type { Game, Point } from '../game/types';
import type { GameBackend } from './types';

const STORAGE_KEY = 'dig-here-dummy-v1';
const TICK_MS = 250;
const FAKE_TX_MS = 350;

export const PLAYABLE_ACCOUNTS = ['you.near', 'friend.near', 'rival.near'];
const STARTING_BALANCE = 50_000;
const BOT_NAMES = [
  'salty.near', 'mabel.near', 'shovel_guy.near', 'goose.near', 'dr_dig.near', 'nana.near',
  'lucky_kev.near', 'mudlark.near', 'barnacle.near', 'tilda.near', 'hole_in_one.near', 'ferris.near',
];

type BotPlan = { account: string; joinAt: number; sloppiness: number; joined: boolean };

type Persisted = {
  account: string;
  balances: Record<string, number>;
  games: Game[];
  bots: Record<string, BotPlan[]>;
  nextId: number;
};

function freshState(): Persisted {
  return {
    account: PLAYABLE_ACCOUNTS[0],
    balances: Object.fromEntries(PLAYABLE_ACCOUNTS.map((a) => [a, STARTING_BALANCE])),
    games: [],
    bots: {},
    nextId: 1,
  };
}

function load(): Persisted | null {
  try {
    const saved = localStorage.getItem(STORAGE_KEY);
    return saved ? JSON.parse(saved) : null;
  } catch {
    return null;
  }
}

function pickBots(): string[] {
  const names = [...BOT_NAMES].sort(() => Math.random() - 0.5);
  return names.slice(0, 5 + Math.floor(Math.random() * 5));
}

// A mix of early gamblers and late, careful players, so the bonus trade-off shows up in play.
function planBots(): BotPlan[] {
  return pickBots().map((account) => {
    const style = Math.random();
    const joinAt = style < 0.3 ? 0.03 + Math.random() * 0.4 : style < 0.7 ? 0.52 + Math.random() * 0.36 : 0.91 + Math.random() * 0.08;
    return { account, joinAt, sloppiness: 8 + Math.random() * 60, joined: false };
  });
}

class DummyBackend implements GameBackend {
  #state = $state<Persisted>(load() ?? freshState());
  speed = $state(1);

  constructor() {
    if (this.#state.games.length === 0) this.#seedLobby();
    setInterval(() => this.#tick(TICK_MS / 1000), TICK_MS);
    setInterval(() => this.#save(), 2000);
  }

  get account() {
    return this.#state.account;
  }

  get games() {
    return this.#state.games;
  }

  balanceOf(account: string) {
    return this.#state.balances[account] ?? 0;
  }

  async createGame(input: { name: string; fee: number; durationSec: number; hostCutBps: number }) {
    // Whoever signed is fixed at the moment of the click, as with a real wallet.
    const host = this.account;
    await this.#fakeTx();
    return this.#addGame({ ...input, host });
  }

  async dig(gameId: string, spot: Point) {
    const account = this.account;
    await this.#fakeTx();
    const game = this.#find(gameId);
    if (this.balanceOf(account) < game.fee) {
      throw new GameError('Not enough NEAR in this wallet for the entry fee.');
    }
    placeDig(game, account, spot);
    this.#state.balances[account] -= game.fee;
    this.#save();
  }

  // Playtest controls. These exist only on the dummy and aren't part of GameBackend.

  switchAccount(account: string) {
    this.#state.account = account;
    this.#save();
  }

  skipToNextClue(gameId: string) {
    const game = this.#find(gameId);
    const wait = secondsToNextClue(game);
    this.#advanceGame(game, wait === null ? game.durationSec - game.elapsed : Math.max(wait, 0));
  }

  endNow(gameId: string) {
    const game = this.#find(gameId);
    this.#advanceGame(game, game.durationSec - game.elapsed);
  }

  reset() {
    this.#state = freshState();
    this.#seedLobby();
    this.#save();
  }

  #fakeTx() {
    return new Promise((resolve) => setTimeout(resolve, FAKE_TX_MS));
  }

  #find(gameId: string): Game {
    const game = this.#state.games.find((g) => g.id === gameId);
    if (!game) throw new GameError('That game no longer exists.');
    return game;
  }

  #addGame(input: { name: string; host: string; fee: number; durationSec: number; hostCutBps: number }): string {
    const id = String(this.#state.nextId++);
    const game = createGame(id, input, Math.random);
    this.#state.games.unshift(game);
    this.#state.bots[id] = planBots();
    return id;
  }

  #seedLobby() {
    // Started part-way through, so the first look at the lobby shows games with players in them.
    const seeds = [
      { name: 'High rollers only', host: 'goose.near', fee: 5000, durationSec: 600, hostCutBps: 200, progress: 0.3 },
      { name: 'Horse whisperers', host: 'mabel.near', fee: 1000, durationSec: 300, hostCutBps: 1000, progress: 0.6 },
      { name: 'Lunch money', host: 'captain.near', fee: 500, durationSec: 180, hostCutBps: 500, progress: 0.15 },
    ];
    for (const { progress, ...input } of seeds) {
      const id = this.#addGame(input);
      this.#advanceGame(this.#find(id), progress * input.durationSec);
    }
  }

  #tick(realSeconds: number) {
    const seconds = realSeconds * this.speed;
    for (const game of this.#state.games) {
      if (game.status === 'open') this.#advanceGame(game, seconds);
    }
    if (this.#state.games.filter((g) => g.status === 'open').length < 2) {
      this.#addGame({ name: `Round ${this.#state.nextId}`, host: 'captain.near', fee: 1000, durationSec: 180, hostCutBps: 500 });
    }
  }

  #advanceGame(game: Game, seconds: number) {
    if (game.status !== 'open') return;
    // Step through the jump so bots still act under the clue they would have seen.
    let left = seconds;
    while (left > 0 && game.status === 'open') {
      const nextClue = secondsToNextClue(game);
      const roundEnd = game.durationSec - game.elapsed;
      const step = Math.min(left, nextClue !== null && nextClue > 0 ? nextClue : roundEnd, 1);
      this.#runBots(game, game.elapsed / game.durationSec + step / game.durationSec);
      if (game.elapsed + step >= game.durationSec) break;
      advance(game, step, Math.random);
      left -= step;
    }
    if (left > 0 && game.status === 'open') {
      advance(game, game.durationSec - game.elapsed, Math.random);
    }
    if (game.status !== 'open') this.#payOut(game);
  }

  #runBots(game: Game, fraction: number) {
    for (const bot of this.#state.bots[game.id] ?? []) {
      if (bot.joined || bot.joinAt > fraction) continue;
      bot.joined = true;
      placeDig(game, bot.account, this.#botSpot(game, bot.sloppiness));
    }
  }

  // Bots only use the public clues: a random landmark that still fits, plus some sloppiness.
  #botSpot(game: Game, sloppiness: number): Point {
    const id = game.candidateIds[Math.floor(Math.random() * game.candidateIds.length)];
    const landmark = MAP.landmarks[id];
    for (let attempt = 0; attempt < 30; attempt++) {
      const angle = Math.random() * Math.PI * 2;
      const spot = {
        x: landmark.x + Math.cos(angle) * sloppiness,
        y: landmark.y + Math.sin(angle) * sloppiness,
      };
      if (isLand(spot)) return spot;
    }
    return { x: landmark.x, y: landmark.y };
  }

  #payOut(game: Game) {
    const { balances } = this.#state;
    const credit = (account: string, amount: number) => {
      balances[account] = (balances[account] ?? 0) + amount;
    };
    if (game.status === 'refunded') {
      for (const dig of game.digs) credit(dig.account, game.fee);
    } else if (game.result?.winner) {
      credit(game.result.winner, game.result.prize);
      credit(game.host, game.result.hostCut);
    }
    this.#save();
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
