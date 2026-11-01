import type { BuilderOutcome, DiffFile, ResolvedTask, ReviewOutcome, RoundRecord, RunEvent, RunStatus, VerificationResult, Review } from '@agent-orchestrator/contracts';
import type { ApprovedTaskSnapshot, BuilderInput, DiffCapture, EngineDeps, PreflightReport, ReviewerInput, RunRecorder, VerifierInput, WorkspaceHandle } from '../../src/engine.js';

export const sampleTask: ResolvedTask = {
  schemaVersion: 2,
  id: 'TASK-TEST-001',
  title: 'テストタスク',
  repository: '/repo',
  baseRef: 'main',
  requirements: ['要件A'],
  acceptanceCriteria: [{ id: 'AC-001', given: 'g', when: 'w', then: 't' }],
  verificationProfile: 'node-pnpm',
  limits: { maxImplementationAttempts: 3, maxDurationSeconds: 2700, cliTimeoutSeconds: 900, verificationTimeoutSeconds: 300 },
  review: { blockingSeverities: ['critical', 'high'] }
};

export function snapshot(over: Partial<ApprovedTaskSnapshot> = {}): ApprovedTaskSnapshot {
  return { approvedTaskId: 'AT-1', task: sampleTask, approved: true, approvedAt: '2026-11-01T00:00:00Z', taskYaml: 'schemaVersion: 2\n', ...over };
}

export class MemoryRecorder implements RunRecorder {
  statuses: RunStatus[] = [];
  events: RunEvent[] = [];
  rounds = new Map<number, RoundRecord>();
  artifacts = new Map<string, string>();
  report: string | null = null;
  async createRun(status: RunStatus): Promise<void> {
    this.statuses.push(status);
  }
  async updateStatus(status: RunStatus): Promise<void> {
    this.statuses.push(status);
  }
  async appendEvent(event: Omit<RunEvent, 'sequence' | 'timestamp'>): Promise<RunEvent> {
    const ev: RunEvent = { ...event, sequence: this.events.length + 1, timestamp: new Date().toISOString() };
    this.events.push(ev);
    return ev;
  }
  async saveRound(_runId: string, round: RoundRecord): Promise<void> {
    this.rounds.set(round.round, round);
  }
  async saveArtifact(_runId: string, round: number, name: string, content: string): Promise<void> {
    this.artifacts.set(`${round}/${name}`, content);
  }
  async saveReport(_runId: string, markdown: string): Promise<void> {
    this.report = markdown;
  }
  async persistedEventCount(): Promise<number> {
    return this.events.length;
  }
  get lastStatus(): RunStatus {
    return this.statuses[this.statuses.length - 1]!;
  }
  types(): string[] {
    return this.events.map((e) => e.type);
  }
}

export const okBuilder = (): BuilderOutcome => ({ exitCode: 0, timedOut: false, durationMs: 5, isError: false, resultExcerpt: 'done', sessionId: 's', costUsd: 0.1 });
export const okVerification = (): VerificationResult => ({
  profile: 'node-pnpm',
  passed: true,
  commands: ['install', 'typecheck', 'lint', 'test:run'].map((name) => ({ name, argv: ['pnpm', 'run', name], exitCode: 0, timedOut: false, durationMs: 3, stdoutExcerpt: '', stderrExcerpt: '', truncated: false })),
  missing: [],
  startedAt: 't',
  finishedAt: 't'
});
export const failVerification = (): VerificationResult => {
  const v = okVerification();
  v.passed = false;
  v.commands[3] = { ...v.commands[3]!, exitCode: 1, stderrExcerpt: 'FAIL login.test.ts' };
  return v;
};
export const timeoutVerification = (): VerificationResult => {
  const v = okVerification();
  v.passed = false;
  v.commands[3] = { ...v.commands[3]!, exitCode: null, timedOut: true };
  return v;
};
export const reviewOutcome = (parsed: Review | null, over: Partial<ReviewOutcome> = {}): ReviewOutcome => ({ parsed, parseError: parsed ? null : 'invalid json', exitCode: 0, timedOut: false, durationMs: 2, rawExcerpt: '', ...over });
export const approvedReview = (): Review => ({ verdict: 'approved', findings: [], requirementsUnverified: [], summary: 'ok' });
export const highReview = (): Review => ({
  verdict: 'changes_requested',
  findings: [{ id: 'REV-001', severity: 'high', file: 'src/auth/login.ts', line: 42, description: 'leak', evidence: 'e', recommendation: 'fix' }],
  requirementsUnverified: [],
  summary: 'needs fix'
});
export const diffCapture = (files: DiffFile[] = [{ path: 'src/auth/login.ts', status: 'modified', additions: 5, deletions: 1 }]): DiffCapture => ({
  summary: { files, isEmpty: files.length === 0, patchBytes: 100, truncated: false },
  patch: 'diff --git a/x b/x',
  patches: {}
});

