<script lang="ts">
  import { onMount } from 'svelte';
  import { audio } from '../lib/audio/audio.svelte';
  import { backend } from '../lib/backend';
  import type { DeedEvent } from '../lib/game/economy';
  import { ago, near, percent } from '../lib/format';
  import { kindName, mapName } from '../lib/game/copy';
  import { deedChance, deedCount } from '../lib/game/economy';
  import { LANDMARKS_PER_MAP } from '../lib/game/map';
  import { RULES } from '../lib/game/rules';
  import { ALL_DEEDS, canAfford, islandStats, parsePrice } from '../lib/market';
  import type { DeedRow } from '../lib/market';
  import { explorer, FAUCET_URL, GAS_TGAS } from '../lib/near/config';
  import { attachFor } from '../lib/pay';
  import { ui } from '../lib/ui.svelte';
  import DeedArt from './DeedArt.svelte';
  import MapBadge from './MapBadge.svelte';
  import Sprite from './Sprite.svelte';
  import Who from './Who.svelte';

  let { row }: { row: DeedRow } = $props();

  type Form = '' | 'list' | 'price' | 'send';

  const WON_MS = 1400;
  const CLOCK_MS = 30_000;

  let form = $state<Form>('');
  let priceText = $state('');
  let sendTo = $state('');
  /** A wallet window is up, or the move it signed is on its way. */
  let waiting = $state(false);
  let error = $state('');
  let note = $state('');
  let heading = $state<HTMLHeadingElement>();
  /** Just became theirs, or just changed. Lights the frame for a moment. */
  let won = $state(false);

  const me = $derived(backend.account);
  const deed = $derived(backend.deedOf(row.id));
  const mine = $derived(!!me && deed.owner === me);
  const listed = $derived(deed.owner !== null && deed.price !== null);
  const signedIn = $derived(backend.identity.kind !== 'none');
  const title = $derived(kindName(row.kind).replace(/^./, (c) => c.toUpperCase()));
  const chance = $derived(deedChance(row.map, row.kind));
  const count = $derived(deedCount(row.map, row.kind));
  const island = $derived(islandStats(row.map, (id) => backend.deedOf(id)));
  const siblings = $derived(ALL_DEEDS.filter((other) => other.map === row.map && other.id !== row.id));
  const history = $derived(backend.deedHistory(row.id));
  const wallet = $derived(backend.walletOf(me));
  const balance = $derived(backend.balanceOf(me));
  const buyCheck = $derived(listed && !mine && signedIn && backend.walletKnown ? canAfford(deed.price!, GAS_TGAS.market_buy, wallet) : { ok: true as const });
  const mintCheck = $derived(deed.owner === null && signedIn && backend.walletKnown ? canAfford(Math.max(0, backend.prices.mintPrice - balance), GAS_TGAS.mint_nft, wallet) : { ok: true as const });
  const parsed = $derived(parsePrice(priceText));
  let now = $state(backend.nowMs());

  onMount(() => {
    heading?.focus({ preventScroll: true });
    // It may have been a while, and this decides whether Buy is on offer.
    backend.refreshBalances();
    const timer = setInterval(() => (now = backend.nowMs()), CLOCK_MS);
    return () => clearInterval(timer);
  });

  /** Resolving to false means it stepped aside without doing anything, as when the top-up was closed. */
  async function act(action: () => Promise<void | false>, done: string) {
    error = note = '';
    try {
      if ((await action()) === false) return;
      audio.coin();
      note = done;
      form = '';
      won = true;
      setTimeout(() => (won = false), WON_MS);
    } catch (e) {
      // An empty message means they backed out of connecting, which needs no telling off.
      const message = (e as Error).message;
      if (message) {
        error = message;
        audio.error();
      }
    } finally {
      waiting = false;
    }
  }

  function mint() {
    void act(async () => {
      await backend.ensureAccount();
      const attach = await attachFor(`Mint the ${title} NFT`, backend.prices.mintPrice, 50);
      if (attach === null) return false;
      waiting = true;
      await backend.mintDeed(row.id, attach);
    }, `You minted the ${title} NFT. Every time the treasure lands by ${withArticle(kindName(row.kind))}, you earn.`);
  }

  function buy() {
    const price = deed.price!;
    void act(async () => {
      await backend.ensureAccount();
      // Just signed in, this is the first look at their wallet, and the panel can now say what's missing.
      if (backend.account === deed.owner) return false;
      if (!canAfford(price, GAS_TGAS.market_buy, backend.walletOf(backend.account)).ok) return false;
      waiting = true;
      await backend.buyDeed(row.id, price);
    }, `The ${title} NFT is yours, and ${near(price)} went to the seller.`);
  }

  function openForm(next: Form) {
    form = next;
    priceText = next === 'price' && deed.price !== null ? String(deed.price / 1000) : '';
    sendTo = '';
    error = note = '';
  }

  function submitPrice(event: SubmitEvent) {
    event.preventDefault();
    if ('error' in parsed) {
      error = parsed.error;
      audio.error();
      return;
    }
    const { milli } = parsed;
    waiting = true;
    if (form === 'list') void act(() => backend.listDeed(row.id, milli), `Listed for ${near(milli)}. When it sells, the coins land in your wallet.`);
    else void act(() => backend.changeDeedPrice(row.id, milli), `Price changed to ${near(milli)}.`);
  }

  function delist() {
    waiting = true;
    void act(() => backend.delistDeed(row.id), 'Off the market. It stays yours.');
  }

  function send(event: SubmitEvent) {
    event.preventDefault();
    const to = sendTo.trim();
    waiting = true;
    void act(() => backend.transferDeed(row.id, to), `Sent to ${to}.`);
  }

  const withArticle = (noun: string) => `${/^[aeiou]/.test(noun) ? 'an' : 'a'} ${noun}`;

  const EVENT_WORDS: Record<DeedEvent['kind'], string> = {
    minted: 'Minted',
    listed: 'Listed',
    price: 'New price',
    delisted: 'Taken off the market',
    sold: 'Sold',
    failed: 'A sale fell through',
    sent: 'Sent',
    landed: 'Treasure landed here',
  };
