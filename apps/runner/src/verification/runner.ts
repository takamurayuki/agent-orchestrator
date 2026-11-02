import type { VerificationCommandResult, VerificationResult } from '@agent-orchestrator/contracts';
import type { VerifierInput } from '../engine.js';
import { excerpt } from '../masking.js';
import { CONTAINER_WORKSPACE, type SandboxExecutor } from '../isolation/types.js';
import { verifyGeneratedArtifacts } from './generated.js';
import { expectedCommandNames, getProfile } from './profiles.js';

/** install（依存取得）の実行時間の下限。検証コマンド上限より短くはしない */
export const INSTALL_TIMEOUT_FLOOR_MS = 10 * 60 * 1000;

/**
 * Verifier。AI ではない。プロファイルのコマンドを隔離コンテナ内で逐次実行し、終了コード・タイムアウトを記録する。
 * 1 つでも失敗したら以降はスキップし（欠落として記録）、passed=false。
 */
export class SandboxVerifier {
  constructor(
    private readonly sandbox: SandboxExecutor,
    /** 運用者設定の追加環境変数（config.sandboxEnv） */
    private readonly extraEnv: Record<string, string> = {}
  ) {}

  expectedCommands(profile: VerifierInput['profile']): string[] {
    return expectedCommandNames(profile);
  }

  async verify(input: VerifierInput): Promise<VerificationResult> {
    const profile = getProfile(input.profile);
    const startedAt = new Date().toISOString();
    const commands: VerificationCommandResult[] = [];
    const missing: string[] = [];
    let failed = false;
    const perCommandTimeout = Math.max(1000, Math.floor(input.timeoutMs));
    // 依存関係の取得（install）はネットワーク依存で、Run ごとに新しいボリュームへ取り直すため 2〜5 分かかる（v0.2.2 配布版検証: 131〜302 秒）。
    // 検証コマンドの上限（既定 300 秒）だけでは起動前検査で時間切れになりやすいので、install にだけ下限 10 分を与える。
    // 隔離・ネットワーク制限は変えない（同じサンドボックス・同じ egress allowlist）。Run 全体の制限時間（maxDurationSeconds）は別途適用される
    const installTimeout = Math.max(perCommandTimeout, INSTALL_TIMEOUT_FLOOR_MS);
    for (const cmd of profile.commands) {
      if (failed || input.signal.aborted) {
        missing.push(cmd.name);
        continue;
      }
      input.onLog(`\n$ ${cmd.argv.join(' ')}\n`);
      const result = await this.sandbox.exec(input.runId, {
        name: `verify-${cmd.name.replace(/[^A-Za-z0-9-]/g, '-')}-r${input.round}`,
        argv: cmd.argv,
        workspace: 'rw',
        aux: 'none',
        workdir: CONTAINER_WORKSPACE,
        // pnpm store はワークスペースボリューム内（tmpfs の /tmp に大量書込しない。同期からは除外される）
        env: { ...this.extraEnv, CI: '1', FORCE_COLOR: '0', NODE_OPTIONS: '--max-old-space-size=2048', pnpm_config_store_dir: '/workspace/.pnpm-store', pnpm_config_cache_dir: '/workspace/.pnpm-store/cache', npm_config_cache: '/workspace/.npm-cache', YARN_CACHE_FOLDER: '/workspace/.yarn-cache', pnpm_config_manage_package_manager_versions: 'false', COREPACK_ENABLE_STRICT: '0', COREPACK_ENABLE_AUTO_PIN: '0' },
        network: cmd.network,
        timeoutMs: cmd.name === 'install' ? installTimeout : perCommandTimeout,
        signal: input.signal,
        onStdout: input.onLog,
        onStderr: input.onLog
      });
      const record: VerificationCommandResult = {
        name: cmd.name,
        argv: cmd.argv,
        exitCode: result.timedOut ? null : result.exitCode,
        timedOut: result.timedOut,
        durationMs: result.durationMs,
        stdoutExcerpt: excerpt(result.stdout, 6000),
        stderrExcerpt: excerpt(result.stderr, 6000),
        truncated: result.truncated
      };
      commands.push(record);
      if (record.timedOut || record.exitCode !== 0) failed = true;
    }
    // 生成物の更新検証（v0.2.1、D-41）: プロファイルの検証がすべて通った後に、生成スクリプトを再実行して生成物が最新かを決定的に確認する
    if (!failed && missing.length === 0 && !input.signal.aborted && (input.generatedArtifacts?.length ?? 0) > 0) {
      const env = { ...this.extraEnv, CI: '1', FORCE_COLOR: '0', NODE_OPTIONS: '--max-old-space-size=2048', pnpm_config_store_dir: '/workspace/.pnpm-store', pnpm_config_cache_dir: '/workspace/.pnpm-store/cache', npm_config_cache: '/workspace/.npm-cache', YARN_CACHE_FOLDER: '/workspace/.yarn-cache', pnpm_config_manage_package_manager_versions: 'false', COREPACK_ENABLE_STRICT: '0', COREPACK_ENABLE_AUTO_PIN: '0' };
      const generated = await verifyGeneratedArtifacts(this.sandbox, { runId: input.runId, round: input.round, artifacts: input.generatedArtifacts ?? [], profile: input.profile, env, timeoutMs: perCommandTimeout, signal: input.signal, onLog: input.onLog });
      commands.push(...generated);
      if (generated.some((g) => g.exitCode !== 0 || g.timedOut)) failed = true;
    }
    return {
      profile: profile.name,
      passed: !failed && missing.length === 0 && commands.length >= profile.commands.length,
      commands,
      missing,
      startedAt,
      finishedAt: new Date().toISOString()
    };
  }
}
