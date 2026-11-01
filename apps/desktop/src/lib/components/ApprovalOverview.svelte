<script lang="ts">
  import type { DraftView } from '@agent-orchestrator/contracts';

  interface Props {
    draft: DraftView;
  }

  let { draft }: Props = $props();
  const p = $derived(draft.proposal);
  const activeDecisions = $derived(draft.decisions.filter((d) => d.status === 'active'));
</script>

{#if p}
  <section class="card" aria-labelledby="overview-heading" data-testid="approval-overview">
    <h2 id="overview-heading">要件サマリー（リビジョン {draft.revision}）</h2>
    <p class="small muted">AI が依頼と回答から整理した内容です。この内容で開発を始めてよいか確認してください。技術的な詳細や修正は下の「要件を修正する」から行えます。</p>

    <h3>何を作るか</h3>
    <p><strong data-testid="overview-title">{p.title}</strong></p>
    <p data-testid="overview-objective">{p.objective}</p>

    <h3>機能要件（{p.requirements.length} 件）</h3>
    <ol data-testid="overview-requirements">
      {#each p.requirements as r, i (i)}
        <li>{r}</li>
      {/each}
    </ol>

    <h3>受入条件（{p.acceptanceCriteria.length} 件）— こうなっていれば完了</h3>
    <ol data-testid="overview-criteria">
      {#each p.acceptanceCriteria as c (c.id)}
        <li><span class="muted small">{c.id}</span> {c.given}とき、{c.when}と、{c.then}。</li>
      {/each}
    </ol>

    <h3>制約・やらないこと</h3>
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

    <h3>進め方（実装方針）</h3>
    <p data-testid="overview-approach">{p.approach}</p>

    <h3>変更が予想されるファイル・領域</h3>
    {#if p.expectedChanges.length === 0}
      <p class="muted" data-testid="overview-expected-changes">指定なし（AI の変更範囲は判定されません）</p>
    {:else}
      <ul data-testid="overview-expected-changes">
        {#each p.expectedChanges as e, i (i)}
          <li><code>{e}</code></li>
        {/each}
      </ul>
      <p class="small muted">この範囲の外に大きな変更があった場合、AI は検証・レビューの前に止まり、人の判断を求めます。</p>
    {/if}

    <h3>既存機能との衝突の可能性</h3>
    {#if p.conflictRisks.length === 0}
      <p class="muted" data-testid="overview-conflict-risks">特定されていません</p>
    {:else}
      <ul data-testid="overview-conflict-risks">
        {#each p.conflictRisks as r, i (i)}
          <li>{r}</li>
        {/each}
      </ul>
    {/if}

    <h3>確認方法（テスト）</h3>
    {#if draft.verificationReadiness}
      <p data-testid="overview-verification">
        {draft.verificationReadiness.ready
          ? `プロジェクトの検証コマンド（${draft.verificationReadiness.detail}）を自動で実行し、すべて成功することを完了条件にします。`
          : `検証コマンドが不足しています: ${draft.verificationReadiness.missingScripts.join(', ')}。このままでは開始できません。`}
      </p>
    {:else}
      <p class="muted">検証方法は未確定です。</p>
    {/if}

    <h3>推奨事項・未確定の点</h3>
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
  </section>
{/if}

<style>
  h3 {
    margin: 0.9rem 0 0.3rem;
  }
  ol,
  ul {
    margin: 0;
  }
</style>
