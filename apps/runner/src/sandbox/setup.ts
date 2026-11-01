import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import type { SandboxManifest, SandboxSetupState, SandboxSetupStep } from '@agent-orchestrator/contracts';
import type { RunnerConfig } from '../config.js';
import { maskSecrets } from '../masking.js';
import { runProcess, type ProcessRunner } from '../process-runner.js';
import { SANDBOX_FILES, SANDBOX_MANIFEST } from './assets.generated.js';

/**
 * サンドボックス準備（v0.1.0 公開準備、D-36）。GUI の「サンドボックスを準備する」から呼ばれ、固定の手順だけを実行する:
 *   1. docker info（デーモン到達）
 *   2. ピン留めしたベースイメージ（タグ@ダイジェスト）を pull — ユーザーの明示的な同意（acknowledgePull）が必要
 *   3. ベースイメージの RepoDigests にマニフェストのダイジェストが含まれることを検証（不一致なら停止）
 *   4. 埋め込みコンテキストを一時ディレクトリに書き出し、egress プロキシ / サンドボックスを docker build（--pull=false、ラベル付与）
 *   5. ビルド結果のラベル（version / base-digest）を検証。失敗したイメージは rmi して使わせない
 * 任意のコマンドは実行しない（docker の固定引数のみ）。失敗はすべて fail-closed（原因と復旧方法を返す）。
 */
export interface SandboxSetupDeps {
  config: RunnerConfig;
  run?: ProcessRunner;
  onProgress?: (state: SandboxSetupState) => void;
  now?: () => Date;
}

export class SandboxSetupError extends Error {
  constructor(
    readonly code: 'INVALID_STATE' | 'INVALID_PARAMS',
    message: string
  ) {
    super(message);
    this.name = 'SandboxSetupError';
  }
}

const STEP_DEFS: Array<{ id: string; label: string }> = [
  { id: 'docker', label: 'Docker デーモンの確認' },
  { id: 'base.pull', label: 'ベースイメージの取得（Docker Hub、ピン留め）' },
  { id: 'base.verify', label: 'ベースイメージのダイジェスト検証' },
  { id: 'build.proxy', label: 'egress プロキシイメージのビルド' },
  { id: 'build.sandbox', label: 'サンドボックスイメージのビルド' },
  { id: 'verify', label: 'ビルド結果の整合性検証' }
];

export function manifestForConfig(config: RunnerConfig): SandboxManifest {
  return {
    version: SANDBOX_MANIFEST.version,
    baseImage: SANDBOX_MANIFEST.baseImage,
    baseDigest: SANDBOX_MANIFEST.baseDigest,
    images: SANDBOX_MANIFEST.images.map((i) => ({ id: i.id, tag: i.id === 'sandbox' ? config.sandboxImage : config.egressProxyImage, label: i.label }))
  };
}

export class SandboxSetupService {
  private readonly run: ProcessRunner;
  private state: SandboxSetupState;
  private controller: AbortController | null = null;

  constructor(private readonly deps: SandboxSetupDeps) {
    this.run = deps.run ?? runProcess;
    this.state = this.idle();
  }

  status(): SandboxSetupState {
    return structuredClone(this.state);
  }

  private idle(): SandboxSetupState {
    return { state: 'idle', startedAt: null, finishedAt: null, steps: STEP_DEFS.map((s) => ({ ...s, status: 'pending', detail: '' })), logTail: [], error: null, manifest: manifestForConfig(this.deps.config) };
  }

  /** 準備を開始する（非同期に進み、進捗は onProgress / status() で取れる）。 */
  start(params: { acknowledgePull: boolean }): SandboxSetupState {
    if (params.acknowledgePull !== true) throw new SandboxSetupError('INVALID_PARAMS', 'ベースイメージの取得への同意（acknowledgePull）が必要です');
    if (this.state.state === 'running') throw new SandboxSetupError('INVALID_STATE', 'サンドボックスの準備は既に実行中です');
    this.state = { ...this.idle(), state: 'running', startedAt: this.nowIso() };
    this.controller = new AbortController();
    void this.execute(this.controller.signal);
    this.emit();
    return this.status();
  }

  cancel(): SandboxSetupState {
    if (this.state.state !== 'running' || !this.controller) throw new SandboxSetupError('INVALID_STATE', '実行中のサンドボックス準備はありません');
    this.controller.abort();
    return this.status();
  }

  private nowIso(): string {
    return (this.deps.now?.() ?? new Date()).toISOString();
  }

  private emit(): void {
    this.deps.onProgress?.(this.status());
  }

  private step(id: string, status: SandboxSetupStep['status'], detail = ''): void {
    this.state.steps = this.state.steps.map((s) => (s.id === id ? { ...s, status, detail: maskSecrets(detail).slice(0, 500) } : s));
    this.emit();
  }

  private log(chunk: string): void {
    const lines = chunk.split(/\r?\n/).map((l) => maskSecrets(l.trimEnd())).filter((l) => l.length > 0);
    if (lines.length === 0) return;
    this.state.logTail = [...this.state.logTail, ...lines].slice(-40);
    this.emit();
  }

  private async docker(args: string[], signal: AbortSignal, timeoutMs: number): Promise<{ ok: boolean; stdout: string; stderr: string }> {
    const r = await this.run({ command: 'docker', args, inheritEnv: true, timeoutMs, signal, onStdout: (c) => this.log(c), onStderr: (c) => this.log(c) });
    return { ok: r.exitCode === 0, stdout: r.stdout, stderr: r.stderr };
  }

  private fail(stepId: string, code: string, message: string, fix: string): void {
    this.step(stepId, 'fail', message);
    this.state = { ...this.state, state: 'failed', finishedAt: this.nowIso(), error: { code, message: maskSecrets(message), fix } };
    this.emit();
  }

