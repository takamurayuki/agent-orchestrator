<script lang="ts">
  import { onMount } from 'svelte';
  import { REASON_CODE_LABELS, RUN_STATE_TONES, formatDateTime, isTerminalRunState, runStateLabel } from '../lib/labels';
  import { SEVERITY_LABELS, describeOutcome, severityImpact, severityTone } from '../lib/outcome';
  import { app } from '../lib/stores/app.svelte';
  import { loadHistory, openRunReport, resumeRun } from '../lib/stores/actions';
  import Alert from '../lib/components/Alert.svelte';
  import HistoryList from '../lib/components/HistoryList.svelte';
  import StatusBadge from '../lib/components/StatusBadge.svelte';

  const report = $derived(app.report);
  const outcome = $derived(report ? describeOutcome(report.run, report) : null);

  let diffOpen = $state(false);
  let copied = $state<string | null>(null);

  onMount(() => {
    void loadHistory();
    if (!app.report && app.run && isTerminalRunState(app.run.state)) void openRunReport(app.run.runId);
    else if (!app.report && app.history[0]) void openRunReport(app.history[0].runId);
  });

  // 別の Run を開いたら差分の展開状態を戻す
  $effect(() => {
    void app.reportRunId;
    diffOpen = false;
    copied = null;
  });

  function showChanges() {
    diffOpen = true;
    queueMicrotask(() => document.getElementById('changes-heading')?.scrollIntoView({ behavior: 'smooth', block: 'start' }));
  }

  async function copyText(label: string, text: string | null) {
    if (!text) return;
    try {
      await navigator.clipboard.writeText(text);
      copied = label;
      app.announce(`${label}をコピーしました`);
    } catch {
      copied = null;
      app.announce('コピーできませんでした。下のパスを選択してコピーしてください');
    }
  }

  function newRequest() {
    app.navigate('home');
  }

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
      {#if !report || !outcome}
        <div class="card">
          <p class="muted" role="status">{app.busy ? 'レポートを取得しています…' : '右の履歴から実行を選択してください。'}</p>
        </div>
      {:else}
        {@const run = report.run}
        {@const unapprovedPolicy = report.policyFindings.filter((p) => !p.approved)}
        <!-- 1. 結果の要約（平易な日本語） -->
        <section class="card outcome {outcome.tone}" aria-labelledby="result-heading" data-testid="result-summary">
          <p class="small muted">依頼: {run.taskTitle}</p>
          <div class="row" style="justify-content: space-between; align-items: flex-start">
            <h2 id="result-heading" data-testid="outcome-headline">{outcome.headline}</h2>
            <StatusBadge label={runStateLabel(run.state)} code={run.state} tone={RUN_STATE_TONES[run.state]} testid="result-state" />
          </div>
          <p data-testid="outcome-summary">{outcome.summary}</p>
          {#if outcome.caution}
            <Alert tone="warning" role="status" title="取り込む前に確認してください" message={outcome.caution} testid="outcome-caution" />
          {/if}
          {#if !isTerminalRunState(run.state)}
            <div class="row">
              <button type="button" class="primary" onclick={() => void resumeRun(run)}>実行画面で進捗を見る</button>
            </div>
          {/if}

          <dl class="guidance" data-testid="outcome-guidance">
            <dt>何が起きたか</dt>
            <dd>{outcome.guidance.cause}</dd>
            <dt>変更の状態</dt>
            <dd>{outcome.guidance.impact}</dd>
            <dt>次にできること</dt>
            <dd>
              <ol>
                {#each outcome.guidance.next as n, i (i)}
                  <li>{n}</li>
                {/each}
              </ol>
            </dd>
          </dl>
          {#if run.reasonDetail}
            <Alert tone={RUN_STATE_TONES[run.state]} role="status" title={run.state === 'PRECHECK_FAILED' ? '問題の内容' : 'システムからの詳細'} message={run.reasonDetail} testid="result-reason-detail" />
          {/if}

          <div class="row actions" data-testid="result-actions">
            {#if report.changedFiles.length > 0}
              <button type="button" class="primary" onclick={showChanges} data-testid="show-diff">変更内容を見る（{report.changedFiles.length} ファイル）</button>
            {/if}
            {#if report.worktreePath}
              <button type="button" onclick={() => void copyText('作業用コピーのパス', report.worktreePath)} data-testid="copy-worktree">作業用コピーのパスをコピー</button>
            {/if}
            <button type="button" onclick={newRequest} data-testid="new-request">新しい依頼を作る</button>
            {#if copied}<span class="small muted" role="status">{copied}をコピーしました</span>{/if}
          </div>
          <p class="small muted" data-testid="apply-note">
            元のプロジェクトへの反映はこのアプリでは行いません（push / merge / deploy もしません）。取り込む場合は、作業用コピーのフォルダーをお使いの Git ツールで開き、内容を確認してから取り込んでください。
          </p>
        </section>

        <!-- 2. 未解決の指摘（原因・影響・次の操作） -->
        <section class="card" aria-labelledby="findings-heading">
          <h2 id="findings-heading">未解決の指摘（{report.openFindings.length}）／ 確認できなかった要件（{report.requirementsUnverified.length}）</h2>
          {#if report.openFindings.length === 0}
            <p class="muted">未解決の指摘はありません。</p>
          {:else}
            <ul class="findings" data-testid="open-findings">
              {#each report.openFindings as f (f.id)}
                {@const impact = severityImpact(f.severity)}
                <li data-testid="open-finding">
                  <div class="row">
                    <StatusBadge label={`重要度: ${SEVERITY_LABELS[f.severity] ?? f.severity}`} code={f.severity} tone={severityTone(f.severity)} />
                    <strong>{f.id}</strong>
                    <code>{f.file}:{f.line}</code>
                  </div>
                  <dl class="finding">
                    <dt>原因</dt>
                    <dd>{f.description}</dd>
                    <dt>影響</dt>
                    <dd>{impact.text}</dd>
                    <dt>次の操作</dt>
                    <dd>{f.recommendation}</dd>
                  </dl>
                </li>
              {/each}
            </ul>
          {/if}
          {#if report.requirementsUnverified.length > 0}
            <h3>レビューで確認できなかった要件</h3>
            <p class="small muted">これらの要件は満たされているかどうか確認できていません。人が確認するまで完了と見なさないでください。</p>
            <ul data-testid="requirements-unverified">
              {#each report.requirementsUnverified as r, i (i)}
                <li>{r}</li>
              {/each}
            </ul>
          {/if}
        </section>

        <!-- 3. ポリシー違反 -->
        {#if report.policyFindings.length > 0}
          <section class="card" aria-labelledby="policy-heading" data-testid="policy-findings">
            <h2 id="policy-heading">ポリシー違反の内容（未承認 {unapprovedPolicy.length} 件）</h2>
            <p class="small">AI の変更がプロジェクトのルール（lint・型チェック・テスト）を弱めていないかを機械的に確認した結果です。この判定は AI のレビュー結果では上書きできません。</p>
            <ul data-testid="policy-finding-list">
              {#each report.policyFindings as p, i (`${p.ruleId}:${p.file}:${p.line}:${i}`)}
                <li>
                  <StatusBadge label={p.approved ? '承認済み例外' : '未承認'} tone={p.approved ? 'neutral' : 'danger'} />
                  <strong>{p.ruleId}</strong> <code>{p.file}:{p.line}</code>
                  <div>{p.message}</div>
                  <div class="small"><code>{p.evidence}</code>{#if p.approvalReason}（理由: {p.approvalReason}）{/if}</div>
                </li>
              {/each}
            </ul>
            <p class="small muted">意図した変更であれば、開発者に例外の登録（ベースコミットの <code>.agent-orchestrator/policy.json</code>、理由付き）を依頼してください。</p>
          </section>
        {:else}
          <section class="card" data-testid="policy-findings">
            <h2>ポリシー違反の内容</h2>
            <p class="muted">ルールの無効化・テストの削除や無効化・検証設定の緩和は検出されていません。</p>
          </section>
        {/if}

        <!-- 4. 変更内容 -->
        <section class="card" aria-labelledby="changes-heading">
          <h2 id="changes-heading">変更内容（{report.changedFiles.length} ファイル）</h2>
          {#if !outcome.done && report.changedFiles.length > 0}
            <p class="small"><strong>注意:</strong> これらは途中の変更です。完了条件を通過していません。</p>
          {/if}
          {#if report.changedFiles.length === 0}
            <p class="muted">変更されたファイルはありません。</p>
          {:else}
            <ul class="files" data-testid="changed-files">
              {#each report.changedFiles as file (file)}
                <li><code>{file}</code></li>
              {/each}
            </ul>
          {/if}
          <details bind:open={diffOpen} data-testid="diff">
            <summary>差分を表示{report.diffTruncated ? '（サイズ上限により一部省略）' : ''}</summary>
            {#if report.diffExcerpt}
              <pre class="diff">{report.diffExcerpt}</pre>
            {:else}
              <p class="muted">差分はありません。</p>
            {/if}
          </details>
          <p class="small muted">作業用コピー: <span data-testid="worktree-path">{report.worktreePath ?? '（なし）'}</span></p>
        </section>

        <!-- 5. 内部ステータス・技術情報（折りたたみ） -->
        <details class="card" data-testid="result-internal">
          <summary>内部ステータス・技術情報</summary>
          <p data-testid="result-status-text">
            内部ステータス: <strong>{runStateLabel(run.state)}（{run.state}）</strong>
            {#if run.reasonCode}
              ／ 理由コード: {REASON_CODE_LABELS[run.reasonCode] ?? run.reasonCode}（{run.reasonCode}）
            {/if}
          </p>
          <dl>
            <dt>Run ID</dt>
            <dd>{run.runId}</dd>
            <dt>開始 / 終了</dt>
            <dd>{formatDateTime(run.startedAt)} / {formatDateTime(run.finishedAt)}</dd>
            <dt>ラウンド</dt>
            <dd>{run.currentRound}/{run.maxRounds}</dd>
            <dt>未解決の blocking 指摘</dt>
            <dd>{run.openBlockingFindings} 件</dd>
            <dt>ベース</dt>
            <dd>{run.baseRef}{run.baseSha ? ` @ ${run.baseSha.slice(0, 12)}` : ''}</dd>
            <dt>作業用コピー</dt>
            <dd>{report.worktreePath ?? '（なし）'}</dd>
            <dt>レポート</dt>
            <dd>{report.reportPath}</dd>
          </dl>
          <h3>Runner が提示する次の手順（技術者向け）</h3>
          {#if run.nextActions.length === 0}
            <p class="muted">なし</p>
          {:else}
            <ol data-testid="next-actions">
              {#each run.nextActions as action, i (i)}
                <li>{action}</li>
              {/each}
            </ol>
          {/if}

          <h3>ネットワーク（egress プロキシ）</h3>
          <div data-testid="egress-summary">
            {#if !report.egress.available}
              <p class="muted">この Run の egress ログはありません。</p>
            {:else}
              <p class="small">
                許可（AI / レジストリ通信）: <strong data-testid="egress-allowed">{report.egress.allowed}</strong> 件 ／
                拒否（allowlist 外）: <strong data-testid="egress-denied">{report.egress.denied}</strong> 件 ／
                接続エラー: <strong data-testid="egress-errors">{report.egress.errors}</strong> 件
              </p>
              <dl>
                <dt><StatusBadge label="許可" tone="success" /> 通常の AI 通信先</dt>
                <dd>{report.egress.allowedHosts.length === 0 ? '（なし）' : report.egress.allowedHosts.join(', ')}</dd>
                <dt><StatusBadge label="拒否" tone="warning" /> allowlist 外への接続（遮断済み）</dt>
                <dd>
                  {#if report.egress.deniedHosts.length === 0}
                    （なし）
                  {:else}
                    <ul data-testid="egress-denied-hosts">
                      {#each report.egress.deniedHosts as d (d.host)}
                        <li><code>{d.host}</code> × {d.count}</li>
                      {/each}
                    </ul>
                  {/if}
                </dd>
                <dt><StatusBadge label="エラー" tone="danger" /> 許可先への接続エラー</dt>
                <dd>{report.egress.errorHosts.length === 0 ? '（なし）' : report.egress.errorHosts.join(', ')}</dd>
              </dl>
              <p class="small muted">ログにはホスト名とポートだけが記録されます（URL パス・ヘッダー・認証情報は含みません）。</p>
            {/if}
          </div>

          <details data-testid="report-markdown">
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
  .outcome {
    border-left: 6px solid var(--border);
  }
  .outcome.success {
    border-left-color: var(--success);
  }
  .outcome.warning {
    border-left-color: var(--warning, #b7791f);
  }
  .outcome.danger {
    border-left-color: var(--danger, #c53030);
  }
  .outcome.info {
    border-left-color: var(--info);
  }
  .guidance dd ol {
    margin: 0;
    padding-left: 1.2rem;
  }
  .actions {
    margin-top: 0.75rem;
    flex-wrap: wrap;
  }
  .findings > li {
    border: 1px solid var(--border);
    border-radius: var(--radius);
    padding: 0.5rem 0.75rem;
    margin-bottom: 0.5rem;
    list-style: none;
  }
  .findings {
    padding-left: 0;
  }
  .finding dt {
    font-weight: 600;
    margin-top: 0.3rem;
  }
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
