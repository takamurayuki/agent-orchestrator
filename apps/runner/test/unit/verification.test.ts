import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { checkProfileReadiness, commandsFor, detectProfileFromFiles, expectedCommandNames, runScriptArgv } from '../../src/verification/profiles.js';
import { INSTALL_TIMEOUT_FLOOR_MS, SandboxVerifier } from '../../src/verification/runner.js';
import { FakeSandbox } from '../helpers/fake-sandbox.js';

let dir: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'ao-verify-'));
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

describe('verification profile readiness (SPEC §7)', () => {
  it('reports missing scripts and lockfile', () => {
    writeFileSync(join(dir, 'package.json'), JSON.stringify({ scripts: { test: 'vitest' } }));
    const r = checkProfileReadiness(dir, 'node-pnpm');
    expect(r.ready).toBe(false);
    expect(r.missingScripts).toEqual(['typecheck', 'lint', 'test:run']);
  });

  it('is ready when typecheck/lint/test:run and pnpm-lock.yaml exist', () => {
    writeFileSync(join(dir, 'package.json'), JSON.stringify({ scripts: { typecheck: 'tsc', lint: 'eslint .', 'test:run': 'vitest run' } }));
    writeFileSync(join(dir, 'pnpm-lock.yaml'), 'lockfileVersion: 9\n');
    expect(checkProfileReadiness(dir, 'node-pnpm').ready).toBe(true);
  });

  it('requires pnpm-lock.yaml', () => {
    writeFileSync(join(dir, 'package.json'), JSON.stringify({ scripts: { typecheck: 'tsc', lint: 'eslint .', 'test:run': 'vitest run' } }));
    const r = checkProfileReadiness(dir, 'node-pnpm');
    expect(r.ready).toBe(false);
    expect(r.detail).toContain('pnpm-lock.yaml');
  });

  it('only exposes predefined commands (no shell from YAML) [SEC-07]', () => {
    expect(expectedCommandNames('node-pnpm')).toEqual(['install', 'typecheck', 'lint', 'test:run']);
    expect(expectedCommandNames('node-npm')).toEqual(['install', 'typecheck', 'lint', 'test:run']);
    expect(expectedCommandNames('node-yarn')).toEqual(['install', 'typecheck', 'lint', 'test:run']);
  });

  it('v0.3 (D-44): npm and yarn 1 projects are supported with lockfile-pinned, script-free installs', () => {
    expect(detectProfileFromFiles(['package.json', 'package-lock.json'])).toBe('node-npm');
    expect(detectProfileFromFiles(['package.json', 'yarn.lock'])).toBe('node-yarn');
    expect(detectProfileFromFiles(['package.json', 'pnpm-lock.yaml', 'yarn.lock'])).toBe('node-pnpm');
    expect(detectProfileFromFiles(['package.json', 'bun.lock'])).toBeNull();
    expect(commandsFor('node-npm', dir)[0]!.argv).toEqual(['npm', 'ci', '--ignore-scripts', '--no-audit', '--no-fund']);
    expect(commandsFor('node-yarn', dir)[0]!.argv).toEqual(['yarn', 'install', '--frozen-lockfile', '--ignore-scripts', '--non-interactive']);
    expect(runScriptArgv('node-npm', 'typecheck')).toEqual(['npm', 'run', 'typecheck']);
    expect(runScriptArgv('node-yarn', 'test:run')).toEqual(['yarn', 'run', 'test:run']);
    const scripts = { typecheck: 'tsc', lint: 'eslint .', 'test:run': 'vitest run' };
    writeFileSync(join(dir, 'package.json'), JSON.stringify({ scripts }));
    writeFileSync(join(dir, 'package-lock.json'), JSON.stringify({ lockfileVersion: 3 }));
    expect(checkProfileReadiness(dir, 'node-npm').ready).toBe(true);
    expect(checkProfileReadiness(dir, 'node-yarn').ready).toBe(false);
    writeFileSync(join(dir, 'yarn.lock'), '# yarn lockfile v1\n');
    expect(checkProfileReadiness(dir, 'node-yarn').ready).toBe(true);
    writeFileSync(join(dir, 'yarn.lock'), '__metadata:\n  version: 8\n');
    const berry = checkProfileReadiness(dir, 'node-yarn');
    expect(berry.ready).toBe(false);
    expect(berry.detail).toContain('Berry');
  });
});

