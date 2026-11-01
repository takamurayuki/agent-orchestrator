import { appendFileSync, existsSync, mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import type { DiffFile, DiffSummary } from '@agent-orchestrator/contracts';
import type { DiffCapture, WorkspaceHandle } from './engine.js';
import { truncateBytes } from './masking.js';
import { runProcess, type ProcessRunner } from './process-runner.js';

/**
 * 隔離ワークスペース（Git）。
 * 元リポジトリから `git clone --local --no-hardlinks` した独立リポジトリを baseSha で detached checkout し、remote を削除する。
 * - 元リポジトリの refs/HEAD/作業ツリーには一切触れない（git worktree は refs を共有するため Builder が元ブランチを動かせてしまう。docs/DECISIONS.md D-03）
 * - コンテナ内でも .git が完結しているので Builder/Reviewer の git コマンドが動く
 * 差分・ハッシュは一時 index を使い、未追跡ファイルも含めて baseSha と比較する（node_modules 等は除外）。
 */
export interface WorkspaceManagerOptions {
  worktreesDir: string;
  run?: ProcessRunner;
  maxDiffBytes?: number;
  /** 差分・ハッシュから除外するパス（git pathspec） */
  excludes?: string[];
}

const DEFAULT_EXCLUDES = ['node_modules', '.pnpm-store', 'dist', 'build', 'coverage', '.turbo', '.next', '.svelte-kit'];
const SHA_RE = /^[0-9a-f]{40}$/;

export class GitError extends Error {
  constructor(message: string, readonly stderr: string) {
    super(message);
    this.name = 'GitError';
  }
}

export class WorkspaceManager {
  private readonly run: ProcessRunner;
  private readonly maxDiffBytes: number;
  private readonly excludes: string[];

  constructor(private readonly options: WorkspaceManagerOptions) {
    this.run = options.run ?? runProcess;
    this.maxDiffBytes = options.maxDiffBytes ?? 4 * 1024 * 1024;
    this.excludes = options.excludes ?? DEFAULT_EXCLUDES;
  }

  /**
   * git 実行。
   * - ワークスペース操作（clone / diff / hash）はシステム設定を無視し（GIT_CONFIG_NOSYSTEM）、LF のまま扱う（Linux コンテナ向け）
   * - 利用者の元リポジトリの状態確認（status / branch / HEAD）は利用者の設定を尊重する（Git for Windows の core.autocrlf=true は
   *   システム設定にあり、無視すると CRLF の作業ツリーが全て「変更あり」に見えて preflight が誤って失敗する。D-25）
   */
  private async git(cwd: string, args: string[], env: Record<string, string> = {}, timeoutMs = 120_000, options: { userConfig?: boolean } = {}): Promise<string> {
    const base: Record<string, string> = options.userConfig ? { GIT_TERMINAL_PROMPT: '0' } : { GIT_TERMINAL_PROMPT: '0', GIT_CONFIG_NOSYSTEM: '1' };
    const result = await this.run({ command: 'git', args, cwd, env: { ...base, ...env }, inheritEnv: true, timeoutMs, maxOutputBytes: this.maxDiffBytes * 2 });
    if (result.spawnError) throw new GitError(`git を起動できない: ${result.spawnError}`, '');
    if (result.exitCode !== 0) throw new GitError(`git ${args.slice(0, 2).join(' ')} が失敗 (exit ${result.exitCode}${result.timedOut ? ', timeout' : ''}): ${result.stderr.trim().slice(0, 500)}`, result.stderr);
    return result.stdout;
  }

  async isGitRepository(path: string): Promise<{ root: string | null }> {
    try {
      const out = await this.run({ command: 'git', args: ['rev-parse', '--show-toplevel'], cwd: path, inheritEnv: true, timeoutMs: 15_000 });
      if (out.exitCode !== 0) return { root: null };
      return { root: resolve(out.stdout.trim()) };
    } catch {
      return { root: null };
    }
  }

  async currentBranch(repo: string): Promise<string | null> {
    const out = (await this.git(repo, ['rev-parse', '--abbrev-ref', 'HEAD'], {}, 120_000, { userConfig: true })).trim();
    return out === 'HEAD' ? null : out;
  }

  async headSha(repo: string): Promise<string> {
    return (await this.git(repo, ['rev-parse', 'HEAD'], {}, 120_000, { userConfig: true })).trim();
  }

  /** 利用者のリポジトリに未コミットの変更が無いか（利用者の git 設定で判定。D-25） */
  async isClean(repo: string): Promise<boolean> {
    return (await this.git(repo, ['status', '--porcelain'], {}, 120_000, { userConfig: true })).trim() === '';
  }

  async resolveBaseSha(repository: string, baseRef: string): Promise<string> {
    if (/^-/.test(baseRef)) throw new GitError(`不正な baseRef: ${baseRef}`, '');
    const sha = (await this.git(repository, ['rev-parse', '--verify', '--end-of-options', `${baseRef}^{commit}`])).trim();
    if (!SHA_RE.test(sha)) throw new GitError(`baseRef を SHA に解決できない: ${baseRef}`, '');
    return sha;
  }

  workspacePath(runId: string): string {
    if (!/^[A-Za-z0-9_-]+$/.test(runId)) throw new Error(`不正な runId: ${runId}`);
    return join(this.options.worktreesDir, runId);
  }

  async create(input: { runId: string; repository: string; baseSha: string }): Promise<WorkspaceHandle> {
    if (!SHA_RE.test(input.baseSha)) throw new GitError(`baseSha が SHA ではない: ${input.baseSha}`, '');
    const path = this.workspacePath(input.runId);
    if (existsSync(path)) throw new GitError(`ワークスペースが既に存在する: ${path}`, '');
    mkdirSync(this.options.worktreesDir, { recursive: true });
    await this.git(this.options.worktreesDir, ['clone', '--quiet', '--local', '--no-hardlinks', '--no-checkout', '--end-of-options', input.repository, path], {}, 600_000);
    await this.git(path, ['checkout', '--quiet', '--detach', input.baseSha]);
    // 誤って push できないように remote を消し、フックも無効化する
    await this.git(path, ['remote', 'remove', 'origin']).catch(() => undefined);
    await this.git(path, ['config', 'core.hooksPath', '/dev/null']);
    await this.git(path, ['config', 'user.name', 'agent-orchestrator']);
    await this.git(path, ['config', 'user.email', 'agent-orchestrator@localhost']);
    // コンテナ内に生成される依存・ストアを git からも見えなくする（Reviewer が untracked として報告しないように。LIVE GUI で実測）
    const excludeFile = join(path, '.git', 'info', 'exclude');
    mkdirSync(join(path, '.git', 'info'), { recursive: true });
    appendFileSync(excludeFile, `\n# agent-orchestrator\n${this.excludes.map((e) => `/${e}/`).join('\n')}\n`, 'utf8');
    return { path, baseSha: input.baseSha };
  }

  private excludePathspecs(): string[] {
    return ['--', '.', ...this.excludes.map((e) => `:(exclude,glob)**/${e}/**`), ...this.excludes.map((e) => `:(exclude)${e}`)];
  }

  /** 一時 index に全ファイル（未追跡含む）を add し、その index を使って fn を実行する。実 index は変更しない。 */
  private async withTempIndex<T>(workspace: WorkspaceHandle, fn: (env: Record<string, string>) => Promise<T>): Promise<T> {
    const tmp = mkdtempSync(join(tmpdir(), 'ao-index-'));
    const indexFile = join(tmp, 'index');
    const env = { GIT_INDEX_FILE: indexFile };
    try {
      await this.git(workspace.path, ['read-tree', workspace.baseSha], env);
      await this.git(workspace.path, ['add', '-A', '--force', ...this.excludePathspecs()], env);
      return await fn(env);
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  }

  async captureDiff(workspace: WorkspaceHandle): Promise<DiffCapture> {
    return this.withTempIndex(workspace, async (env) => {
      const nameStatus = await this.git(workspace.path, ['diff', '--cached', '--name-status', '-z', '--find-renames', workspace.baseSha], env);
      const numstat = await this.git(workspace.path, ['diff', '--cached', '--numstat', '-z', workspace.baseSha], env);
      const untracked = new Set((await this.git(workspace.path, ['ls-files', '--others', '--exclude-standard', '-z', ...this.excludePathspecs()])).split('\0').filter(Boolean));
      const files = parseNameStatus(nameStatus, parseNumstat(numstat), untracked);
      const patchRaw = await this.git(workspace.path, ['diff', '--cached', '--no-color', '--find-renames', '--unified=3', '--no-ext-diff', workspace.baseSha], env);
      const patchBytes = Buffer.byteLength(patchRaw);
      const { text: patch, truncated } = truncateBytes(patchRaw, this.maxDiffBytes);
      const summary: DiffSummary = { files, isEmpty: files.length === 0, patchBytes, truncated };
      return { summary, patch, patches: splitPatchByFile(patchRaw) };
    });
  }

  /** ワークスペース内容のハッシュ（未追跡含む tree hash）。レビュー前後の比較に使う。 */
  async hash(workspace: WorkspaceHandle): Promise<string> {
    return this.withTempIndex(workspace, async (env) => (await this.git(workspace.path, ['write-tree'], env)).trim());
  }

  async remove(runId: string): Promise<void> {
    rmSync(this.workspacePath(runId), { recursive: true, force: true });
  }
}

function parseNumstat(out: string): Map<string, { additions: number; deletions: number }> {
  const map = new Map<string, { additions: number; deletions: number }>();
  // -z 形式: "add\tdel\tpath\0" / rename は "add\tdel\0old\0new\0"
  const parts = out.split('\0');
  for (let i = 0; i < parts.length; i++) {
    const part = parts[i];
    if (!part) continue;
    const [add, del, path] = part.split('\t');
    const a = add === '-' ? 0 : Number(add ?? 0);
    const d = del === '-' ? 0 : Number(del ?? 0);
    if (path !== undefined && path !== '') {
      map.set(path, { additions: a, deletions: d });
    } else {
      const newPath = parts[i + 2];
      if (newPath) map.set(newPath, { additions: a, deletions: d });
      i += 2;
    }
  }
  return map;
}

function parseNameStatus(out: string, numstat: Map<string, { additions: number; deletions: number }>, untracked: Set<string>): DiffFile[] {
  const files: DiffFile[] = [];
  const parts = out.split('\0');
  for (let i = 0; i < parts.length; i++) {
    const code = parts[i];
    if (!code) continue;
    let path = parts[i + 1] ?? '';
    let status: DiffFile['status'] = 'modified';
    if (code.startsWith('R') || code.startsWith('C')) {
      path = parts[i + 2] ?? path;
      status = 'renamed';
      i += 2;
    } else {
      i += 1;
      if (code === 'A') status = untracked.has(path) ? 'untracked' : 'added';
      else if (code === 'D') status = 'deleted';
      else status = 'modified';
    }
    const n = numstat.get(path) ?? { additions: 0, deletions: 0 };
    files.push({ path, status, additions: n.additions, deletions: n.deletions });
  }
  return files;
}

export function splitPatchByFile(patch: string): Record<string, string> {
  const result: Record<string, string> = {};
  const chunks = patch.split(/^(?=diff --git )/m);
  for (const chunk of chunks) {
    const m = /^diff --git a\/(.+?) b\/(.+)$/m.exec(chunk);
    if (m) result[m[2] ?? m[1] ?? ''] = chunk;
  }
  return result;
}
