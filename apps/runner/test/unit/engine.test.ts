import { describe, expect, it } from 'vitest';
import { RunEngine } from '../../src/engine.js';
import {
  approvedReview,
  createMockDeps,
  diffCapture,
  failVerification,
  highReview,
  okBuilder,
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

  it('policy violation (test deleted) → NEEDS_HUMAN / POLICY_VIOLATION', async () => {
    const mock = createMockDeps({ diffs: [diffCapture([{ path: 'src/login.test.ts', status: 'deleted', additions: 0, deletions: 20 }])] });
    const status = await runWith(mock);
    expect(status.reasonCode).toBe('POLICY_VIOLATION');
    expect(mock.calls.verifier).toBe(0);
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
