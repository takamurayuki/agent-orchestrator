import { mkdirSync } from 'node:fs';
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';

/** 実行時設定。環境変数で上書きできるが、UI・利用者入力からは変更できない。 */
export interface RunnerConfig {
  /** app-data ディレクトリ（SQLite・tasks・runs） */
  appDataDir: string;
  /** worktree を作るディレクトリ（元リポジトリの外） */
  worktreesDir: string;
  /** サンドボックスイメージ（ローカルでピン留め） */
  sandboxImage: string;
  /** egress プロキシイメージ */
  egressProxyImage: string;
  /** LLM CLI が通信してよいホスト（これ以外はプロキシが拒否） */
  egressAllowlist: string[];
  /** コンテナのリソース上限 */
  limits: { cpus: number; memory: string; pids: number };
  /** ログ・差分のサイズ上限（バイト） */
  maxLogBytes: number;
  maxDiffBytes: number;
  /** repo 調査の上限 */
  inspect: { maxFiles: number; maxFileBytes: number; maxTotalBytes: number; timeoutMs: number };
  /** 実 CLI を使う E2E を許可するか（RUN_LIVE_E2E=1） */
  liveE2E: boolean;
  /**
   * 検証 / Builder コンテナに追加する環境変数（運用者設定。allowlist されたキーのみ）。
   * 例: AGENT_ORCHESTRATOR_PNPM_MIN_RELEASE_AGE=0 → pnpm_config_minimum_release_age=0
   *（pnpm 12 の supply-chain policy「公開から一定時間未満のパッケージを拒否」をプロジェクト側で既に受け入れている場合に、
   *   サンドボックス内の install が同じ lockfile で失敗しないようにする。D-26）
   */
  sandboxEnv: Record<string, string>;
}

export const DEFAULT_EGRESS_ALLOWLIST = [
  'api.anthropic.com',
  'api.openai.com',
  'chatgpt.com',
  'auth.openai.com',
  'registry.npmjs.org'
];

export function loadConfig(env: NodeJS.ProcessEnv = process.env): RunnerConfig {
  const appDataDir = resolve(env.AGENT_ORCHESTRATOR_APP_DATA ?? join(homedir(), '.agent-orchestrator', 'app-data'));
  const allowlist = (env.AGENT_ORCHESTRATOR_EGRESS_ALLOWLIST ?? DEFAULT_EGRESS_ALLOWLIST.join(','))
    .split(',')
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
  return {
    appDataDir,
    worktreesDir: resolve(env.AGENT_ORCHESTRATOR_WORKTREES ?? join(appDataDir, 'worktrees')),
    sandboxImage: env.AGENT_ORCHESTRATOR_SANDBOX_IMAGE ?? 'agent-orchestrator-sandbox:0.1.0',
    egressProxyImage: env.AGENT_ORCHESTRATOR_EGRESS_IMAGE ?? 'agent-orchestrator-egress-proxy:0.1.0',
    egressAllowlist: allowlist,
    limits: { cpus: Number(env.AGENT_ORCHESTRATOR_CPUS ?? 2), memory: env.AGENT_ORCHESTRATOR_MEMORY ?? '4g', pids: Number(env.AGENT_ORCHESTRATOR_PIDS ?? 512) },
    maxLogBytes: 2 * 1024 * 1024,
    maxDiffBytes: 4 * 1024 * 1024,
    inspect: { maxFiles: 4000, maxFileBytes: 256 * 1024, maxTotalBytes: 24 * 1024 * 1024, timeoutMs: 20_000 },
    liveE2E: env.RUN_LIVE_E2E === '1',
    sandboxEnv: {
      ...(env.AGENT_ORCHESTRATOR_PNPM_MIN_RELEASE_AGE !== undefined && /^\d+$/.test(env.AGENT_ORCHESTRATOR_PNPM_MIN_RELEASE_AGE) ? { pnpm_config_minimum_release_age: env.AGENT_ORCHESTRATOR_PNPM_MIN_RELEASE_AGE } : {})
    }
  };
}

export function ensureAppDataLayout(config: RunnerConfig): { dbPath: string; tasksDir: string; runsDir: string } {
  const tasksDir = join(config.appDataDir, 'tasks');
  const runsDir = join(config.appDataDir, 'runs');
  for (const dir of [config.appDataDir, tasksDir, runsDir, config.worktreesDir]) mkdirSync(dir, { recursive: true });
  return { dbPath: join(config.appDataDir, 'orchestrator.sqlite'), tasksDir, runsDir };
}

export function nowIso(): string {
  return new Date().toISOString();
}
