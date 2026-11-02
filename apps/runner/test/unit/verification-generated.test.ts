import { describe, expect, it } from 'vitest';
import type { GeneratedArtifact, VerificationResult } from '@agent-orchestrator/contracts';
import { evaluateCompletionGate } from '../../src/gate.js';
import { generatedCommandNames, verifyGeneratedArtifacts } from '../../src/verification/generated.js';
import { SandboxVerifier } from '../../src/verification/runner.js';
import { FakeSandbox, type StepHandler } from '../helpers/fake-sandbox.js';

const artifact: GeneratedArtifact = { path: 'docs/QUALITY_REPORT.md', script: 'quality:report', reason: 'r' };
const input = (signal = new AbortController().signal) => ({ runId: 'R1', round: 1, artifacts: [artifact], env: { CI: '1' }, timeoutMs: 5000, signal, onLog: () => undefined });

/** before/after のハッシュと生成スクリプトの結果を差し替えられるフェイク */
const sandboxWith = (hashes: { before: string; after: string }, run: Partial<{ exitCode: number; timedOut: boolean; stderr: string }> = {}) =>
  new FakeSandbox(((step) => {
    if (step.name.startsWith('generate-hash-before')) return { stdout: `${hashes.before}\n` };
    if (step.name.startsWith('generate-hash-after')) return { stdout: `${hashes.after}\n` };
    if (step.name.startsWith('generate-')) return { exitCode: 0, ...run };
    return {};
  }) as StepHandler);

describe('generated artifact verification (D-41)', () => {
  it('passes only when re-running the script leaves the artifact unchanged; the script runs with no network via pnpm run', async () => {
    const sb = sandboxWith({ before: 'aaa', after: 'aaa' });
    const r = await verifyGeneratedArtifacts(sb, input());
    expect(r).toHaveLength(1);
    expect(r[0]).toMatchObject({ name: 'generate:quality:report', exitCode: 0, timedOut: false, argv: ['pnpm', 'run', 'quality:report'] });
    const run = sb.steps.find((s) => s.name.startsWith('generate-quality'))!;
    expect(run.argv).toEqual(['pnpm', 'run', 'quality:report']);
    expect(run.network).toBe('none');
    expect(run.workspace).toBe('rw');
    expect(run.aux).toBe('none');
    // ハッシュは固定の node スクリプトで取る（任意コマンドではない）
    const hash = sb.steps.find((s) => s.name.startsWith('generate-hash-before'))!;
    expect(hash.argv.slice(0, 2)).toEqual(['node', '-e']);
    expect(hash.argv[3]).toBe('docs/QUALITY_REPORT.md');
    // 再生成の前に退避し、比較後に Builder の出力へ戻す（Verifier はワークスペースを変更しない）
    expect(sb.steps.map((s) => s.name.replace(/-r1$/, ''))).toEqual(['generate-hash-before', 'generate-snapshot', 'generate-quality-report', 'generate-hash-after', 'generate-restore']);
    expect(sb.steps[1]!.argv.slice(3)).toEqual(['snapshot', 'docs/QUALITY_REPORT.md']);
    expect(sb.steps[4]!.argv.slice(3)).toEqual(['restore', 'docs/QUALITY_REPORT.md']);
    for (const s of sb.steps) expect(s.network).toBe('none');
  });

  it('restores the artifact even when the script fails or times out', async () => {
    const sb = sandboxWith({ before: 'aaa', after: 'aaa' }, { exitCode: 2 });
    await verifyGeneratedArtifacts(sb, input());
    expect(sb.steps.at(-1)!.name).toBe('generate-restore-r1');
    const to = sandboxWith({ before: 'aaa', after: 'aaa' }, { timedOut: true });
    await verifyGeneratedArtifacts(to, input());
    expect(to.steps.at(-1)!.name).toBe('generate-restore-r1');
  });

  it('reports freshness only (not validity) when the inputs are outside git', async () => {
    const sb = sandboxWith({ before: 'aaa', after: 'aaa' });
    const r = await verifyGeneratedArtifacts(sb, { ...input(), artifacts: [{ ...artifact, inputStatus: 'missing', inputs: [{ path: 'test-results/dogfood', status: 'ignored', detail: 'd' }] }] });
    expect(r[0]!.exitCode).toBe(0);
    expect(r[0]!.stdoutExcerpt).toContain('内容の妥当性は未確認');
    expect(r[0]!.stdoutExcerpt).toContain('test-results/dogfood');
  });

  it('runs the generator with the package manager of the profile (npm / yarn)', async () => {
    const sb = sandboxWith({ before: 'a', after: 'a' });
    const r = await verifyGeneratedArtifacts(sb, { ...input(), profile: 'node-npm' });
    expect(r[0]!.argv).toEqual(['npm', 'run', 'quality:report']);
    expect(sb.steps.find((s) => s.name.startsWith('generate-quality'))!.argv).toEqual(['npm', 'run', 'quality:report']);
    const yb = sandboxWith({ before: 'a', after: 'a' });
    await verifyGeneratedArtifacts(yb, { ...input(), profile: 'node-yarn' });
    expect(yb.steps.find((s) => s.name.startsWith('generate-quality'))!.argv).toEqual(['yarn', 'run', 'quality:report']);
  });

  it('fails with a plain-language reason when the artifact is stale (Builder did not regenerate)', async () => {
    const r = await verifyGeneratedArtifacts(sandboxWith({ before: 'aaa', after: 'bbb' }), input());
    expect(r[0]!.exitCode).toBe(1);
    expect(r[0]!.stdoutExcerpt).toContain('最新ではありません');
    expect(r[0]!.stdoutExcerpt).toContain('quality:report');
  });

  it('fails when the script fails, times out, or never produces the file', async () => {
    expect((await verifyGeneratedArtifacts(sandboxWith({ before: 'aaa', after: 'aaa' }, { exitCode: 2, stderr: 'boom' }), input()))[0]).toMatchObject({ exitCode: 2 });
    expect((await verifyGeneratedArtifacts(sandboxWith({ before: 'aaa', after: 'aaa' }, { timedOut: true }), input()))[0]).toMatchObject({ exitCode: null, timedOut: true });
    const missing = (await verifyGeneratedArtifacts(sandboxWith({ before: 'MISSING', after: 'MISSING' }), input()))[0]!;
    expect(missing.exitCode).toBe(1);
    expect(missing.stdoutExcerpt).toContain('作られませんでした');
  });

  it('rejects script names and paths outside the contract without executing anything [SEC]', async () => {
    const sb = sandboxWith({ before: 'a', after: 'a' });
    const r = await verifyGeneratedArtifacts(sb, {
      ...input(),
      artifacts: [
        { path: '../etc/passwd', script: 'quality:report', reason: 'r' },
        { path: 'x.md', script: 'rm -rf /', reason: 'r' }
      ]
    });
    expect(r.map((x) => x.exitCode)).toEqual([1, 1]);
    expect(sb.steps).toHaveLength(0);
  });

  it('the gate requires a generate:<script> result for every artifact', () => {
    expect(generatedCommandNames([artifact])).toEqual(['generate:quality:report']);
    expect(generatedCommandNames(undefined)).toEqual([]);
    const commands = ['install', 'typecheck', 'lint', 'test:run', 'structure'].map((name) => ({ name, argv: [name], exitCode: 0, timedOut: false, durationMs: 1, stdoutExcerpt: '', stderrExcerpt: '', truncated: false }));
    const verification: VerificationResult = { profile: 'node-pnpm', passed: true, commands, missing: [], startedAt: 't', finishedAt: 't' };
    const base = {
      taskApproved: true,
      verification,
      diff: { files: [{ path: 'a.ts', status: 'modified' as const, additions: 1, deletions: 0 }], isEmpty: false, patchBytes: 1, truncated: false },
      review: { parsed: { verdict: 'approved' as const, findings: [], requirementsUnverified: [], summary: 'ok' }, parseError: null, exitCode: 0, timedOut: false, durationMs: 1, rawExcerpt: '' },
      blockingSeverities: ['critical', 'high'] as Array<'critical' | 'high'>,
      workspaceHashBeforeReview: 'h',
      workspaceHashAfterReview: 'h',
      withinTimeLimit: true,
      policyViolations: [],
      allEventsPersisted: true
    };
    const without = evaluateCompletionGate({ ...base, expectedVerificationCommands: ['install', 'typecheck', 'lint', 'test:run', ...generatedCommandNames([artifact]), 'structure'] });
    expect(without.passed).toBe(false);
    const withGen = evaluateCompletionGate({
      ...base,
      verification: { ...verification, commands: [...commands, { ...commands[0]!, name: 'generate:quality:report' }] },
      expectedVerificationCommands: ['install', 'typecheck', 'lint', 'test:run', 'generate:quality:report', 'structure']
    });
    expect(withGen.passed).toBe(true);
  });
});

