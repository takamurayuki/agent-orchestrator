import { describe, expect, it } from 'vitest';
import { BUILDER_ALLOWED_TOOLS, ClaudeBuilder, buildClaudeArgs, parseClaudeJson, renderBuilderPrompt, toBuilderOutcome } from '../../src/agents/claude.js';
import { CodexReviewer, buildCodexArgs, parseReviewOutput, renderReviewerPrompt, toReviewOutcome } from '../../src/agents/codex.js';
import { buildDockerRunArgs } from '../../src/isolation/docker.js';
import { findForbiddenFlags } from '../../src/policy.js';
import { FakeSandbox } from '../helpers/fake-sandbox.js';
import { approvedReview, diffCapture, okVerification, sampleTask } from '../helpers/mock-deps.js';
import type { BuilderInput, ReviewerInput } from '../../src/engine.js';

const builderInput = (feedback: BuilderInput['feedback'] = null): BuilderInput => ({
  runId: 'R1',
  round: 1,
  workspace: { path: 'C:/ws/R1', baseSha: 'b'.repeat(40) },
  task: sampleTask,
  taskYaml: 'schemaVersion: 2\nid: TASK-TEST-001\n',
  feedback,
  timeoutMs: 1000,
  signal: new AbortController().signal,
  onLog: () => undefined
});

describe('Claude Builder adapter', () => {
  it('builds a non-interactive argv without dangerous flags [SEC-08]', () => {
    const args = buildClaudeArgs({ systemPrompt: 'sys', maxBudgetUsd: 5, allowedTools: BUILDER_ALLOWED_TOOLS });
    expect(args[0]).toBe('claude');
    expect(args).toContain('--print');
    expect(args).toContain('--permission-prompts');
    expect(args).not.toContain('--dangerously-skip-permissions');
    expect(findForbiddenFlags(args)).toEqual([]);
    // プロンプトは argv ではなく stdin で渡す（D-28）。argv にプロンプト本文が無い
    expect(args.join(' ')).not.toContain('do it');
    // 対象リポジトリの settings/hook を読み込まない
    expect(args.slice(args.indexOf('--setting-sources'), args.indexOf('--setting-sources') + 2)).toEqual(['--setting-sources', 'user']);
  });

  it('allowed tools never include unrestricted Bash or git push', () => {
    expect(BUILDER_ALLOWED_TOOLS).not.toContain('Bash');
    expect(BUILDER_ALLOWED_TOOLS.some((t) => /push|merge|deploy|curl|wget/.test(t))).toBe(false);
  });

  it('renders feedback from previous round into the prompt', () => {
    const prompt = renderBuilderPrompt(
      builderInput({ previousRound: 1, verificationFailures: ['test:run: exit=1\nFAIL login'], reviewFindings: [{ id: 'REV-1', severity: 'high', file: 'a.ts', line: 3, description: 'leak', evidence: 'e', recommendation: 'fix' }], requirementsUnverified: ['logout'], reviewSummary: 'needs work', policyFindings: ['[PG-ESLINT-DISABLE] a.ts:2 — 新規の eslint-disable'] })
    );
    expect(prompt).toContain('FAIL login');
    expect(prompt).toContain('REV-1');
    expect(prompt).toContain('logout');
    expect(prompt).toContain('AC-001');
  });

  it('parses claude json output (even with leading warning lines) and maps to BuilderOutcome', () => {
    const out = 'warning: something\n{"type":"result","subtype":"success","is_error":false,"result":"done","session_id":"s1","total_cost_usd":0.5}';
    expect(parseClaudeJson(out)?.session_id).toBe('s1');
    const outcome = toBuilderOutcome({ command: 'docker', args: [], exitCode: 0, signal: null, stdout: out, stderr: '', truncated: false, timedOut: false, aborted: false, durationMs: 10, spawnError: null });
    expect(outcome).toMatchObject({ exitCode: 0, isError: false, sessionId: 's1', costUsd: 0.5 });
    const errOutcome = toBuilderOutcome({ command: 'docker', args: [], exitCode: 0, signal: null, stdout: '{"is_error":true,"result":"budget exceeded"}', stderr: '', truncated: false, timedOut: false, aborted: false, durationMs: 10, spawnError: null });
    expect(errOutcome.isError).toBe(true);
  });

  it('runs inside the sandbox with rw workspace, egress network and injected credentials masked [SEC-05]', async () => {
    const sandbox = new FakeSandbox(() => ({ stdout: '{"type":"result","is_error":false,"result":"ok"}' }));
    const builder = new ClaudeBuilder(sandbox, async () => ({ env: { CLAUDE_CODE_OAUTH_TOKEN: 'tok-secret-123456' }, secrets: ['tok-secret-123456'] }));
    const outcome = await builder.implement(builderInput());
    expect(outcome.exitCode).toBe(0);
    const step = sandbox.steps[0]!;
    expect(step.network).toBe('egress');
    expect(step.workspace).toBe('rw');
    expect(step.env.CLAUDE_CODE_OAUTH_TOKEN).toBe('tok-secret-123456');
    expect(step.secrets).toContain('tok-secret-123456');
    expect(step.argv[0]).toBe('claude');
    // プロンプトは stdin（argv 長制限の回避 D-28）。シェル解釈なしで 1 つのストリームとして渡る
    expect(step.stdin).toContain('TASK-TEST-001');
    expect(step.argv.join(' ')).not.toContain('TASK-TEST-001');
  });

  it('D-28: a spawn failure (e.g. argv too long) is an error outcome, never a silent success', () => {
    const outcome = toBuilderOutcome({ command: 'docker', args: [], exitCode: null, signal: null, stdout: '', stderr: '', truncated: false, timedOut: false, aborted: false, durationMs: 2, spawnError: 'spawn docker E2BIG' });
    expect(outcome.isError).toBe(true);
    expect(outcome.resultExcerpt).toContain('E2BIG');
    const review = toReviewOutcome({ command: 'docker', args: [], exitCode: null, signal: null, stdout: '', stderr: '', truncated: false, timedOut: false, aborted: false, durationMs: 2, spawnError: 'spawn docker E2BIG' }, '');
    expect(review.parsed).toBeNull();
    expect(review.parseError).toContain('E2BIG');
  });
});

