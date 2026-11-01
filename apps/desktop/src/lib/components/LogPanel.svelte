<script lang="ts">
  import type { RunEvent } from '@agent-orchestrator/contracts';
  import { formatDateTime, summarizePayload } from '../labels';

  interface Props {
    events: RunEvent[];
    open?: boolean;
  }

  let { events, open = false }: Props = $props();
</script>

<details class="card" bind:open data-testid="log-panel">
  <summary>詳細ログ（全イベント {events.length} 件）</summary>
  {#if events.length === 0}
    <p class="small muted">イベントはまだありません。</p>
  {:else}
    <div class="table-wrap">
      <table aria-label="実行イベントログ">
        <thead>
          <tr>
            <th scope="col">#</th>
            <th scope="col">時刻</th>
            <th scope="col">種別</th>
            <th scope="col">ラウンド</th>
            <th scope="col">内容</th>
          </tr>
        </thead>
        <tbody>
          {#each events as event (event.sequence)}
            <tr data-testid="log-row">
              <td class="mono">{event.sequence}</td>
              <td class="mono">{formatDateTime(event.timestamp)}</td>
              <td class="mono">{event.type}</td>
              <td>{event.round ?? '—'}</td>
              <td>{summarizePayload(event.payload)}</td>
            </tr>
          {/each}
        </tbody>
      </table>
    </div>
  {/if}
</details>

<style>
  .table-wrap {
    max-height: 22rem;
    overflow: auto;
    margin-top: 0.5rem;
  }
  .mono {
    font-family: var(--mono);
    font-size: 0.8rem;
    white-space: nowrap;
  }
</style>
