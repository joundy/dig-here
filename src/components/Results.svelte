<script lang="ts">
  import { onDestroy, untrack } from 'svelte';
  import { audio } from '../lib/audio/audio.svelte';
  import { bonus, near, points } from '../lib/format';
  import { kindName, withArticle } from '../lib/game/copy';
  import { getMap } from '../lib/game/map';
  import { RULES } from '../lib/game/rules';
  import type { Game } from '../lib/game/types';
  import { buzz, ui } from '../lib/ui.svelte';
  import { world } from '../lib/world/world';
  import Parrot from './Parrot.svelte';

  const JACKPOT_MS = 4500;

  let { game, me, dramatic = false, ondone }: { game: Game; me: string; dramatic?: boolean; ondone?: () => void } = $props();

  const result = $derived(game.result!);
  const treasure = $derived(result.treasure);
  const isWinner = $derived(result.winner === me);
  const myDig = $derived(result.ranking.find((d) => d.account === me));
  const place = $derived(myDig ? result.ranking.indexOf(myDig) + 1 : 0);
  const neverDug = $derived(game.players.includes(me) && !myDig);
  const kind = $derived(treasure ? kindName(getMap(game.mapId).landmarks[treasure.landmarkId].kind) : '');
  const myPoints = $derived(result.seasonPoints[me] ?? 0);
  const jackpotWin = $derived(result.jackpotWin);
  const jackpotName = $derived(jackpotWin?.account === me ? 'You' : jackpotWin?.account);

  // Rows land from last place up to first, so the winner is the final beat.
  let revealed = $state(untrack(() => (dramatic ? 0 : result.ranking.length)));
  let announced = $state(untrack(() => !dramatic));
  let jackpotMoment = $state(false);
  const timers: ReturnType<typeof setTimeout>[] = [];

  $effect(() => {
    if (!dramatic) return;
    untrack(() => {
      const count = result.ranking.length;
      for (let i = 1; i <= count; i++) {
        timers.push(setTimeout(() => {
          revealed = i;
          audio.scoreRow(i / count);
        }, i * 170));
      }
      timers.push(setTimeout(() => {
        announced = true;
        if (isWinner) world.celebrate();
        if (jackpotWin) {
          jackpotMoment = true;
          buzz([120, 60, 120, 60, 120, 60, 400]);
          audio.jackpot();
          world.jackpotBurst();
          timers.push(setTimeout(() => (jackpotMoment = false), JACKPOT_MS));
        } else if (isWinner) {
          buzz([40, 60, 40, 60, 120]);
          audio.fanfare();
        } else if (myDig) {
          audio.lose();
        } else {
          audio.coin();
        }
        ondone?.();
      }, (count + 1) * 170));
    });
  });

  onDestroy(() => timers.forEach(clearTimeout));

  const headline = $derived.by(() => {
    if (isWinner) return `You win ${near(result.split.prize)}! Squawk!`;
    return `${result.winner} wins ${near(result.split.prize)}.`;
  });

  const detail = $derived.by(() => {
    const where = `It landed by ${withArticle(kind)}.`;
    if (neverDug) return `${where} You joined but never dug.`;
    if (isWinner || !myDig) return where;
    return `${where} You came ${place} of ${result.ranking.length}. Better dig next time.`;
  });

  const deedLine = $derived.by(() => {
    if (!result.deedOwner) return `Nobody owns the ${kind} NFT, so the share went to the jackpot.`;
    if (result.deedOwner === me) return `You own the ${kind} NFT, so you earned ${near(result.split.deed)}.`;
    return `${result.deedOwner} owns the ${kind} NFT and earned ${near(result.split.deed)}.`;
  });

  const refundLine = $derived(result.refundReason === 'expired' ? 'Not enough players joined.' : `A game needs ${RULES.minDigs} digs.`);
  const splitRows = $derived([
    { label: 'Winner', amount: result.split.prize },
    { label: game.host === me ? 'You hosted' : 'Host', amount: result.split.hostCut },
    { label: 'Jackpot', amount: result.split.jackpot },
    { label: 'NFT owner', amount: result.split.deed },
    { label: 'Season', amount: result.split.season },
  ]);
</script>

