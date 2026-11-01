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

  function onPathSubmit(e: SubmitEvent) {
    e.preventDefault();
    void inspectProject(app.projectPath);
  }
</script>

<div class="stack" data-testid="screen-home">
  <h1>依頼を作成</h1>

  {#if app.environment && !app.environment.canRun}
    <SetupCheck report={app.environment} error={app.environmentError} busy={app.busy !== null} onRecheck={() => void checkEnvironment()} setup={app.sandboxSetup} onSandboxStart={() => void startSandboxSetup()} onSandboxCancel={() => void cancelSandboxSetup()} />
  {:else if app.sandboxSetup?.state === 'succeeded' && app.environment?.canRun}
    <Alert tone="success" role="status" title="サンドボックスの準備が完了しました" message="実行環境が整いました。プロジェクトを選んで依頼を入力してください。" testid="sandbox-success" />
  {:else if app.environmentError}
    <SetupCheck report={null} error={app.environmentError} busy={app.busy !== null} onRecheck={() => void checkEnvironment()} />
  {/if}

  <div class="grid-2">
    <div class="stack">
      <section class="card" aria-labelledby="project-heading">
        <h2 id="project-heading">1. プロジェクトフォルダー</h2>
        <form class="row" onsubmit={onPathSubmit}>
          <label for="project-path" class="sr-only">プロジェクトフォルダーのパス</label>
          <input type="text" id="project-path" style="flex: 1 1 20rem" bind:value={app.projectPath} placeholder="例: C:\Users\dev\projects\web-app" autocomplete="off" data-testid="project-path" />
          {#if transport.hasFolderPicker}
            <button type="button" onclick={() => void pickFolder()} disabled={app.busy !== null} data-testid="pick-folder">フォルダーを選択…</button>
          {/if}
          <button type="submit" disabled={app.busy !== null || app.projectPath.trim() === ''} data-testid="inspect-project">選択</button>
        </form>
        <p class="small muted">Git リポジトリのルートを指定してください。読み取り専用で Git・ベースブランチ・依存・テスト方式を調べます。</p>

        {#if app.projectError}
          <Alert tone="danger" role="alert" title="プロジェクトを調査できません" message={`${app.projectError.message} (${app.projectError.code})`} testid="project-error" />
        {:else if app.project}
          {@const p = app.project}
          <div class="stack" data-testid="project-info">
            <p>
              <StatusBadge label={PROJECT_STATUS_LABELS[p.status] ?? p.status} code={p.status} tone={p.status === 'ok' ? 'success' : 'danger'} testid="project-status" />
            </p>
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
            <dl>
              <dt>パス</dt>
              <dd>{p.path}</dd>
              <dt>Git ルート</dt>
              <dd>{p.gitRoot ?? '未検出'}</dd>
              <dt>現在のブランチ</dt>
              <dd>{p.currentBranch ?? '—'}{p.headSha ? ` @ ${p.headSha.slice(0, 12)}` : ''}</dd>
              <dt>ベースブランチ</dt>
              <dd>{p.defaultBaseRef ?? '—'}</dd>
              <dt>作業ツリー</dt>
              <dd>{p.isClean === null ? '—' : p.isClean ? 'クリーン' : '未コミットの変更あり'}</dd>
              <dt>パッケージ管理</dt>
              <dd>{p.packageManager ?? '—'}</dd>
              <dt>フレームワーク</dt>
              <dd>{p.frameworks.length ? p.frameworks.join(', ') : '—'}</dd>
              <dt>テスト</dt>
              <dd>{p.testFrameworks.length ? p.testFrameworks.join(', ') : '—'}</dd>
              <dt>検証プロファイル</dt>
              <dd data-testid="verification-profile">
                {#if p.verificationProfile}
                  {p.verificationProfile.name}: {p.verificationProfile.ready ? '準備完了' : `不足スクリプト ${p.verificationProfile.missingScripts.join(', ')}`}
                {:else}
                  未判定
                {/if}
              </dd>
              <dt>ファイル数</dt>
              <dd>{p.fileCount}</dd>
            </dl>
          </div>
        {/if}
      </section>

      <section class="card" aria-labelledby="request-heading">
        <h2 id="request-heading">2. 依頼内容</h2>
        <label for="request">何を実現したいか、自然言語で入力してください</label>
        <textarea id="request" bind:value={app.request} rows="5" placeholder="例: メールアドレスとパスワードでログインできる機能を追加したい" data-testid="request"></textarea>
        <p class="small muted">詳細は任意です。不足している情報は次の画面で最大 3 問ずつ質問します。実装は承認後にのみ開始されます。</p>
        <div class="row">
          <button type="button" class="primary" onclick={() => void createDraft()} disabled={!app.canStart} data-testid="start" aria-describedby={startDisabledReason ? 'start-reason' : undefined}>開始</button>
          {#if startDisabledReason}
            <span id="start-reason" class="small muted" data-testid="start-reason">{startDisabledReason}</span>
          {/if}
        </div>
      </section>
    </div>

    <aside class="stack">
      <section class="card" aria-labelledby="history-heading">
        <h2 id="history-heading">最近の履歴</h2>
        <HistoryList runs={app.history.slice(0, 5)} onSelect={(run) => (isTerminalRunState(run.state) ? void showResult(run.runId) : void resumeRun(run))} label="最近の実行履歴" />
        {#if app.history.length > 0}
          <button type="button" class="link" onclick={() => app.navigate('result')} style="margin-top: 0.5rem">すべての履歴を見る</button>
        {/if}
      </section>
      {#if app.environment?.canRun}
        <SetupCheck report={app.environment} error={null} busy={app.busy !== null} onRecheck={() => void checkEnvironment()} />
      {/if}
    </aside>
  </div>
</div>