export interface MockOptions {
  preflight?: PreflightReport;
  builders?: Array<BuilderOutcome | ((input: BuilderInput) => Promise<BuilderOutcome>)>;
  verifications?: Array<VerificationResult | ((input: VerifierInput) => Promise<VerificationResult>)>;
  /** ベースライン検証（round 0）の結果。省略時は成功 */
  baseline?: VerificationResult;
  reviews?: Array<ReviewOutcome | ((input: ReviewerInput) => Promise<ReviewOutcome>)>;
  diffs?: DiffCapture[];
  hashes?: string[];
  hasActiveRun?: boolean;
  now?: () => number;
}

export function createMockDeps(options: MockOptions = {}) {
  const recorder = new MemoryRecorder();
  const calls = { builder: 0, verifier: 0, reviewer: 0, hash: 0, diff: 0, push: 0, pull: 0, baseline: 0 };
  const builderInputs: BuilderInput[] = [];
  const reviewerInputs: ReviewerInput[] = [];
  const pick = <T, I>(list: Array<T | ((i: I) => Promise<T>)> | undefined, idx: number, input: I, fallback: T): Promise<T> => {
    const item = list?.[Math.min(idx, (list?.length ?? 1) - 1)];
    if (item === undefined) return Promise.resolve(fallback);
    return typeof item === 'function' ? (item as (i: I) => Promise<T>)(input) : Promise.resolve(item);
  };
  const deps: EngineDeps = {
    preflight: async () => options.preflight ?? { ok: true, checks: [{ id: 'docker', label: 'Docker', status: 'ok', detail: 'ok', fix: null }] },
    workspace: {
      resolveBaseSha: async () => 'abc123',
      create: async ({ runId }): Promise<WorkspaceHandle> => ({ path: `/worktrees/${runId}`, baseSha: 'abc123' }),
      captureDiff: async () => {
        const d = options.diffs?.[Math.min(calls.diff, (options.diffs?.length ?? 1) - 1)] ?? diffCapture();
        calls.diff++;
        return d;
      },
      hash: async () => {
        const h = options.hashes?.[Math.min(calls.hash, (options.hashes?.length ?? 1) - 1)] ?? 'hash-1';
        calls.hash++;
        return h;
      }
    },
    builder: {
      implement: async (input) => {
        builderInputs.push(input);
        const r = await pick(options.builders, calls.builder, input, okBuilder());
        calls.builder++;
        return r;
      }
    },
    verifier: {
      expectedCommands: () => ['install', 'typecheck', 'lint', 'test:run'],
      verify: async (input) => {
        // round 0 はベースライン検証（Builder 前）。シナリオ配列は Builder 後の検証にだけ使う
        if (input.round === 0) {
          calls.baseline++;
          return options.baseline ?? okVerification();
        }
        const r = await pick(options.verifications, calls.verifier, input, okVerification());
        calls.verifier++;
        return r;
      }
    },
    transport: {
      push: async () => {
        calls.push++;
      },
      pull: async () => {
        calls.pull++;
      }
    },
    reviewer: {
      review: async (input) => {
        reviewerInputs.push(input);
        const r = await pick(options.reviews, calls.reviewer, input, reviewOutcome(approvedReview()));
        calls.reviewer++;
        return r;
      }
    },
    recorder,
    hasActiveRun: () => options.hasActiveRun ?? false,
    now: options.now ?? (() => Date.now())
  };
  return { deps, recorder, calls, builderInputs, reviewerInputs };
}
