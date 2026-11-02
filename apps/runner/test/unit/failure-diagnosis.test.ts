import { describe, expect, it } from 'vitest';
import type { RoundRecord, RunStatus, VerificationCommandResult } from '@agent-orchestrator/contracts';
import { diagnoseFailure } from '../../src/failure-diagnosis.js';

const run = (over: Partial<RunStatus>): RunStatus => ({
  runId: 'R',
  approvedTaskId: 'A',
  taskId: 'T',
  taskTitle: 't',
  repository: 'C:/repo',
  baseRef: 'main',
  state: 'NEEDS_HUMAN',
  reasonCode: 'MAX_ROUNDS',
  reasonDetail: null,
  baseSha: null,
  maxRounds: 3,
  currentRound: 3,
  worktreePath: null,
  runDir: 'd',
  startedAt: 't',
  finishedAt: 't',
  lastSequence: 1,
  openBlockingFindings: 0,
  nextActions: [],
  ...over
});
const cmd = (name: string, exitCode: number | null, out = '', timedOut = false): VerificationCommandResult => ({ name, argv: [name], exitCode, timedOut, durationMs: 1, stdoutExcerpt: out, stderrExcerpt: '', truncated: false });
const round = (over: Partial<RoundRecord>): RoundRecord => ({ round: 1, builder: null, diff: null, scopeCheck: null, policyViolations: [], policyFindings: [], verification: null, review: null, workspaceHashBeforeReview: null, workspaceHashAfterReview: null, startedAt: 't', finishedAt: 't', ...over });
const verification = (commands: VerificationCommandResult[]) => ({ profile: 'node-pnpm' as const, passed: commands.every((c) => c.exitCode === 0), commands, missing: [], startedAt: 't', finishedAt: 't' });
const builder = (resultExcerpt: string) => ({ exitCode: 0, timedOut: false, durationMs: 1, isError: false, resultExcerpt, sessionId: null, costUsd: null });
const review = (verdict: 'approved' | 'changes_requested' | 'unknown') => ({ parsed: { verdict, findings: verdict === 'changes_requested' ? [{ id: 'F-1', severity: 'high' as const, file: 'a.ts', line: 1, description: 'bad', evidence: 'e', recommendation: 'fix' }] : [], requirementsUnverified: [], summary: 's' }, parseError: null, exitCode: 0, timedOut: false, durationMs: 1, rawExcerpt: '' });

