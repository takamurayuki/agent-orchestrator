import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { WorkspaceManager, splitPatchByFile } from '../../src/workspace.js';

/** 実 git を使う統合テスト。元リポジトリが不変であること（LIVE-02 のローカル版）を確認する。 */
let root: string;
let repo: string;
let wm: WorkspaceManager;

const git = (cwd: string, ...args: string[]) => execFileSync('git', args, { cwd, encoding: 'utf8', env: { ...process.env, GIT_CONFIG_NOSYSTEM: '1' } }).trim();

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'ao-ws-'));
  repo = join(root, 'repo');
  mkdirSync(repo);
  git(repo, 'init', '-q', '-b', 'main');
  git(repo, 'config', 'user.email', 't@example.com');
  git(repo, 'config', 'user.name', 'T');
  writeFileSync(join(repo, 'README.md'), '# demo\n');
  mkdirSync(join(repo, 'src'));
  writeFileSync(join(repo, 'src', 'a.ts'), 'export const a = 1;\n');
  writeFileSync(join(repo, '.gitignore'), 'node_modules/\n');
  git(repo, 'add', '-A');
  git(repo, 'commit', '-q', '-m', 'init');
  wm = new WorkspaceManager({ worktreesDir: join(root, 'worktrees') });
});
afterEach(() => rmSync(root, { recursive: true, force: true }));

describe('WorkspaceManager (git)', () => {
  it('resolves baseRef to a SHA and rejects option-like refs', async () => {
    const sha = await wm.resolveBaseSha(repo, 'main');
    expect(sha).toMatch(/^[0-9a-f]{40}$/);
    expect(sha).toBe(git(repo, 'rev-parse', 'HEAD'));
    await expect(wm.resolveBaseSha(repo, '--output=/tmp/x')).rejects.toThrow();
    await expect(wm.resolveBaseSha(repo, 'no-such-branch')).rejects.toThrow();
  });

  it('creates an isolated detached workspace without touching the original repo [LIVE-02 local]', async () => {
    const headBefore = git(repo, 'rev-parse', 'HEAD');
    const statusBefore = git(repo, 'status', '--porcelain');
    const sha = await wm.resolveBaseSha(repo, 'main');
    const ws = await wm.create({ runId: 'RUN1', repository: repo, baseSha: sha });
    expect(existsSync(join(ws.path, 'src', 'a.ts'))).toBe(true);
    expect(git(ws.path, 'rev-parse', 'HEAD')).toBe(sha);
    expect(git(ws.path, 'remote')).toBe('');
    // 元リポジトリは不変
    expect(git(repo, 'rev-parse', 'HEAD')).toBe(headBefore);
    expect(git(repo, 'status', '--porcelain')).toBe(statusBefore);
    // ワークスペース内でブランチを作っても元リポジトリに影響しない
    git(ws.path, 'branch', '-f', 'main', 'HEAD');
    expect(git(repo, 'rev-parse', 'main')).toBe(headBefore);
    await expect(wm.create({ runId: 'RUN1', repository: repo, baseSha: sha })).rejects.toThrow(/既に存在/);
  });

  it('captures diff including untracked files and ignores node_modules [EX-11]', async () => {
    const sha = await wm.resolveBaseSha(repo, 'main');
    const ws = await wm.create({ runId: 'RUN2', repository: repo, baseSha: sha });
    const empty = await wm.captureDiff(ws);
    expect(empty.summary.isEmpty).toBe(true);
    const hashBefore = await wm.hash(ws);

    writeFileSync(join(ws.path, 'src', 'a.ts'), 'export const a = 2;\n');
    writeFileSync(join(ws.path, 'src', 'new.ts'), 'export const n = 1;\n');
    mkdirSync(join(ws.path, 'node_modules', 'pkg'), { recursive: true });
    writeFileSync(join(ws.path, 'node_modules', 'pkg', 'index.js'), 'module.exports = 1;');
    rmSync(join(ws.path, 'README.md'));

    const diff = await wm.captureDiff(ws);
    const byPath = Object.fromEntries(diff.summary.files.map((f) => [f.path, f]));
    expect(byPath['src/a.ts']?.status).toBe('modified');
    expect(byPath['src/new.ts']?.status).toBe('untracked');
    expect(byPath['README.md']?.status).toBe('deleted');
    expect(Object.keys(byPath).some((p) => p.startsWith('node_modules'))).toBe(false);
    expect(diff.patch).toContain('+export const n = 1;');
    expect(diff.patches['src/new.ts']).toContain('new file');
    // 実 index は汚れていない（status は未追跡のまま）
    expect(git(ws.path, 'status', '--porcelain')).toContain('?? src/new.ts');

    const hashAfter = await wm.hash(ws);
    expect(hashAfter).not.toBe(hashBefore);
    expect(await wm.hash(ws)).toBe(hashAfter);
  });

  it('splitPatchByFile splits a multi-file patch', () => {
    const patch = 'diff --git a/x.ts b/x.ts\n--- a/x.ts\n+++ b/x.ts\n@@ -1 +1 @@\n-a\n+b\ndiff --git a/y.ts b/y.ts\nnew file mode 100644\n--- /dev/null\n+++ b/y.ts\n@@ -0,0 +1 @@\n+c\n';
    const parts = splitPatchByFile(patch);
    expect(Object.keys(parts)).toEqual(['x.ts', 'y.ts']);
    expect(parts['y.ts']).toContain('new file');
  });
});

describe('WorkspaceManager honours the user git config for repo status (D-25, dogfood regression)', () => {
  it('a clean checkout under system core.autocrlf=true is reported clean', async () => {
    const sysConfig = join(root, 'system-gitconfig');
    writeFileSync(sysConfig, '[core]\n\tautocrlf = true\n');
    const prev = process.env.GIT_CONFIG_SYSTEM;
    process.env.GIT_CONFIG_SYSTEM = sysConfig;
    try {
      // autocrlf=true のもとで checkout し直す（作業ツリーは CRLF、index は LF）
      execFileSync('git', ['rm', '-rq', '--cached', '.'], { cwd: repo, env: { ...process.env } });
      execFileSync('git', ['reset', '-q', '--hard'], { cwd: repo, env: { ...process.env } });
      expect(execFileSync('git', ['status', '--porcelain'], { cwd: repo, encoding: 'utf8', env: { ...process.env } }).trim()).toBe('');
      expect(await wm.isClean(repo)).toBe(true);
      expect(await wm.currentBranch(repo)).toBe('main');
    } finally {
      if (prev === undefined) delete process.env.GIT_CONFIG_SYSTEM;
      else process.env.GIT_CONFIG_SYSTEM = prev;
    }
  });
});

describe('WorkspaceManager git excludes (regression from LIVE GUI run)', () => {
  it('ignores container-side stores so the reviewer does not see them as untracked', async () => {
    const sha = await wm.resolveBaseSha(repo, 'main');
    const ws = await wm.create({ runId: 'RUN3', repository: repo, baseSha: sha });
    mkdirSync(join(ws.path, '.pnpm-store', 'v11'), { recursive: true });
    writeFileSync(join(ws.path, '.pnpm-store', 'v11', 'x'), 'x');
    expect(git(ws.path, 'status', '--porcelain')).toBe('');
    const diff = await wm.captureDiff(ws);
    expect(diff.summary.isEmpty).toBe(true);
  });
});
