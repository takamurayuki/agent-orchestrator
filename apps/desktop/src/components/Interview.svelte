<script lang="ts">
  import { DRAFT_STATE_LABELS, MAX_INTERVIEW_QUESTIONS, MAX_INTERVIEW_ROUNDS } from '../lib/labels';
  import { app } from '../lib/stores/app.svelte';
  import { answerRound, approveAndStart, goBack, reviseDraft } from '../lib/stores/actions';
  import Alert from '../lib/components/Alert.svelte';
  import ApprovalOverview from '../lib/components/ApprovalOverview.svelte';
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
  /** 要件を修正した後は再承認が必要（UI の説明用。承認の可否自体は revision の一致で Runner が判定） */
  let revisedSinceSummary = $state(false);
  let editorOpen = $state(false);

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
  /** 回答後の再評価中（GAP_ANALYZING 等）: 質問も素案もまだ無い。承認セクションは出さない（v0.2.2 配布版検証で、再評価中に承認セクションが先に出て自動操作が誤動作した） */
  const evaluating = $derived(!!draft && !asking && !draft.proposal && draft.state !== 'BLOCKED');
  const roundCount = $derived(draft ? Math.max(1, Math.ceil(draft.totalQuestionsAsked / 3), draft.round) : 1);
  const unresolvedContradictions = $derived(draft?.contradictions ?? []);
  const roundPct = $derived(draft ? Math.min(100, Math.round((Math.min(draft.round, MAX_INTERVIEW_ROUNDS) / MAX_INTERVIEW_ROUNDS) * 100)) : 0);
  const answeredNow = $derived(draft ? draft.currentQuestions.filter((q) => (answers[q.id]?.value ?? '').trim() !== '' || answers[q.id]?.skipped).length : 0);

  const approveDisabledReasons = $derived.by(() => {
    const reasons: string[] = [];
    if (!draft) return ['draft がありません'];
    if (draft.approved) reasons.push('既に承認済みです');
    if (draft.state === 'BLOCKED') reasons.push('BLOCKED: ' + (draft.blockedReason ?? '要件を確定できません'));
    if (blocking.length > 0) {
      const titles = blocking.map((id) => draft.askedQuestions.find((q) => q.id === id)?.question ?? id);
      reasons.push(`未回答の必須質問があります: ${titles.join(' / ')}`);
    }
    if (unresolvedContradictions.length > 0) reasons.push(`未解消の矛盾があります: ${unresolvedContradictions.map((c) => c.description).join(' / ')}`);
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

  async function revise(edits: Parameters<typeof reviseDraft>[0]): Promise<boolean> {
    const ok = await reviseDraft(edits);
    if (ok) {
      revisedSinceSummary = true;
      consent = false; // 内容が変わったので同意も取り直す（再承認）
    }
    return ok;
  }
</script>

{#if !draft}
  <div class="card" data-testid="screen-interview">
    <h1>ヒアリング</h1>
    {#if app.busy}
      <p role="status" data-testid="draft-creating">{app.busy}中です。リポジトリを調べて最初の質問を用意しています（数十秒かかります）…</p>
    {:else}
      <p>まずホーム画面でプロジェクトと依頼内容を入力して「開始」を押してください。</p>
      <button type="button" onclick={() => app.navigate('home')}>ホームへ</button>
    {/if}
  </div>
{:else}
  <div class="stack" data-testid="screen-interview">
    <!-- 見出し: 依頼を主役に、状態と進捗は 1 行 -->
    <header class="card hero tone-info">
      <div class="row between">
        <span class="eyebrow">ヒアリングと承認</span>
        <StatusBadge label={DRAFT_STATE_LABELS[draft.state] ?? draft.state} code={draft.state} tone={draft.state === 'BLOCKED' ? 'danger' : draft.approved ? 'success' : 'info'} testid="draft-state" />
      </div>
      <h1 class="headline request">{draft.request}</h1>
      <p class="tiny muted">プロジェクト: {draft.projectPath} ／ リビジョン {draft.revision}</p>
      <div class="progress" role="group" aria-label="ヒアリングの進捗" data-testid="progress">
        <div class="progress-bar" aria-hidden="true"><span style="width: {roundPct}%"></span></div>
        <div class="row small">
          <span>ラウンド <strong>{Math.min(draft.round, MAX_INTERVIEW_ROUNDS)}/{MAX_INTERVIEW_ROUNDS}</strong></span>
          <span class="sep" aria-hidden="true">·</span>
          <span>質問数 <strong>{draft.totalQuestionsAsked}/{MAX_INTERVIEW_QUESTIONS}</strong></span>
          <span class="sep" aria-hidden="true">·</span>
          <span>未回答の必須質問 <strong>{blocking.length}</strong> 件</span>
          <span class="tiny muted">（実施済みラウンド: {roundCount}）</span>
        </div>
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
            <div class="row between">
              <h2 id="round-heading">ラウンド {draft.round} の質問（{draft.currentQuestions.length} 問）</h2>
              <span class="small muted">回答済み {answeredNow}/{draft.currentQuestions.length}</span>
            </div>
            {#each draft.currentQuestions as question, i (question.id)}
              <QuestionCard
                {question}
                index={i + 1}
                answer={answers[question.id] ?? { value: '', skipped: false }}
                disabled={app.busy !== null}
                onChange={(next) => (answers = { ...answers, [question.id]: next })}
              />
            {/each}
            <div class="actionbar row between">
              <div class="row">
                <button type="button" onclick={() => void goBack()} disabled={!canGoBack} data-testid="back-round">戻る</button>
                <span class="tiny muted">未入力の質問はスキップとして送信されます。必須質問をスキップすると要件は確定できません。</span>
              </div>
              <button type="button" class="primary large" onclick={submitRound} disabled={app.busy !== null} data-testid="answer-round">回答して次へ</button>
            </div>
          </section>
          <p class="tiny muted" data-testid="approve-pending-note">すべての質問に回答すると、要件サマリーと「開発を開始」ボタンが表示されます。</p>
        {:else if draft.state === 'BLOCKED'}
          <section class="card actions row">
            <button type="button" onclick={() => void goBack()} disabled={!canGoBack} data-testid="back-round">戻る</button>
            <span class="small">「戻る」で直前のラウンドに戻り、必須質問に回答してください。</span>
          </section>
        {:else if draft.proposal && !draft.approved}
          <section class="card actions row">
            <button type="button" onclick={() => void goBack()} disabled={!canGoBack} data-testid="back-round">戻る（質問を修正）</button>
            <span class="small muted">質問は完了しました。要件サマリーを確認し、よければ承認してください。</span>
          </section>
        {/if}

        {#if evaluating}
          <section class="card" role="status" data-testid="draft-evaluating">
            <h2>要件を再評価しています</h2>
            <p class="small muted">回答をもとにリポジトリの事実と照らし合わせ、次の質問または要件サマリーを用意しています（数十秒〜数分）。状態: {DRAFT_STATE_LABELS[draft.state] ?? draft.state}</p>
          </section>
        {/if}
        {#if !asking && (draft.proposal || draft.state === 'BLOCKED')}
          <!-- 1. 要件サマリー（平易な概要）を最初に。BLOCKED のときは承認できない理由を見せるために残す -->
          <ApprovalOverview {draft} />

          <!-- 2. 承認（主操作は常に見える位置に） -->
          <section class="card actionbar approve" aria-labelledby="approve-heading" data-testid="approve-section">
            <h2 id="approve-heading">承認して開発を開始</h2>
            {#if revisedSinceSummary && !draft.approved}
              <Alert tone="info" role="status" title="要件を変更したため再承認が必要です" message={`リビジョン ${draft.revision} の内容を確認し、同意のチェックを入れ直してから承認してください。`} testid="reapproval-note" />
            {/if}
            <p class="tiny muted">承認すると要件が固定され、隔離環境で AI の実装・検証・レビューが始まります（最大 {3} 回の修正、数分〜数十分、AI の利用料金が発生）。<strong>リポジトリの内容がモデル提供者へ送信される</strong>可能性があります。push / merge / deploy は行いません。</p>
            <div class="row between approve-row">
              <div class="consent">
                <input type="checkbox" id="consent" bind:checked={consent} disabled={draft.approved} data-testid="consent" />
                <label for="consent">リポジトリの内容がモデルに送信されることに同意する</label>
              </div>
              <button type="button" class="primary large" onclick={() => void approveAndStart()} disabled={!canApprove} aria-describedby="approve-reasons" data-testid="approve">この内容で開発を開始</button>
            </div>
            <div id="approve-reasons" class="tiny" data-testid="approve-reasons">
              {#if approveDisabledReasons.length > 0}
                <span class="muted">開始できない理由:</span>
                <ul>
                  {#each approveDisabledReasons as reason, i (i)}
                    <li>{reason}</li>
                  {/each}
                </ul>
              {:else}
                <span class="muted">承認できます。ボタンを押すと要件（リビジョン {draft.revision}）が固定され、実行が始まります。</span>
              {/if}
            </div>
          </section>

          <!-- 3. 修正（必要な場合だけ開く） -->
          {#if draft.proposal}
            <details class="card" bind:open={editorOpen} data-testid="summary-editor-details">
              <summary data-testid="edit-summary">要件を修正する（要件・対象外・実装方針・受入条件を直接編集）</summary>
              <p class="small muted">修正して保存すると新しいリビジョンになり、承認は取り直しになります。</p>
              <SummaryEditor {draft} disabled={app.busy !== null || draft.approved} onRevise={revise} onDirtyChange={(d) => (summaryDirty = d)} />
            </details>
          {/if}
        {/if}

        <!-- 4. AI の要件理解・判断の記録（折りたたみ） -->
        {#if asking}
          <details class="card" data-testid="understanding-details">
            <summary>AI の現在の要件理解（回答のたびに更新）</summary>
            <p class="tiny muted">確定事項・選択・推奨・未確定は分けて記録されます。</p>
            <pre data-testid="draft-summary">{draft.summary}</pre>
          </details>
        {:else}
          <details class="card" data-testid="understanding-details">
            <summary>AI の要件理解と判断の記録（技術情報）</summary>
            <h3>現在の要件理解</h3>
            <pre data-testid="draft-summary">{draft.summary}</pre>
            {#if draft.decisions.length > 0}
              <h3>意思決定ログ</h3>
              <p class="small muted">質問への回答・矛盾の解消・承認前の修正を記録します。同じ事項の新しい判断が古い判断より優先されます。</p>
              <ul class="small" data-testid="decision-log">
                {#each draft.decisions as d (d.topicKey)}
                  <li class:muted={d.status !== 'active'}>
                    <span class="badge neutral">{d.source === 'interview' ? '質問' : d.source === 'contradiction' ? '矛盾' : '修正'}</span>
                    <strong>{d.topicKey}</strong>: {d.question} → <strong>{d.chosenLabel}</strong>
                    {#if d.status === 'retracted'}<span class="badge neutral">取り消し</span>{:else if d.status === 'superseded'}<span class="badge neutral">{d.supersededBy} で置き換え</span>{/if}
                    {#if d.consequence}<span class="muted">（{d.consequence}）</span>{/if}
                    {#if d.relatedRequirements.length > 0}<span class="muted"> 対象: {d.relatedRequirements.join(' / ')}</span>{/if}
                    {#if d.history.length > 0}<span class="muted"> 履歴 {d.history.length} 件</span>{/if}
                  </li>
                {/each}
              </ul>
            {/if}
            {#if draft.approved && draft.taskYaml}
              <h3>固定された task.yaml</h3>
              <pre>{draft.taskYaml}</pre>
            {/if}
          </details>
        {/if}
      </div>

      <aside class="stack">
        <FactsPanel facts={draft.facts} />
        {#if draft.verificationReadiness}
          <section class="card quiet" aria-labelledby="verif-heading">
            <h2 id="verif-heading">検証プロファイル</h2>
            <p class="row">
              <StatusBadge label={draft.verificationReadiness.ready ? '準備完了' : '不足あり'} tone={draft.verificationReadiness.ready ? 'success' : 'danger'} />
              <code>{draft.verificationReadiness.profile}</code>
            </p>
            <p class="tiny muted">{draft.verificationReadiness.detail}</p>
            {#if draft.verificationReadiness.missingScripts.length}
              <p class="small">不足スクリプト: {draft.verificationReadiness.missingScripts.join(', ')}。package.json に追加してください。</p>
            {/if}
          </section>
        {/if}
        {#if draft.answers.length > 0}
          <section class="card quiet" aria-labelledby="answers-heading">
            <h2 id="answers-heading">回答履歴</h2>
            <ul class="small list-plain answers" data-testid="answer-history">
              {#each draft.answers as a (a.questionId)}
                {@const q = draft.askedQuestions.find((x) => x.id === a.questionId)}
                <li>
                  <span class="tiny muted">R{a.round} {a.questionId}</span>
                  <div>{q?.question ?? ''}</div>
                  <div class="answer">→ {a.skipped ? 'スキップ' : (q?.options.find((o) => o.value === a.value)?.label ?? a.value)}</div>
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
  .request {
    font-size: 1.2rem;
    font-weight: 600;
  }
  .progress {
    margin-top: 0.6rem;
    display: grid;
    gap: 0.4rem;
  }
  .sep {
    color: var(--muted);
  }
  .actions {
    padding: 0.75rem 1rem;
  }
  .approve {
    padding-top: 0.7rem;
    padding-bottom: 0.6rem;
  }
  .approve h2 {
    margin-bottom: 0.15rem;
    font-size: 0.98rem;
  }
  .approve-row {
    margin: 0.35rem 0 0.2rem;
  }
  .approve :global(ul) {
    margin: 0.1rem 0 0;
  }
  .consent {
    display: flex;
    gap: 0.5rem;
    align-items: center;
  }
  .consent label {
    margin: 0;
    font-weight: 500;
  }
  .consent input {
    width: 1.2rem;
    height: 1.2rem;
    accent-color: var(--primary);
  }
  .answers li + li {
    margin-top: 0.5rem;
  }
  .answer {
    color: var(--text-soft);
  }
</style>
