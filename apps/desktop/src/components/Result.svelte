<script lang="ts">
  import { onMount } from 'svelte';
  import { REASON_CODE_LABELS, RUN_STATE_TONES, formatDateTime, isTerminalRunState, runStateLabel } from '../lib/labels';
  import { app } from '../lib/stores/app.svelte';
  import { loadHistory, openRunReport, resumeRun } from '../lib/stores/actions';
  import Alert from '../lib/components/Alert.svelte';
  import HistoryList from '../lib/components/HistoryList.svelte';
  import StatusBadge from '../lib/components/StatusBadge.svelte';

  const report = $derived(app.report);

  onMount(() => {
    void loadHistory();
    if (!app.report && app.run && isTerminalRunState(app.run.state)) void openRunReport(app.run.runId);
    else if (!app.report && app.history[0]) void openRunReport(app.history[0].runId);
  });

  /** Minimal, safe markdown → text blocks (no HTML is ever rendered). */
  function markdownBlocks(md: string): Array<{ kind: 'h1' | 'h2' | 'h3' | 'li' | 'p' | 'blank'; text: string }> {
    return md.split(/\r?\n/).map((line) => {
      if (/^# /.test(line)) return { kind: 'h1', text: line.slice(2) };
      if (/^## /.test(line)) return { kind: 'h2', text: line.slice(3) };
      if (/^### /.test(line)) return { kind: 'h3', text: line.slice(4) };
      if (/^\s*[-*] /.test(line)) return { kind: 'li', text: line.replace(/^\s*[-*] /, '') };
      if (/^\s*\d+\. /.test(line)) return { kind: 'li', text: line.replace(/^\s*\d+\. /, '') };
      if (line.trim() === '') return { kind: 'blank', text: '' };
      return { kind: 'p', text: line };
    });
  }
</script>

<div class="stack" data-testid="screen-result">
  <h1>結果・履歴</h1>
  <div class="grid-2">
    <div class="stack">
      {#if !report}
        <div class="card">
          <p class="muted" role="status">{app.busy ? 'レポートを取得しています…' : '右の履歴から Run を選択してください。'}</p>
        </div>
      {:else}
        {@const run = report.run}
        <section class="card" aria-labelledby="result-heading" data-testid="result-summary">
          <div class="row" style="justify-content: space-between">
            <h2 id="result-heading">{run.taskTitle}</h2>
            <StatusBadge label={runStateLabel(run.state)} code={run.state} tone={RUN_STATE_TONES[run.state]} testid="result-state" />
          </div>
          <p data-testid="result-status-text">
            ステータス: <strong>{runStateLabel(run.state)}（{run.state}）</strong>
            {#if run.reasonCode}
              ／ 理由: {REASON_CODE_LABELS[run.reasonCode] ?? run.reasonCode}（{run.reasonCode}）
            {/if}
          </p>
          {#if run.reasonDetail}
            <Alert tone={RUN_STATE_TONES[run.state]} role="status" title="詳細" message={run.reasonDetail} testid="result-reason-detail" />
          {/if}
          {#if !isTerminalRunState(run.state)}
            <div class="row">
              <span>この Run は進行中です。</span>
              <button type="button" onclick={() => void resumeRun(run)}>実行画面で見る</button>
            </div>
          {/if}
          <dl>
            <dt>Run ID</dt>
            <dd>{run.runId}</dd>
            <dt>開始 / 終了</dt>
            <dd>{formatDateTime(run.startedAt)} / {formatDateTime(run.finishedAt)}</dd>
            <dt>ラウンド</dt>
            <dd>{run.currentRound}/{run.maxRounds}</dd>
            <dt>未解決の blocking 指摘</dt>
            <dd>{run.openBlockingFindings} 件</dd>
            <dt>ワークスペース</dt>
            <dd data-testid="worktree-path">{report.worktreePath ?? '（なし）'}</dd>
            <dt>レポート</dt>
            <dd>{report.reportPath}</dd>
          </dl>
        </section>

        <section class="card" aria-labelledby="next-heading">
          <h2 id="next-heading">次の手動操作</h2>
          {#if run.nextActions.length === 0}
            <p class="muted">なし</p>
          {:else}
            <ol data-testid="next-actions">
              {#each run.nextActions as action, i (i)}
                <li>{action}</li>
              {/each}
            </ol>
          {/if}
          <p class="small muted">push / merge / deploy は自動で行いません。ワークツリーは保持されています。</p>
        </section>

        <section class="card" aria-labelledby="files-heading">
          <h2 id="files-heading">変更ファイル（{report.changedFiles.length}）</h2>
          {#if report.changedFiles.length === 0}
            <p class="muted">変更ファイルはありません。</p>
          {:else}
            <ul class="files" data-testid="changed-files">
              {#each report.changedFiles as file (file)}
                <li><code>{file}</code></li>
              {/each}
            </ul>
          {/if}
        </section>

        <section class="card" aria-labelledby="findings-heading">
          <h2 id="findings-heading">未解決の指摘（{report.openFindings.length}）／ 未検証要件（{report.requirementsUnverified.length}）</h2>
          {#if report.openFindings.length === 0}
            <p class="muted">未解決の指摘はありません。</p>
          {:else}
            <ul data-testid="open-findings">
              {#each report.openFindings as f (f.id)}
                <li>
                  <StatusBadge label={f.severity} tone={f.severity === 'critical' || f.severity === 'high' ? 'danger' : f.severity === 'medium' ? 'warning' : 'neutral'} />
                  <strong>{f.id}</strong> <code>{f.file}:{f.line}</code>
                  <div>{f.description}</div>
                  <div class="small"><strong>対応案:</strong> {f.recommendation}</div>
                </li>
              {/each}
            </ul>
          {/if}
          {#if report.requirementsUnverified.length > 0}
            <h3>未検証の要件</h3>
            <ul data-testid="requirements-unverified">
              {#each report.requirementsUnverified as r, i (i)}
                <li>{r}</li>
              {/each}
            </ul>
          {/if}
        </section>

        <details class="card" data-testid="diff">
          <summary>差分{report.diffTruncated ? '（サイズ上限により一部省略）' : ''}</summary>
          {#if report.diffExcerpt}
            <pre class="diff">{report.diffExcerpt}</pre>
          {:else}
            <p class="muted">差分はありません。</p>
          {/if}
        </details>

        <details class="card" open data-testid="report-markdown">
          <summary>レポート（report.md）</summary>
          <div class="report">
            {#each markdownBlocks(report.reportMarkdown) as block, i (i)}
              {#if block.kind === 'h1'}
                <h3 class="md-h1">{block.text}</h3>
              {:else if block.kind === 'h2'}
                <h4>{block.text}</h4>
              {:else if block.kind === 'h3'}
                <h5>{block.text}</h5>
              {:else if block.kind === 'li'}
                <div class="md-li">• {block.text}</div>
              {:else if block.kind === 'p'}
                <p>{block.text}</p>
              {/if}
            {/each}
          </div>
        </details>
      {/if}
    </div>

    <aside class="card" aria-labelledby="history-heading">
      <h2 id="history-heading">実行履歴</h2>
      <HistoryList runs={app.history} selectedId={app.reportRunId} onSelect={(run) => void openRunReport(run.runId)} />
    </aside>
  </div>
</div>

<style>
  .files {
    columns: 1;
  }
  .diff {
    max-height: 32rem;
  }
  .report p {
    margin: 0 0 0.3rem;
  }
  .md-h1 {
    margin-top: 0.5rem;
  }
  .md-li {
    padding-left: 1rem;
  }
  h4,
  h5 {
    margin: 0.7rem 0 0.3rem;
  }
</style>
