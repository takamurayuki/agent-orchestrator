<script lang="ts">
  import { getTransport } from '../lib/api';
  import { PROJECT_STATUS_LABELS } from '../lib/labels';
  import { app } from '../lib/stores/app.svelte';
  import { cancelSandboxSetup, checkEnvironment, createDraft, inspectProject, pickFolder, resumeRun, showResult, startSandboxSetup } from '../lib/stores/actions';
  import { isTerminalRunState } from '../lib/labels';
  import Alert from '../lib/components/Alert.svelte';
  import HistoryList from '../lib/components/HistoryList.svelte';
  import SetupCheck from '../lib/components/SetupCheck.svelte';
  import StatusBadge from '../lib/components/StatusBadge.svelte';

  const transport = getTransport();

  const startDisabledReason = $derived.by(() => {
    if (app.environment && !app.environment.canRun) return '実行環境が整っていません。セットアップチェックの修正方法を確認してください。';
    if (app.environmentError) return '環境チェックに失敗しているため開始できません。';
    if (!app.environment) return '環境チェック中です。';
    if (!app.project) return 'プロジェクトフォルダーを選択してください。';
    if (app.project.status !== 'ok') return 'プロジェクトに問題があるため開始できません。原因と修正案を確認してください。';
    if (app.request.trim().length === 0) return '依頼内容を入力してください。';
    if (app.busy) return `${app.busy}中です…`;
    return null;
  });

  const projectOk = $derived(app.project?.status === 'ok');

  const VERDICT_LABEL = { ready: '実行可能', unverified: '未確認あり（実行は可能）', issues: '問題あり', blocked: '実行不可' } as const;
  const VERDICT_TONE = { ready: 'success', unverified: 'info', issues: 'warning', blocked: 'danger' } as const;

  function onPathSubmit(e: SubmitEvent) {
    e.preventDefault();
    void inspectProject(app.projectPath);
  }
</script>

