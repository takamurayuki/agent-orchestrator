<script lang="ts">
  import { DRAFT_STATE_LABELS, MAX_INTERVIEW_QUESTIONS, MAX_INTERVIEW_ROUNDS } from '../lib/labels';
  import { app } from '../lib/stores/app.svelte';
  import { answerRound, approveAndStart, goBack, reviseDraft } from '../lib/stores/actions';
  import Alert from '../lib/components/Alert.svelte';
  import FactsPanel from '../lib/components/FactsPanel.svelte';
  import QuestionCard from '../lib/components/QuestionCard.svelte';
  import type { QuestionDraftAnswer } from '../lib/components/types';
  import StatusBadge from '../lib/components/StatusBadge.svelte';
  import SummaryEditor from '../lib/components/SummaryEditor.svelte';

  const draft = $derived(app.draft);

  /** Answers for the questions currently on screen. */
  let answers = $state<Record<string, QuestionDraftAnswer>>({});
  /** Remembered answers so「戻る」prefills the previous choices for editing. */
  let remembered: Record<string, QuestionDraftAnswer> = {};
  let roundKey = '';
  let consent = $state(false);
  let summaryDirty = $state(false);

  $effect(() => {
    const d = app.draft;
    if (!d) return;
    const key = `${d.id}:${d.round}:${d.currentQuestions.map((q) => q.id).join(',')}`;
    if (key === roundKey) return;
    roundKey = key;
    const next: Record<string, QuestionDraftAnswer> = {};
    for (const q of d.currentQuestions) {
      const recorded = d.answers.find((a) => a.questionId === q.id);
      next[q.id] = recorded
        ? { value: recorded.value ?? '', skipped: recorded.skipped }
        : (remembered[q.id] ?? { value: '', skipped: false });
    }
    answers = next;
  });

  const blocking = $derived(draft?.blockingQuestions ?? []);
  const canGoBack = $derived((draft?.answers.length ?? 0) > 0 && !draft?.approved && app.busy === null);
  const asking = $derived(draft?.state === 'ASKING' && (draft?.currentQuestions.length ?? 0) > 0);
  const roundCount = $derived(draft ? Math.max(1, Math.ceil(draft.totalQuestionsAsked / 3), draft.round) : 1);

  const approveDisabledReasons = $derived.by(() => {
    const reasons: string[] = [];
    if (!draft) return ['draft がありません'];
    if (draft.approved) reasons.push('既に承認済みです');
    if (draft.state === 'BLOCKED') reasons.push('BLOCKED: ' + (draft.blockedReason ?? '要件を確定できません'));
    if (blocking.length > 0) {
      const titles = blocking.map((id) => draft.askedQuestions.find((q) => q.id === id)?.question ?? id);
      reasons.push(`未回答の必須質問があります: ${titles.join(' / ')}`);
    }
    if (asking) reasons.push('現在のラウンドの質問に回答してください');
    if (!draft.proposal) reasons.push('要件サマリーがまだ生成されていません');
    if (draft.verificationReadiness && !draft.verificationReadiness.ready) reasons.push(`検証スクリプトが不足しています: ${draft.verificationReadiness.missingScripts.join(', ')}`);
    if (draft.validationErrors.length > 0) reasons.push(`YAML 検証エラー: ${draft.validationErrors.join(' / ')}`);
    if (summaryDirty) reasons.push('要件サマリーに未保存の修正があります。保存または破棄してください');
    if (!consent) reasons.push('「リポジトリの内容がモデルに送信されることに同意」にチェックしてください');
    if (app.busy) reasons.push(`${app.busy}中です`);
    return reasons;
  });

  const canApprove = $derived(approveDisabledReasons.length === 0);

  function submitRound() {
    if (!draft) return;
    const payload = draft.currentQuestions.map((q) => {
      const a = answers[q.id] ?? { value: '', skipped: false };
      remembered[q.id] = a;
      const value = a.skipped || a.value.trim() === '' ? null : a.value.trim();
      return { questionId: q.id, value, skipped: value === null };
    });
    void answerRound(payload);
  }
</script>