const reviewerInput = (): ReviewerInput => ({
  runId: 'R1',
  round: 1,
  workspace: { path: 'C:/ws/R1', baseSha: 'b'.repeat(40) },
  task: sampleTask,
  taskYaml: 'schemaVersion: 2\n',
  diff: diffCapture([{ path: 'src/new.ts', status: 'untracked', additions: 3, deletions: 0 }]),
  verification: okVerification(),
  timeoutMs: 1000,
  signal: new AbortController().signal,
  onLog: () => undefined
});

describe('Codex Reviewer adapter', () => {
  it('uses read-only sandbox and output schema; no dangerous flags [SEC-08]', () => {
    const args = buildCodexArgs({ schemaFile: '/tmp/s.json', outputFile: '/tmp/o.json' });
    expect(args.slice(0, 2)).toEqual(['codex', 'exec']);
    expect(args).toContain('read-only');
    expect(args).toContain('--output-schema');
    expect(args[args.length - 1]).toBe('-'); // プロンプトは stdin
    expect(findForbiddenFlags(args)).toEqual([]);
  });

  it('includes untracked files in the prompt [EX-11]', () => {
    const prompt = renderReviewerPrompt(reviewerInput());
    expect(prompt).toContain('untracked src/new.ts');
    expect(prompt).toContain('AC-001');
  });

  it('parses valid review JSON (plain or fenced) and rejects invalid [EX-06]', () => {
    expect(parseReviewOutput(JSON.stringify(approvedReview())).parsed?.verdict).toBe('approved');
    expect(parseReviewOutput('```json\n' + JSON.stringify(approvedReview()) + '\n```').parsed?.verdict).toBe('approved');
    expect(parseReviewOutput('{"verdict":"approved"}').parsed).toBeNull();
    expect(parseReviewOutput('not json').parsed).toBeNull();
    expect(parseReviewOutput('').parseError).toContain('empty');
  });

  it('maps timeout / non-zero exit to parsed=null (unknown, no auto-repair) [EX-05]', () => {
    const base = { command: 'docker', args: [], signal: null, stdout: '', stderr: 'boom', truncated: false, aborted: false, durationMs: 1, spawnError: null };
    expect(toReviewOutcome({ ...base, exitCode: null, timedOut: true }, JSON.stringify(approvedReview()))).toMatchObject({ parsed: null, timedOut: true });
    expect(toReviewOutcome({ ...base, exitCode: 1, timedOut: false }, JSON.stringify(approvedReview())).parsed).toBeNull();
  });

  it('mounts the workspace read-only, injects the schema and auth via aux, and reads the output back [SEC-03]', async () => {
    const sandbox = new FakeSandbox();
    const reviewer = new CodexReviewer(sandbox, async () => ({ authJsonPath: null, env: { OPENAI_API_KEY: 'sk-test-abcdefghijklmnop' }, secrets: ['sk-test-abcdefghijklmnop'] }));
    const outcome = await reviewer.review(reviewerInput());
    const step = sandbox.steps[0]!;
    expect(step.workspace).toBe('ro');
    expect(step.aux).toBe('rw');
    expect(step.env.CODEX_HOME).toBe('/aux/codex-home');
    expect(step.stdin).toContain('untracked src/new.ts');
    expect([...sandbox.files.keys()]).toContain('/aux/review/review.schema.json');
    // 出力ファイルが無い → parsed=null
    expect(outcome.parsed).toBeNull();
    // 出力があれば検証して返す
    sandbox.files.set('/aux/review/review-r1.json', JSON.stringify(approvedReview()));
    const ok = await reviewer.review(reviewerInput());
    expect(ok.parsed?.verdict).toBe('approved');
  });
});