<div class="stack" data-testid="screen-home">
  <header class="intro">
    <span class="eyebrow">新しい依頼</span>
    <h1>依頼を作成</h1>
    <p class="lead">プロジェクトを選び、やりたいことを書くだけ。AI が足りない点を質問して要件を固め、あなたの承認後に隔離環境で実装します。</p>
  </header>

  {#if app.environment && !app.environment.canRun}
    <SetupCheck report={app.environment} error={app.environmentError} busy={app.busy !== null} onRecheck={() => void checkEnvironment()} setup={app.sandboxSetup} onSandboxStart={() => void startSandboxSetup()} onSandboxCancel={() => void cancelSandboxSetup()} />
  {:else if app.sandboxSetup?.state === 'succeeded' && app.environment?.canRun}
    <Alert tone="success" role="status" title="サンドボックスの準備が完了しました" message="実行環境が整いました。プロジェクトを選んで依頼を入力してください。" testid="sandbox-success" />
  {:else if app.environmentError}
    <SetupCheck report={null} error={app.environmentError} busy={app.busy !== null} onRecheck={() => void checkEnvironment()} />
  {/if}

  <div class="grid-2">
    <div class="stack">
      <!-- 1. プロジェクト -->
      <section class="card" aria-labelledby="project-heading">
        <div class="step-head">
          <span class="stepnum" class:done={projectOk} aria-hidden="true">{projectOk ? '✓' : '1'}</span>
          <h2 id="project-heading">プロジェクトフォルダー</h2>
        </div>
        <form class="row" onsubmit={onPathSubmit}>
          <label for="project-path" class="sr-only">プロジェクトフォルダーのパス</label>
          <input type="text" id="project-path" style="flex: 1 1 20rem" bind:value={app.projectPath} placeholder="例: C:\Users\dev\projects\web-app" autocomplete="off" data-testid="project-path" />
          {#if transport.hasFolderPicker}
            <button type="button" onclick={() => void pickFolder()} disabled={app.busy !== null} data-testid="pick-folder">フォルダーを選択…</button>
          {/if}
          <button type="submit" disabled={app.busy !== null || app.projectPath.trim() === ''} data-testid="inspect-project">選択</button>
        </form>
        <p class="small muted hint">Git リポジトリのルートを指定してください。読み取り専用で Git・ベースブランチ・依存・テスト方式を調べます。</p>

        {#if app.projectError}
          <Alert tone="danger" role="alert" title="プロジェクトを調査できません" message={`${app.projectError.message} (${app.projectError.code})`} testid="project-error" />
        {:else if app.project}
          {@const p = app.project}
          <div class="stack project" data-testid="project-info">
            <div class="row between">
              <StatusBadge label={PROJECT_STATUS_LABELS[p.status] ?? p.status} code={p.status} tone={p.status === 'ok' ? 'success' : 'danger'} testid="project-status" />
              <span class="small muted">{p.fileCount} ファイル</span>
            </div>

            {#if p.problems.length > 0}
              <Alert tone="danger" role="alert" title="このフォルダーでは実行できません" testid="project-problems">
                <ul>
                  {#each p.problems as problem (problem.code)}
                    <li>
                      <strong>原因:</strong> {problem.message} <code>{problem.code}</code>
                      {#if problem.fix}
                        <div><strong>修正案:</strong> {problem.fix}</div>
                      {/if}
                    </li>
                  {/each}
                </ul>
              </Alert>
            {/if}

            <ul class="chips" aria-label="プロジェクトの概要">
              <li class="chip"><span class="k">ブランチ</span>{p.currentBranch ?? '—'}{p.headSha ? ` @ ${p.headSha.slice(0, 7)}` : ''}</li>
              <li class="chip"><span class="k">ベース</span>{p.defaultBaseRef ?? '—'}</li>
              <li class="chip"><span class="k">作業ツリー</span>{p.isClean === null ? '—' : p.isClean ? 'クリーン' : '未コミットあり'}</li>
              <li class="chip"><span class="k">パッケージ</span>{p.packageManager ?? '—'}</li>
              {#if p.frameworks.length}<li class="chip"><span class="k">構成</span>{p.frameworks.join(', ')}</li>{/if}
              {#if p.testFrameworks.length}<li class="chip"><span class="k">テスト</span>{p.testFrameworks.join(', ')}</li>{/if}
              <li class="chip" data-testid="verification-profile">
                <span class="k">検証</span>
                {#if p.verificationProfile}
                  {p.verificationProfile.name}: {p.verificationProfile.ready ? '準備完了' : `不足スクリプト ${p.verificationProfile.missingScripts.join(', ')}`}
                {:else}
                  未判定
                {/if}
              </li>
            </ul>

            {#if p.diagnosis.checks.length > 0}
              {@const impacting = p.diagnosis.checks.filter((c) => c.status === 'fail' || c.status === 'warn')}
              {@const unverified = p.diagnosis.checks.filter((c) => c.status === 'unverified')}
              {@const okChecks = p.diagnosis.checks.filter((c) => c.status === 'ok')}
              <section class="diagnosis" aria-labelledby="diagnosis-heading" data-testid="project-diagnosis" data-verdict={p.diagnosis.verdict}>
                <div class="row between">
                  <h3 id="diagnosis-heading">事前診断（ヒアリング前の確認）</h3>
                  <StatusBadge label={VERDICT_LABEL[p.diagnosis.verdict]} tone={VERDICT_TONE[p.diagnosis.verdict]} testid="diagnosis-verdict" />
                </div>
                <p class="small muted">読み取り専用で調べた結果です。設定や allowlist の自動変更は行いません。</p>
                {#if impacting.length > 0}
                  <ul class="list-plain" aria-label="実行に影響する事項">
                    {#each impacting as c (c.id)}
                      <li class="check-row" data-testid="diagnosis-check" data-status={c.status}>
                        <StatusBadge label={c.status === 'fail' ? '実行不可' : '問題あり'} tone={c.status === 'fail' ? 'danger' : 'warning'} />
                        <strong>{c.label}</strong>
                        <div class="detail">{c.detail}</div>
                        {#if c.fix}<div class="fix"><strong>対処:</strong> {c.fix}</div>{/if}
                      </li>
                    {/each}
                  </ul>
                {/if}
                {#if unverified.length > 0}
                  <details class="section" data-testid="diagnosis-unverified">
                    <summary>未確認 {unverified.length} 件<span class="count">問題とは限りません。実行時に失敗する可能性があるため理由と確認方法を記載</span></summary>
                    <ul class="list-plain">
                      {#each unverified as c (c.id)}
                        <li class="check-row" data-testid="diagnosis-check" data-status={c.status}>
                          <StatusBadge label="未確認" tone="neutral" />
                          <strong>{c.label}</strong>
                          <div class="detail"><strong>理由:</strong> {c.detail}</div>
                          {#if c.howToVerify}<div class="detail"><strong>確認方法:</strong> {c.howToVerify}</div>{/if}
                          {#if c.fix}<div class="detail"><strong>失敗したとき:</strong> {c.fix}</div>{/if}
                        </li>
                      {/each}
                    </ul>
                  </details>
                {/if}
                <details class="section" data-testid="diagnosis-ok">
                  <summary>正常 {okChecks.length} 件</summary>
                  <ul class="list-plain">
                    {#each okChecks as c (c.id)}
                      <li class="check-row" data-testid="diagnosis-check" data-status={c.status}>
                        <StatusBadge label="正常" tone="success" />
                        <strong>{c.label}</strong>
                        <div class="detail">{c.detail}</div>
                      </li>
                    {/each}
                  </ul>
                </details>
              </section>
            {/if}

            <details class="section">
              <summary>詳細（パス・Git ルート）</summary>
              <dl class="small">
                <dt>パス</dt>
                <dd>{p.path}</dd>
                <dt>Git ルート</dt>
                <dd>{p.gitRoot ?? '未検出'}</dd>
                <dt>現在のブランチ</dt>
                <dd>{p.currentBranch ?? '—'}{p.headSha ? ` @ ${p.headSha.slice(0, 12)}` : ''}</dd>
                <dt>ファイル数</dt>
                <dd>{p.fileCount}</dd>
              </dl>
            </details>
          </div>
        {/if}
      </section>

      <!-- 2. 依頼 -->
      <section class="card" aria-labelledby="request-heading">
        <div class="step-head">
          <span class="stepnum" aria-hidden="true">2</span>
          <h2 id="request-heading">依頼内容</h2>
        </div>
        <label for="request">何を実現したいか、自然言語で入力してください</label>
        <textarea id="request" bind:value={app.request} rows="5" placeholder="例: メールアドレスとパスワードでログインできる機能を追加したい" data-testid="request"></textarea>
        <p class="small muted">詳細は任意です。不足している情報は次の画面で最大 3 問ずつ質問します。実装は承認後にのみ開始されます。</p>
        <div class="row between">
          <span id="start-reason" class="small muted" data-testid="start-reason">{startDisabledReason ?? ''}</span>
          <button type="button" class="primary large" onclick={() => void createDraft()} disabled={!app.canStart} data-testid="start" aria-describedby={startDisabledReason ? 'start-reason' : undefined}>開始</button>
        </div>
      </section>
    </div>

    <aside class="stack">
      {#if app.environment?.canRun}
        <SetupCheck report={app.environment} error={null} busy={app.busy !== null} onRecheck={() => void checkEnvironment()} compact />
      {/if}
      <section class="card quiet" aria-labelledby="history-heading">
        <h2 id="history-heading">最近の履歴</h2>
        <HistoryList runs={app.history.slice(0, 4)} onSelect={(run) => (isTerminalRunState(run.state) ? void showResult(run.runId) : void resumeRun(run))} label="最近の実行履歴" compact />
        {#if app.history.length > 0}
          <button type="button" class="link" onclick={() => app.navigate('result')} style="margin-top: 0.4rem">すべての履歴を見る</button>
        {/if}
      </section>
    </aside>
  </div>
</div>

<style>
  .intro {
    padding: 0.2rem 0 0.3rem;
  }
  .intro .lead {
    max-width: 60ch;
  }
  .hint {
    margin-top: 0.4rem;
  }
  .project {
    margin-top: 0.8rem;
    padding-top: 0.8rem;
    border-top: 1px solid var(--border);
  }
  .chips {
    list-style: none;
    padding: 0;
  }
  .diagnosis h3 {
    margin: 0;
  }
  .diagnosis {
    background: var(--surface-alt);
    border-radius: var(--radius-sm);
    padding: 0.7rem 0.9rem 0.4rem;
  }
</style>
