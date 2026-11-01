import type { AskedQuestion, Contradiction, DecisionRecord, TaskProposal } from '@agent-orchestrator/contracts';

/**
 * 意思決定ログ（v2.2、D-32）。通常ヒアリングの回答・矛盾解消・承認前の要件修正を共通の DecisionRecord で記録する純粋関数群。
 * - 同じ topicKey の判断は 1 レコードに積み上げ、過去の値は history に残す（取り消し / 置き換えを区別）
 * - 「戻る」は削除ではなく status=retracted（履歴として残す）
 * - 同一事項について矛盾する判断は新しい方を優先し、古い方を superseded にする（古い判断が新しい明示的指示を上書きしない）
 */
export interface NewDecisionInput {
  topicKey: string;
  source: DecisionRecord['source'];
  kind: DecisionRecord['kind'];
  question: string;
  options: DecisionRecord['options'];
  chosen: string;
  chosenLabel: string;
  rationale: string;
  consequence: string;
  evidence: string[];
  relatedRequirements: string[];
  decidedAt: string;
}

export function makeDecision(input: NewDecisionInput, previous: DecisionRecord | null): DecisionRecord {
  const history = previous
    ? [
        ...previous.history,
        {
          chosen: previous.chosen,
          chosenLabel: previous.chosenLabel,
          decidedAt: previous.decidedAt,
          retracted: previous.status === 'retracted',
          note: previous.status === 'retracted' ? '「戻る」で取り消された判断' : previous.status === 'superseded' ? `後続の判断（${previous.supersededBy ?? '?'}）で置き換えられた判断` : '再回答で置き換えられた判断'
        }
      ]
    : [];
  return {
    topicKey: input.topicKey,
    contradictionId: input.topicKey,
    source: input.source,
    kind: input.kind,
    question: input.question,
    options: input.options.map((o) => ({ value: o.value, label: o.label })),
    chosen: input.chosen,
    chosenLabel: input.chosenLabel,
    rationale: input.rationale,
    consequence: input.consequence,
    evidence: [...input.evidence],
    relatedRequirements: [...new Set(input.relatedRequirements)],
    decidedAt: input.decidedAt,
    history,
    supersededBy: null,
    status: 'active'
  };
}

export function retractDecision(d: DecisionRecord): DecisionRecord {
  return { ...d, status: 'retracted' };
}

export const activeDecisions = (ds: readonly DecisionRecord[]): DecisionRecord[] => ds.filter((d) => d.status === 'active');

/** 通常質問への回答 → interview 判断 */
export function decisionFromInterviewAnswer(q: AskedQuestion, value: string, answeredAt: string): NewDecisionInput {
  const opt = q.options.find((o) => o.value === value);
  return {
    topicKey: q.id,
    source: 'interview',
    kind: 'other',
    question: q.question,
    options: q.options,
    chosen: value,
    chosenLabel: opt?.label ?? value,
    rationale: opt ? `ユーザーが選択肢を選択（推奨: ${q.recommendation || '（なし）'}）` : `ユーザーの自由入力（推奨: ${q.recommendation || '（なし）'}）`,
    consequence: opt ? `${opt.label} を前提に要件を確定する` : '自由入力の内容を前提に要件を確定する',
    evidence: [],
    relatedRequirements: []
  , decidedAt: answeredAt };
}

/** 矛盾質問への回答 → contradiction 判断。対象要件は保留中の素案から分かる範囲で紐付ける */
export function decisionFromContradiction(c: Contradiction, value: string, answeredAt: string, pendingProposal: TaskProposal | null): NewDecisionInput {
  const opt = c.options.find((o) => o.value === value);
  return {
    topicKey: c.id,
    source: 'contradiction',
    kind: c.kind,
    question: c.description,
    options: c.options.map((o) => ({ value: o.value, label: o.label })),
    chosen: value,
    chosenLabel: opt?.label ?? value,
    rationale: opt ? `ユーザーが選択（推奨: ${c.recommendation || '（なし）'}）` : `ユーザーの自由入力（推奨: ${c.recommendation || '（なし）'}）`,
    consequence: opt?.consequence ?? '（自由入力）',
    evidence: c.evidence,
    relatedRequirements: matchRequirements([c.description, ...c.evidence], pendingProposal),
    decidedAt: answeredAt
  };
}

