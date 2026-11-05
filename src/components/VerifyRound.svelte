<script lang="ts">
  import { backend } from '../lib/backend';
  import { fromBase58ToHex } from '../lib/base58';
  import { explorer } from '../lib/near/config';
  import type { ChainRoom } from '../lib/near/rooms';
  import { blockAt } from '../lib/near/rpc';
  import { overallState, verifyRound } from '../lib/verify';
  import type { Check, CheckGroup } from '../lib/verify';

  let { gameId, onclose }: { gameId: string; onclose: () => void } = $props();

  type BlockLine = { label: string; height: number; hash: string | null };
  type RandomLine = { step: number; height: number; randomValue: string; lockSeed: string; same: boolean };

  let dialog = $state<HTMLDialogElement>();
  let room = $state.raw<ChainRoom | null>(null);
  let groups = $state.raw<CheckGroup[]>([]);
  let failed = $state(false);
  let blocks = $state.raw<BlockLine[]>([]);
  let randoms = $state.raw<RandomLine[]>([]);
  let randomError = $state(false);

  const overall = $derived(groups.length ? overallState(groups) : null);
  const passed = $derived(groups.reduce((sum, g) => sum + g.checks.filter((c) => c.state === 'pass').length, 0));
  const hadRolls = $derived(!!room?.rolls?.some((r) => r.lock_seed));
  const allDiffer = $derived(randoms.length > 0 && randoms.every((r) => !r.same));
  const allSame = $derived(randoms.length > 0 && randoms.every((r) => r.same));

  $effect(() => {
    const el = dialog;
    el?.showModal();
    return () => el?.close();
  });

  $effect(() => {
    void load();
  });

  async function load() {
    try {
      const proof = await backend.proofOf(gameId);
      if (!proof) {
        failed = true;
        return;
      }
      room = proof;
      groups = verifyRound(proof);
      await loadBlocks(proof);
    } catch {
      failed = true;
    }
  }

  // A block's random value is the one thing here the contract doesn't report itself. Reading it means
  // going to the chain, and a failure there says nothing about whether the round was fair.
  async function loadBlocks(proof: ChainRoom) {
    const wanted: { label: string; height: number }[] = [];
    if (proof.created_height) wanted.push({ label: 'Room created', height: proof.created_height });
    for (const roll of proof.rolls ?? []) {
      if (roll.lock_height) wanted.push({ label: `Step ${roll.step} locked`, height: roll.lock_height });
      if (roll.reveal_height) wanted.push({ label: `Step ${roll.step} revealed`, height: roll.reveal_height });
    }
    const lines: BlockLine[] = [];
    const found: RandomLine[] = [];
    for (const want of wanted) {
      try {
        const header = await blockAt(want.height);
        lines.push({ ...want, hash: header.hash });
        const roll = proof.rolls?.find((r) => r.lock_height === want.height);
        if (roll?.lock_seed) {
          const randomValue = fromBase58ToHex(header.random_value);
          found.push({ step: roll.step, height: want.height, randomValue, lockSeed: roll.lock_seed, same: randomValue === roll.lock_seed });
        }
      } catch {
        lines.push({ ...want, hash: null });
        randomError = true;
      }
      blocks = [...lines];
      randoms = [...found];
    }
  }

  const short = (hex: string) => `${hex.slice(0, 12)}…`;
  const mark = (check: Check) => (check.state === 'pass' ? '✓' : check.state === 'fail' ? '✗' : '•');
</script>

