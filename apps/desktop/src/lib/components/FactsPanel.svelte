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

<section class="card quiet" aria-labelledby="facts-heading" data-testid="facts-panel">
  <h2 id="facts-heading">リポジトリ調査結果</h2>
  <p class="tiny muted">確認済みの事実・AI の推測・未確定事項を分けて表示します。推測は確定事項として扱いません。</p>
  {#each groups as group (group.confidence)}
    <details class="section group {group.confidence}" open={group.confidence !== 'confirmed' && group.items.length > 0}>
      <summary><span class="dot" aria-hidden="true"></span>{group.label}<span class="count">{group.items.length} 件</span></summary>
      {#if group.items.length === 0}
        <p class="small muted">なし</p>
      {:else}
        <ul class="facts list-plain" data-testid="facts-{group.confidence}">
          {#each group.items as fact, i (`${fact.key}:${i}`)}
            <li>
              <div class="small">{fact.value}</div>
              <div class="tiny muted">根拠: {fact.source}</div>
            </li>
          {/each}
        </ul>
      {/if}
    </details>
  {/each}
</section>

<style>
  .dot {
    width: 0.55rem;
    height: 0.55rem;
    border-radius: 50%;
    background: var(--neutral);
    flex: 0 0 auto;
  }
  .group.confirmed .dot {
    background: var(--success);
  }
  .group.inferred .dot {
    background: var(--warning);
  }
  .group.unknown .dot {
    background: var(--danger);
  }
  .facts li + li {
    margin-top: 0.45rem;
  }
</style>
