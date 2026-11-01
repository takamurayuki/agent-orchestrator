import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { EnvironmentCheck, EnvironmentReport } from '@agent-orchestrator/contracts';
import { loadConfig } from '../../src/config.js';
import type { EnvironmentAdapter } from '../../src/environment.js';
import { createPreflight } from '../../src/preflight.js';
import { WorkspaceManager } from '../../src/workspace.js';
import { sampleTask } from '../helpers/mock-deps.js';

let root: string;
let repo: string;
const git = (cwd: string, ...args: string[]) => execFileSync('git', args, { cwd, encoding: 'utf8' }).trim();

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'ao-pre-'));
  repo = join(root, 'repo');
  mkdirSync(repo);
  writeFileSync(join(repo, 'package.json'), JSON.stringify({ scripts: { typecheck: 'tsc', lint: 'eslint .', 'test:run': 'vitest run' } }));
  writeFileSync(join(repo, 'pnpm-lock.yaml'), 'lockfileVersion: 9\n');
  git(repo, 'init', '-q', '-b', 'main');
  git(repo, 'config', 'user.email', 't@example.com');
  git(repo, 'config', 'user.name', 'T');
  git(repo, 'add', '-A');
  git(repo, 'commit', '-q', '-m', 'init');
});
afterEach(() => rmSync(root, { recursive: true, force: true }));

const envAdapter = (checks: EnvironmentCheck[], probe: EnvironmentCheck[] = []): EnvironmentAdapter => ({
  mode: 'docker-desktop-windows',
  toMountSource: (p) => p,
  check: async (): Promise<EnvironmentReport> => ({ platform: 'test', executionMode: 'docker-desktop-windows', canRun: checks.every((c) => c.status === 'ok'), checks, checkedAt: 't' }),
  probeIsolation: async () => probe
});
const ok = (id: string): EnvironmentCheck => ({ id, label: id, status: 'ok', detail: 'ok', fix: null });
const fail = (id: string, detail = 'bad'): EnvironmentCheck => ({ id, label: id, status: 'fail', detail, fix: 'fix it' });
const env = { ANTHROPIC_API_KEY: 'sk-ant-test', OPENAI_API_KEY: 'sk-test' };

describe('preflight (SPEC §9)', () => {
  const run = async (checks: EnvironmentCheck[], probe: EnvironmentCheck[] = [], task = { ...sampleTask, repository: '' }) => {
    const config = loadConfig({ AGENT_ORCHESTRATOR_APP_DATA: join(root, 'app-data') });
    const preflight = createPreflight({ config, environment: envAdapter(checks, probe), workspace: new WorkspaceManager({ worktreesDir: join(root, 'wt') }), env });
    return preflight({ task: { ...task, repository: task.repository || repo }, signal: new AbortController().signal });
  };

  it('passes when environment, repo, profile, credentials, and isolation probe are all ok', async () => {
    const r = await run([ok('docker.cli'), ok('docker.daemon')], [ok('docker.egress.direct'), ok('docker.egress.deny'), ok('docker.egress.allow'), ok('docker.readonly'), ok('docker.nonroot')]);
    expect(r.ok).toBe(true);
    expect(r.checks.find((c) => c.id === 'repo.clean')?.status).toBe('ok');
    expect(r.checks.find((c) => c.id === 'repo.baseRef')?.detail).toMatch(/main → [0-9a-f]{40}/);
    expect(r.checks.find((c) => c.id === 'verification.profile')?.status).toBe('ok');
  });

  it('SEC-01: Docker unavailable → not ok, isolation probe not attempted', async () => {
    const r = await run([fail('docker.cli', 'docker not found')]);
    expect(r.ok).toBe(false);
    expect(r.checks.find((c) => c.id === 'docker.isolation')?.status).toBe('fail');
    expect(r.checks.find((c) => c.id === 'docker.cli')?.fix).toBe('fix it');
  });

  it('SEC-02: egress cannot be restricted → not ok', async () => {
    const r = await run([ok('docker.cli')], [fail('docker.egress.direct', 'direct=connected'), ok('docker.egress.deny'), ok('docker.egress.allow'), ok('docker.readonly'), ok('docker.nonroot')]);
    expect(r.ok).toBe(false);
    expect(r.checks.find((c) => c.id === 'docker.egress.direct')?.status).toBe('fail');
  });

  it('fails on dirty working tree, missing baseRef, and missing verification scripts', async () => {
    writeFileSync(join(repo, 'dirty.txt'), 'x');
    const r1 = await run([ok('docker.cli')], [ok('docker.egress.direct')]);
    expect(r1.checks.find((c) => c.id === 'repo.clean')?.status).toBe('fail');
    rmSync(join(repo, 'dirty.txt'));
    const r2 = await run([ok('docker.cli')], [ok('docker.egress.direct')], { ...sampleTask, repository: repo, baseRef: 'does-not-exist' });
    expect(r2.checks.find((c) => c.id === 'repo.baseRef')?.status).toBe('fail');
    writeFileSync(join(repo, 'package.json'), JSON.stringify({ scripts: {} }));
    git(repo, 'commit', '-q', '-am', 'drop scripts');
    const r3 = await run([ok('docker.cli')], [ok('docker.egress.direct')]);
    expect(r3.checks.find((c) => c.id === 'verification.profile')?.status).toBe('fail');
    expect(r3.ok).toBe(false);
  });

  it('fails when credentials cannot be injected', async () => {
    const config = loadConfig({ AGENT_ORCHESTRATOR_APP_DATA: join(root, 'app-data') });
    const preflight = createPreflight({ config, environment: envAdapter([ok('docker.cli')], [ok('docker.egress.direct')]), workspace: new WorkspaceManager({ worktreesDir: join(root, 'wt') }), env: { CLAUDE_CONFIG_DIR: join(root, 'nocreds'), CODEX_HOME: join(root, 'nocreds') } });
    const r = await preflight({ task: { ...sampleTask, repository: repo }, signal: new AbortController().signal });
    expect(r.checks.find((c) => c.id === 'auth.claude.load')?.status).toBe('fail');
    expect(r.checks.find((c) => c.id === 'auth.codex.load')?.status).toBe('fail');
    expect(r.ok).toBe(false);
  });
});
