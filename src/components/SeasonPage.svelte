<script lang="ts">
  import { backend } from '../lib/backend';
  import { longTime, near } from '../lib/format';
  import { RULES } from '../lib/game/rules';
  import Sprite from './Sprite.svelte';
  import Who from './Who.svelte';

  const TOP = 10;
  const PLACES = ['1st', '2nd', '3rd'];

  let now = $state(backend.nowMs());

  $effect(() => {
    const timer = setInterval(() => (now = backend.nowMs()), 1000);
    return () => clearInterval(timer);
  });

  const me = $derived(backend.account);
  const season = $derived(backend.season);
  const ranking = $derived(backend.seasonRanking());
  const rank = $derived(ranking.findIndex((row) => row.account === me) + 1);
  const top = $derived(ranking.slice(0, TOP).map((row, i) => ({ ...row, place: i + 1 })));
  const prizes = $derived(RULES.seasonPrizeBps.map((bps) => Math.floor((season.pool * bps) / 10000)));
  const [first, second, third] = RULES.seasonPointsPerNear;
</script>

<section class="panel season">
  <header>
    <h1>Season {season.number}</h1>
    <a class="back" href="#/">Back to games</a>
  </header>

  <div class="stats">
    <div class="stat pool">
      <span class="label">Prize pool</span>
      <span class="value big"><Sprite name="coin" scale={4} /> {near(season.pool)}</span>
    </div>
    <div class="stat">
      <span class="label">Time left</span>
      <span class="value">{longTime((season.endsAt - now) / 1000)}</span>
    </div>
    <div class="stat">
      <span class="label">Your rank</span>
      <span class="value">{rank ? `#${rank}` : 'Unranked'}</span>
    </div>
  </div>

  <ol class="prizes">
    {#each prizes as prize, i}
      <li><span class="label">{PLACES[i]}</span> <span class="amount">{near(prize)}</span></li>
    {/each}
  </ol>

  <p class="how">Rounds with {RULES.seasonMinDigs}+ digs count. Per NEAR in the pot: 1st gets {first} points, 2nd {second}, 3rd {third}.</p>

  <div class="columns" class:both={season.lastWinners.length > 0}>
    <div>
      <h2>Top players</h2>
      {#if top.length}
        <table>
          <thead>
            <tr><th class="place">#</th><th>Player</th><th class="points">Points</th></tr>
          </thead>
          <tbody>
            {#each top as row (row.account)}
              <tr class:me={row.account === me}>
                <td class="place">{row.place}</td>
                <td class="player"><Who account={row.account} {me} /></td>
                <td class="points">{row.points}</td>
              </tr>
            {/each}
            {#if rank > TOP}
              <tr class="me">
                <td class="place">{rank}</td>
                <td class="player"><Who account={me} {me} /></td>
                <td class="points">{ranking[rank - 1].points}</td>
              </tr>
            {/if}
          </tbody>
        </table>
      {:else}
        <p class="empty">Nobody has scored yet. The podium is lonely.</p>
      {/if}
    </div>

    {#if season.lastWinners.length}
      <div>
        <h2>Last season</h2>
        <ol class="winners">
          {#each season.lastWinners as winner, i}
            <li class:me={winner.account === me}>
              <span class="label">{PLACES[i]}</span>
              <span class="player"><Who account={winner.account} {me} /></span>
              <span class="amount">{near(winner.prize)}</span>
            </li>
          {/each}
        </ol>
      </div>
    {/if}
  </div>
</section>

<style>
  .season {
    display: grid;
    gap: 0.75rem;
  }
  header {
    display: flex;
    align-items: baseline;
    justify-content: space-between;
    gap: 1rem;
  }
  h1 {
    margin: 0;
    font-family: var(--display);
    font-size: 2.8rem;
    font-weight: 400;
    line-height: 1;
    color: var(--sun);
    white-space: nowrap;
  }
  .back {
    font-size: 1.2rem;
    text-align: right;
  }
  h2 {
    margin: 0 0 0.3rem;
    font-size: 1.5rem;
    font-weight: 400;
    line-height: 1;
  }
  .stats {
    display: grid;
    grid-template-columns: 2fr 1fr 1fr;
    gap: 0.4rem;
  }
  .stat {
    display: grid;
    align-content: start;
    gap: 0.25rem;
    padding: 0.5rem 0.7rem;
    background: var(--deep);
  }
  .label {
    font-size: 1.15rem;
    line-height: 1;
    color: var(--mist);
  }
  .value {
    display: flex;
    align-items: center;
    gap: 0.4rem;
    font-size: 1.7rem;
    line-height: 1;
    white-space: nowrap;
    font-variant-numeric: tabular-nums;
  }
  .big {
    font-family: var(--display);
    font-size: 2.6rem;
    color: var(--sun);
  }
  .prizes {
    display: grid;
    grid-template-columns: repeat(3, 1fr);
    gap: 0.4rem;
    margin: 0;
    padding: 0;
    list-style: none;
  }
  .prizes li {
    display: flex;
    align-items: baseline;
    justify-content: space-between;
    flex-wrap: wrap;
    gap: 0 0.4rem;
    padding: 0.3rem 0.6rem;
    background: var(--deep);
  }
  .amount {
    color: var(--sun);
    white-space: nowrap;
  }
  .how {
    margin: 0;
    font-size: 1.25rem;
    line-height: 1.15;
    color: var(--mist);
  }
  .columns {
    display: grid;
    gap: 1rem;
  }
  .columns.both {
    grid-template-columns: minmax(0, 2fr) minmax(0, 1fr);
  }
  table {
    width: 100%;
    border-collapse: collapse;
    table-layout: fixed;
    font-size: 1.3rem;
  }
  th {
    padding: 0.1rem 0.5rem;
    font-size: 1.1rem;
    font-weight: 400;
    text-align: left;
    color: var(--mist);
  }
  td {
    padding: 0.15rem 0.5rem;
    line-height: 1.15;
  }
  tbody tr:nth-child(odd) {
    background: var(--deep);
  }
  tr.me,
  tbody tr.me:nth-child(odd) {
    color: var(--ink);
    background: var(--sun);
  }
  .place {
    width: 2.75rem;
    font-variant-numeric: tabular-nums;
  }
  .player {
    overflow: hidden;
    white-space: nowrap;
    text-overflow: ellipsis;
  }
  .points {
    width: 5rem;
    text-align: right;
    font-variant-numeric: tabular-nums;
  }
  .empty {
    margin: 0;
    padding: 1.5rem 1rem;
    text-align: center;
    font-size: 1.3rem;
    background: var(--deep);
  }
  .winners {
    display: grid;
    gap: 0.25rem;
    margin: 0;
    padding: 0;
    list-style: none;
  }
  .winners li {
    display: grid;
    grid-template-columns: auto minmax(0, 1fr) auto;
    align-items: baseline;
    gap: 0.5rem;
    padding: 0.2rem 0.5rem;
    background: var(--deep);
  }
  .winners li.me {
    outline: var(--px) solid var(--sun);
    outline-offset: calc(-1 * var(--px));
  }
  @media (max-width: 760px) {
    .stats {
      grid-template-columns: 1fr 1fr;
    }
    .pool {
      grid-column: 1 / -1;
    }
    .columns.both {
      grid-template-columns: minmax(0, 1fr);
    }
  }
</style>
