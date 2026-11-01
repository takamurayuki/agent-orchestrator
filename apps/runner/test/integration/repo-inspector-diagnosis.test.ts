import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { loadConfig } from '../../src/config.js';
import { RepoInspector } from '../../src/requirements/repo-inspector.js';
import { WorkspaceManager } from '../../src/workspace.js';

/** 事前診断（D-38）の統合テスト: 実際の Git リポジトリに対して読み取り専用で診断し、ヒアリング前の判定と facts に載ることを確認する。 */
let root: string;
const git = (cwd: string, ...args: string[]) => execFileSync('git', args, { cwd, encoding: 'utf8' }).trim();

function makeRepo(name: string, files: Record<string, string>): string {
  const dir = join(root, name);
  mkdirSync(dir, { recursive: true });
  for (const [rel, content] of Object.entries(files)) {
    mkdirSync(join(dir, rel, '..'), { recursive: true });
    writeFileSync(join(dir, rel), content);
  }
  git(dir, 'init', '-q', '-b', 'main');
  git(dir, 'config', 'user.email', 't@example.com');
  git(dir, 'config', 'user.name', 'T');
  git(dir, 'add', '-A');
  git(dir, 'commit', '-q', '-m', 'init');
  return dir;
}

const inspector = () => new RepoInspector(loadConfig({}), new WorkspaceManager({ worktreesDir: join(root, 'wt') }));
const base = { 'package.json': JSON.stringify({ name: 'demo', scripts: { typecheck: 'tsc', lint: 'eslint .', 'test:run': 'vitest run' }, dependencies: {} }), 'pnpm-lock.yaml': "lockfileVersion: '9.0'\n" };

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'ao-diag-'));
});
afterEach(() => rmSync(root, { recursive: true, force: true }));

describe('RepoInspector pre-diagnosis (D-38)', () => {
  it('a clean pnpm repo with an explicit minimumReleaseAge is ready and stays ok', async () => {
    const r = await inspector().inspect(makeRepo('ready', { ...base, 'pnpm-workspace.yaml': 'minimumReleaseAge: 1440\n' }));
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.info.status).toBe('ok');
    expect(r.info.diagnosis.verdict).toBe('ready');
    expect(r.info.problems).toEqual([]);
  });

  it('without minimumReleaseAge the verdict is needs_attention, the item is unverified (not pass), and it becomes an unknown fact for the interview', async () => {
    const r = await inspector().inspect(makeRepo('policy', base));
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.info.status).toBe('ok'); // 要確認は開始を止めない
    expect(r.info.diagnosis.verdict).toBe('needs_attention');
    const c = r.info.diagnosis.checks.find((x) => x.id === 'supply_chain');
    expect(c?.status).toBe('unverified');
    expect(r.facts.some((f) => f.key === 'env.supply_chain' && f.confidence === 'unknown' && f.value.includes('未確認'))).toBe(true);
  });

  it('a private registry outside the allowlist is blocking and shows up as a problem with a fix (no auto-widening)', async () => {
    const r = await inspector().inspect(makeRepo('private', { ...base, '.npmrc': 'registry=https://npm.example.corp/\n', 'pnpm-workspace.yaml': 'minimumReleaseAge: 0\n' }));
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.info.diagnosis.verdict).toBe('blocked');
    const prob = r.info.problems.find((p) => p.code === 'DIAG_NETWORK');
    expect(prob?.message).toContain('npm.example.corp');
    expect(prob?.fix).toContain('自動で広げません');
  });

  it('prisma in a verification script is a warning (needs_attention), not a blocker, and is not auto-fixed', async () => {
    const r = await inspector().inspect(makeRepo('prisma', { 'package.json': JSON.stringify({ scripts: { typecheck: 'prisma generate && tsc', lint: 'eslint .', 'test:run': 'vitest run' }, devDependencies: { prisma: '5.20.0' } }), 'pnpm-lock.yaml': "lockfileVersion: '9.0'\n", 'pnpm-workspace.yaml': 'minimumReleaseAge: 0\n' }));
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.info.diagnosis.verdict).toBe('needs_attention');
    expect(r.info.diagnosis.checks.find((x) => x.id === 'network')?.detail).toContain('binaries.prisma.sh');
    expect(r.info.problems).toEqual([]);
  });
});
