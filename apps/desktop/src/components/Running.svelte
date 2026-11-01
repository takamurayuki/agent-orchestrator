<script lang="ts">
  import { onMount } from 'svelte';
  import { RUN_STATE_TONES, formatDateTime, formatDuration, isTerminalRunState, runStateLabel } from '../lib/labels';
  import { app } from '../lib/stores/app.svelte';
  import { cancelRun, refreshRunStatus, showResult } from '../lib/stores/actions';
  import Alert from '../lib/components/Alert.svelte';
  import LogPanel from '../lib/components/LogPanel.svelte';
  import StatusBadge from '../lib/components/StatusBadge.svelte';

  const run = $derived(app.run);
  const terminal = $derived(run ? isTerminalRunState(run.state) : false);

  let now = $state(Date.now());
  $effect(() => {
    if (terminal) return;
    const timer = setInterval(() => (now = Date.now()), 1000);
    return () => clearInterval(timer);
  });

  const elapsed = $derived.by(() => {
    if (!run) return '0:00';
    const start = new Date(run.startedAt).getTime();
    const end = run.finishedAt ? new Date(run.finishedAt).getTime() : now;
    return formatDuration(end - start);
  });

  interface VerificationView {
    passed: boolean;
    commands: Array<{ name: string; exitCode: number | null }>;
    missing: string[];
  }

  const verification = $derived.by<VerificationView | null>(() => {
    const ev = [...app.events].reverse().find((e) => e.type === 'verification.completed');
    if (!ev) return null;
    const p = ev.payload as { passed?: unknown; commands?: unknown; missing?: unknown };
    const commands = Array.isArray(p.commands)
      ? (p.commands as Array<Record<string, unknown>>).map((c) => ({
          name: String(c['name'] ?? ''),
          exitCode: typeof c['exitCode'] === 'number' ? (c['exitCode'] as number) : null
        }))
      : [];
    return { passed: p.passed === true, commands, missing: Array.isArray(p.missing) ? (p.missing as unknown[]).map(String) : [] };
  });

  const review = $derived.by(() => {
    const ev = [...app.events].reverse().find((e) => e.type === 'review.completed');
    if (!ev) return null;
    const p = ev.payload as Record<string, unknown>;
    return {
      verdict: String(p['verdict'] ?? 'unknown'),
      findings: typeof p['findingsCount'] === 'number' ? (p['findingsCount'] as number) : 0,
      blocking: typeof p['blockingFindings'] === 'number' ? (p['blockingFindings'] as number) : 0,
      summary: typeof p['summary'] === 'string' ? (p['summary'] as string) : ''
    };
  });

  const steps = ['PREFLIGHT', 'IMPLEMENTING', 'VERIFYING', 'REVIEWING', 'COMPLETED'] as const;
  const stepLabels: Record<(typeof steps)[number], string> = {
    PREFLIGHT: '起動前検査',
    IMPLEMENTING: '実装',
    VERIFYING: '検証',
    REVIEWING: 'レビュー',
    COMPLETED: '完了'
  };
  // POLICY_BLOCKED（v2.2）は「実装」ステップに差し戻された状態として表示する
  const stepIndex = $derived(run ? steps.indexOf((run.state === 'POLICY_BLOCKED' ? 'IMPLEMENTING' : run.state) as (typeof steps)[number]) : -1);
  const policyBlocked = $derived(run?.state === 'POLICY_BLOCKED');

  const yaml = $derived(app.approval?.taskYaml ?? app.draft?.taskYaml ?? null);

  onMount(() => {
    // Reconnect: fetch any events after the last known sequence.
    void refreshRunStatus();
  });
</script>

