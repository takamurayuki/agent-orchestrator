import { describe, expect, it } from 'vitest';
import type { DecisionRecord } from '@agent-orchestrator/contracts';
import { decisionFromContradiction, decisionFromInterviewAnswer, decisionsFromRevision, findConflicts, makeDecision, matchRequirements, renderBindingDecisions, resolveConflicts, retractDecision, upgradeDecision } from '../../src/requirements/decisions.js';

const proposal = { title: 't', objective: 'o', requirements: ['メールアドレスとパスワードで認証する', 'ログアウトでセッションを無効化する'], outOfScope: [], approach: 'a', acceptanceCriteria: [{ id: 'AC-001', given: 'g', when: 'w', then: 't' }], openItems: [], expectedChanges: [], conflictRisks: [], generatedArtifacts: [] };
const mk = (topicKey: string, chosen: string, decidedAt: string, extra: Partial<DecisionRecord> = {}): DecisionRecord =>
  makeDecision({ topicKey, source: 'interview', kind: 'other', question: `q ${topicKey}`, options: [], chosen, chosenLabel: chosen, rationale: 'r', consequence: 'c', evidence: [], relatedRequirements: [], decidedAt, ...extra }, null);

describe('decision log model (v2.2, D-32)', () => {
  it('interview answers record options, rationale (recommendation) and free text', () => {
    const q = { id: 'Q-001', round: 1, question: 'セッション方式は？', decisionImpact: 'blocking' as const, options: [{ value: 'jwt', label: 'JWT' }, { value: 'cookie', label: 'Cookie' }], recommendation: 'Cookie を推奨' };
    const d = makeDecision(decisionFromInterviewAnswer(q, 'cookie', 't1'), null);
    expect(d).toMatchObject({ topicKey: 'Q-001', contradictionId: 'Q-001', source: 'interview', chosen: 'cookie', chosenLabel: 'Cookie', status: 'active', history: [], supersededBy: null });
    expect(d.rationale).toContain('Cookie を推奨');
    const free = makeDecision(decisionFromInterviewAnswer(q, 'セッションは不要', 't1'), null);
    expect(free.chosenLabel).toBe('セッションは不要');
    expect(free.rationale).toContain('自由入力');
  });

  it('contradiction answers link related requirements found in the evidence', () => {
    const c = { id: 'CONTRA-001', kind: 'requirement_vs_project' as const, severity: 'blocking' as const, description: '「ログアウトでセッションを無効化する」は既存のステートレス JWT と矛盾', evidence: ['要件: ログアウトでセッションを無効化する', 'src/auth.ts: JWT'], options: [{ value: 'a', label: 'A', consequence: 'ca' }, { value: 'b', label: 'B', consequence: 'cb' }], recommendation: 'a' };
    const d = makeDecision(decisionFromContradiction(c, 'b', 't1', proposal), null);
    expect(d).toMatchObject({ source: 'contradiction', kind: 'requirement_vs_project', chosen: 'b', chosenLabel: 'B', consequence: 'cb', relatedRequirements: ['ログアウトでセッションを無効化する'] });
    expect(matchRequirements(['AC-001 が成立しない'], proposal)).toEqual(['AC-001']);
    expect(matchRequirements(['無関係'], proposal)).toEqual([]);
    expect(matchRequirements(['x'], null)).toEqual([]);
  });

  it('revision edits become one decision per changed field with old value and added requirements', () => {
    const after = { ...proposal, requirements: [...proposal.requirements, '5 回失敗でロック'], approach: 'b' };
    const ds = decisionsFromRevision(proposal, after, 't2');
    expect(ds.map((d) => d.topicKey).sort()).toEqual(['revision:approach', 'revision:requirements']);
    expect(ds.find((d) => d.topicKey === 'revision:requirements')).toMatchObject({ source: 'revision', kind: 'scope', relatedRequirements: ['5 回失敗でロック'] });
    expect(ds.find((d) => d.topicKey === 'revision:approach')?.consequence).toBe('旧値: a');
    expect(decisionsFromRevision(proposal, proposal, 't')).toEqual([]);
  });

  it('re-deciding the same topic keeps history; retraction is recorded as such', () => {
    const first = mk('Q-001', 'a', 't1');
    const retracted = retractDecision(first);
    expect(retracted.status).toBe('retracted');
    const second = makeDecision({ ...first, chosen: 'b', chosenLabel: 'b', decidedAt: 't2' }, retracted);
    expect(second.history).toEqual([{ chosen: 'a', chosenLabel: 'a', decidedAt: 't1', retracted: true, note: '「戻る」で取り消された判断' }]);
    const third = makeDecision({ ...second, chosen: 'c', chosenLabel: 'c', decidedAt: 't3' }, second);
    expect(third.history.map((h) => h.chosen)).toEqual(['a', 'b']);
    expect(third.history[1]?.retracted).toBe(false);
  });

  it('conflicts: same question → newer wins; same related requirements → newer wins; a contradiction resolution naming a decision supersedes it; never the reverse', () => {
    const a = mk('Q-001', 'jwt', '2026-01-01T00:00:00Z', { question: 'セッション方式は？' });
    const b = mk('Q-007', 'cookie', '2026-01-02T00:00:00Z', { question: 'セッション方式は？' });
    const same = mk('Q-008', 'cookie', '2026-01-03T00:00:00Z', { question: 'セッション方式は？' }); // 同じ選択は矛盾ではない
    const c1 = findConflicts([a, b, same]);
    expect(c1.map((c) => [c.older.topicKey, c.newer.topicKey])).toEqual([['Q-001', 'Q-007'], ['Q-001', 'Q-008']]);
    const r = resolveConflicts([a, b, same]);
    expect(r.updated.map((d) => [d.topicKey, d.status, d.supersededBy])).toEqual([['Q-001', 'superseded', 'Q-008']]);
    expect(r.updated[0]?.history.at(-1)?.note).toContain('同じ問いに異なる回答');

    const x = mk('CONTRA-001', 'a', '2026-01-01T00:00:00Z', { relatedRequirements: ['R1', 'R2'] });
    const y = mk('revision:requirements', 'b', '2026-01-05T00:00:00Z', { relatedRequirements: ['R2', 'R1'] });
    expect(findConflicts([y, x]).map((c) => [c.older.topicKey, c.newer.topicKey])).toEqual([['CONTRA-001', 'revision:requirements']]);

    const resolver = makeDecision({ topicKey: 'CONTRA-010', source: 'contradiction', kind: 'requirement_vs_requirement', question: '判断 Q-001 と revision:approach が矛盾', options: [], chosen: 'keep_rev', chosenLabel: 'k', rationale: 'r', consequence: 'c', evidence: ['Q-001: jwt'], relatedRequirements: [], decidedAt: '2025-12-31T00:00:00Z' }, null);
    // 解消した側は decidedAt が古くても常に新しい判断として扱う（Q-0010 のような部分一致は対象外）
    const other = mk('Q-0010', 'z', '2026-01-01T00:00:00Z');
    const cs = findConflicts([a, resolver, other]);
    expect(cs.map((c) => [c.older.topicKey, c.newer.topicKey])).toEqual([['Q-001', 'CONTRA-010']]);
    expect(findConflicts([retractDecision(a), b])).toEqual([]); // retracted は対象外
  });

  it('upgrades v2.1 rows and renders binding decisions oldest → newest, active only', () => {
    const old = upgradeDecision({ contradictionId: 'CONTRA-001', kind: 'requirement_vs_project', question: 'q', chosen: 'a', chosenLabel: 'A', consequence: 'ca', evidence: [], decidedAt: 't' });
    expect(old).toMatchObject({ topicKey: 'CONTRA-001', source: 'contradiction', status: 'active', options: [], history: [], supersededBy: null });
    const lines = renderBindingDecisions([mk('Q-002', 'b', '2026-01-02T00:00:00Z'), mk('Q-001', 'a', '2026-01-01T00:00:00Z'), retractDecision(mk('Q-003', 'c', '2026-01-03T00:00:00Z'))]);
    expect(lines[0]).toContain('Binding decisions');
    expect(lines.slice(1)).toEqual(['- [interview:Q-001] q Q-001 → a (a)', '- [interview:Q-002] q Q-002 → b (b)']);
    expect(renderBindingDecisions([])).toEqual([]);
  });
});
