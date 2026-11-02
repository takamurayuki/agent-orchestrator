<script lang="ts">
  import type { DraftView } from '@agent-orchestrator/contracts';

  interface Props {
    draft: DraftView;
  }

  let { draft }: Props = $props();
  const p = $derived(draft.proposal);
  const activeDecisions = $derived(draft.decisions.filter((d) => d.status === 'active'));
  const generatedMissing = $derived(p ? p.generatedArtifacts.filter((g) => g.inputStatus === 'missing').length : 0);
</script>

{#if p}
  <section class="card" aria-labelledby="overview-heading" data-testid="approval-overview">
    <span class="eyebrow">要件サマリー（リビジョン {draft.revision}）</span>
    <h2 id="overview-heading" class="headline" data-testid="overview-title">{p.title}</h2>
    <p data-testid="overview-objective">{p.objective}</p>
    <p class="tiny muted">AI が依頼と回答から整理した内容です。この内容で開発を始めてよいか確認してください。修正は下の「要件を修正する」から行えます。</p>

    <div class="tiles" aria-label="要約">
      <div class="tile"><span class="label">機能要件</span><span class="value">{p.requirements.length} <span class="unit">件</span></span></div>
      <div class="tile"><span class="label">受入条件</span><span class="value">{p.acceptanceCriteria.length} <span class="unit">件</span></span></div>
      <div class="tile"><span class="label">変更が予想される範囲</span><span class="value">{p.expectedChanges.length} <span class="unit">箇所</span></span></div>
      <div class="tile"><span class="label">対象外</span><span class="value">{p.outOfScope.length} <span class="unit">件</span></span></div>
      <div class="tile"><span class="label">生成物の更新</span><span class="value">{p.generatedArtifacts.length} <span class="unit">件</span>{#if generatedMissing > 0}<span class="tiny warn"> 入力不足 {generatedMissing}</span>{/if}</span></div>
      <div class="tile"><span class="label">確認方法</span><span class="value text">{draft.verificationReadiness ? (draft.verificationReadiness.ready ? '自動検証あり' : '検証コマンド不足') : '未確定'}</span></div>
    </div>

    <details class="section" open>
      <summary>機能要件<span class="count">{p.requirements.length} 件</span></summary>
      <ol data-testid="overview-requirements">
        {#each p.requirements as r, i (i)}
          <li>{r}</li>
        {/each}
      </ol>
    </details>

    <details class="section" open>
      <summary>受入条件 — こうなっていれば完了<span class="count">{p.acceptanceCriteria.length} 件</span></summary>
      <ol data-testid="overview-criteria">
        {#each p.acceptanceCriteria as c (c.id)}
          <li><span class="tiny muted">{c.id}</span> {c.given}とき、{c.when}と、{c.then}。</li>
        {/each}
      </ol>
    </details>

    <details class="section">
      <summary>制約・やらないこと<span class="count">{p.outOfScope.length + draft.prohibitedOperations.length + 2} 件</span></summary>
      <ul data-testid="overview-constraints">
        {#each p.outOfScope as o, i (i)}
          <li>対象外: {o}</li>
        {/each}
        {#each draft.prohibitedOperations as op, i (i)}
          <li>自動では行わない操作: {op}</li>
        {/each}
        <li>push / merge / deploy は行いません。変更は作業用コピーに保存され、元のプロジェクトへの反映は手動です。</li>
        <li>実装・検証・レビューは Docker で隔離したコンテナ内で行い、許可した通信先以外には接続しません。</li>
      </ul>
    </details>

    <details class="section">
      <summary>進め方（実装方針）</summary>
      <p data-testid="overview-approach">{p.approach}</p>
    </details>

    <details class="section">
      <summary>変更が予想されるファイル・領域<span class="count">{p.expectedChanges.length} 件</span></summary>
      {#if p.expectedChanges.length === 0}
        <p class="muted" data-testid="overview-expected-changes">指定なし（AI の変更範囲は判定されません）</p>
      {:else}
        <ul data-testid="overview-expected-changes">
          {#each p.expectedChanges as e, i (i)}
            <li><code>{e}</code></li>
          {/each}
        </ul>
        <p class="tiny muted">この範囲の外に大きな変更があった場合、AI は検証・レビューの前に止まり、人の判断を求めます。</p>
      {/if}
    </details>

    <details class="section" open={generatedMissing > 0}>
      <summary>生成物の更新（自動で再生成して確認）<span class="count">{p.generatedArtifacts.length === 0 ? 'なし' : `${p.generatedArtifacts.length} 件`}</span></summary>
      {#if p.generatedArtifacts.length === 0}
        <p class="muted" data-testid="overview-generated-artifacts">なし</p>
      {:else}
        <ul data-testid="overview-generated-artifacts">
          {#each p.generatedArtifacts as g, i (i)}
            <li>
              <code>{g.path}</code> ← <code>pnpm run {g.script}</code><span class="tiny muted">（{g.reason}）</span>
              {#if g.inputStatus === 'missing'}
                <div class="small" data-testid="generated-input-status" data-status="missing"><strong>注意:</strong> 生成スクリプトの入力 {(g.inputs ?? []).filter((x) => x.status === 'ignored' || x.status === 'missing').map((x) => x.path).join(', ')} は Git 管理外で、隔離環境にはありません。再生成の最新性だけを検証し、内容の妥当性は未確認になります。</div>
              {:else if g.inputStatus === 'unknown'}
                <div class="tiny muted" data-testid="generated-input-status" data-status="unknown">入力の依存関係は静的に確定できませんでした（確認方法: 生成スクリプトが読むファイルが Git 管理下か確認する）。</div>
              {:else if g.inputStatus === 'ok'}
                <div class="tiny muted" data-testid="generated-input-status" data-status="ok">入力はすべて Git 管理下です。</div>
              {/if}
            </li>
          {/each}
        </ul>
        <p class="tiny muted">AI がスクリプトを実行して更新し、検証で再実行して最新であることを確認します。</p>
      {/if}
    </details>

    <details class="section" open={p.conflictRisks.length > 0}>
      <summary>既存機能との衝突の可能性<span class="count">{p.conflictRisks.length === 0 ? '特定なし' : `${p.conflictRisks.length} 件`}</span></summary>
      {#if p.conflictRisks.length === 0}
        <p class="muted" data-testid="overview-conflict-risks">特定されていません</p>
      {:else}
        <ul data-testid="overview-conflict-risks">
          {#each p.conflictRisks as r, i (i)}
            <li>{r}</li>
          {/each}
        </ul>
      {/if}
    </details>

    <details class="section">
      <summary>確認方法（テスト）</summary>
      {#if draft.verificationReadiness}
        <p data-testid="overview-verification">
          {draft.verificationReadiness.ready
            ? `プロジェクトの検証コマンド（${draft.verificationReadiness.detail}）を自動で実行し、すべて成功することを完了条件にします。`
            : `検証コマンドが不足しています: ${draft.verificationReadiness.missingScripts.join(', ')}。このままでは開始できません。`}
        </p>
      {:else}
        <p class="muted">検証方法は未確定です。</p>
      {/if}
    </details>

    <details class="section" open={p.openItems.length > 0}>
      <summary>推奨事項・未確定の点<span class="count">{p.openItems.length === 0 && activeDecisions.length === 0 ? 'なし' : `${p.openItems.length} 件`}</span></summary>
      {#if p.openItems.length === 0 && activeDecisions.length === 0}
        <p class="muted">なし</p>
      {:else}
        <ul data-testid="overview-open-items">
          {#each p.openItems as item, i (i)}
            <li>未確定: {item}</li>
          {/each}
          {#if activeDecisions.length > 0}
            <li>あなたの判断 {activeDecisions.length} 件（質問への回答・矛盾の解消・修正）を前提にしています。内容は「AI の要件理解と判断の記録」で確認できます。</li>
          {/if}
        </ul>
      {/if}
    </details>
  </section>
{/if}

<style>
  .unit {
    font-size: 0.75rem;
    font-weight: 500;
    color: var(--muted);
  }
  .warn {
    color: var(--warning);
    font-weight: 600;
  }
  ol,
  ul {
    margin: 0.2rem 0 0.4rem;
  }
</style>
