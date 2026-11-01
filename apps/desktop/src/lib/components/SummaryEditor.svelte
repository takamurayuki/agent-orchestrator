<script lang="ts">
  import type { AcceptanceCriterion, DraftView } from '@agent-orchestrator/contracts';
  import Alert from './Alert.svelte';

  interface Props {
    draft: DraftView;
    disabled?: boolean;
    onRevise: (edits: { requirements?: string[]; outOfScope?: string[]; acceptanceCriteria?: AcceptanceCriterion[]; approach?: string }) => Promise<boolean>;
    onDirtyChange?: (dirty: boolean) => void;
  }

  let { draft, disabled = false, onRevise, onDirtyChange }: Props = $props();

  let requirements = $state<string[]>([]);
  let outOfScope = $state<string[]>([]);
  let approach = $state('');
  let criteria = $state<AcceptanceCriterion[]>([]);
  let loadedKey = '';
  let saving = $state(false);
  let validation = $state<string | null>(null);

  // Reload the editable copies whenever a new revision / proposal arrives.
  $effect(() => {
    const key = `${draft.id}:${draft.revision}:${draft.state}`;
    if (key === loadedKey) return;
    loadedKey = key;
    reset();
  });

  function reset() {
    const p = draft.proposal;
    requirements = p ? [...p.requirements] : [];
    outOfScope = p ? [...p.outOfScope] : [];
    approach = p ? p.approach : '';
    criteria = p ? p.acceptanceCriteria.map((c) => ({ ...c })) : [];
    validation = null;
  }

  const dirty = $derived.by(() => {
    const p = draft.proposal;
    if (!p) return false;
    return (
      JSON.stringify(requirements) !== JSON.stringify(p.requirements) ||
      JSON.stringify(outOfScope) !== JSON.stringify(p.outOfScope) ||
      approach !== p.approach ||
      JSON.stringify(criteria) !== JSON.stringify(p.acceptanceCriteria)
    );
  });

  $effect(() => {
    onDirtyChange?.(dirty);
  });

  async function save() {
    const p = draft.proposal;
    if (!p) return;
    const cleanedReq = requirements.map((r) => r.trim()).filter(Boolean);
    const cleanedOut = outOfScope.map((r) => r.trim()).filter(Boolean);
    const cleanedCriteria = criteria.map((c) => ({ id: c.id.trim(), given: c.given.trim(), when: c.when.trim(), then: c.then.trim() }));
    if (cleanedReq.length === 0) {
      validation = '要件（スコープ）は 1 件以上必要です。';
      return;
    }
    if (cleanedCriteria.length === 0 || cleanedCriteria.some((c) => !c.id || !c.given || !c.when || !c.then)) {
      validation = '受入条件は 1 件以上必要で、ID・Given・When・Then をすべて入力してください。';
      return;
    }
    validation = null;
    const edits: Parameters<typeof onRevise>[0] = {};
    if (JSON.stringify(cleanedReq) !== JSON.stringify(p.requirements)) edits.requirements = cleanedReq;
    if (JSON.stringify(cleanedOut) !== JSON.stringify(p.outOfScope)) edits.outOfScope = cleanedOut;
    if (approach.trim() !== p.approach) edits.approach = approach.trim();
    if (JSON.stringify(cleanedCriteria) !== JSON.stringify(p.acceptanceCriteria)) edits.acceptanceCriteria = cleanedCriteria;
    if (Object.keys(edits).length === 0) return;
    saving = true;
    try {
      await onRevise(edits);
    } finally {
      saving = false;
    }
  }

  function updateList(list: string[], index: number, value: string): string[] {
    return list.map((item, i) => (i === index ? value : item));
  }
</script>

