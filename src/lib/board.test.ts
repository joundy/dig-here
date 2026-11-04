import { describe, expect, it } from 'vitest';
import { boardView, quickPlayRoom, roomScore } from './board';
import type { BoardOptions } from './board';
import { createGame, joinGame } from './game/engine';
import type { Game, MapId } from './game/types';

const hostsTable: Record<string, { finished: number; expired: number }> = {
  'good.near': { finished: 20, expired: 0 },
  'spam.near': { finished: 0, expired: 6 },
};
const hosts = (a: string) => hostsTable[a] ?? { finished: 0, expired: 0 };

function room(id: string, over: Partial<{ host: string; fee: number; hostCutBps: number; mapId: MapId; maxPlayers: number; players: number; countdownSec: number }> = {}): Game {
  const { players = 0, ...rest } = over;
  const game = createGame(id, { name: id, host: 'good.near', mapId: 'tropical', fee: 1000, durationSec: 180, hostCutBps: 500, minPlayers: 2, maxPlayers: 10, countdownSec: 0, ...rest });
  for (let i = 0; i < players; i++) joinGame(game, `p${i}`);
  return game;
}

const options: BoardOptions = { tab: 'waiting', sort: 'best', map: 'all', maxFee: null, hideFull: false, page: 0, perPage: 6 };

describe('boardView', () => {
  it('sinks empty spam rooms below real ones', () => {
    const spam = Array.from({ length: 5 }, (_, i) => room(`spam${i}`, { host: 'spam.near' }));
    const real = room('real', { players: 1 });
    expect(roomScore(real, hosts)).toBeGreaterThan(roomScore(spam[0], hosts));
    expect(boardView([...spam, real], options, hosts).rooms[0].id).toBe('real');
  });

  it('sorts by each option', () => {
    const a = room('a', { fee: 500, hostCutBps: 1000, players: 1 });
    const b = room('b', { fee: 2000, hostCutBps: 100, players: 3 });
    const first = (sort: BoardOptions['sort']) => boardView([a, b], { ...options, sort }, hosts).rooms[0].id;
    expect(first('fee')).toBe('a');
    expect(first('pot')).toBe('b');
    expect(first('cut')).toBe('b');
    expect(first('players')).toBe('b');
  });

  it('puts rooms that will start soonest first', () => {
    const later = room('later');
    const soon = room('soon', { countdownSec: 30, players: 2 });
    expect(boardView([later, soon], { ...options, sort: 'soon' }, hosts).rooms[0].id).toBe('soon');
  });

  it('filters by map, fee, and full rooms', () => {
    const snow = room('snow', { mapId: 'snowy' });
    const pricey = room('pricey', { fee: 9000 });
    const full = room('full', { maxPlayers: 2, players: 2 });
    const games = [snow, pricey, full];
    expect(boardView(games, { ...options, map: 'snowy' }, hosts).rooms.map((g) => g.id)).toEqual(['snow']);
    expect(boardView(games, { ...options, maxFee: 1000 }, hosts).rooms.map((g) => g.id)).not.toContain('pricey');
    expect(boardView(games, { ...options, hideFull: true }, hosts).rooms.map((g) => g.id)).not.toContain('full');
  });

  it('pages without repeats, and pulls a stale page back into range', () => {
    const games = Array.from({ length: 14 }, (_, i) => room(`r${String(i).padStart(2, '0')}`));
    const one = boardView(games, options, hosts);
    const two = boardView(games, { ...options, page: 1 }, hosts);
    expect(one.pages).toBe(3);
    expect(one.rooms).toHaveLength(6);
    expect(new Set([...one.rooms, ...two.rooms].map((g) => g.id)).size).toBe(12);
    expect(boardView(games, { ...options, page: 99 }, hosts).page).toBe(2);
  });

  it('counts each tab', () => {
    const live = room('l');
    live.stage = 'live';
    const done = room('d');
    done.stage = 'refunded';
    expect(boardView([room('w'), live, done], options, hosts).counts).toEqual({ waiting: 1, live: 1, finished: 1 });
  });
});

describe('quickPlayRoom', () => {
  it('skips full, unaffordable, already-joined and started rooms', () => {
    const full = room('full', { maxPlayers: 2, players: 2 });
    const dear = room('dear', { fee: 99999, players: 3 });
    const mine = room('mine', { players: 3 });
    joinGame(mine, 'me');
    const started = room('started', { players: 3 });
    started.stage = 'live';
    const ok = room('ok', { players: 1 });
    expect(quickPlayRoom([full, dear, mine, started, ok], 5000, 'me', hosts)?.id).toBe('ok');
  });

  it('is null when nothing fits', () => {
    expect(quickPlayRoom([room('dear', { fee: 99999 })], 5000, 'me', hosts)).toBeNull();
  });
});