const REVISION_FIELDS = ['title', 'requirements', 'outOfScope', 'acceptanceCriteria', 'approach'] as const;
type RevisionField = (typeof REVISION_FIELDS)[number];
const FIELD_LABEL: Record<RevisionField, string> = { title: 'タイトル', requirements: '要件', outOfScope: '対象外', acceptanceCriteria: '受入条件', approach: '実装方針' };
const FIELD_KIND: Record<RevisionField, DecisionRecord['kind']> = { title: 'other', requirements: 'scope', outOfScope: 'scope', acceptanceCriteria: 'acceptance', approach: 'design' };

function summarize(v: unknown): string {
  const s = typeof v === 'string' ? v : Array.isArray(v) ? v.map((x) => (typeof x === 'string' ? x : typeof x === 'object' && x && 'id' in x ? String((x as { id: unknown }).id) : JSON.stringify(x))).join(' / ') : JSON.stringify(v);
  return s.length > 160 ? `${s.slice(0, 157)}…` : s;
}

/** 承認前の要件修正 → revision 判断（フィールド単位。ユーザーの最新の明示的指示として記録） */
export function decisionsFromRevision(before: TaskProposal, after: TaskProposal, decidedAt: string): NewDecisionInput[] {
  const out: NewDecisionInput[] = [];
  for (const field of REVISION_FIELDS) {
    const b = JSON.stringify(before[field]);
    const a = JSON.stringify(after[field]);
    if (a === b) continue;
    let related: string[] = [];
    if (field === 'requirements' || field === 'outOfScope') related = (after[field] as string[]).filter((x) => !(before[field] as string[]).includes(x));
    if (field === 'acceptanceCriteria') related = after.acceptanceCriteria.filter((x) => !before.acceptanceCriteria.some((y) => JSON.stringify(y) === JSON.stringify(x))).map((x) => x.id);
    out.push({
      topicKey: `revision:${field}`,
      source: 'revision',
      kind: FIELD_KIND[field],
      question: `承認前の要件修正: ${FIELD_LABEL[field]}`,
      options: [],
      chosen: a,
      chosenLabel: summarize(after[field]),
      rationale: 'ユーザーが要件サマリーを手動で編集（最新の明示的指示として、過去の質問回答・矛盾解消の判断より優先する）',
      consequence: `旧値: ${summarize(before[field])}`,
      evidence: [],
      relatedRequirements: related,
      decidedAt
    });
  }
  return out;
}

const normalize = (s: string) => s.replace(/\s+/g, '').toLowerCase();

/** 根拠文に引用されている要件 / AC id を素案から拾う（分かる範囲で） */
export function matchRequirements(texts: string[], proposal: TaskProposal | null): string[] {
  if (!proposal) return [];
  const ns = texts.map(normalize);
  const out: string[] = [];
  for (const r of proposal.requirements) {
    const nr = normalize(r);
    if (nr.length === 0) continue;
    const head = nr.slice(0, Math.min(nr.length, 12));
    if (ns.some((t) => t.includes(nr) || (nr.length >= 8 && t.includes(head)) || (t.length >= 8 && nr.includes(t)))) out.push(r);
  }
  for (const ac of proposal.acceptanceCriteria) if (texts.some((t) => t.includes(ac.id))) out.push(ac.id);
  return [...new Set(out)];
}

export interface DecisionConflict {
  older: DecisionRecord;
  newer: DecisionRecord;
  reason: string;
}

/**
 * 同一事項に対して矛盾する active な判断の組。
 *   1. 同じ問い（正規化した質問文が一致）に異なる回答
 *   2. 同じ対象要件集合に異なる判断
 *   3. 矛盾解消（contradiction）の判断が、根拠や問いの中で既存の判断の topicKey（例: Q-003, revision:approach）を名指ししている
 *      → 矛盾検出モデルが「判断同士の矛盾」を報告し、ユーザーが解消した場合。解消した側が常に新しい
 * 1・2 は decidedAt の新しい方が勝つ。
 */
