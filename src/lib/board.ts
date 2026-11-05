// What the Game Board shows, in what order. No one can pay to rank higher here.
import type { HostRecord } from './game/economy';
import { potOf, secondsLeft } from './game/engine';
import { RULES } from './game/rules';
import type { Game, MapId } from './game/types';

export type BoardTab = 'waiting' | 'live' | 'finished';
export type SortId = 'best' | 'soon' | 'pot' | 'fee' | 'cut' | 'players';

export const SORTS: { id: SortId; label: string }[] = [
  { id: 'best', label: 'Best' },
  { id: 'soon', label: 'Starting soon' },
  { id: 'pot', label: 'Biggest pot' },
  { id: 'fee', label: 'Lowest fee' },
  { id: 'cut', label: 'Lowest host cut' },
  { id: 'players', label: 'Most players' },
];

export type BoardOptions = {
  tab: BoardTab;
  sort: SortId;
  map: MapId | 'all';
  /** Highest entry fee to show, or null for any. */
  maxFee: number | null;
  hideFull: boolean;
  page: number;
  perPage: number;
};

type Hosts = (account: string) => HostRecord;

/** Real players and a good hosting record lift a room. Empty rooms from unreliable hosts sink. */
export function roomScore(game: Game, hosts: Hosts): number {
  const { finished, expired } = hosts(game.host);
  return game.players.length * 3 + Math.min(finished, 10) - expired * 2 + (game.startIn !== null ? 5 : 0) - (game.players.length === 0 ? 6 : 0);
}

/** Seconds until a room starts by itself, or until a round ends. */
export function timeLeft(game: Game): number {
  if (game.stage === 'waiting') return game.startIn ?? RULES.waitingDeadlineSec - game.waited;
  return secondsLeft(game);
}

function compare(sort: SortId, hosts: Hosts): (a: Game, b: Game) => number {
  switch (sort) {
    case 'soon': return (a, b) => timeLeft(a) - timeLeft(b);
    case 'pot': return (a, b) => potOf(b) - potOf(a);
    case 'fee': return (a, b) => a.fee - b.fee;
    case 'cut': return (a, b) => a.hostCutBps - b.hostCutBps;
    case 'players': return (a, b) => b.players.length - a.players.length;
    default: return (a, b) => roomScore(b, hosts) - roomScore(a, hosts);
  }
}

function inTab(game: Game, tab: BoardTab): boolean {
  if (tab === 'finished') return game.stage === 'finished' || game.stage === 'refunded';
  return game.stage === tab;
}

export function boardView(games: Game[], options: BoardOptions, hosts: Hosts) {
  const { tab, sort, map, maxFee, hideFull, page, perPage } = options;
  const counts: Record<BoardTab, number> = {
    waiting: games.filter((g) => inTab(g, 'waiting')).length,
    live: games.filter((g) => inTab(g, 'live')).length,
    finished: games.filter((g) => inTab(g, 'finished')).length,
  };
  const matching = games.filter((g) => {
    if (!inTab(g, tab)) return false;
    if (map !== 'all' && g.mapId !== map) return false;
    if (maxFee !== null && g.fee > maxFee) return false;
    return !(hideFull && g.players.length >= g.maxPlayers);
  });
  // The finished tab keeps newest first. An ID tie-break stops cards swapping places every tick.
  const sorted = tab === 'finished' ? matching : [...matching].sort((a, b) => compare(sort, hosts)(a, b) || a.id.localeCompare(b.id));
  const pages = Math.max(1, Math.ceil(sorted.length / perPage));
  const current = Math.min(page, pages - 1);
  return { rooms: sorted.slice(current * perPage, (current + 1) * perPage), pages, page: current, counts, total: sorted.length };
}

/** The best waiting room this player can join right now, or null. Someone paying from their wallet gets the cheapest. */
export function quickPlayRoom(games: Game[], balance: number, account: string, hosts: Hosts, cheapest = false): Game | null {
  const options = games.filter((g) => g.stage === 'waiting' && g.fee <= balance && g.players.length < g.maxPlayers && !g.players.includes(account));
  return [...options].sort((a, b) => (cheapest ? a.fee - b.fee : 0) || roomScore(b, hosts) - roomScore(a, hosts) || a.id.localeCompare(b.id))[0] ?? null;
}