{#if draft.proposal}
  {@const p = draft.proposal}
  <section class="card" aria-labelledby="summary-heading" data-testid="summary-editor">
    <div class="row" style="justify-content: space-between">
      <h2 id="summary-heading">要件サマリー（リビジョン {draft.revision}）</h2>
      {#if dirty}
        <span class="badge warning" data-testid="summary-dirty">未保存の修正あり</span>
      {/if}
    </div>
    <p class="small muted">内容を修正して保存すると新しいリビジョンになり、承認はリセットされます。YAML の直接編集は不要です。</p>

    <h3>タイトル</h3>
    <p data-testid="summary-title">{p.title}</p>

    <h3>目的</h3>
    <p data-testid="summary-objective">{p.objective}</p>

    <h3>スコープ（要件）</h3>
    <ol class="editable" aria-label="要件一覧（編集可）">
      {#each requirements as item, i (i)}
        <li>
          <label class="sr-only" for="req-{i}">要件 {i + 1}</label>
          <input type="text" id="req-{i}" value={item} {disabled} oninput={(e) => (requirements = updateList(requirements, i, (e.currentTarget as HTMLInputElement).value))} data-testid="requirement-input" />
          <button type="button" class="link" {disabled} onclick={() => (requirements = requirements.filter((_, j) => j !== i))} aria-label="要件 {i + 1} を削除">削除</button>
        </li>
      {/each}
    </ol>
    <button type="button" {disabled} onclick={() => (requirements = [...requirements, ''])} data-testid="add-requirement">要件を追加</button>

    <h3>対象外</h3>
    <ul class="editable" aria-label="対象外一覧（編集可）">
      {#each outOfScope as item, i (i)}
        <li>
          <label class="sr-only" for="oos-{i}">対象外 {i + 1}</label>
          <input type="text" id="oos-{i}" value={item} {disabled} oninput={(e) => (outOfScope = updateList(outOfScope, i, (e.currentTarget as HTMLInputElement).value))} />
          <button type="button" class="link" {disabled} onclick={() => (outOfScope = outOfScope.filter((_, j) => j !== i))} aria-label="対象外 {i + 1} を削除">削除</button>
        </li>
      {/each}
    </ul>
    <button type="button" {disabled} onclick={() => (outOfScope = [...outOfScope, ''])}>対象外を追加</button>

    <h3><label for="approach">実装方針</label></h3>
    <textarea id="approach" bind:value={approach} {disabled} rows="4"></textarea>

    <h3>受入条件（Given / When / Then）</h3>
    <ol class="criteria" aria-label="受入条件一覧（編集可）">
      {#each criteria as c, i (i)}
        <li class="criterion" data-testid="criterion">
          <div class="row">
            <label for="ac-id-{i}">ID</label>
            <input type="text" id="ac-id-{i}" class="id" value={c.id} {disabled} oninput={(e) => (criteria = criteria.map((x, j) => (j === i ? { ...x, id: (e.currentTarget as HTMLInputElement).value } : x)))} />
            <button type="button" class="link" {disabled} onclick={() => (criteria = criteria.filter((_, j) => j !== i))} aria-label="受入条件 {c.id} を削除">削除</button>
          </div>
          <label for="ac-given-{i}">Given（前提）</label>
          <input type="text" id="ac-given-{i}" value={c.given} {disabled} oninput={(e) => (criteria = criteria.map((x, j) => (j === i ? { ...x, given: (e.currentTarget as HTMLInputElement).value } : x)))} />
          <label for="ac-when-{i}">When（操作）</label>
          <input type="text" id="ac-when-{i}" value={c.when} {disabled} oninput={(e) => (criteria = criteria.map((x, j) => (j === i ? { ...x, when: (e.currentTarget as HTMLInputElement).value } : x)))} />
          <label for="ac-then-{i}">Then（期待結果）</label>
          <input type="text" id="ac-then-{i}" value={c.then} {disabled} oninput={(e) => (criteria = criteria.map((x, j) => (j === i ? { ...x, then: (e.currentTarget as HTMLInputElement).value } : x)))} />
        </li>
      {/each}
    </ol>
    <button type="button" {disabled} onclick={() => (criteria = [...criteria, { id: `AC-${String(criteria.length + 1).padStart(3, '0')}`, given: '', when: '', then: '' }])}>受入条件を追加</button>

    <h3>テスト（検証方法）</h3>
    {#if draft.verificationReadiness}
      <p data-testid="summary-verification">
        検証プロファイル <code>{draft.verificationReadiness.profile}</code>:
        {draft.verificationReadiness.ready ? '準備完了' : `不足スクリプト: ${draft.verificationReadiness.missingScripts.join(', ')}`}
        <span class="small muted">（{draft.verificationReadiness.detail}）</span>
      </p>
    {:else}
      <p class="muted">検証プロファイル未確定</p>
    {/if}

    <h3>不明事項</h3>
    {#if p.openItems.length === 0}
      <p class="muted">なし</p>
    {:else}
      <ul data-testid="summary-open-items">
        {#each p.openItems as item, i (i)}
          <li>{item}</li>
        {/each}
      </ul>
    {/if}

    {#if validation}
      <Alert tone="danger" role="alert" message={validation} />
    {/if}

    <div class="row" style="margin-top: 0.75rem">
      <button type="button" class="primary" onclick={save} disabled={disabled || !dirty || saving} data-testid="save-revision">修正を保存して再評価</button>
      <button type="button" onclick={reset} disabled={disabled || !dirty || saving}>修正を破棄</button>
    </div>
  </section>
{/if}

<style>
  .editable {
    padding-left: 1.3rem;
  }
  .editable li {
    display: flex;
    gap: 0.5rem;
    align-items: center;
    margin-bottom: 0.35rem;
  }
  .criteria {
    padding-left: 1.3rem;
  }
  .criterion {
    border: 1px solid var(--border);
    border-radius: var(--radius);
    padding: 0.5rem 0.75rem;
    margin-bottom: 0.5rem;
  }
  .criterion label {
    font-weight: 500;
    font-size: 0.85rem;
    margin-top: 0.3rem;
  }
  .criterion .id {
    width: 8rem;
  }
  h3 {
    margin-top: 0.9rem;
  }
</style>
