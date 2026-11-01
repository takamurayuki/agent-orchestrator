import type { VerificationCommandResult, VerificationResult } from '@agent-orchestrator/contracts';
import type { VerifierInput } from '../engine.js';
import { excerpt } from '../masking.js';
import { CONTAINER_WORKSPACE, type SandboxExecutor } from '../isolation/types.js';
import { expectedCommandNames, getProfile } from './profiles.js';

/**
 * Verifier。AI ではない。プロファイルのコマンドを隔離コンテナ内で逐次実行し、終了コード・タイムアウトを記録する。
 * 1 つでも失敗したら以降はスキップし（欠落として記録）、passed=false。
 */
export class SandboxVerifier {
  constructor(private readonly sandbox: SandboxExecutor) {}

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
        env: { CI: '1', FORCE_COLOR: '0', NODE_OPTIONS: '--max-old-space-size=2048', pnpm_config_store_dir: '/workspace/.pnpm-store', pnpm_config_cache_dir: '/workspace/.pnpm-store/cache', pnpm_config_manage_package_manager_versions: 'false', COREPACK_ENABLE_STRICT: '0', COREPACK_ENABLE_AUTO_PIN: '0' },
        network: cmd.network,
        timeoutMs: perCommandTimeout,
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
    return {
      profile: profile.name,
      passed: !failed && missing.length === 0 && commands.length === profile.commands.length,
      commands,
      missing,
      startedAt,
      finishedAt: new Date().toISOString()
    };
  }
}