describe('failure diagnosis (D-43): deterministic classification from records', () => {
  it('returns null for completed and in-progress runs', () => {
    expect(diagnoseFailure({ run: run({ state: 'COMPLETED', reasonCode: 'COMPLETED' }), rounds: [] })).toBeNull();
    expect(diagnoseFailure({ run: run({ state: 'IMPLEMENTING', reasonCode: null }), rounds: [] })).toBeNull();
  });

  it('distinguishes generated-artifact staleness, supply-chain policy, dependency fetch, network and docker failures from the failing command output', () => {
    const stale = diagnoseFailure({ run: run({}), rounds: [round({ verification: verification([cmd('install', 0), cmd('generate:quality:report', 1, '生成物 docs/Q.md が最新ではありません: quality:report を再実行すると内容が変わります')]) })] })!;
    expect(stale.category).toBe('generated_artifact');
    expect(stale.whatHappened).toContain('再生成していない');
    expect(stale.evidence[0]).toContain('generate:quality:report exit=1');
    expect(stale.autoRecoverable).toBe('no');

    const sc = diagnoseFailure({ run: run({}), rounds: [round({ verification: verification([cmd('install', 1, 'ERR_PNPM_MINIMUM_RELEASE_AGE_VIOLATION foo@1.2.3')]) })] })!;
    expect(sc.category).toBe('supply_chain_policy');
    expect(sc.autoRecoveryNote).toContain('自動で緩めません');

    const fetch = diagnoseFailure({ run: run({}), rounds: [round({ verification: verification([cmd('install', 1, 'ERR_PNPM_FETCH_404 GET https://registry.npmjs.org/x 404')]) })] })!;
    expect(fetch.category).toBe('dependency_fetch_failed');

    const net = diagnoseFailure({ run: run({}), rounds: [round({ verification: verification([cmd('install', 1, 'request to https://x failed, reason: getaddrinfo ENOTFOUND x')]) })], egress: { available: true, allowed: 1, denied: 2, errors: 0, allowedHosts: [], deniedHosts: [{ host: 'x', count: 2 }], errorHosts: [] } })!;
    expect(net.category).toBe('network_blocked');
    expect(net.evidence).toContain('拒否: x');
    expect(net.nextSteps.join(' ')).not.toMatch(/緩め|無効/);

    const docker = diagnoseFailure({ run: run({}), rounds: [round({ verification: verification([cmd('typecheck', 125, 'docker: Error response from daemon')]) })] })!;
    expect(docker.category).toBe('docker_error');

    const plain = diagnoseFailure({ run: run({}), rounds: [round({ verification: verification([cmd('test:run', 1, '1 test failed')]) })] })!;
    expect(plain.category).toBe('verification_failed');
    expect(plain.whatHappened).toContain('test:run');
  });

  it('classifies review-driven round limits, reviewer undecidability, builder command denial (inferred) and policy/scope stops', () => {
    const lim = diagnoseFailure({ run: run({}), rounds: [round({ verification: verification([cmd('install', 0)]), review: review('changes_requested') })] })!;
    expect(lim.category).toBe('limit_reached');
    expect(lim.evidence[0]).toContain('[high] a.ts:1');

    const unk = diagnoseFailure({ run: run({ reasonCode: 'REVIEW_UNKNOWN' }), rounds: [round({ review: review('unknown') })] })!;
    expect(unk.category).toBe('review_undecidable');
    expect(unk.autoRecoveryNote).toContain('推測で補うことはしません');

    const denied = diagnoseFailure({ run: run({ reasonCode: 'NO_CHANGES', state: 'NEEDS_HUMAN' }), rounds: [round({ builder: builder('The shell command was denied because the sandbox has no way to approve it. The denial reason was "brace with quote character (expansion obfuscation)".') })] })!;
    expect(denied.category).toBe('builder_command_denied');
    expect(denied.confidence).toBe('inferred');
    expect(denied.whatHappened).toContain('AI 側 CLI の判断');
    expect(denied.autoRecoveryNote).toContain('権限を広げることはしません');

    expect(diagnoseFailure({ run: run({ reasonCode: 'POLICY_VIOLATION' }), rounds: [round({})] })!.category).toBe('policy_violation');
    expect(diagnoseFailure({ run: run({ reasonCode: 'SCOPE_DEVIATION' }), rounds: [round({ scopeCheck: { expected: [], unexpected: ['ci.yml'], severity: 'major', detail: 'd', builderReason: null } })] })!.evidence).toEqual(['ci.yml']);
  });

  it('keeps unknown causes unknown instead of guessing', () => {
    const d = diagnoseFailure({ run: run({ reasonCode: 'INTERNAL_ERROR', state: 'INTERNAL_ERROR', reasonDetail: 'TypeError: x is not a function' }), rounds: [] })!;
    expect(d.category).toBe('unknown');
    expect(d.confidence).toBe('unknown');
    expect(d.autoRecoverable).toBe('unknown');
    const nc = diagnoseFailure({ run: run({ reasonCode: 'NO_CHANGES' }), rounds: [round({ builder: builder('Nothing to do; the requirement is already met.') })] })!;
    expect(nc.category).toBe('no_changes');
    expect(nc.autoRecoverable).toBe('unknown');
  });

  it('precheck: supply-chain and docker causes are recognised and AI is reported as not executed', () => {
    const d = diagnoseFailure({ run: run({ state: 'PRECHECK_FAILED', reasonCode: 'PRECHECK_FAILED', reasonDetail: 'baseline install failed: ERR_PNPM_MINIMUM_RELEASE_AGE_VIOLATION' }), rounds: [] })!;
    expect(d.category).toBe('supply_chain_policy');
    expect(d.whatHappened).toContain('AI は実行していません');
    expect(diagnoseFailure({ run: run({ state: 'PRECHECK_FAILED', reasonCode: 'PRECHECK_FAILED', reasonDetail: 'Cannot connect to the Docker daemon' }), rounds: [] })!.category).toBe('docker_error');
  });
});
