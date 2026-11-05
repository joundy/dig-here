<script lang="ts">
  import { backend } from '../lib/backend';
  import { CONTRACT, explorer } from '../lib/near/config';
  import { chainReader } from '../lib/near/rpc';
  import { overallState, verifyRound } from '../lib/verify';
  import type { Check, CheckGroup } from '../lib/verify';
  import { headline, trustNotes, verifyOnChain } from '../lib/verifyChain';
  import type { BlockLine, RandomLine, RoundProof } from '../lib/verifyChain';

  let { gameId, onclose }: { gameId: string; onclose: () => void } = $props();

  let dialog = $state<HTMLDialogElement>();
  let proof = $state.raw<RoundProof | null>(null);
  let groups = $state.raw<CheckGroup[]>([]);
  let progress = $state.raw<{ done: number; total: number } | null>(null);
  let chainDone = $state(false);
  let failed = $state(false);
  let blocks = $state.raw<BlockLine[]>([]);
  let randoms = $state.raw<RandomLine[]>([]);
  let codeHash = $state<string | null>(null);

  // Nothing is claimed until the chain has answered: a story that only adds up is no result at all.
  const overall = $derived(chainDone ? overallState(groups) : null);
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
      const found = await backend.proofOf(gameId);
      if (!found) {
        failed = true;
        return;
      }
      proof = found;
      const local = verifyRound(found.room);
      groups = local;
      const chain = await verifyOnChain(found, chainReader(), (done, total) => (progress = { done, total }));
      groups = [...chain.groups, ...local];
      blocks = chain.blocks;
      randoms = chain.randoms;
      codeHash = chain.codeHash;
      chainDone = true;
    } catch {
      failed = true;
    }
  }

  const short = (hex: string) => `${hex.slice(0, 12)}…`;
  const MARKS: Record<Check['state'], string> = { pass: '✓', fail: '✗', note: '•', unchecked: '?' };
</script>

<!-- svelte-ignore a11y_click_events_have_key_events, a11y_no_noninteractive_element_interactions -->
<dialog class="modal" bind:this={dialog} aria-labelledby="verify-title" oncancel={onclose} onclose={onclose} onclick={(e) => { if (e.target === dialog) onclose(); }}>
  <div class="panel body">
    <div class="heading">
      <h2 id="verify-title">Verify this round</h2>
      <button class="x" aria-label="Close" onclick={onclose}>×</button>
    </div>

    {#if failed}
      <p class="summary fail" data-overall="fail">Couldn't get this round, so nothing here is verified. The network or our server may be having a moment, so try again.</p>
    {:else if !groups.length}
      <p class="summary">Reading the round and redoing every roll in your browser…</p>
    {:else}
      <p class="summary" class:pass={overall === 'pass'} class:partial={overall === 'partial'} class:fail={overall === 'fail'} data-overall={overall ?? 'checking'} role="status">
        {#if overall && proof}
          {headline(overall, groups, proof.source)}
        {:else if progress && progress.total}
          Looking up transactions on the chain, {progress.done} of {progress.total}…
        {:else}
          Checking this round against the chain…
        {/if}
      </p>

      {#each groups as group}
        <h3>{group.title}</h3>
        <ul>
          {#each group.checks as check}
            <li class={check.state}>
              <span class="mark" aria-hidden="true">{MARKS[check.state]}</span>
              <span class="words">
                <span class="title">{check.title}</span>
                {#if check.detail}<span class="detail">{check.detail}</span>{/if}
              </span>
            </li>
          {/each}
        </ul>
      {/each}

      {#if overall && proof}
        <h3>Who vouches for what</h3>
        {#each trustNotes(proof, overall, codeHash) as note}
          <p class="plain"><b>{note.who}.</b> {note.text}</p>
        {/each}

        {#if randoms.length}
          <p class="plain">
            {#if allSame}
              Here each lock's block has the lock seed as its public random value.
            {:else if allDiffer}
              Here each lock's block has a different public random value from the lock seed, as expected:
            {:else}
              Some public random values here match the lock seed and some don't:
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
        {/if}

        <h3>See it on the explorer</h3>
        <ul class="links">
          {#each blocks as block}
            {#if block.hash}
              <li><a href={explorer.block(block.hash)} target="_blank" rel="noopener">{block.label}, block {block.height}</a></li>
            {:else}
              <li>{block.label}, block {block.height}</li>
            {/if}
          {/each}
          {#each proof.links as tx}
            <li><a href={explorer.tx(tx.hash)} target="_blank" rel="noopener">{tx.label}, transaction</a></li>
          {/each}
          <li><a href={explorer.account(CONTRACT)} target="_blank" rel="noopener">The contract</a></li>
        </ul>
        {#if proof.source === 'contract' && proof.links.length}
          <p class="plain">Our server found the transaction links, as a shortcut. No check above uses them.</p>
        {/if}
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
  .heading {
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
  .summary.partial {
    color: var(--ink);
    background: #f2b84b;
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
  li.unchecked,
  li.unchecked .mark {
    color: #f2b84b;
  }
  li.unchecked .detail {
    color: #f2b84b;
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
    overflow-wrap: anywhere;
  }
  .plain b {
    font-weight: 400;
    color: var(--foam);
  }
  .links li {
    display: block;
  }
  .links a {
    color: var(--sun);
  }
</style>
