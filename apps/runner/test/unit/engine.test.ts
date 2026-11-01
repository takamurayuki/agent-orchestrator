import { describe, expect, it } from 'vitest';
import { RunEngine } from '../../src/engine.js';
import { evaluateCompletionGate } from '../../src/gate.js';
import {
  approvedReview,
  createMockDeps,
  diffCapture,
  failVerification,
  highReview,
  okBuilder,
  okVerification,
  reviewOutcome,
  snapshot,
  timeoutVerification
} from '../helpers/mock-deps.js';

const runWith = async (mock: ReturnType<typeof createMockDeps>, snap = snapshot(), controller = new AbortController()) => {
  const engine = new RunEngine(mock.deps);
  return engine.run({ runId: 'RUN-1', snapshot: snap, runDir: '/runs/RUN-1', signal: controller.signal });
};

describe('RunEngine state machine (SPEC §6)', () => {
  it('EX-01: implement + verify + review success → COMPLETED', async () => {
    const mock = createMockDeps();
    const status = await runWith(mock);
    expect(status.state).toBe('COMPLETED');
    expect(status.reasonCode).toBe('COMPLETED');
    expect(mock.calls).toMatchObject({ builder: 1, verifier: 1, reviewer: 1 });
    const types = mock.recorder.types();
    expect(types).toEqual(expect.arrayContaining(['run.created', 'preflight.completed', 'workspace.created', 'builder.finished', 'verify.finished', 'review.finished', 'gate.evaluated', 'run.finished']));
    // 状態遷移の順序
    const transitions = mock.recorder.events.filter((e) => e.type === 'run.state_changed').map((e) => e.payload.to);
    expect(transitions).toEqual(['PREFLIGHT', 'IMPLEMENTING', 'VERIFYING', 'REVIEWING', 'COMPLETED']);
    expect(mock.calls.baseline).toBe(1);
    expect(types).toContain('verify.baseline.finished');
    // D-27: push 1 回、pull は Builder 後 / 検証後 / レビュー後の 3 回（レビュー前ハッシュは検証後の状態から取る）
    expect(mock.calls.push).toBe(1);
    expect(mock.calls.pull).toBe(3);
    const synced = mock.recorder.events.filter((e) => e.type === 'workspace.synced').map((e) => `${e.payload.direction}:${e.payload.after ?? ''}`);
    expect(synced).toEqual(['push:', 'pull:builder', 'pull:verification', 'pull:review'].slice(0, synced.length));
  });

  it('D-23: baseline verification failure (repo broken before any change) → PRECHECK_FAILED without calling the Builder', async () => {
    const mock = createMockDeps({ baseline: failVerification() });
    const status = await runWith(mock);
    expect(status.state).toBe('PRECHECK_FAILED');
    expect(status.reasonDetail).toContain('ベースライン検証');
    expect(status.reasonDetail).toContain('test:run');
    expect(mock.calls.builder).toBe(0);
    expect(mock.calls.reviewer).toBe(0);
    expect(mock.recorder.artifacts.has('0/verify.baseline.json')).toBe(true);
  });

  it('EX-02: verification fails then fix succeeds → Builder 2, Reviewer 1', async () => {
    const mock = createMockDeps({ verifications: [failVerification(), { ...failVerification(), passed: true, commands: failVerification().commands.map((c) => ({ ...c, exitCode: 0 })) }] });
    const status = await runWith(mock);
    expect(status.state).toBe('COMPLETED');
    expect(mock.calls).toMatchObject({ builder: 2, verifier: 2, reviewer: 1 });
    // 2 回目の Builder には検証失敗のフィードバックが渡る
    expect(mock.builderInputs[1]?.feedback?.verificationFailures.join('')).toContain('test:run');
  });

  it('EX-03: high finding → fix → approved → Builder 2, Reviewer 2', async () => {
    const mock = createMockDeps({ reviews: [reviewOutcome(highReview()), reviewOutcome(approvedReview())] });
    const status = await runWith(mock);
    expect(status.state).toBe('COMPLETED');
    expect(mock.calls).toMatchObject({ builder: 2, verifier: 2, reviewer: 2 });
    expect(mock.builderInputs[1]?.feedback?.reviewFindings[0]?.id).toBe('REV-001');
  });

  it('EX-04: three failures → NEEDS_HUMAN / MAX_ROUNDS', async () => {
    const mock = createMockDeps({ verifications: [failVerification()] });
    const status = await runWith(mock);
    expect(status.state).toBe('NEEDS_HUMAN');
    expect(status.reasonCode).toBe('MAX_ROUNDS');
    expect(mock.calls).toMatchObject({ builder: 3, verifier: 3, reviewer: 0 });
  });

  it('EX-04b: three changes_requested reviews → NEEDS_HUMAN / MAX_ROUNDS with 3 builders', async () => {
    const mock = createMockDeps({ reviews: [reviewOutcome(highReview())] });
    const status = await runWith(mock);
    expect(status.state).toBe('NEEDS_HUMAN');
    expect(status.reasonCode).toBe('MAX_ROUNDS');
    expect(mock.calls).toMatchObject({ builder: 3, reviewer: 3 });
  });

  it('EX-05: reviewer unknown → NEEDS_HUMAN', async () => {
    const mock = createMockDeps({ reviews: [reviewOutcome({ ...approvedReview(), verdict: 'unknown' })] });
    const status = await runWith(mock);
    expect(status.state).toBe('NEEDS_HUMAN');
    expect(status.reasonCode).toBe('REVIEW_UNKNOWN');
    expect(mock.calls.builder).toBe(1);
  });

  it('EX-06: invalid review JSON → NEEDS_HUMAN (no auto-repair)', async () => {
    const mock = createMockDeps({ reviews: [reviewOutcome(null)] });
    const status = await runWith(mock);
    expect(status.state).toBe('NEEDS_HUMAN');
    expect(status.reasonCode).toBe('REVIEW_INVALID_JSON');
  });

  it('EX-07: approved with high finding → not COMPLETED', async () => {
    const mock = createMockDeps({ reviews: [reviewOutcome({ ...highReview(), verdict: 'approved' })] });
    const status = await runWith(mock);
    expect(status.state).not.toBe('COMPLETED');
    expect(status.state).toBe('NEEDS_HUMAN');
    expect(status.reasonCode).toBe('REVIEW_INCONSISTENT');
  });

  it('EX-08: verification timeout → not COMPLETED, reviewer not called that round', async () => {
    const mock = createMockDeps({ verifications: [timeoutVerification()] });
    const status = await runWith(mock);
    expect(status.state).not.toBe('COMPLETED');
    expect(mock.calls.reviewer).toBe(0);
  });

  it('EX-09: builder non-zero exit → NEEDS_HUMAN / BUILDER_FAILED', async () => {
    const mock = createMockDeps({ builders: [{ ...okBuilder(), exitCode: 2 }] });
    const status = await runWith(mock);
    expect(status.state).toBe('NEEDS_HUMAN');
    expect(status.reasonCode).toBe('BUILDER_FAILED');
    expect(mock.calls.verifier).toBe(0);
  });

  it('EX-09b: builder timeout → NEEDS_HUMAN / BUILDER_TIMEOUT', async () => {
    const mock = createMockDeps({ builders: [{ ...okBuilder(), exitCode: null, timedOut: true }] });
    const status = await runWith(mock);
    expect(status.reasonCode).toBe('BUILDER_TIMEOUT');
  });

  it('EX-10: no diff → NEEDS_HUMAN / NO_CHANGES', async () => {
    const mock = createMockDeps({ diffs: [diffCapture([])] });
    const status = await runWith(mock);
    expect(status.state).toBe('NEEDS_HUMAN');
    expect(status.reasonCode).toBe('NO_CHANGES');
  });

  it('EX-11: untracked files are part of the diff passed to the reviewer', async () => {
    const mock = createMockDeps({ diffs: [diffCapture([{ path: 'src/new-file.ts', status: 'untracked', additions: 10, deletions: 0 }])] });
    await runWith(mock);
    expect(mock.reviewerInputs[0]?.diff.summary.files[0]?.status).toBe('untracked');
  });

  it('EX-12: cancellation during builder → INTERRUPTED', async () => {
    const controller = new AbortController();
    const mock = createMockDeps({
      builders: [
        async (input) => {
          controller.abort();
          expect(input.signal.aborted).toBe(true);
          return okBuilder();
        }
      ]
    });
    const status = await runWith(mock, snapshot(), controller);
    expect(status.state).toBe('INTERRUPTED');
    expect(status.reasonCode).toBe('CANCELLED');
    expect(mock.calls.verifier).toBe(0);
  });

  it('EX-13: another active run → refused', async () => {
    const mock = createMockDeps({ hasActiveRun: true });
    const status = await runWith(mock);
    expect(status.state).toBe('NEEDS_HUMAN');
    expect(mock.calls.builder).toBe(0);
  });

  it('RA-12 / UI-07: unapproved snapshot never invokes the Builder', async () => {
    const mock = createMockDeps();
    const status = await runWith(mock, snapshot({ approved: false, approvedAt: null }));
    expect(status.state).toBe('NEEDS_HUMAN');
    expect(status.reasonCode).toBe('TASK_NOT_APPROVED');
    expect(mock.calls.builder).toBe(0);
  });

  it('SEC-01/SEC-02: preflight failure → PRECHECK_FAILED, no builder', async () => {
    const mock = createMockDeps({ preflight: { ok: false, checks: [{ id: 'docker.egress', label: 'egress', status: 'fail', detail: 'cannot restrict', fix: 'build proxy image' }] } });
    const status = await runWith(mock);
    expect(status.state).toBe('PRECHECK_FAILED');
    expect(status.reasonDetail).toContain('docker.egress');
    expect(mock.calls.builder).toBe(0);
  });

  it('SEC-03: workspace hash mismatch across review → NEEDS_HUMAN', async () => {
    const mock = createMockDeps({ hashes: ['h-before', 'h-after'] });
    const status = await runWith(mock);
    expect(status.state).toBe('NEEDS_HUMAN');
    expect(status.reasonCode).toBe('WORKSPACE_MODIFIED_DURING_REVIEW');
  });

  it('security violation (path escape) → immediate NEEDS_HUMAN / POLICY_VIOLATION', async () => {
    const mock = createMockDeps({ diffs: [diffCapture([{ path: '../outside.txt', status: 'added', additions: 1, deletions: 0 }])] });
    const status = await runWith(mock);
    expect(status.reasonCode).toBe('POLICY_VIOLATION');
    expect(mock.calls.verifier).toBe(0);
    expect(mock.calls.builder).toBe(1);
  });

  it('v2.1 case 7: an unapproved Policy Gate violation is fed back to the Builder and never reaches COMPLETED while it persists', async () => {
    const withDisable = "export function f(x: any) {\n  // eslint-disable-next-line @typescript-eslint/no-explicit-any\n  return x;\n}\n";
    const mock = createMockDeps({
      diffs: [diffCapture([{ path: 'src/f.ts', status: 'added', additions: 4, deletions: 0 }])],
      currentContents: { 'src/f.ts': withDisable }
    });
    const status = await runWith(mock);
    expect(status.state).toBe('NEEDS_HUMAN');
    expect(status.reasonCode).toBe('POLICY_VIOLATION');
    expect(status.reasonDetail).toContain('PG-ESLINT-DISABLE');
    // 3 ラウンドとも Builder に差し戻され、検証・レビューは一度も実行されない
    expect(mock.calls.builder).toBe(3);
    expect(mock.calls.verifier).toBe(0);
    expect(mock.calls.reviewer).toBe(0);
    expect(mock.builderInputs[1]?.feedback?.policyFindings.join(' ')).toContain('PG-ESLINT-DISABLE');
    expect(mock.recorder.artifacts.has('1/policy.json')).toBe(true);
    // v2.2: POLICY_BLOCKED を経由し、差し戻し内容が feedback.json に残る
    const transitions = mock.recorder.events.filter((e) => e.type === 'run.state_changed').map((e) => e.payload.to);
    expect(transitions.slice(0, 5)).toEqual(['PREFLIGHT', 'IMPLEMENTING', 'POLICY_BLOCKED', 'IMPLEMENTING', 'POLICY_BLOCKED']);
    expect(mock.recorder.artifacts.get('2/feedback.json')).toContain('PG-ESLINT-DISABLE');
    expect(mock.recorder.events.some((e) => e.type === 'policy.gate' && e.payload.blocking === 1)).toBe(true);
  });

  it('v2.1 case 8: once the Builder removes the violation, verification and review run and the run can complete', async () => {
    const withDisable = "export function f(x: any) {\n  // eslint-disable-next-line @typescript-eslint/no-explicit-any\n  return x;\n}\n";
    const fixed = 'export function f(x: unknown) {\n  return x;\n}\n';
    const mock = createMockDeps({
      diffs: [diffCapture([{ path: 'src/f.ts', status: 'added', additions: 4, deletions: 0 }])],
      currentContents: [{ 'src/f.ts': withDisable }, { 'src/f.ts': fixed }]
    });
    const status = await runWith(mock);
    expect(status.state).toBe('COMPLETED');
    expect(mock.calls.builder).toBe(2);
    expect(mock.calls.verifier).toBe(1);
    expect(mock.calls.reviewer).toBe(1);
    expect(mock.recorder.rounds.get(2)?.policyFindings).toEqual([]);
    const transitions = mock.recorder.events.filter((e) => e.type === 'run.state_changed').map((e) => e.payload.to);
    expect(transitions).toEqual(['PREFLIGHT', 'IMPLEMENTING', 'POLICY_BLOCKED', 'IMPLEMENTING', 'VERIFYING', 'REVIEWING', 'COMPLETED']);
  });

  it('v2.1: a human-approved exception in the BASE commit lets the violation pass; the AI cannot add one in the working tree', async () => {
    const withDisable = "// eslint-disable-next-line no-console\nconsole.log('x');\n";
    const approvedRun = createMockDeps({
      diffs: [diffCapture([{ path: 'src/log.ts', status: 'added', additions: 2, deletions: 0 }])],
      currentContents: { 'src/log.ts': withDisable, '.agent-orchestrator/policy.json': '{"allow":[{"ruleId":"PG-ESLINT-DISABLE","reason":"ai-added"}]}' },
      policyExceptionsJson: JSON.stringify({ allow: [{ ruleId: 'PG-ESLINT-DISABLE', file: 'src/**', reason: 'ログ出力は console を許容（人間が承認）' }] })
    });
    const approved = await runWith(approvedRun);
    expect(approved.state).toBe('COMPLETED');
    expect(approvedRun.recorder.rounds.get(1)?.policyFindings[0]?.approved).toBe(true);
    // 作業ツリー側にだけ例外ファイルを置いても（AI が追加しても）効かない
    const aiOnly = createMockDeps({
      diffs: [diffCapture([{ path: 'src/log.ts', status: 'added', additions: 2, deletions: 0 }, { path: '.agent-orchestrator/policy.json', status: 'added', additions: 1, deletions: 0 }])],
      currentContents: { 'src/log.ts': withDisable, '.agent-orchestrator/policy.json': '{"allow":[{"ruleId":"PG-ESLINT-DISABLE","reason":"ai-added"}]}' }
    });
    const rejected = await runWith(aiOnly);
    expect(rejected.state).toBe('NEEDS_HUMAN');
    expect(rejected.reasonCode).toBe('POLICY_VIOLATION');
  });

  it('v2.1: an approved review verdict cannot override an unapproved Policy Gate finding (gate 7)', () => {
    // 完了ゲートの純粋関数レベルでも確認
    const finding = { ruleId: 'PG-TEST-SKIP' as const, severity: 'blocking' as const, file: 'test/a.test.ts', line: 3, evidence: 'it.skip', message: 'skip', approved: false, approvalReason: null };
    const base = { taskApproved: true, verification: okVerification(), expectedVerificationCommands: ['install', 'typecheck', 'lint', 'test:run'], diff: diffCapture().summary, review: reviewOutcome(approvedReview()), blockingSeverities: ['critical', 'high'], workspaceHashBeforeReview: 'h', workspaceHashAfterReview: 'h', withinTimeLimit: true, policyViolations: [], allEventsPersisted: true };
    expect(evaluateCompletionGate({ ...base, unapprovedPolicyFindings: [finding] }).failures.map((f) => f.code)).toContain('POLICY_VIOLATION');
    expect(evaluateCompletionGate({ ...base, unapprovedPolicyFindings: [{ ...finding, approved: true }] }).passed).toBe(true);
  });

  it('time limit exceeded → NEEDS_HUMAN / TIMEOUT', async () => {
    let t = 0;
    const mock = createMockDeps({ now: () => (t += 1_000_000) });
    const status = await runWith(mock);
    expect(status.reasonCode).toBe('TIMEOUT');
  });

  it('AUD-02: events are persisted with strictly increasing sequence and final status persisted', async () => {
    const mock = createMockDeps();
    const status = await runWith(mock);
    const seqs = mock.recorder.events.map((e) => e.sequence);
    expect(seqs).toEqual(seqs.map((_, i) => i + 1));
    expect(mock.recorder.lastStatus.state).toBe('COMPLETED');
    expect(status.lastSequence).toBe(seqs.length);
    expect(mock.recorder.artifacts.has('1/builder.log')).toBe(true);
    expect(mock.recorder.artifacts.has('1/review.json')).toBe(true);
    expect(mock.recorder.artifacts.has('1/diff.patch')).toBe(true);
  });

  it('unexpected exception → INTERNAL_ERROR', async () => {
    const mock = createMockDeps({ builders: [async () => { throw new Error('boom'); }] });
    const status = await runWith(mock);
    expect(status.state).toBe('INTERNAL_ERROR');
    expect(status.reasonDetail).toContain('boom');
  });
});
