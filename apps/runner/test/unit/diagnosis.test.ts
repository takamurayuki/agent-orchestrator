import { describe, expect, it } from 'vitest';
import { PNPM_DEFAULT_MINIMUM_RELEASE_AGE_MINUTES, diagnoseProject, sandboxVersions, satisfiesMajor } from '../../src/requirements/diagnosis.js';

const ALLOW = ['api.anthropic.com', 'api.openai.com', 'chatgpt.com', 'auth.openai.com', 'registry.npmjs.org'];

function project(files: Record<string, string>, over: Partial<Parameters<typeof diagnoseProject>[0]> = {}) {
  const names = Object.keys(files);
  return diagnoseProject({
    files: names,
    readText: (p) => files[p] ?? null,
    packageManager: names.includes('pnpm-lock.yaml') ? 'pnpm' : names.includes('package-lock.json') ? 'npm' : null,
    verificationReady: true,
    verificationDetail: '実行可能',
    isClean: true,
    egressAllowlist: ALLOW,
    workspacePackages: names.filter((n) => /^(apps|packages)\/[^/]+\/package\.json$/.test(n)),
    ...over
  });
}
const byId = (d: ReturnType<typeof diagnoseProject>, id: string) => d.checks.find((c) => c.id === id)!;

describe('project pre-diagnosis (D-38)', () => {
  it('reads the sandbox Node / pnpm versions from the embedded manifest and Dockerfile', () => {
    const v = sandboxVersions();
    expect(v.node).toMatch(/^22\./);
    expect(v.pnpm).toMatch(/^12\./);
  });

  it('semver range check handles common forms and reports undecidable ranges as null', () => {
    expect(satisfiesMajor('>=20', '22.23.4')).toBe(true);
    expect(satisfiesMajor('^18', '22.23.4')).toBe(false);
    expect(satisfiesMajor('18.x || >=20', '22.23.4')).toBe(true);
    expect(satisfiesMajor('~22.23', '22.23.4')).toBe(true);
    expect(satisfiesMajor('<22', '22.23.4')).toBe(false);
    expect(satisfiesMajor('lts/*', '22.23.4')).toBeNull();
  });

  it('a clean pnpm project with explicit minimumReleaseAge is ready', () => {
    const d = project({
      'package.json': JSON.stringify({ name: 'x', packageManager: 'pnpm@12.9.1', engines: { node: '>=22' }, scripts: { typecheck: 'tsc', lint: 'eslint .', 'test:run': 'vitest run' } }),
      'pnpm-lock.yaml': "lockfileVersion: '9.0'\n",
      'pnpm-workspace.yaml': 'minimumReleaseAge: 1440\n'
    });
    expect(d.verdict).toBe('ready');
    expect(d.checks.map((c) => c.status)).not.toContain('fail');
    expect(byId(d, 'supply_chain').status).toBe('ok');
    expect(byId(d, 'network').status).toBe('ok');
  });

  it('without minimumReleaseAge the policy is reported as unverified (pnpm 12 default 24h), never as pass', () => {
    const d = project({ 'package.json': JSON.stringify({ scripts: {} }), 'pnpm-lock.yaml': "lockfileVersion: '9.0'\n" });
    const c = byId(d, 'supply_chain');
    expect(c.status).toBe('unverified');
    expect(c.detail).toContain(`${PNPM_DEFAULT_MINIMUM_RELEASE_AGE_MINUTES / 60} 時間`);
    expect(c.detail).toContain('未確認');
    expect(c.fix).toContain('minimumReleaseAge');
    expect(d.verdict).toBe('needs_attention');
  });

  it('flags non-pnpm lockfiles, old lockfile versions and mismatched engines / packageManager', () => {
    const npm = project({ 'package.json': JSON.stringify({ packageManager: 'npm@10.0.0' }), 'package-lock.json': '{}' });
    expect(byId(npm, 'lockfile').status).toBe('fail');
    expect(byId(npm, 'pnpm').status).toBe('fail');
    expect(npm.verdict).toBe('blocked');
    const old = project({ 'package.json': JSON.stringify({ engines: { node: '^18' }, packageManager: 'pnpm@8.15.0' }), 'pnpm-lock.yaml': "lockfileVersion: '6.0'\n", 'pnpm-workspace.yaml': 'minimumReleaseAge: 0\n' });
    expect(byId(old, 'lockfile').status).toBe('warn');
    expect(byId(old, 'node').status).toBe('warn');
    expect(byId(old, 'pnpm').status).toBe('warn');
    expect(old.verdict).toBe('needs_attention');
  });

  it('detects registries and tarball hosts outside the egress allowlist as blocking, and binary downloads as warnings', () => {
    const priv = project({ 'package.json': JSON.stringify({}), 'pnpm-lock.yaml': "lockfileVersion: '9.0'\n", '.npmrc': 'registry=https://npm.example.corp/\n', 'pnpm-workspace.yaml': 'minimumReleaseAge: 0\n' });
    expect(byId(priv, 'network').status).toBe('fail');
    expect(byId(priv, 'network').detail).toContain('npm.example.corp');
    expect(byId(priv, 'network').fix).toContain('自動で広げません');
    expect(priv.verdict).toBe('blocked');
    const tar = project({ 'package.json': JSON.stringify({}), 'pnpm-lock.yaml': "lockfileVersion: '9.0'\npackages:\n  foo@1.0.0:\n    resolution: {tarball: https://github.com/x/foo/archive/abc.tgz}\n", 'pnpm-workspace.yaml': 'minimumReleaseAge: 0\n' });
    expect(byId(tar, 'network').status).toBe('fail');
    expect(byId(tar, 'network').detail).toContain('github.com');
    const prisma = project({
      'package.json': JSON.stringify({ scripts: { typecheck: 'prisma generate && tsc' }, dependencies: { '@prisma/client': '5.20.0' }, devDependencies: { prisma: '5.20.0' } }),
      'pnpm-lock.yaml': "lockfileVersion: '9.0'\n",
      'pnpm-workspace.yaml': 'minimumReleaseAge: 0\n'
    });
    expect(byId(prisma, 'network').status).toBe('warn');
    expect(byId(prisma, 'network').detail).toContain('binaries.prisma.sh');
    expect(prisma.verdict).toBe('needs_attention');
  });

  it('lifecycle scripts (not run under --ignore-scripts) are unverified, including workspace packages', () => {
    const d = project({
      'package.json': JSON.stringify({ scripts: {} }),
      'apps/server/package.json': JSON.stringify({ scripts: { postinstall: 'prisma generate' } }),
      'pnpm-lock.yaml': "lockfileVersion: '9.0'\n",
      'pnpm-workspace.yaml': 'minimumReleaseAge: 0\n'
    });
    expect(byId(d, 'install_scripts').status).toBe('unverified');
    expect(byId(d, 'install_scripts').detail).toContain('apps/server/package.json#postinstall');
  });

  it('verification readiness and a dirty worktree are blocking, and nothing is auto-fixed', () => {
    const d = project({ 'package.json': JSON.stringify({}), 'pnpm-lock.yaml': "lockfileVersion: '9.0'\n", 'pnpm-workspace.yaml': 'minimumReleaseAge: 0\n' }, { verificationReady: false, verificationDetail: 'scripts 不足 lint', isClean: false });
    expect(byId(d, 'verification').status).toBe('fail');
    expect(byId(d, 'worktree').status).toBe('fail');
    expect(d.verdict).toBe('blocked');
    for (const c of d.checks) if (c.fix) expect(c.fix).not.toMatch(/自動で(修正|追加|緩和)/);
  });
});
