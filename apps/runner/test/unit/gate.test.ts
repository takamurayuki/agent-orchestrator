import { describe, expect, it } from 'vitest';
import type { DiffSummary, ReviewOutcome, VerificationResult } from '@agent-orchestrator/contracts';
import { evaluateCompletionGate, type GateInput } from '../../src/gate.js';

const verification = (over: Partial<VerificationResult> = {}): VerificationResult => ({
  profile: 'node-pnpm',
  passed: true,
  commands: ['install', 'typecheck', 'lint', 'test:run'].map((name) => ({ name, argv: ['pnpm', name], exitCode: 0, timedOut: false, durationMs: 10, stdoutExcerpt: '', stderrExcerpt: '', truncated: false })),
  missing: [],
  startedAt: 't',
  finishedAt: 't',
  ...over
});
const diff = (over: Partial<DiffSummary> = {}): DiffSummary => ({ files: [{ path: 'src/a.ts', status: 'modified', additions: 1, deletions: 0 }], isEmpty: false, patchBytes: 10, truncated: false, ...over });
const review = (over: Partial<NonNullable<ReviewOutcome['parsed']>> = {}): ReviewOutcome => ({
  parsed: { verdict: 'approved', findings: [], requirementsUnverified: [], summary: 'ok', ...over },
  parseError: null,
  exitCode: 0,
  timedOut: false,
  durationMs: 1,
  rawExcerpt: ''
});
const good = (): GateInput => ({
  taskApproved: true,
  verification: verification(),
  expectedVerificationCommands: ['install', 'typecheck', 'lint', 'test:run'],
  diff: diff(),
  review: review(),
  blockingSeverities: ['critical', 'high'],
  workspaceHashBeforeReview: 'h1',
  workspaceHashAfterReview: 'h1',
  withinTimeLimit: true,
  policyViolations: [],
  allEventsPersisted: true
});

describe('completion gate (SPEC §6.1)', () => {
  it('passes when all seven gates hold [EX-01]', () => {
    expect(evaluateCompletionGate(good())).toEqual({ passed: true, failures: [] });
  });

  it('fails when task is not approved [RA-12][UI-07]', () => {
    const r = evaluateCompletionGate({ ...good(), taskApproved: false });
    expect(r.passed).toBe(false);
    expect(r.failures.map((f) => f.code)).toContain('TASK_NOT_APPROVED');
  });

  it('fails on verification timeout [EX-08]', () => {
    const v = verification();
    v.commands[3] = { ...v.commands[3]!, timedOut: true, exitCode: null };
    v.passed = false;
    const r = evaluateCompletionGate({ ...good(), verification: v });
    expect(r.failures.map((f) => f.code)).toContain('VERIFICATION_TIMEOUT');
  });

  it('fails when a verification command is missing', () => {
    const v = verification({ commands: verification().commands.slice(0, 2) });
    const r = evaluateCompletionGate({ ...good(), verification: v });
    expect(r.failures.map((f) => f.code)).toContain('VERIFICATION_INCOMPLETE');
  });

  it('fails with no diff [EX-10]', () => {
    const r = evaluateCompletionGate({ ...good(), diff: diff({ files: [], isEmpty: true }) });
    expect(r.failures.map((f) => f.code)).toContain('NO_DIFF');
  });

  it('fails when approved coexists with high finding [EX-07]', () => {
    const r = evaluateCompletionGate({
      ...good(),
      review: review({ findings: [{ id: 'R1', severity: 'high', file: 'a.ts', line: 1, description: 'd', evidence: 'e', recommendation: 'r' }] })
    });
    expect(r.passed).toBe(false);
    expect(r.failures.map((f) => f.code)).toEqual(expect.arrayContaining(['REVIEW_INCONSISTENT', 'BLOCKING_FINDINGS']));
  });

  it('fails when requirementsUnverified is non-empty', () => {
    const r = evaluateCompletionGate({ ...good(), review: review({ requirementsUnverified: ['logout'] }) });
    expect(r.failures.map((f) => f.code)).toContain('REQUIREMENTS_UNVERIFIED');
  });

  it('fails on invalid review JSON and on unknown verdict [EX-05][EX-06]', () => {
    const invalid = evaluateCompletionGate({ ...good(), review: { ...review(), parsed: null, parseError: 'bad json' } });
    expect(invalid.failures.map((f) => f.code)).toContain('REVIEW_INVALID');
    const unknown = evaluateCompletionGate({ ...good(), review: review({ verdict: 'unknown' }) });
    expect(unknown.failures.map((f) => f.code)).toContain('REVIEW_NOT_APPROVED');
  });

  it('fails when workspace hash changed during review [SEC-03]', () => {
    const r = evaluateCompletionGate({ ...good(), workspaceHashAfterReview: 'h2' });
    expect(r.failures.map((f) => f.code)).toContain('WORKSPACE_HASH_MISMATCH');
  });

  it('fails on time limit, policy violation, or unpersisted events', () => {
    expect(evaluateCompletionGate({ ...good(), withinTimeLimit: false }).failures.map((f) => f.code)).toContain('TIME_LIMIT_EXCEEDED');
    expect(evaluateCompletionGate({ ...good(), policyViolations: [{ code: 'TEST_SKIPPED', file: 'a.test.ts', detail: 'x' }] }).failures.map((f) => f.code)).toContain('POLICY_VIOLATION');
    expect(evaluateCompletionGate({ ...good(), allEventsPersisted: false }).failures.map((f) => f.code)).toContain('EVENTS_NOT_PERSISTED');
  });

  it('allows medium findings when blockingSeverities is critical/high', () => {
    const r = evaluateCompletionGate({
      ...good(),
      review: review({ findings: [{ id: 'R1', severity: 'medium', file: 'a.ts', line: 1, description: 'd', evidence: 'e', recommendation: 'r' }] })
    });
    expect(r.passed).toBe(true);
  });
});