</script>

{#snippet trouble()}
  {#if backend.deedsError}
    <p class="short" role="status">{backend.deedsError} <button class="link" onclick={() => backend.reloadDeeds()}>Try again</button></p>
  {/if}
{/snippet}

<article class="detail {row.map}">
  <a class="back" href="#/deeds">‹ All NFTs</a>

  <div class="top">
    <figure class="hero" class:won>
      <DeedArt map={row.map} kind={row.kind} scale={ui.compact ? 6 : ui.short ? 5 : 8} live alt="{title}, {mapName(row.map)}" />
    </figure>

    <div class="side">
      <p class="set"><MapBadge mapId={row.map} /> {#if backend.deedsReady}<span>{island.minted} of {island.total} minted</span>{/if}</p>
      <h1 bind:this={heading} tabindex="-1">{title}</h1>
      <p class="owner">
        {#if !backend.deedsReady}Looking up who owns this…{:else if mine}<span class="you">You own this</span>{:else if deed.owner}Owned by <Who account={deed.owner} {me} />{:else}Nobody owns this yet{/if}
      </p>
      <p class="pitch">Whoever owns it earns {percent(RULES.deedBps)} of the pot each time the treasure lands by {withArticle(kindName(row.kind))} on this island.</p>

      <div class="deal" class:waiting aria-busy={waiting || !backend.deedsReady}>
        {#if !backend.deedsReady}
          {#if backend.deedsError}
            <p class="short" role="alert">{backend.deedsError}</p>
            <button class="btn alt" onclick={() => backend.reloadDeeds()}>Try again</button>
          {:else}
            <p class="tagline">Reading the chain</p>
            <div class="reading" aria-hidden="true"><span></span><span></span></div>
          {/if}
        {:else if waiting}
          <div class="wait" role="status">
            <span class="dig"><Sprite name="shovel" scale={3} /></span>
            <div>
              <strong>Waiting for your wallet</strong>
              <p>Approve it in the wallet window. Closing that window cancels this, and nothing is spent.</p>
            </div>
          </div>
        {:else if form === 'list' || form === 'price'}
          {@render trouble()}
          <form onsubmit={submitPrice}>
            <label>
              <span class="label">{form === 'list' ? 'Your price' : 'New price'}, in NEAR</span>
              <input class="input" bind:value={priceText} inputmode="decimal" autocomplete="off" placeholder="1.5" aria-describedby="price-help" />
            </label>
            <p class="fine" id="price-help">
              {#if form === 'list'}
                Your wallet approves this once, then the market can sell it only at your price. When it sells, the coins land in your wallet, not your game balance. You keep earning until then.
              {:else}
                Your wallet confirms the change. Someone mid-purchase at the old price gets a refund if it went up.
              {/if}
              {#if island.floor !== null} Cheapest on this island right now: {near(island.floor)}.{/if}
            </p>
            <div class="buttons">
              <button class="btn" type="submit">{form === 'list' ? 'List for sale' : 'Change price'}</button>
              <button class="plain" type="button" onclick={() => openForm('')}>Cancel</button>
            </div>
          </form>
        {:else if form === 'send'}
          <form onsubmit={send}>
            <label>
              <span class="label">Send to account</span>
              <input class="input" bind:value={sendTo} placeholder="name.testnet" autocomplete="off" />
            </label>
            <p class="fine">It costs nothing and can't be undone. The new owner earns from here on.{#if listed} Sending it ends your listing.{/if}</p>
            <div class="buttons">
              <button class="btn" type="submit" disabled={!sendTo.trim()}>Send</button>
              <button class="plain" type="button" onclick={() => openForm('')}>Cancel</button>
            </div>
          </form>
        {:else if listed && deed.saleInProgress}
          <p class="tagline">Sale on its way</p>
          <p class="price"><Sprite name="coin" scale={3} /> {near(deed.price!)}</p>
          <p class="fine">Someone's purchase is going through right now. If it falls through, this goes back on sale by itself.</p>
        {:else if mine && listed}
          <p class="tagline">Your listing</p>
          <p class="price"><Sprite name="coin" scale={3} /> {near(deed.price!)}</p>
          <p class="fine">When it sells, the coins go straight to your wallet. You keep earning until then.</p>
          <div class="buttons">
            <button class="btn alt" onclick={() => openForm('price')}>Change price</button>
            <button class="plain" onclick={delist}>Take off market</button>
          </div>
        {:else if mine}
          {@render trouble()}
          <p class="tagline">Not on the market</p>
          <p class="fine">Keep it and carry on earning, or set a price. Sales pay straight to your wallet.</p>
          <div class="buttons">
            <button class="btn" onclick={() => openForm('list')}>List for sale</button>
          </div>
        {:else if listed}
          <p class="tagline">For sale</p>
          <p class="price"><Sprite name="coin" scale={3} /> {near(deed.price!)}</p>
          {#if !buyCheck.ok}
            <p class="short" role="status">
              Your wallet is {near(buyCheck.short)} short. It has {near(wallet)}, and the network wants a little kept back for the move.
              {#if backend.testnet}<a href={FAUCET_URL} target="_blank" rel="noopener">Get free test coins</a>{/if}
            </p>
            <button class="btn" disabled>Buy for {near(deed.price!)}</button>
          {:else}
            <button class="btn" onclick={buy}>{signedIn ? `Buy for ${near(deed.price!)}` : 'Connect and buy'}</button>
          {/if}
          <p class="fine">You pay from your wallet, not your game balance, and the coins go straight to the seller's wallet.</p>
        {:else if deed.owner === null}
          <p class="tagline">Ready to mint</p>
          <p class="price"><Sprite name="coin" scale={3} /> {near(backend.prices.mintPrice)}</p>
          {#if !mintCheck.ok}
            <p class="short" role="status">
              You're {near(mintCheck.short)} short, counting your wallet and your game balance.
              {#if backend.testnet}<a href={FAUCET_URL} target="_blank" rel="noopener">Get free test coins</a>{/if}
            </p>
            <button class="btn" disabled>Mint for {near(backend.prices.mintPrice)}</button>
          {:else}
            <button class="btn" onclick={mint}>{signedIn ? `Mint for ${near(backend.prices.mintPrice)}` : 'Connect and mint'}</button>
          {/if}
          <p class="fine">Comes out of your game balance, and your wallet tops it up if it's short. There's only ever one of these.</p>
        {:else if backend.deedsError}
          <p class="tagline">Price unknown</p>
          {@render trouble()}
        {:else}
          <p class="tagline">Not for sale</p>
          <p class="fine">Its owner is keeping it for now. If they list it, it shows up under For sale.</p>
        {/if}

        {#if error}<p class="error" role="alert">{error}</p>{/if}
        {#if note}<p class="note" role="status">{note}</p>{/if}
      </div>

      {#if mine && backend.canTransferDeeds && !waiting && form === ''}
        <button class="plain send" onclick={() => openForm('send')}>Send to someone</button>
      {/if}

      <dl class="stats">
        <div>
          <dt>Chance</dt>
          <dd>{Math.round(chance * 100)}%</dd>
          <p>{count} of the {LANDMARKS_PER_MAP} landmarks on this island</p>
        </div>
        <div>
          <dt>Landings</dt>
          <dd>{deed.landings}</dd>
          <p>times the treasure landed by one</p>
        </div>
        <div>
          <dt>Earned</dt>
          <dd>{near(deed.earned)}</dd>
          <p>paid to its owners so far</p>
        </div>
      </dl>
    </div>
  </div>

  <div class="lower">
    <section class="activity">
      <h2>Activity</h2>
      {#if history === null}
        <p class="quiet">The history isn't available right now. It comes back with the game server. Everything above is straight from the chain.</p>
      {:else if history.length === 0}
        <p class="quiet">Nothing has happened to this one yet.</p>
      {:else}
        <ol>
          {#each history as event (`${event.kind}${event.at}`)}
            <li class={event.kind}>
              <span class="what">
                <b>{EVENT_WORDS[event.kind]}</b>
                {#if event.kind === 'sold' || event.kind === 'sent'}
                  <span class="who"><Who account={event.from ?? ''} {me} you="you" /> to <Who account={event.to ?? ''} {me} you="you" /></span>
                {:else if event.kind === 'landed' && event.to}
                  <span class="who"><Who account={event.to} {me} you="you" /> earned</span>
                {:else if event.to ?? event.from}
                  <span class="who">by <Who account={(event.to ?? event.from)!} {me} you="you" /></span>
                {/if}
              </span>
              <span class="sum">
                {#if event.price !== null}<strong>{near(event.price)}</strong>{/if}
                {#if backend.testnet && event.tx}<a href={explorer.tx(event.tx)} target="_blank" rel="noopener">{ago(event.at, now)}</a>{:else}<span>{ago(event.at, now)}</span>{/if}
              </span>
            </li>
          {/each}
        </ol>
      {/if}
    </section>

    <section class="more">
      <h2>More from {mapName(row.map)}</h2>
      <ul>
        {#each siblings as other (other.id)}
          {@const sibling = backend.deedOf(other.id)}
          <li>
            <a href="#/deeds/{other.id}" title={kindName(other.kind)}>
              <span class="thumb"><Sprite name={other.kind} scale={2} /></span>
              <span class="tiny">
                {#if sibling.owner !== null && sibling.price !== null}{near(sibling.price)}{:else if sibling.owner === null}Mint{:else}Owned{/if}
              </span>
            </a>
          </li>
        {/each}
      </ul>
    </section>
  </div>
</article>

<style>
  .detail {
    display: grid;
    gap: 0.75rem;
  }
  .back {
    justify-self: start;
    padding: 0.2rem 0;
    font-size: 1.25rem;
    color: var(--mist);
    text-decoration: none;
  }
  .back:hover {
    color: var(--foam);
  }
  .top {
    display: grid;
    grid-template-columns: minmax(0, 6fr) minmax(0, 5fr);
    gap: 1.25rem;
    align-items: start;
  }
  .hero {
    --frame: 3px;
    margin: var(--frame);
    aspect-ratio: 8 / 7;
    box-shadow:
      0 calc(-1 * var(--frame)) 0 0 var(--set),
      0 var(--frame) 0 0 var(--set),
      calc(-1 * var(--frame)) 0 0 0 var(--set),
      var(--frame) 0 0 0 var(--set);
  }
  .hero.won {
    animation: won 1.4s steps(7);
  }
  @keyframes won {
    0%, 28%, 56% { --set: var(--sun); box-shadow: 0 0 0 6px var(--sun); }
    14%, 42%, 70% { box-shadow: 0 0 0 3px var(--foam); }
  }
  .side {
    display: grid;
    gap: 0.45rem;
    min-width: 0;
  }
  .set {
    display: flex;
    flex-wrap: wrap;
    align-items: center;
    justify-content: space-between;
    gap: 0.2rem 0.75rem;
    margin: 0;
    color: var(--set);
    font-size: 1.2rem;
    line-height: 1.1;
  }
  .set > span:last-child {
    color: var(--mist);
  }
  h1 {
    margin: 0;
    font-family: var(--display);
    font-size: clamp(3.2rem, 6vw, 4.6rem);
    font-weight: 400;
    line-height: 0.9;
    color: var(--foam);
    outline: none;
  }
  .owner {
    margin: 0;
    font-size: 1.3rem;
    line-height: 1.15;
    color: var(--mist);
  }
  .you {
    color: #ffb3d1;
  }
  .pitch {
    margin: 0;
    font-size: 1.2rem;
    line-height: 1.15;
    color: var(--mist);
    max-width: 30rem;
  }
  .deal {
    display: grid;
    gap: 0.45rem;
    margin-top: 0.25rem;
    padding: 0.7rem 0.75rem 0.8rem;
    background: var(--deep);
  }
  .tagline {
    margin: 0;
    font-size: 1.25rem;
    line-height: 1;
    color: var(--mist);
  }
  .price {
    display: flex;
    align-items: center;
    gap: 0.5rem;
    margin: 0;
    font-family: var(--display);
    font-size: 3rem;
    line-height: 1;
    color: var(--sun);
  }
  .fine {
    margin: 0;
    font-size: 1.15rem;
    line-height: 1.15;
    color: var(--mist);
  }
  .short {
    margin: 0;
    padding: 0.3rem 0.5rem;
    font-size: 1.2rem;
    line-height: 1.15;
    color: var(--ink);
    background: var(--sand);
  }
  .buttons {
    display: flex;
    align-items: center;
    flex-wrap: wrap;
    gap: 0.5rem 0.9rem;
  }
  .buttons .btn {
    flex: 1 1 10rem;
    width: auto;
  }
  .deal .btn:disabled {
    cursor: not-allowed;
    filter: saturate(0.3);
  }
  .plain {
    min-height: 2.75rem;
    padding: 0 0.25rem;
    font: inherit;
    font-size: 1.2rem;
    color: var(--mist);
    background: none;
    border: 0;
    text-decoration: underline;
    cursor: pointer;
  }
  .plain:hover {
    color: var(--foam);
  }
  .send {
    justify-self: start;
  }
  form {
    display: grid;
    gap: 0.45rem;
  }
  .label {
    display: block;
    margin-bottom: 0.15rem;
    font-size: 1.2rem;
    color: var(--mist);
  }
  .wait {
    display: flex;
    align-items: center;
    gap: 0.75rem;
    min-height: 6rem;
  }
  .wait strong {
    display: block;
    font-family: var(--display);
    font-size: 1.9rem;
    font-weight: 400;
    line-height: 1;
    color: var(--sun);
  }
  .wait p {
    margin: 0.2rem 0 0;
    font-size: 1.15rem;
    line-height: 1.15;
    color: var(--mist);
  }
  .dig {
    flex: none;
    transform-origin: 50% 90%;
    animation: dig 0.7s steps(3) infinite alternate;
  }
  @keyframes dig {
    from { transform: rotate(-16deg); }
    to { transform: rotate(16deg) translateY(4px); }
  }
  .link {
    padding: 0;
    font: inherit;
    color: inherit;
    background: none;
    border: 0;
    text-decoration: underline;
    cursor: pointer;
  }
  .reading {
    display: grid;
    gap: 0.4rem;
    animation: reading 1.2s steps(4) infinite alternate;
  }
  .reading span {
    height: 1.4rem;
    background: rgb(247 247 238 / 0.14);
  }
  .reading span:first-child {
    width: 55%;
    height: 2.6rem;
  }
  @keyframes reading {
    from { opacity: 0.45; }
    to { opacity: 0.95; }
  }
  .note {
    margin: 0;
    padding: 0.3rem 0.5rem;
    font-size: 1.2rem;
    line-height: 1.15;
    color: var(--ink);
    background: var(--sun);
  }
  .deal .error {
    margin: 0;
  }
  .stats {
    display: grid;
    grid-template-columns: repeat(3, minmax(0, 1fr));
    gap: 0.4rem;
    margin: 0;
  }
  .stats div {
    padding: 0.45rem 0.6rem 0.55rem;
    background: var(--deep);
  }
  .stats dt {
    font-size: 1.15rem;
    line-height: 1;
    color: var(--mist);
  }
  .stats dd {
    margin: 0.1rem 0;
    font-family: var(--display);
    font-size: 2.1rem;
    line-height: 1;
    white-space: nowrap;
  }
  .stats p {
    margin: 0;
    font-size: 1.05rem;
    line-height: 1.1;
    color: var(--mist);
  }
  .lower {
    display: grid;
    grid-template-columns: minmax(0, 6fr) minmax(0, 5fr);
    gap: 1.25rem;
  }
  h2 {
    margin: 0 0 0.35rem;
    font-family: var(--display);
    font-size: 1.7rem;
    font-weight: 400;
    line-height: 1;
  }
  .quiet {
    margin: 0;
    font-size: 1.15rem;
    line-height: 1.15;
    color: var(--mist);
  }
  .activity ol {
    display: grid;
    gap: 0.2rem;
    margin: 0;
    padding: 0;
    list-style: none;
  }
  .activity li {
    display: flex;
    justify-content: space-between;
    gap: 0.75rem;
    padding: 0.2rem 0.5rem 0.3rem;
    font-size: 1.15rem;
    line-height: 1.15;
    background: var(--deep);
  }
  .activity li.sold {
    box-shadow: inset 3px 0 0 var(--sun);
  }
  .activity li.landed {
    box-shadow: inset 3px 0 0 var(--set);
  }
  .activity b {
    font-weight: 400;
  }
  .what {
    display: grid;
    min-width: 0;
  }
  .who {
    color: var(--mist);
    font-size: 1.05rem;
    overflow: hidden;
    white-space: nowrap;
    text-overflow: ellipsis;
  }
  .sum {
    display: grid;
    justify-items: end;
    flex: none;
    color: var(--mist);
    font-size: 1.05rem;
  }
  .sum strong {
    font-weight: 400;
    font-size: 1.15rem;
    color: var(--sun);
  }
  .more ul {
    display: grid;
    grid-template-columns: repeat(auto-fill, minmax(4.2rem, 1fr));
    gap: 0.3rem;
    margin: 0;
    padding: 0;
    list-style: none;
  }
  .more a {
    display: grid;
    justify-items: center;
    gap: 0.1rem;
    padding: 0.25rem 0.1rem 0.15rem;
    color: var(--mist);
    text-decoration: none;
    background: var(--deep);
  }
  .more a:hover {
    color: var(--foam);
    background: var(--sea);
  }
  .thumb {
    display: grid;
    place-items: end center;
    height: 2.8rem;
  }
  .tiny {
    font-size: 1rem;
    line-height: 1;
    white-space: nowrap;
    overflow: hidden;
    max-width: 100%;
  }

  @media (max-width: 760px) and (orientation: portrait) {
    .top,
    .lower {
      grid-template-columns: minmax(0, 1fr);
      gap: 0.75rem;
    }
    .hero {
      aspect-ratio: 16 / 11;
    }
    /* The price and the button come first on a small screen, and what it earns can wait a moment. */
    .pitch {
      order: 1;
    }
    .stats {
      order: 2;
    }
    h1 {
      font-size: 3.2rem;
    }
    .price {
      font-size: 2.6rem;
    }
    .stats p {
      display: none;
    }
    .stats dd {
      font-size: 1.65rem;
    }
  }
</style>
