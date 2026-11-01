import type { ProcessResult } from '../process-runner.js';

/**
 * 隔離実行の抽象。実装は Docker（isolation/docker.ts）。単体テストではフェイクを注入する。
 * Builder/Reviewer/Verifier はこのインターフェースだけを使い、docker CLI を直接呼ばない。
 *
 * ワークスペースは Run ごとの名前付きボリューム（/workspace）に置く。ホストとの同期は tar ストリーム（push/pull）。
 * 補助ファイル（スキーマ・出力・認証）は aux ボリューム（/aux）に putFile/getFile で出し入れする。
 * bind mount は使わない（Docker Desktop のホスト共有が使えない環境があり、実測で I/O エラーになった。docs/DECISIONS.md D-18）。
 */
export type VolumeAccess = 'rw' | 'ro' | 'none';

export interface SandboxStep {
  /** コンテナ名の一部（英数字と - のみ） */
  name: string;
  argv: string[];
  /** /workspace（Run のワークスペースボリューム）へのアクセス */
  workspace: VolumeAccess;
  /** /aux（補助ボリューム）へのアクセス */
  aux: VolumeAccess;
  workdir: string;
  env: Record<string, string>;
  /** egress: 内部ネットワーク + allowlist プロキシ経由のみ / none: ネットワークなし */
  network: 'egress' | 'none';
  timeoutMs: number;
  signal?: AbortSignal;
  /** ログからマスキングする値 */
  secrets?: string[];
  onStdout?: (chunk: string) => void;
  onStderr?: (chunk: string) => void;
  stdin?: string;
  /**
   * コンテナ内でさらに非特権 user namespace を作ることを許す（Codex の bubblewrap サンドボックス用）。
   * Docker 既定の seccomp は CAP_SYS_ADMIN 無しの unshare/mount を拒否するため、このステップだけ seccomp を外す。
   * cap-drop ALL / no-new-privileges / 非 root / read-only root / ワークスペース :ro / internal ネットワークは維持される（D-22）。
   */
  allowUserNamespaces?: boolean;
}

export interface SandboxExecutor {
  /** Run 単位の資源（内部ネットワーク・プロキシ・ボリューム）を用意する。冪等 */
  prepare(runId: string): Promise<void>;
  exec(runId: string, step: SandboxStep): Promise<ProcessResult>;
  /** ホストのディレクトリ内容をワークスペースボリュームへミラーする（node_modules 等は除外） */
  pushWorkspace(runId: string, hostDir: string): Promise<void>;
  /** ワークスペースボリュームの内容をホストのディレクトリへミラーする（ホスト側は置き換え） */
  pullWorkspace(runId: string, hostDir: string): Promise<void>;
  /** aux ボリューム内のファイルを書く（containerPath は /aux 配下） */
  putFile(runId: string, containerPath: string, content: string): Promise<void>;
  /** aux ボリューム内のファイルを読む。無ければ null */
  getFile(runId: string, containerPath: string): Promise<string | null>;
  /** プロキシのアクセスログ（allow/deny の JSON 行） */
  egressLog(runId: string): Promise<string>;
  cleanup(runId: string): Promise<void>;
}

/** コンテナ内のパス規約 */
export const CONTAINER_WORKSPACE = '/workspace';
export const CONTAINER_AUX = '/aux';
export const CONTAINER_HOME = '/home/agent';
export const CONTAINER_USER = '1001:1001';
export const PROXY_ALIAS = 'egress-proxy';
export const PROXY_PORT = 3128;
/** ホスト⇄ボリューム同期から除外するパス */
export const SYNC_EXCLUDES = ['node_modules', '.pnpm-store', '.turbo', 'coverage', 'dist', 'build', '.next', '.svelte-kit'];