  private async execute(signal: AbortSignal): Promise<void> {
    const manifest = this.state.manifest;
    const base = `${manifest.baseImage}@${manifest.baseDigest}`;
    const buildRoot = join(this.deps.config.appDataDir, 'sandbox-build', String(Date.now()));
    const cancelled = () => {
      if (!signal.aborted) return false;
      this.state = { ...this.state, state: 'cancelled', finishedAt: this.nowIso(), steps: this.state.steps.map((s) => (s.status === 'running' ? { ...s, status: 'skipped', detail: 'キャンセル' } : s)) };
      this.emit();
      return true;
    };
    try {
      // 1. docker
      this.step('docker', 'running');
      const info = await this.docker(['info', '--format', '{{.ServerVersion}}|{{.OSType}}'], signal, 60_000);
      if (cancelled()) return;
      if (!info.ok || !info.stdout.includes('|linux')) {
        this.fail('docker', 'DOCKER_UNAVAILABLE', info.ok ? `Linux コンテナモードではありません: ${info.stdout.trim()}` : info.stderr.trim().slice(0, 300) || 'docker info が失敗', 'Docker Desktop を起動し（WSL2 バックエンド、Linux コンテナ）、「再試行」を押してください');
        return;
      }
      this.step('docker', 'ok', `server ${info.stdout.trim().split('|')[0]}`);

      // 2. base pull（同意済み）
      this.step('base.pull', 'running', base);
      const pull = await this.docker(['pull', base], signal, 15 * 60_000);
      if (cancelled()) return;
      if (!pull.ok) {
        this.fail('base.pull', 'BASE_PULL_FAILED', pull.stderr.trim().slice(0, 300) || 'docker pull が失敗', 'ネットワーク接続と Docker Hub への到達性（プロキシ設定）を確認し、「再試行」を押してください');
        return;
      }
      this.step('base.pull', 'ok');

      // 3. base verify
      this.step('base.verify', 'running');
      const digests = await this.docker(['image', 'inspect', '--format', '{{json .RepoDigests}}', base], signal, 30_000);
      if (cancelled()) return;
      if (!digests.ok || !digests.stdout.includes(manifest.baseDigest)) {
        this.fail('base.verify', 'BASE_DIGEST_MISMATCH', `取得したベースイメージのダイジェストがマニフェスト（${manifest.baseDigest}）と一致しません: ${digests.stdout.trim().slice(0, 200)}`, '改ざんや取り違えの可能性があります。処理を停止しました。開発者に連絡してください（イメージは使用しません）');
        return;
      }
      this.step('base.verify', 'ok', manifest.baseDigest);

      // 4. builds
      for (const img of manifest.images) {
        const stepId = img.id === 'proxy' ? 'build.proxy' : 'build.sandbox';
        const contextName = img.id === 'proxy' ? 'egress-proxy' : 'sandbox';
        this.step(stepId, 'running', img.tag);
        const context = join(buildRoot, contextName);
        for (const [rel, content] of Object.entries(SANDBOX_FILES)) {
          if (!rel.startsWith(`${contextName}/`)) continue;
          const target = join(buildRoot, rel);
          mkdirSync(dirname(target), { recursive: true });
          writeFileSync(target, content, 'utf8');
        }
        const build = await this.docker(
          ['build', '--pull=false', '-f', join(context, 'Dockerfile'), '-t', img.tag, '--build-arg', `NODE_IMAGE=${base}`, '--label', `${SANDBOX_MANIFEST.labels.version}=${manifest.version}`, '--label', `${SANDBOX_MANIFEST.labels.baseDigest}=${manifest.baseDigest}`, context],
          signal,
          30 * 60_000
        );
        if (cancelled()) return;
        if (!build.ok) {
          this.fail(stepId, 'BUILD_FAILED', `${img.tag} のビルドが失敗しました: ${(build.stderr || build.stdout).trim().slice(-300)}`, 'ネットワーク（npm レジストリへの到達）とディスク空き容量を確認し、「再試行」を押してください。繰り返す場合はログを添えて開発者に連絡してください');
          return;
        }
        this.step(stepId, 'ok');
      }

      // 5. verify labels
      this.step('verify', 'running');
      for (const img of manifest.images) {
        const v = await this.docker(['image', 'inspect', '--format', `{{index .Config.Labels "${SANDBOX_MANIFEST.labels.version}"}}|{{index .Config.Labels "${SANDBOX_MANIFEST.labels.baseDigest}"}}`, img.tag], signal, 30_000);
        if (cancelled()) return;
        if (!v.ok || v.stdout.trim() !== `${manifest.version}|${manifest.baseDigest}`) {
          await this.docker(['rmi', '-f', img.tag], signal, 60_000);
          this.fail('verify', 'IMAGE_VERIFY_FAILED', `${img.tag} の整合性検証に失敗しました（${v.stdout.trim().slice(0, 120) || v.stderr.trim().slice(0, 120)}）。イメージは削除しました`, '「再試行」で作り直してください。繰り返す場合は開発者に連絡してください');
          return;
        }
      }
      this.step('verify', 'ok', `version ${manifest.version} / base ${manifest.baseDigest.slice(0, 19)}`);
      this.state = { ...this.state, state: 'succeeded', finishedAt: this.nowIso() };
      this.emit();
    } catch (err) {
      if (cancelled()) return;
      this.fail(this.state.steps.find((s) => s.status === 'running')?.id ?? 'docker', 'INTERNAL_ERROR', err instanceof Error ? err.message : String(err), '「再試行」を押してください。繰り返す場合は開発者に連絡してください');
    } finally {
      rmSync(buildRoot, { recursive: true, force: true });
      this.controller = null;
    }
  }
}