{#if !run}
  <div class="card" data-testid="screen-running">
    <h1>実行中</h1>
    <p>実行中の Run はありません。ヒアリングを承認すると実行が開始されます。</p>
    <button type="button" onclick={() => app.navigate('home')}>ホームへ</button>
  </div>
{:else}
  <div class="stack" data-testid="screen-running">
    <header class="card">
      <div class="row" style="justify-content: space-between">
        <h1>実行中: {run.taskTitle}</h1>
        <StatusBadge label={runStateLabel(run.state)} code={run.state} tone={RUN_STATE_TONES[run.state]} testid="run-state" />
      </div>
      <dl class="meta">
        <dt>Run ID</dt>
        <dd data-testid="run-id">{run.runId}</dd>
        <dt>状態</dt>
        <dd><span data-testid="run-state-text">{runStateLabel(run.state)}（{run.state}）</span></dd>
        <dt>ラウンド</dt>
        <dd data-testid="run-round">{run.currentRound}/{run.maxRounds}</dd>
        <dt>経過時間</dt>
        <dd data-testid="elapsed" aria-live="off">{elapsed}</dd>
        <dt>開始</dt>
        <dd>{formatDateTime(run.startedAt)}</dd>
        <dt>ベース</dt>
        <dd>{run.baseRef}{run.baseSha ? ` @ ${run.baseSha.slice(0, 12)}` : ''}</dd>
        <dt>ワークツリー</dt>
        <dd>{run.worktreePath ?? '作成待ち'}</dd>
      </dl>
      <ol class="steps" aria-label="実行ステップ">
        {#each steps as step, i (step)}
          <li class:done={i < stepIndex || run.state === 'COMPLETED'} class:current={i === stepIndex && !terminal} aria-current={i === stepIndex && !terminal ? 'step' : undefined}>
            <span class="mark" aria-hidden="true">{i < stepIndex || run.state === 'COMPLETED' ? '✔' : i === stepIndex ? '▶' : '○'}</span>
            {stepLabels[step]}{#if step === 'IMPLEMENTING' && policyBlocked}（ポリシー違反で差し戻し中）{/if}
            {#if i === stepIndex && !terminal}<span class="sr-only">（現在）</span>{/if}
          </li>
        {/each}
      </ol>
      {#if policyBlocked}
        <p class="small" data-testid="policy-blocked-note">静的チェック（Policy Gate）が未承認の違反を検出したため、検証・レビューを行わず AI に修正を依頼しています。残りの試行回数内で解消されない場合は「要確認」で停止します。</p>
      {/if}
      <div class="row">
        <button type="button" class="danger" onclick={() => void cancelRun()} disabled={terminal || app.busy !== null} data-testid="cancel-run">実行をキャンセル</button>
        {#if terminal}
          <button type="button" class="primary" onclick={() => void showResult(run.runId)} data-testid="view-result">結果を見る</button>
        {/if}
        <span class="small muted">キャンセルすると子プロセスを停止し INTERRUPTED として記録します。ワークツリーは保持されます。</span>
      </div>
    </header>

    {#if terminal}
      <Alert tone={RUN_STATE_TONES[run.state]} role="status" title={`実行は終了しました: ${runStateLabel(run.state)} (${run.state})`} message={run.reasonDetail ?? ''} testid="run-finished" />
    {/if}

    <div class="grid-2">
      <section class="card" aria-labelledby="verification-heading" data-testid="verification-results">
        <h2 id="verification-heading">検証結果</h2>
        {#if !verification}
          <p class="muted">まだ検証は実行されていません。</p>
        {:else}
          <p><StatusBadge label={verification.passed ? '検証成功' : '検証失敗'} tone={verification.passed ? 'success' : 'danger'} /></p>
          <table aria-label="検証コマンド結果">
            <thead><tr><th scope="col">コマンド</th><th scope="col">終了コード</th><th scope="col">結果</th></tr></thead>
            <tbody>
              {#each verification.commands as c (c.name)}
                <tr>
                  <td><code>{c.name}</code></td>
                  <td>{c.exitCode ?? 'タイムアウト'}</td>
                  <td>{c.exitCode === 0 ? '成功' : '失敗'}</td>
                </tr>
              {/each}
            </tbody>
          </table>
          {#if verification.missing.length}
            <p class="small">未実行の検証: {verification.missing.join(', ')}</p>
          {/if}
        {/if}
      </section>

      <section class="card" aria-labelledby="review-heading" data-testid="review-results">
        <h2 id="review-heading">レビュー</h2>
        {#if !review}
          <p class="muted">まだレビューは実行されていません。</p>
        {:else}
          <p>判定: <strong>{review.verdict}</strong></p>
          <p>指摘件数: <strong data-testid="findings-count">{review.findings}</strong>（うち blocking {review.blocking} 件）</p>
          {#if review.summary}<p class="small">{review.summary}</p>{/if}
        {/if}
        <p class="small muted">未解決の blocking 指摘: {run.openBlockingFindings} 件</p>
      </section>
    </div>

    {#if yaml}
      <details class="card" data-testid="fixed-yaml">
        <summary>承認済み task.yaml（固定、変更不可）</summary>
        <pre>{yaml}</pre>
      </details>
    {/if}

    <LogPanel events={app.events} />
  </div>
{/if}

<style>
  .meta {
    margin: 0.5rem 0;
  }
  .steps {
    list-style: none;
    padding: 0;
    margin: 0.75rem 0;
    display: flex;
    flex-wrap: wrap;
    gap: 0.5rem;
  }
  .steps li {
    border: 1px solid var(--border);
    border-radius: 999px;
    padding: 0.2rem 0.8rem;
    color: var(--muted);
  }
  .steps li.done {
    color: var(--success);
    border-color: var(--success);
  }
  .steps li.current {
    color: var(--info);
    border-color: var(--info);
    font-weight: 700;
  }
  .mark {
    margin-right: 0.3rem;
  }
</style>
