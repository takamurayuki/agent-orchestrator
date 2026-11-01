<script lang="ts">
  import type { RunStatus } from '@agent-orchestrator/contracts';
  import { RUN_STATE_TONES, formatDateTime, isTerminalRunState, runStateLabel } from '../labels';
  import StatusBadge from './StatusBadge.svelte';

  interface Props {
    runs: RunStatus[];
    selectedId?: string | null;
    onSelect: (run: RunStatus) => void;
    label?: string;
  }

  let { runs, selectedId = null, onSelect, label = '実行履歴' }: Props = $props();
</script>

<nav aria-label={label} data-testid="history-list">
  {#if runs.length === 0}
    <p class="small muted">履歴はまだありません。</p>
  {:else}
    <ul class="history">
      {#each runs as run (run.runId)}
        <li>
          <button type="button" class="item" class:selected={run.runId === selectedId} aria-current={run.runId === selectedId ? 'true' : undefined} onclick={() => onSelect(run)} data-testid="history-item">
            <span class="title">{run.taskTitle}</span>
            <span class="meta small muted">{formatDateTime(run.startedAt)} ／ ラウンド {run.currentRound}/{run.maxRounds}{isTerminalRunState(run.state) ? '' : '（進行中）'}</span>
            <StatusBadge label={runStateLabel(run.state)} code={run.state} tone={RUN_STATE_TONES[run.state]} />
          </button>
        </li>
      {/each}
    </ul>
  {/if}
</nav>

<style>
  .history {
    list-style: none;
    padding: 0;
    margin: 0;
    display: grid;
    gap: 0.4rem;
  }
  .item {
    width: 100%;
    text-align: left;
    display: grid;
    grid-template-columns: 1fr auto;
    gap: 0.2rem 0.75rem;
    align-items: center;
    padding: 0.5rem 0.75rem;
  }
  .item .title {
    font-weight: 600;
    grid-column: 1;
  }
  .item .meta {
    grid-column: 1;
  }
  .item :global(.badge) {
    grid-column: 2;
    grid-row: 1 / span 2;
  }
  .item.selected {
    border-color: var(--primary);
    box-shadow: inset 0 0 0 1px var(--primary);
  }
</style>