<div class="results">
  {#if game.stage === 'refunded'}
    <Parrot text="No treasure this time. Squawk!" plain="{refundLine} Every entry fee went back." instant={!dramatic} compact={ui.compact} />
  {:else}
    {#if announced}
      <Parrot text={headline} plain={detail} instant={!dramatic} />
    {:else}
      <Parrot text="And the scores are..." />
    {/if}

    {#if jackpotWin && announced}
      <p class="jackpot-line">Jackpot! {jackpotName} hit the exact pixel and won {near(jackpotWin.amount)}.</p>
    {/if}

    <table>
      <thead>
        <tr><th scope="col">Player</th><th scope="col" class="n">Close</th><th scope="col" class="n">Bonus</th><th scope="col" class="n">Score</th></tr>
      </thead>
      <tbody>
        {#each result.ranking as d, i (d.account)}
          {@const visible = result.ranking.length - i <= revealed}
          <tr class:win={i === 0 && visible} class:me={d.account === me} class:visible>
            <td>{d.account === me ? 'You' : d.account}</td>
            <td class="n">{points(d.closeness)}</td>
            <td class="n">{bonus(d.bonusBps)}{#if d.crowded}<span class="crowded" title="Crowded">{bonus(RULES.crowdBps)}</span>{/if}</td>
            <td class="n">{points(d.score)}</td>
          </tr>
        {/each}
      </tbody>
    </table>

    <dl class="split">
      <div class="total"><dt>Pot</dt><dd>{near(result.pot)}</dd></div>
      {#each splitRows as row}
        <div><dt>{row.label}</dt><dd>{near(row.amount)}</dd></div>
      {/each}
    </dl>

    <p class="line">{deedLine}</p>
    {#if myPoints}<p class="line points">You earned {myPoints} season points.</p>{/if}
  {/if}

  <a class="btn" href="#/">Find another game</a>
</div>

{#if jackpotMoment && jackpotWin}
  <div class="jackpot" role="alert">
    <p class="big">JACKPOT!</p>
    <p class="amount">{near(jackpotWin.amount)}</p>
    <p class="who">{jackpotName} hit the exact pixel!</p>
  </div>
{/if}

<style>
  table {
    width: 100%;
    margin: 0.9rem 0 0.6rem;
    border-collapse: collapse;
    font-size: 1.35rem;
    line-height: 1.1;
    font-variant-numeric: tabular-nums;
  }
  th {
    text-align: left;
    font-weight: 400;
    color: var(--mist);
    font-size: 1.15rem;
    padding: 0 0 0.15rem;
  }
  td {
    padding: 0.14rem 0;
    overflow-wrap: anywhere;
  }
  tbody tr {
    opacity: 0;
    transform: translateX(14px);
    transition: opacity 0.14s ease-out, transform 0.18s cubic-bezier(0.3, 1.5, 0.6, 1);
  }
  tbody tr.visible {
    opacity: 1;
    transform: none;
  }
  .n {
    text-align: right;
    padding-left: 0.6rem;
    white-space: nowrap;
  }
  th.n {
    text-align: right;
  }
  .crowded {
    margin-left: 0.3em;
    color: #ff8a8a;
  }
  .win td {
    color: var(--sun);
  }
  .me td {
    color: #ffb3d1;
  }
  .win.me td {
    color: var(--sun);
  }
  .results :global(.btn) {
    position: sticky;
    bottom: 0;
    margin-top: 0.75rem;
  }
  .split {
    margin: 0 0 0.5rem;
    display: grid;
    grid-template-columns: 1fr 1fr;
    gap: 0 1.25rem;
    color: var(--mist);
    font-size: 1.2rem;
    line-height: 1.15;
  }
  .split div {
    display: flex;
    justify-content: space-between;
    gap: 0.5rem;
  }
  .split .total {
    color: var(--foam);
  }
  dd {
    margin: 0;
    white-space: nowrap;
    font-variant-numeric: tabular-nums;
  }
  .line {
    margin: 0 0 0.25rem;
    color: var(--mist);
    font-size: 1.2rem;
    line-height: 1.15;
  }
  .points {
    color: var(--sun);
  }
  .jackpot-line {
    margin: 0.6rem 0 0;
    padding: 0.3rem 0.6rem;
    color: var(--ink);
    background: var(--sun);
    font-size: 1.3rem;
    line-height: 1.15;
  }
  /* Clicks pass through, so the moment can't block anything underneath. */
  .jackpot {
    position: fixed;
    top: 30%;
    left: 0;
    right: 0;
    z-index: 40;
    padding: 1rem 0.5rem 1.4rem;
    text-align: center;
    pointer-events: none;
    background: var(--ink);
    box-shadow: 0 -6px 0 var(--sun), 0 6px 0 var(--sun), 0 -12px 0 var(--pink), 0 12px 0 var(--pink);
    animation: slam 0.45s cubic-bezier(0.3, 1.6, 0.6, 1);
  }
  .jackpot p {
    margin: 0;
  }
  .big {
    font-family: var(--display);
    font-size: clamp(4.5rem, 21vw, 11rem);
    line-height: 0.85;
    color: var(--sun);
    animation: throb 0.4s steps(2) infinite alternate;
  }
  .amount {
    font-family: var(--display);
    font-size: clamp(2.4rem, 9vw, 4.5rem);
    line-height: 1;
    color: var(--foam);
  }
  .who {
    font-size: 1.5rem;
    line-height: 1.1;
    color: #ffb3d1;
  }
  @keyframes slam {
    from { transform: scale(1.8); opacity: 0; }
  }
  @keyframes throb {
    to { transform: scale(1.05); }
  }
  :global(.stage.compact.game) table {
    margin: 0.5rem 0 0.4rem;
    font-size: 1.2rem;
  }
  :global(.stage.compact.game) .split {
    gap: 0 0.75rem;
    font-size: 1.1rem;
  }
  :global(.stage.compact.game) .line {
    font-size: 1.1rem;
  }
</style>