<!-- svelte-ignore a11y_click_events_have_key_events, a11y_no_noninteractive_element_interactions -->
<dialog class="modal" bind:this={dialog} aria-labelledby="verify-title" oncancel={onclose} onclose={onclose} onclick={(e) => { if (e.target === dialog) onclose(); }}>
  <div class="panel body">
    <div class="top">
      <h2 id="verify-title">Verify this round</h2>
      <button class="x" aria-label="Close" onclick={onclose}>×</button>
    </div>

    {#if failed}
      <p class="summary fail">Couldn't fetch this round's proof. The chain or the game server may be having a moment, so try again.</p>
    {:else if !groups.length}
      <p class="summary">Fetching the round and redoing every roll in your browser…</p>
    {:else}
      <p class="summary" class:pass={overall === 'pass'} class:fail={overall === 'fail'} data-overall={overall}>
        {#if overall === 'pass'}
          All {passed} checks passed. Your browser redid this round and got the same answers.
        {:else}
          Something doesn't add up. See the red lines below.
        {/if}
      </p>

      {#each groups as group}
        <h3>{group.title}</h3>
        <ul>
          {#each group.checks as check}
            <li class={check.state}>
              <span class="mark" aria-hidden="true">{mark(check)}</span>
              <span class="words">
                <span class="title">{check.title}</span>
                {#if check.detail}<span class="detail">{check.detail}</span>{/if}
              </span>
            </li>
          {/each}
        </ul>
      {/each}

      <h3>What you're trusting</h3>
      <p class="plain">Everything above uses numbers the contract stored, rechecked here by the same rules. Two of those numbers, the room's block seed and each lock seed, can only come from the contract, which took them from the network's randomness at that moment.</p>
      {#if hadRolls}
        {#if randoms.length}
          <p class="plain">
            {#if allSame}
              We also read each lock's block from the chain, and its public random value is the lock seed itself.
            {:else if allDiffer}
              We also read each lock's block from the chain. Its public random value isn't the same number as the lock seed: NEAR hands a contract its own value for each call, built from the block's value plus details of that call. So this can't confirm the seed on its own, and shows only what the chain says.
            {:else}
              We also read each lock's block from the chain. Some public random values match the lock seed and some don't.
            {/if}
          </p>
          <ul>
            {#each randoms as line}
              <li class="note">
                <span class="mark" aria-hidden="true">•</span>
                <span class="words"><span class="detail">Step {line.step}, block {line.height}: random value {short(line.randomValue)}, lock seed {short(line.lockSeed)}. {line.same ? 'The same.' : 'Different.'}</span></span>
              </li>
            {/each}
          </ul>
        {:else if randomError}
          <p class="plain">We couldn't read the lock blocks from the chain just now. That doesn't change the checks above.</p>
        {/if}
      {/if}

      {#if blocks.length}
        <h3>See it on the explorer</h3>
        <ul class="links">
          {#each blocks as block}
            {#if block.hash}
              <li><a href={explorer.block(block.hash)} target="_blank" rel="noopener">{block.label}, block {block.height}</a></li>
            {:else}
              <li>{block.label}, block {block.height}</li>
            {/if}
          {/each}
          {#each room?.txs ?? [] as tx}
            <li><a href={explorer.tx(tx.hash)} target="_blank" rel="noopener">{tx.label}, transaction</a></li>
          {/each}
          <li><a href={explorer.account('v1.dighere.testnet')} target="_blank" rel="noopener">The contract</a></li>
        </ul>
      {/if}
    {/if}
  </div>
</dialog>

<style>
  .body {
    display: grid;
    gap: 0.5rem;
    max-height: 85dvh;
    overflow-y: auto;
  }
  .top {
    display: flex;
    align-items: center;
    justify-content: space-between;
  }
  h2 {
    margin: 0;
    font-family: var(--display);
    font-size: 2.2rem;
    font-weight: 400;
    line-height: 1;
    color: var(--sun);
  }
  h3 {
    margin: 0.4rem 0 0;
    font-family: var(--display);
    font-size: 1.6rem;
    font-weight: 400;
    line-height: 1;
    color: var(--mist);
  }
  .x {
    width: 2.75rem;
    height: 2.75rem;
    padding: 0;
    font-family: var(--display);
    font-size: 2rem;
    line-height: 1;
    color: var(--foam);
    background: var(--deep);
    border: 0;
    cursor: pointer;
  }
  .summary {
    margin: 0;
    padding: 0.4rem 0.6rem;
    font-size: 1.35rem;
    line-height: 1.1;
    background: var(--deep);
  }
  .summary.pass {
    color: var(--ink);
    background: #7ce08a;
  }
  .summary.fail {
    color: var(--foam);
    background: #c9304a;
  }
  ul {
    display: grid;
    gap: 0.3rem;
    margin: 0;
    padding: 0;
    list-style: none;
  }
  li {
    display: grid;
    grid-template-columns: 1.1rem 1fr;
    gap: 0.3rem;
    font-size: 1.2rem;
    line-height: 1.1;
  }
  li.pass .mark {
    color: #7ce08a;
  }
  li.fail,
  li.fail .mark {
    color: #ff8fa3;
  }
  li.note .mark {
    color: var(--mist);
  }
  .words {
    display: grid;
    gap: 0.05rem;
    min-width: 0;
    overflow-wrap: anywhere;
  }
  .detail {
    font-size: 1.05rem;
    color: var(--mist);
  }
  .plain {
    margin: 0;
    font-size: 1.15rem;
    line-height: 1.15;
    color: var(--mist);
  }
  .links li {
    display: block;
  }
  .links a {
    color: var(--sun);
  }
</style>