export function findConflicts(decisions: readonly DecisionRecord[]): DecisionConflict[] {
  const active = activeDecisions(decisions);
  const out: DecisionConflict[] = [];
  const mentions = (d: DecisionRecord, key: string) => {
    const re = new RegExp(`(^|[^A-Za-z0-9_:-])${escapeRe(key)}(?![A-Za-z0-9_-])`);
    return [d.question, ...d.evidence].some((t) => re.test(t));
  };
  for (let i = 0; i < active.length; i++) {
    for (let j = i + 1; j < active.length; j++) {
      const a = active[i]!;
      const b = active[j]!;
      if (a.topicKey === b.topicKey) continue;
      const resolver = a.source === 'contradiction' && mentions(a, b.topicKey) ? a : b.source === 'contradiction' && mentions(b, a.topicKey) ? b : null;
      if (resolver) {
        const older = resolver === a ? b : a;
        out.push({ older, newer: resolver, reason: `矛盾解消 ${resolver.topicKey} が ${older.topicKey} の判断を見直した` });
        continue;
      }
      if (normalize(a.chosen) === normalize(b.chosen)) continue;
      let reason: string | null = null;
      if (normalize(a.question) === normalize(b.question)) reason = '同じ問いに異なる回答';
      else if (a.relatedRequirements.length > 0 && b.relatedRequirements.length > 0 && sameSet(a.relatedRequirements, b.relatedRequirements)) reason = `同じ対象要件（${a.relatedRequirements.join(' / ')}）に異なる判断`;
      if (!reason) continue;
      const [older, newer] = a.decidedAt <= b.decidedAt ? [a, b] : [b, a];
      out.push({ older, newer, reason });
    }
  }
  return out;
}

const escapeRe = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

function sameSet(x: string[], y: string[]): boolean {
  const sx = [...new Set(x.map(normalize))].sort();
  const sy = [...new Set(y.map(normalize))].sort();
  return sx.length === sy.length && sx.every((v, i) => v === sy[i]);
}

/** 矛盾する判断は新しい方を優先。古い方を superseded にして返す（更新が必要なレコードだけ） */
export function resolveConflicts(decisions: readonly DecisionRecord[]): { updated: DecisionRecord[]; conflicts: DecisionConflict[] } {
  const conflicts = findConflicts(decisions);
  const updated = new Map<string, DecisionRecord>();
  for (const c of conflicts) {
    const cur = updated.get(c.older.topicKey) ?? c.older;
    updated.set(c.older.topicKey, { ...cur, status: 'superseded', supersededBy: c.newer.topicKey, history: [...cur.history, { chosen: cur.chosen, chosenLabel: cur.chosenLabel, decidedAt: cur.decidedAt, retracted: false, note: `${c.reason}。新しい判断 ${c.newer.topicKey}（${c.newer.chosenLabel}）を優先` }] });
  }
  return { updated: [...updated.values()], conflicts };
}

/** v2.1 形式（contradictionId/kind/question/chosen/...）の保存行を v2.2 モデルに持ち上げる */
export function upgradeDecision(raw: unknown): DecisionRecord {
  const r = (raw ?? {}) as Partial<DecisionRecord> & { contradictionId?: string };
  const topicKey = r.topicKey ?? r.contradictionId ?? 'unknown';
  return {
    topicKey,
    contradictionId: r.contradictionId ?? topicKey,
    source: r.source ?? 'contradiction',
    kind: r.kind ?? 'other',
    question: r.question ?? '',
    options: r.options ?? [],
    chosen: r.chosen ?? '',
    chosenLabel: r.chosenLabel ?? r.chosen ?? '',
    rationale: r.rationale ?? '（v2.1 形式の記録: 理由は未記録）',
    consequence: r.consequence ?? '',
    evidence: r.evidence ?? [],
    relatedRequirements: r.relatedRequirements ?? [],
    decidedAt: r.decidedAt ?? '',
    history: r.history ?? [],
    supersededBy: r.supersededBy ?? null,
    status: r.status ?? 'active'
  };
}

/** モデルへ渡す「拘束力のある判断」の文面（古い→新しい。後の判断が優先） */
export function renderBindingDecisions(decisions: readonly DecisionRecord[]): string[] {
  const active = [...activeDecisions(decisions)].sort((a, b) => a.decidedAt.localeCompare(b.decidedAt));
  if (active.length === 0) return [];
  const lines = ['## Binding decisions already made by the user (oldest → newest; a later decision overrides an earlier one on the same topic; "revision" entries are the user\'s latest explicit edits and take precedence). Honor them verbatim and do not reopen them.'];
  for (const d of active) {
    lines.push(`- [${d.source}:${d.topicKey}] ${d.question} → ${d.chosenLabel} (${d.chosen})${d.relatedRequirements.length > 0 ? ` / affects: ${d.relatedRequirements.join('; ')}` : ''}`);
  }
  return lines;
}
