import { accessSync, constants, existsSync, mkdirSync } from 'node:fs';
import type { ResolvedTask } from '@agent-orchestrator/contracts';
import type { RunnerConfig } from './config.js';
import { loadClaudeCredentials, loadCodexCredentials } from './credentials.js';
import type { PreflightCheck, PreflightReport } from './engine.js';
import type { EnvironmentAdapter } from './environment.js';
import { checkProfileReadiness } from './verification/profiles.js';
import type { WorkspaceManager } from './workspace.js';

/**
 * 起動前検査（SPEC §9 末尾）。対象: Git clean、Docker 隔離と egress、CLI バージョン/認証可否、検証 profile、ディスク容量、ディレクトリ権限。
 * 1 つでも fail / unverified があれば Run は PRECHECK_FAILED で停止する。
 */
export interface PreflightDeps {
  config: RunnerConfig;
  environment: EnvironmentAdapter;
  workspace: WorkspaceManager;
  env?: NodeJS.ProcessEnv;
  /** Docker 実測をスキップする（単体テスト用。本番では常に実行） */
  skipIsolationProbe?: boolean;
}

export function createPreflight(deps: PreflightDeps) {
  return async function preflight(input: { task: ResolvedTask; runId?: string; signal: AbortSignal }): Promise<PreflightReport> {
    const checks: PreflightCheck[] = [];
    const task = input.task;

    // 環境チェック（CLI/認証/ディスク/権限）
    const envReport = await deps.environment.check();
    for (const c of envReport.checks) {
      checks.push({ id: c.id, label: c.label, status: c.status === 'ok' ? 'ok' : c.status === 'warn' ? 'warn' : c.status === 'unverified' ? 'unverified' : 'fail', detail: c.detail, fix: c.fix });
    }

    // リポジトリ
    if (!existsSync(task.repository)) {
      checks.push({ id: 'repo.exists', label: 'リポジトリ', status: 'fail', detail: `${task.repository} が存在しません`, fix: 'プロジェクトフォルダを再選択してください' });
    } else {
      const { root } = await deps.workspace.isGitRepository(task.repository);
      if (!root) {
        checks.push({ id: 'repo.git', label: 'Git リポジトリ', status: 'fail', detail: 'Git リポジトリではありません', fix: 'git init 済みのフォルダを選択してください' });
      } else {
        checks.push({ id: 'repo.git', label: 'Git リポジトリ', status: 'ok', detail: root, fix: null });
        try {
          const clean = await deps.workspace.isClean(task.repository);
          checks.push({ id: 'repo.clean', label: 'Git 作業ツリー clean', status: clean ? 'ok' : 'fail', detail: clean ? '未コミットの変更なし' : '未コミットの変更があります', fix: clean ? null : '変更を commit または stash してから再実行してください（baseRef のコミット内容だけが実装対象になります）' });
        } catch (err) {
          checks.push({ id: 'repo.clean', label: 'Git 作業ツリー clean', status: 'fail', detail: (err as Error).message, fix: null });
        }
        try {
          const sha = await deps.workspace.resolveBaseSha(task.repository, task.baseRef);
          checks.push({ id: 'repo.baseRef', label: 'baseRef', status: 'ok', detail: `${task.baseRef} → ${sha}`, fix: null });
        } catch (err) {
          checks.push({ id: 'repo.baseRef', label: 'baseRef', status: 'fail', detail: (err as Error).message, fix: 'task.yaml の baseRef を存在するブランチ/タグ/SHA にしてください' });
        }
      }
      const readiness = checkProfileReadiness(task.repository, task.verificationProfile);
      checks.push({ id: 'verification.profile', label: `検証プロファイル ${task.verificationProfile}`, status: readiness.ready ? 'ok' : 'fail', detail: readiness.detail, fix: readiness.ready ? null : 'package.json に typecheck / lint / test:run scripts と pnpm-lock.yaml を用意してください' });
    }

    // ワークスペース置き場
    try {
      mkdirSync(deps.config.worktreesDir, { recursive: true });
      accessSync(deps.config.worktreesDir, constants.W_OK);
      checks.push({ id: 'worktrees.writable', label: 'ワークスペース保存先', status: 'ok', detail: deps.config.worktreesDir, fix: null });
    } catch (err) {
      checks.push({ id: 'worktrees.writable', label: 'ワークスペース保存先', status: 'fail', detail: (err as Error).message, fix: 'AGENT_ORCHESTRATOR_WORKTREES を書き込み可能な場所に設定してください' });
    }

    // 認証情報の読み出し可否（値はログに出さない）
    for (const [id, label, loader] of [
      ['auth.claude.load', 'Claude 認証の注入', () => loadClaudeCredentials(deps.env ?? process.env)],
      ['auth.codex.load', 'Codex 認証の注入', () => loadCodexCredentials(deps.env ?? process.env)]
    ] as const) {
      try {
        await loader();
        checks.push({ id, label, status: 'ok', detail: '注入可能', fix: null });
      } catch (err) {
        checks.push({ id, label, status: 'fail', detail: (err as Error).message, fix: 'ホストで CLI にログインするか API キーを環境変数に設定してください' });
      }
    }

    // Docker 隔離と egress の実測（イメージが無い等の fail が既にある場合はスキップせず unverified として明示）
    const dockerOk = checks.filter((c) => c.id.startsWith('docker.')).every((c) => c.status === 'ok');
    if (deps.skipIsolationProbe) {
      checks.push({ id: 'docker.isolation', label: 'Docker 隔離の実測', status: 'unverified', detail: 'テスト設定により実測をスキップ', fix: null });
    } else if (!dockerOk) {
      checks.push({ id: 'docker.isolation', label: 'Docker 隔離の実測', status: 'fail', detail: 'Docker の前提チェックが失敗しているため実測できません', fix: '上記の Docker 関連の修正を先に行ってください' });
    } else if (input.signal.aborted) {
      checks.push({ id: 'docker.isolation', label: 'Docker 隔離の実測', status: 'fail', detail: 'キャンセルされました', fix: null });
    } else {
      const probe = await deps.environment.probeIsolation(input.runId ?? `preflight-${Date.now().toString(36)}`);
      for (const c of probe) checks.push({ id: c.id, label: c.label, status: c.status === 'ok' ? 'ok' : 'fail', detail: c.detail, fix: c.fix });
    }

    const ok = checks.every((c) => c.status === 'ok' || c.status === 'warn');
    return { ok, checks };
  };
}
