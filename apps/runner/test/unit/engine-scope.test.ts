import { describe, expect, it } from 'vitest';
import type { ResolvedTask } from '@agent-orchestrator/contracts';
import { RunEngine } from '../../src/engine.js';
import { evaluateCompletionGate } from '../../src/gate.js';
import { approvedReview, createMockDeps, diffCapture, failVerification, okBuilder, okVerification, reviewOutcome, sampleTask, snapshot } from '../helpers/mock-deps.js';

const scopedTask: ResolvedTask = { ...sampleTask, expectedChanges: ['src/greet.ts', 'test/'], conflictRisks: ['既存の greet を変更しない'] };
const runWith = async (mock: ReturnType<typeof createMockDeps>, task: ResolvedTask = scopedTask) => {
  const engine = new RunEngine(mock.deps);
  return engine.run({ runId: 'RUN-S', snapshot: snapshot({ task }), runDir: '/runs/RUN-S', signal: new AbortController().signal });
};
const d = (paths: string[]) => diffCapture(paths.map((path) => ({ path, status: 'modified' as const, additions: 1, deletions: 0 })));

describe('scope deviation in the engine (D-39)', () => {
  it('changes inside the expected scope → none; the reviewer and builder receive the scope context', async () => {
    const mock = createMockDeps({ diffs: [d(['src/greet.ts', 'test/greet.test.ts'])] });
    const status = await runWith(mock);
    expect(status.state).toBe('COMPLETED');
    expect(mock.recorder.rounds.get(1)?.scopeCheck?.severity).toBe('none');
    expect(mock.reviewerInputs[0]?.scopeCheck?.severity).toBe('none');
    expect(mock.recorder.types()).toContain('scope.checked');
  });

  it('a minor deviation (1–2 unexpected source files) is recorded, shown to the reviewer, and does not block completion', async () => {
    const mock = createMockDeps({ diffs: [d(['src/greet.ts', 'src/util.ts'])] });
    const status = await runWith(mock);
    expect(status.state).toBe('COMPLETED');
    const sc = mock.recorder.rounds.get(1)?.scopeCheck;
    expect(sc?.severity).toBe('minor');
    expect(sc?.unexpected).toEqual(['src/util.ts']);
    expect(mock.reviewerInputs[0]?.scopeCheck?.severity).toBe('minor');
  });

  it('a major deviation is sent back to the Builder once (no verification / review), then stops with NEEDS_HUMAN / SCOPE_DEVIATION if it persists', async () => {
    const mock = createMockDeps({
      diffs: [d(['src/greet.ts', 'package.json']), d(['src/greet.ts', 'package.json']), d(['src/greet.ts', 'package.json'])],
      builders: [{ ...okBuilder(), resultExcerpt: 'Out-of-scope changes: added a dependency because …' }]
    });
    const status = await runWith(mock);
    expect(status.state).toBe('NEEDS_HUMAN');
    expect(status.reasonCode).toBe('SCOPE_DEVIATION');
    expect(status.reasonDetail).toContain('package.json');
    expect(mock.calls.verifier).toBe(0);
    expect(mock.calls.reviewer).toBe(0);
    expect(mock.calls.builder).toBe(3);
    expect(mock.builderInputs[1]?.feedback?.scopeDeviation).toContain('outside the expected scope');
    expect(mock.recorder.rounds.get(1)?.scopeCheck?.builderReason).toContain('Out-of-scope changes');
    expect(status.nextActions.join(' ')).toContain('expectedChanges');
  });

  it('a major deviation fixed in the next round continues to verification, review and completion', async () => {
    const mock = createMockDeps({ diffs: [d(['src/greet.ts', 'src/a.ts', 'src/b.ts', 'src/c.ts']), d(['src/greet.ts', 'test/greet.test.ts'])] });
    const status = await runWith(mock);
    expect(status.state).toBe('COMPLETED');
    expect(mock.recorder.rounds.get(1)?.scopeCheck?.severity).toBe('major');
    expect(mock.recorder.rounds.get(2)?.scopeCheck?.severity).toBe('none');
    expect(mock.calls.verifier).toBe(1);
  });

  it('tasks without expectedChanges are not judged (backward compatible)', async () => {
    const mock = createMockDeps({ diffs: [d(['anything/x.ts', 'package.json', 'a', 'b'])] });
    const status = await runWith(mock, sampleTask);
    expect(status.state).toBe('COMPLETED');
    expect(mock.recorder.rounds.get(1)?.scopeCheck?.severity).toBe('none');
  });

  it('the completion gate refuses a major deviation even with an approved review', () => {
    const r = evaluateCompletionGate({
      taskApproved: true,
      verification: { ...okVerification(), commands: [...okVerification().commands, { name: 'structure', argv: ['structure-check'], exitCode: 0, timedOut: false, durationMs: 1, stdoutExcerpt: '', stderrExcerpt: '', truncated: false }] },
      expectedVerificationCommands: ['install', 'typecheck', 'lint', 'test:run', 'structure'],
      diff: diffCapture().summary,
      review: reviewOutcome(approvedReview()),
      blockingSeverities: ['critical', 'high'],
      workspaceHashBeforeReview: 'h',
      workspaceHashAfterReview: 'h',
      withinTimeLimit: true,
      policyViolations: [],
      scopeCheck: { expected: ['src/'], unexpected: ['package.json'], severity: 'major', detail: 'x', builderReason: null },
      allEventsPersisted: true
    });
    expect(r.passed).toBe(false);
    expect(r.failures.map((f) => f.code)).toContain('SCOPE_DEVIATION');
  });
});

describe('deterministic structure verification in the engine (D-40)', () => {
  it('a broken JSON file in the diff fails verification with a "structure" record and is fed back to the Builder', async () => {
    const mock = createMockDeps({
      diffs: [d(['src/greet.ts', 'config.json']), d(['src/greet.ts', 'config.json'])],
      currentContents: [{ 'config.json': '{ broken' }, { 'config.json': '{ "ok": true }' }]
    });
    const status = await runWith(mock, sampleTask);
    expect(status.state).toBe('COMPLETED');
    const r1 = mock.recorder.rounds.get(1)?.verification;
    expect(r1?.passed).toBe(false);
    expect(r1?.commands.find((c) => c.name === 'structure')?.exitCode).toBe(1);
    expect(mock.builderInputs[1]?.feedback?.verificationFailures.join(' ')).toContain('config.json');
    expect(mock.recorder.rounds.get(2)?.verification?.commands.find((c) => c.name === 'structure')?.exitCode).toBe(0);
  });

  it('the structure record is skipped (not fabricated as pass) when the profile commands already failed', async () => {
    const mock = createMockDeps({ verifications: [failVerification(), okVerification()], diffs: [d(['src/greet.ts']), d(['src/greet.ts'])] });
    await runWith(mock, sampleTask);
    expect(mock.recorder.rounds.get(1)?.verification?.commands.some((c) => c.name === 'structure')).toBe(false);
    expect(mock.recorder.rounds.get(2)?.verification?.commands.some((c) => c.name === 'structure')).toBe(true);
  });
});
