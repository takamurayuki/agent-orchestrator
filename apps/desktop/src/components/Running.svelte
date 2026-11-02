<script lang="ts">
  import { onMount } from 'svelte';
  import { RUN_STATE_TONES, formatDateTime, formatDuration, isTerminalRunState, runStateLabel } from '../lib/labels';
  import { RUN_STEPS, RUN_STEP_LABELS, currentStepIndex, describeActivity, describeOutcome } from '../lib/outcome';
  import { app } from '../lib/stores/app.svelte';
  import { cancelRun, refreshRunStatus, showResult } from '../lib/stores/actions';
  import Alert from '../lib/components/Alert.svelte';
  import LogPanel from '../lib/components/LogPanel.svelte';
  import StatusBadge from '../lib/components/StatusBadge.svelte';

  const run = $derived(app.run);
  const terminal = $derived(run ? isTerminalRunState(run.state) : false);
  const activity = $derived(run ? describeActivity(run, app.events) : null);
  const outcome = $derived(run && terminal ? describeOutcome(run) : null);

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

  const VERDICT_LABELS: Record<string, string> = { approved: '承認', changes_requested: '修正が必要', unknown: '判定不能' };

  const stepIndex = $derived(run ? currentStepIndex(run.state) : -1);
  const policyBlocked = $derived(run?.state === 'POLICY_BLOCKED');
  const yaml = $derived(app.approval?.taskYaml ?? app.draft?.taskYaml ?? null);

  function stepLabel(step: (typeof RUN_STEPS)[number]): string {
    if (step === 'ANALYSIS') return '要件分析（承認済み）';
    if (step === 'IMPLEMENTING' && run) {
      if (policyBlocked) return `修正（ポリシー違反で差し戻し、ラウンド ${run.currentRound}）`;
      if (activity?.fixing) return `修正（ラウンド ${run.currentRound}）`;
      if (run.currentRound > 1) return `実装・修正（ラウンド ${run.currentRound}）`;
    }
    return RUN_STEP_LABELS[step];
  }

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
    <header class="card hero {terminal ? `tone-${outcome?.tone ?? 'neutral'}` : 'tone-info'}">
      <div class="row between">
        <span class="eyebrow">{terminal ? '実行結果' : '実行中'}</span>
        <StatusBadge label={runStateLabel(run.state)} code={run.state} tone={RUN_STATE_TONES[run.state]} testid="run-state" />
      </div>
      <h1 class="title">{run.taskTitle}</h1>

      {#if activity}
        <p class="activity" role="status" aria-live="polite" data-testid="current-activity">
          {#if !terminal}<span class="live-dot" aria-hidden="true"></span>{/if}
          <strong>{terminal ? '結果' : '現在の処理'}:</strong> {activity.title}
          {#if activity.detail}<span class="small muted"> — {activity.detail}</span>{/if}
        </p>
      {/if}

      <ol class="stepper" aria-label="実行ステップ" data-testid="run-steps">
        {#each RUN_STEPS as step, i (step)}
          {@const done = step === 'ANALYSIS' || i < stepIndex || run.state === 'COMPLETED'}
          {@const current = i === stepIndex && !terminal}
          <li class:done class:current class:blocked={step === 'IMPLEMENTING' && policyBlocked} aria-current={current ? 'step' : undefined} data-step={step}>
            <span class="mark" aria-hidden="true">{done ? '✓' : i + 1}</span>
            <span class="label">{stepLabel(step)}</span>
            {#if current}<span class="sr-only">（現在）</span>{/if}
          </li>
        {/each}
      </ol>
      {#if policyBlocked}
        <p class="small" data-testid="policy-blocked-note">静的チェック（Policy Gate）が未承認の違反を検出したため、検証・レビューを行わず AI に修正を依頼しています。残りの試行回数内で解消されない場合は「要確認」で停止します。</p>
      {/if}

      <div class="tiles">
        <div class="tile"><span class="label">ラウンド</span><span class="value" data-testid="run-round">{run.currentRound}/{run.maxRounds}<span class="tiny muted">（修正は最大 {run.maxRounds} 回まで）</span></span></div>
        <div class="tile"><span class="label">経過時間</span><span class="value" data-testid="elapsed" aria-live="off">{elapsed}</span></div>
        <div class="tile"><span class="label">開始</span><span class="value text">{formatDateTime(run.startedAt)}</span></div>
        {#if run.finishedAt}
          <div class="tile"><span class="label">終了</span><span class="value text">{formatDateTime(run.finishedAt)}</span></div>
        {/if}
      </div>
      {#if !terminal}
        <p class="tiny muted" data-testid="no-eta-note">所要時間は依頼の内容と AI の応答によって大きく変わるため、終了時刻の予測は表示しません。</p>
      {/if}

      <div class="row between">
        <span class="tiny muted">{terminal ? '' : '停止すると AI の処理を止め、途中の変更は作業用コピーに残ります。元のプロジェクトは変わりません。'}</span>
        <div class="row">
          <button type="button" class="danger" onclick={() => void cancelRun()} disabled={terminal || app.busy !== null} data-testid="cancel-run">実行を停止する</button>
          {#if terminal}
            <button type="button" class="primary" onclick={() => void showResult(run.runId)} data-testid="view-result">結果を見る</button>
          {/if}
        </div>
      </div>
    </header>

    {#if terminal && outcome}
      <Alert tone={outcome.tone} role="status" title={outcome.headline} testid="run-finished">
        <p class="small">{outcome.summary}</p>
        <p class="small"><strong>原因:</strong> {outcome.guidance.cause}</p>
        <p class="small"><strong>対応:</strong> {outcome.guidance.next.join(' ／ ')}</p>
        {#if run.reasonDetail}<p class="small muted">詳細: {run.reasonDetail}</p>{/if}
      </Alert>
    {/if}

    <div class="two">
      <section class="card quiet" aria-labelledby="verification-heading" data-testid="verification-results">
        <h2 id="verification-heading">検証結果</h2>
        {#if !verification}
          <p class="small muted">まだ検証は実行されていません。</p>
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

      <section class="card quiet" aria-labelledby="review-heading" data-testid="review-results">
        <h2 id="review-heading">レビュー</h2>
        {#if !review}
          <p class="small muted">まだレビューは実行されていません。</p>
        {:else}
          <p>判定: <strong>{VERDICT_LABELS[review.verdict] ?? review.verdict}</strong><span class="tiny muted">（{review.verdict}）</span></p>
          <p>指摘件数: <strong data-testid="findings-count">{review.findings}</strong><span class="small muted">（うち完了を妨げるもの {review.blocking} 件）</span></p>
          {#if review.summary}<p class="small">{review.summary}</p>{/if}
        {/if}
        <p class="tiny muted">未解決の blocking 指摘: {run.openBlockingFindings} 件</p>
      </section>
    </div>

    <details class="card" data-testid="run-technical">
      <summary>技術情報（Run ID・パス・承認済み要件）</summary>
      <dl class="small">
        <dt>Run ID</dt>
        <dd data-testid="run-id">{run.runId}</dd>
        <dt>内部ステータス</dt>
        <dd><span data-testid="run-state-text">{runStateLabel(run.state)}（{run.state}）</span></dd>
        <dt>ベース</dt>
        <dd>{run.baseRef}{run.baseSha ? ` @ ${run.baseSha.slice(0, 12)}` : ''}</dd>
        <dt>作業用コピー</dt>
        <dd>{run.worktreePath ?? '作成待ち'}</dd>
      </dl>
      {#if yaml}
        <details data-testid="fixed-yaml">
          <summary>承認済み task.yaml（固定、変更不可）</summary>
          <pre>{yaml}</pre>
        </details>
      {/if}
    </details>

    <p class="tiny muted" data-testid="raw-log-note">AI の出力やコマンドの生ログはこの画面には表示しません（秘密情報を含む可能性があるため）。下の詳細ログはイベントの要約だけです。保存されたログファイルは秘密情報をマスキング済みです。</p>
    <LogPanel events={app.events} />
  </div>
{/if}

<style>
  .title {
    font-size: 1.25rem;
    margin-bottom: 0.5rem;
  }
  .activity {
    display: flex;
    align-items: center;
    gap: 0.5rem;
    flex-wrap: wrap;
    margin: 0.2rem 0 0.9rem;
    padding: 0.6rem 0.9rem;
    border-radius: var(--radius-sm);
    background: var(--primary-soft);
    font-size: 1rem;
  }
  .live-dot {
    width: 0.6rem;
    height: 0.6rem;
    border-radius: 50%;
    background: var(--primary);
    animation: pulse 1.2s ease-in-out infinite;
    flex: 0 0 auto;
  }
  @keyframes pulse {
    0%,
    100% {
      opacity: 0.3;
    }
    50% {
      opacity: 1;
    }
  }
  @media (prefers-reduced-motion: reduce) {
    .live-dot {
      animation: none;
    }
  }
  .stepper {
    list-style: none;
    padding: 0;
    margin: 0.4rem 0 0.9rem;
    display: grid;
    grid-template-columns: repeat(6, 1fr);
    gap: 0.3rem;
    counter-reset: step;
  }
  .stepper li {
    position: relative;
    display: grid;
    justify-items: center;
    gap: 0.3rem;
    text-align: center;
    color: var(--muted);
    font-size: 0.8rem;
    padding-top: 0.2rem;
  }
  .stepper li::before {
    content: '';
    position: absolute;
    top: 0.95rem;
    left: 50%;
    width: 100%;
    height: 2px;
    background: var(--border);
    z-index: 0;
  }
  .stepper li:last-child::before {
    display: none;
  }
  .stepper li.done::before {
    background: var(--success);
  }
  .stepper .mark {
    position: relative;
    z-index: 1;
    width: 1.6rem;
    height: 1.6rem;
    border-radius: 50%;
    display: grid;
    place-items: center;
    background: var(--surface);
    border: 2px solid var(--border-strong);
    font-weight: 700;
    font-size: 0.78rem;
  }
  .stepper li.done .mark {
    background: var(--success);
    border-color: var(--success);
    color: #fff;
  }
  .stepper li.current .mark {
    border-color: var(--primary);
    color: var(--primary);
    box-shadow: 0 0 0 4px var(--primary-soft);
  }
  .stepper li.current {
    color: var(--primary);
    font-weight: 700;
  }
  .stepper li.blocked .mark {
    border-color: var(--warning);
    color: var(--warning);
  }
  .stepper li.blocked {
    color: var(--warning);
  }
  .two {
    display: grid;
    grid-template-columns: 1fr 1fr;
    gap: 1rem;
  }
  @media (max-width: 900px) {
    .two {
      grid-template-columns: 1fr;
    }
    .stepper {
      grid-template-columns: repeat(3, 1fr);
    }
  }
</style>