{#if !draft}
  <div class="card" data-testid="screen-interview">
    <h1>ヒアリング</h1>
    <p>まずホーム画面でプロジェクトと依頼内容を入力して「開始」を押してください。</p>
    <button type="button" onclick={() => app.navigate('home')}>ホームへ</button>
  </div>
{:else}
  <div class="stack" data-testid="screen-interview">
    <header class="card">
      <div class="row" style="justify-content: space-between">
        <h1>ヒアリングと承認</h1>
        <StatusBadge label={DRAFT_STATE_LABELS[draft.state] ?? draft.state} code={draft.state} tone={draft.state === 'BLOCKED' ? 'danger' : draft.approved ? 'success' : 'info'} testid="draft-state" />
      </div>
      <p class="small"><strong>依頼:</strong> {draft.request}</p>
      <p class="small muted"><strong>プロジェクト:</strong> {draft.projectPath} ／ <strong>リビジョン</strong> {draft.revision}</p>
      <div class="progress" role="group" aria-label="ヒアリングの進捗" data-testid="progress">
        <span>ラウンド <strong>{Math.min(draft.round, MAX_INTERVIEW_ROUNDS)}/{MAX_INTERVIEW_ROUNDS}</strong></span>
        <span>質問数 <strong>{draft.totalQuestionsAsked}/{MAX_INTERVIEW_QUESTIONS}</strong></span>
        <span>未回答の必須質問 <strong>{blocking.length}</strong> 件</span>
        <span class="muted small">（実施済みラウンド: {roundCount}）</span>
      </div>
    </header>

    {#if draft.state === 'BLOCKED'}
      <Alert tone="danger" role="alert" title="ブロックされています（BLOCKED）" message={draft.blockedReason ?? '要件を確定できません。'} testid="blocked-reason" />
    {/if}

    {#if draft.prohibitedOperations.length > 0}
      <Alert tone="warning" role="status" title="自動実行しない操作が依頼に含まれています" testid="prohibited">
        <ul>
          {#each draft.prohibitedOperations as op, i (i)}
            <li>{op}</li>
          {/each}
        </ul>
      </Alert>
    {/if}

    <div class="grid-2">
      <div class="stack">
        {#if asking}
          <section aria-labelledby="round-heading" class="stack" data-testid="question-round">
            <h2 id="round-heading">ラウンド {draft.round} の質問（{draft.currentQuestions.length} 問）</h2>
            {#each draft.currentQuestions as question, i (question.id)}
              <QuestionCard
                {question}
                index={i + 1}
                answer={answers[question.id] ?? { value: '', skipped: false }}
                disabled={app.busy !== null}
                onChange={(next) => (answers = { ...answers, [question.id]: next })}
              />
            {/each}
            <div class="row card actions">
              <button type="button" class="primary" onclick={submitRound} disabled={app.busy !== null} data-testid="answer-round">回答して次へ</button>
              <button type="button" onclick={() => void goBack()} disabled={!canGoBack} data-testid="back-round">戻る</button>
              <span class="small muted">未入力の質問はスキップとして送信されます。必須質問をスキップすると要件は確定できません。</span>
            </div>
          </section>
        {:else if draft.state === 'BLOCKED'}
          <section class="card actions row">
            <button type="button" onclick={() => void goBack()} disabled={!canGoBack} data-testid="back-round">戻る</button>
            <span class="small">「戻る」で直前のラウンドに戻り、必須質問に回答してください。</span>
          </section>
        {:else if draft.proposal && !draft.approved}
          <section class="card actions row">
            <button type="button" onclick={() => void goBack()} disabled={!canGoBack} data-testid="back-round">戻る（質問を修正）</button>
            <span class="small muted">質問は完了しました。下のサマリーを確認・修正し、承認してください。</span>
          </section>
        {/if}

        <section class="card" aria-labelledby="understanding-heading">
          <h2 id="understanding-heading">現在の要件理解</h2>
          <p class="small muted">回答のたびに再評価されます。確定事項・選択・推奨・未確定は分けて記録します。</p>
          <pre data-testid="draft-summary">{draft.summary}</pre>
          {#if draft.decisions.length > 0}
            <h3>意思決定ログ（矛盾の解消）</h3>
            <ul class="small" data-testid="decision-log">
              {#each draft.decisions as d (d.contradictionId)}
                <li><strong>{d.contradictionId}</strong>: {d.question} → <strong>{d.chosenLabel}</strong>（{d.consequence}）</li>
              {/each}
            </ul>
          {/if}
        </section>

        <SummaryEditor {draft} disabled={app.busy !== null || draft.approved} onRevise={reviseDraft} onDirtyChange={(d) => (summaryDirty = d)} />

        <section class="card" aria-labelledby="approve-heading" data-testid="approve-section">
          <h2 id="approve-heading">承認して開発を開始</h2>
          <Alert tone="info" title="データの取り扱い">
            <p class="small">承認すると task.yaml を固定し、隔離されたワークツリーと Docker コンテナ内で Claude Code による実装、検証、Codex によるレビューを行います。この過程で<strong>リポジトリの内容（コード・設定）がモデル提供者へ送信される</strong>可能性があります。機密リポジトリの場合は事前に確認してください。push / merge / deploy は行いません。</p>
          </Alert>
          <div class="consent">
            <input type="checkbox" id="consent" bind:checked={consent} disabled={draft.approved} data-testid="consent" />
            <label for="consent">リポジトリの内容がモデルに送信されることに同意する</label>
          </div>
          <div class="row">
            <button type="button" class="primary" onclick={() => void approveAndStart()} disabled={!canApprove} aria-describedby="approve-reasons" data-testid="approve">この内容で開発を開始</button>
          </div>
          <div id="approve-reasons" class="small" data-testid="approve-reasons">
            {#if approveDisabledReasons.length > 0}
              <p class="muted">開始できない理由:</p>
              <ul>
                {#each approveDisabledReasons as reason, i (i)}
                  <li>{reason}</li>
                {/each}
              </ul>
            {:else}
              <p class="muted">承認可能です。ボタンを押すと task.yaml（リビジョン {draft.revision}）が固定され、Run が開始されます。</p>
            {/if}
          </div>
          {#if draft.approved && draft.taskYaml}
            <details>
              <summary>固定された task.yaml</summary>
              <pre>{draft.taskYaml}</pre>
            </details>
          {/if}
        </section>
      </div>

      <aside class="stack">
        <FactsPanel facts={draft.facts} />
        {#if draft.verificationReadiness}
          <section class="card" aria-labelledby="verif-heading">
            <h2 id="verif-heading">検証プロファイル</h2>
            <p>
              <StatusBadge label={draft.verificationReadiness.ready ? '準備完了' : '不足あり'} tone={draft.verificationReadiness.ready ? 'success' : 'danger'} />
              <code>{draft.verificationReadiness.profile}</code>
            </p>
            <p class="small">{draft.verificationReadiness.detail}</p>
            {#if draft.verificationReadiness.missingScripts.length}
              <p class="small">不足スクリプト: {draft.verificationReadiness.missingScripts.join(', ')}。package.json に追加してください。</p>
            {/if}
          </section>
        {/if}
        {#if draft.answers.length > 0}
          <section class="card" aria-labelledby="answers-heading">
            <h2 id="answers-heading">回答履歴</h2>
            <ul class="small" data-testid="answer-history">
              {#each draft.answers as a (a.questionId)}
                {@const q = draft.askedQuestions.find((x) => x.id === a.questionId)}
                <li>
                  <strong>R{a.round} {a.questionId}</strong> {q?.question ?? ''}<br />
                  → {a.skipped ? 'スキップ' : (q?.options.find((o) => o.value === a.value)?.label ?? a.value)}
                </li>
              {/each}
            </ul>
          </section>
        {/if}
      </aside>
    </div>
  </div>
{/if}

<style>
  .progress {
    display: flex;
    flex-wrap: wrap;
    gap: 1rem;
    padding: 0.5rem 0.75rem;
    background: var(--surface-alt);
    border-radius: var(--radius);
  }
  .actions {
    padding: 0.75rem 1rem;
  }
  .consent {
    display: flex;
    gap: 0.5rem;
    align-items: center;
    margin: 0.75rem 0;
  }
  .consent label {
    margin: 0;
  }
  .consent input {
    width: 1.2rem;
    height: 1.2rem;
  }
</style>