describe('SandboxVerifier', () => {
  const input = (sandbox: FakeSandbox) => ({
    runId: 'R1',
    round: 1,
    workspace: { path: '/ws', baseSha: 'a'.repeat(40) },
    profile: 'node-pnpm' as const,
    timeoutMs: 1000,
    signal: new AbortController().signal,
    onLog: () => undefined,
    sandbox
  });

  it('gives the install step a 10-minute floor (network-bound dependency fetch) while other commands keep the configured timeout [v0.2.2]', async () => {
    const sandbox = new FakeSandbox();
    await new SandboxVerifier(sandbox).verify(input(sandbox));
    const byName = Object.fromEntries(sandbox.steps.map((s) => [s.name.replace(/-r1$/, ''), s.timeoutMs]));
    expect(byName['verify-install']).toBe(INSTALL_TIMEOUT_FLOOR_MS);
    expect(byName['verify-typecheck']).toBe(1000);
    expect(byName['verify-test-run']).toBe(1000);
    // 設定が下限より長ければそのまま
    const long = new FakeSandbox();
    await new SandboxVerifier(long).verify({ ...input(long), timeoutMs: INSTALL_TIMEOUT_FLOOR_MS + 5000 });
    expect(long.steps.find((s) => s.name.startsWith('verify-install'))!.timeoutMs).toBe(INSTALL_TIMEOUT_FLOOR_MS + 5000);
  });

  it('runs all commands in the sandbox sequentially and passes when all exit 0', async () => {
    const sandbox = new FakeSandbox();
    const result = await new SandboxVerifier(sandbox).verify(input(sandbox));
    expect(result.passed).toBe(true);
    expect(result.commands.map((c) => c.name)).toEqual(['install', 'typecheck', 'lint', 'test:run']);
    expect(sandbox.steps.map((s) => s.argv[0])).toEqual(['pnpm', 'pnpm', 'pnpm', 'pnpm']);
    // install だけ egress、他はネットワークなし
    expect(sandbox.steps.map((s) => s.network)).toEqual(['egress', 'none', 'none', 'none']);
    // ワークスペースは /workspace に rw mount
    expect(sandbox.steps[0]?.workspace).toBe('rw');
    // package.json#packageManager による pnpm のバージョン切替を抑止する（D-24: サンドボックス内でダウンロードできず install が失敗する）
    expect(sandbox.steps[0]?.env.pnpm_config_manage_package_manager_versions).toBe('false');
    expect(sandbox.steps[0]?.env.COREPACK_ENABLE_STRICT).toBe('0');
  });

  it('D-26: operator-provided sandbox env (e.g. pnpm minimum release age) is passed to verification steps, never overriding fixed keys', async () => {
    const sandbox = new FakeSandbox();
    await new SandboxVerifier(sandbox, { pnpm_config_minimum_release_age: '0', CI: 'hacked' }).verify(input(sandbox));
    expect(sandbox.steps[0]?.env.pnpm_config_minimum_release_age).toBe('0');
    expect(sandbox.steps[0]?.env.CI).toBe('1');
  });

  it('stops at the first failure and records remaining as missing', async () => {
    const sandbox = new FakeSandbox((step) => (step.argv.includes('typecheck') ? { exitCode: 2, stderr: 'TS2322' } : {}));
    const result = await new SandboxVerifier(sandbox).verify(input(sandbox));
    expect(result.passed).toBe(false);
    expect(result.commands.map((c) => c.exitCode)).toEqual([0, 2]);
    expect(result.missing).toEqual(['lint', 'test:run']);
    expect(result.commands[1]?.stderrExcerpt).toContain('TS2322');
  });

  it('EX-08: records timeouts as timedOut with null exit code', async () => {
    const sandbox = new FakeSandbox((step) => (step.argv.includes('test:run') ? { timedOut: true, exitCode: 137 } : {}));
    const result = await new SandboxVerifier(sandbox).verify(input(sandbox));
    expect(result.passed).toBe(false);
    expect(result.commands[3]).toMatchObject({ name: 'test:run', timedOut: true, exitCode: null });
  });
});