describe('docker run argv (SPEC §9)', () => {
  it('applies non-root, cap-drop, no-new-privileges, limits, read-only root, no docker socket, and proxy env', () => {
    const args = buildDockerRunArgs({
      containerName: 'ao-R1-builder',
      image: 'agent-orchestrator-sandbox:0.1.0',
      step: { name: 'builder', argv: ['claude', '-p', 'x'], workspace: 'rw', aux: 'none', workdir: '/workspace', env: { A: '1' }, network: 'egress', timeoutMs: 1 },
      volumes: { workspace: 'ao-R1-ws', aux: 'ao-R1-aux' },
      network: 'ao-R1-net',
      limits: { cpus: 2, memory: '4g', pids: 512 },
      proxyUrl: 'http://egress-proxy:3128'
    });
    const joined = args.join(' ');
    expect(joined).toContain('--user 1001:1001');
    expect(joined).toContain('--cap-drop ALL');
    expect(joined).toContain('--security-opt no-new-privileges');
    expect(joined).toContain('--pids-limit 512');
    expect(joined).toContain('--read-only');
    expect(joined).toContain('--network ao-R1-net');
    expect(joined).toContain('-e HTTPS_PROXY=http://egress-proxy:3128');
    expect(joined).not.toContain('docker.sock');
    expect(joined).not.toContain('--privileged');
    expect(args.slice(-3)).toEqual(['claude', '-p', 'x']);
  });

  it('uses --network none when no egress is requested and readonly mounts for reviewer', () => {
    const args = buildDockerRunArgs({
      containerName: 'ao-R1-review',
      image: 'img',
      step: { name: 'review', argv: ['codex'], workspace: 'ro', aux: 'rw', workdir: '/workspace', env: {}, network: 'none', timeoutMs: 1 },
      volumes: { workspace: 'ao-R1-ws', aux: 'ao-R1-aux' },
      network: null,
      limits: { cpus: 1, memory: '1g', pids: 100 },
      proxyUrl: null
    });
    expect(args.join(' ')).toContain('--network none');
    expect(args.join(' ')).toContain('target=/workspace,readonly');
    expect(args.join(' ')).toContain('type=volume,source=ao-R1-aux,target=/aux');
    expect(args.join(' ')).not.toContain('type=bind');
    expect(args.join(' ')).not.toContain('HTTPS_PROXY');
  });

  it('rejects invalid env names and container names', () => {
    expect(() =>
      buildDockerRunArgs({ containerName: 'bad name', image: 'img', step: { name: 'x', argv: [], workspace: 'none', aux: 'none', workdir: '/w', env: {}, network: 'none', timeoutMs: 1 }, volumes: { workspace: 'a', aux: 'b' }, network: null, limits: { cpus: 1, memory: '1g', pids: 1 }, proxyUrl: null })
    ).toThrow();
    expect(() =>
      buildDockerRunArgs({ containerName: 'ok', image: 'img', step: { name: 'x', argv: [], workspace: 'none', aux: 'none', workdir: '/w', env: { 'BAD-NAME': '1' }, network: 'none', timeoutMs: 1 }, volumes: { workspace: 'a', aux: 'b' }, network: null, limits: { cpus: 1, memory: '1g', pids: 1 }, proxyUrl: null })
    ).toThrow();
  });
});

