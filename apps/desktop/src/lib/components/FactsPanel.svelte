<script lang="ts">
  import type { Fact } from '@agent-orchestrator/contracts';
  import { CONFIDENCE_LABELS } from '../labels';

  interface Props {
    facts: Fact[];
  }

  let { facts }: Props = $props();

  const groups = $derived(
    (['confirmed', 'inferred', 'unknown'] as const).map((confidence) => ({
      confidence,
      label: CONFIDENCE_LABELS[confidence] ?? confidence,
      items: facts.filter((f) => f.confidence === confidence)
    }))
  );
</script>

<section class="card" aria-labelledby="facts-heading" data-testid="facts-panel">
  <h2 id="facts-heading">リポジトリ調査結果</h2>
  <p class="small muted">確認済みの事実・AI の推測・未確定事項は分けて表示します。推測は確定事項として扱いません。</p>
  {#each groups as group (group.confidence)}
    <h3 class="group-title {group.confidence}">{group.label} ({group.items.length})</h3>
    {#if group.items.length === 0}
      <p class="small muted">なし</p>
    {:else}
      <ul class="facts" data-testid="facts-{group.confidence}">
        {#each group.items as fact, i (`${fact.key}:${i}`)}
          <li>
            <div>{fact.value}</div>
            <div class="small muted">根拠: {fact.source}</div>
          </li>
        {/each}
      </ul>
    {/if}
  {/each}
</section>

<style>
  .group-title {
    margin-top: 0.75rem;
    padding-left: 0.5rem;
    border-left: 4px solid var(--neutral);
  }
  .group-title.confirmed {
    border-color: var(--success);
  }
  .group-title.inferred {
    border-color: var(--warning);
  }
  .group-title.unknown {
    border-color: var(--danger);
  }
  .facts li {
    margin-bottom: 0.4rem;
  }
</style>