describe('SandboxVerifier runs generated-artifact checks only after the profile passes', () => {
  const verifierInput = (sandbox: FakeSandbox, generatedArtifacts: GeneratedArtifact[] = [artifact]) => ({
    runId: 'R1',
    round: 1,
    workspace: { path: '/ws', baseSha: 'a'.repeat(40) },
    profile: 'node-pnpm' as const,
    generatedArtifacts,
    timeoutMs: 1000,
    signal: new AbortController().signal,
    onLog: () => undefined,
    sandbox
  });

  it('appends generate:* results after install/typecheck/lint/test:run and fails the whole verification when stale', async () => {
    const stale = sandboxWith({ before: 'a', after: 'b' });
    const r = await new SandboxVerifier(stale).verify(verifierInput(stale));
    expect(r.commands.map((c) => c.name)).toEqual(['install', 'typecheck', 'lint', 'test:run', 'generate:quality:report']);
    expect(r.passed).toBe(false);
    const fresh = sandboxWith({ before: 'a', after: 'a' });
    expect((await new SandboxVerifier(fresh).verify(verifierInput(fresh))).passed).toBe(true);
  });

  it('skips generation when a profile command failed, and when there are no artifacts (baseline round)', async () => {
    const failing = new FakeSandbox((step) => (step.name.startsWith('verify-lint') ? { exitCode: 1 } : {}));
    const r = await new SandboxVerifier(failing).verify(verifierInput(failing));
    expect(r.passed).toBe(false);
    expect(r.commands.some((c) => c.name.startsWith('generate:'))).toBe(false);
    expect(failing.steps.some((s) => s.name.startsWith('generate-'))).toBe(false);
    const none = sandboxWith({ before: 'a', after: 'a' });
    const r2 = await new SandboxVerifier(none).verify(verifierInput(none, []));
    expect(r2.passed).toBe(true);
    expect(none.steps.some((s) => s.name.startsWith('generate-'))).toBe(false);
  });
});