describe('Requirements Agent model call (regressions from LIVE-01)', () => {
  it('strips $schema/$id before passing the contract to claude --json-schema, keeping constraints', async () => {
    const { toClaudeJsonSchema } = await import('../../src/agents/requirements.js');
    const { loadJsonSchema } = await import('@agent-orchestrator/contracts');
    const out = toClaudeJsonSchema(loadJsonSchema('interview'));
    expect(out).not.toHaveProperty('$schema');
    expect(out).toHaveProperty('required');
    expect((out as { properties: { questions: { maxItems: number } } }).properties.questions.maxItems).toBe(3);
    expect(out.additionalProperties).toBe(false);
  });

  it('cleans up the per-call sandbox resources even when the CLI fails', async () => {
    const { ClaudeInterviewModel } = await import('../../src/agents/requirements.js');
    const sandbox = new FakeSandbox(() => ({ exitCode: 1, stderr: 'Error: --json-schema is not a valid JSON Schema' }));
    const model = new ClaudeInterviewModel(sandbox, async () => ({ env: {}, secrets: [] }));
    const r = await model.interview({ request: 'x', facts: [], digestText: '', askedQuestions: [], answers: [], round: 1, remainingQuestions: 15, prohibitedOperations: [] }, new AbortController().signal);
    expect(r.ok).toBe(false);
    expect(sandbox.cleaned).toHaveLength(1);
    const schemaArg = sandbox.steps[0]!.argv[sandbox.steps[0]!.argv.indexOf('--json-schema') + 1]!;
    expect(JSON.parse(schemaArg)).not.toHaveProperty('$schema');
  });
});

describe('reviewer sandbox: user namespaces for bubblewrap (regression from LIVE-01, D-22)', () => {
  it('only the reviewer step relaxes seccomp; caps stay dropped and the workspace stays read-only', async () => {
    const sandbox = new FakeSandbox();
    const reviewer = new CodexReviewer(sandbox, async () => ({ authJsonPath: null, env: {}, secrets: [] }));
    await reviewer.review(reviewerInput());
    const step = sandbox.steps[0]!;
    expect(step.allowUserNamespaces).toBe(true);
    expect(step.workspace).toBe('ro');
    // プロファイル無しでは fail-closed
    expect(() => buildDockerRunArgs({ containerName: 'ao-R1-reviewer', image: 'img', step, volumes: { workspace: 'ws', aux: 'aux' }, network: 'net', limits: { cpus: 1, memory: '1g', pids: 10 }, proxyUrl: null })).toThrow(/seccomp/);
    const args = buildDockerRunArgs({ containerName: 'ao-R1-reviewer', image: 'img', step, volumes: { workspace: 'ws', aux: 'aux' }, network: 'net', limits: { cpus: 1, memory: '1g', pids: 10 }, proxyUrl: 'http://egress-proxy:3128', seccompProfilePath: 'C:/app-data/sandbox/seccomp-reviewer.json' });
    const joined = args.join(' ');
    expect(joined).toContain('--security-opt seccomp=C:/app-data/sandbox/seccomp-reviewer.json');
    expect(joined).not.toContain('unconfined');
    expect(joined).toContain('--cap-drop ALL');
    expect(joined).toContain('--security-opt no-new-privileges');
    expect(joined).toContain('target=/workspace,readonly');
    // builder step does not get it
    const builderSandbox = new FakeSandbox(() => ({ stdout: '{"type":"result","is_error":false}' }));
    await new ClaudeBuilder(builderSandbox, async () => ({ env: {}, secrets: [] })).implement(builderInput());
    expect(builderSandbox.steps[0]!.allowUserNamespaces).toBeUndefined();
  });
});
