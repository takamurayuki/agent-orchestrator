import { spawn } from 'node:child_process';
import { mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync, readFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, posix } from 'node:path';
import type { RunnerConfig } from '../config.js';
import { assertNoForbiddenFlags } from '../policy.js';
import { runProcess, type ProcessResult, type ProcessRunner } from '../process-runner.js';
import { CONTAINER_AUX, CONTAINER_HOME, CONTAINER_USER, CONTAINER_WORKSPACE, PROXY_ALIAS, PROXY_PORT, SYNC_EXCLUDES, type SandboxExecutor, type SandboxStep } from './types.js';

/**
 * Docker サンドボックス（SPEC §9）。
 *   - Run ごとに `--internal` ネットワーク（外部到達不可）を作り、allowlist プロキシ（bridge にも接続）だけが外へ出られる
 *   - Run ごとに workspace / aux の名前付きボリュームを作る（bind mount は使わない。D-18）
 *   - 各ステップは `docker run --rm` の使い捨てコンテナ: 非 root、cap-drop ALL、no-new-privileges、read-only root、
 *     pids/cpu/memory 制限、Docker socket 非マウント、/tmp と home は tmpfs。Reviewer はワークスペース :ro
 *   - タイムアウト/キャンセルは `docker kill` でコンテナごと停止する（子プロセスを残さない）
 * egress を技術的に制限できない場合、preflight が fail し実行しない。
 */
export interface DockerSandboxOptions {
  config: RunnerConfig;
  run?: ProcessRunner;
  /** 名前の接頭辞（テスト分離用） */
  prefix?: string;
  /** ホスト側 tar コマンド（既定: tar） */
  tarCommand?: string;
}

const NAME_RE = /^[A-Za-z0-9_.-]+$/;

export function sandboxNames(prefix: string, runId: string) {
  const base = `${prefix}-${runId}`;
  return { network: `${base}-net`, proxy: `${base}-proxy`, workspace: `${base}-ws`, aux: `${base}-aux`, helper: `${base}-helper`, step: (name: string) => `${base}-${name}` };
}

/** docker run の argv を組み立てる（純粋関数。テストで検査する）。 */
export function buildDockerRunArgs(input: {
  containerName: string;
  image: string;
  step: SandboxStep;
  volumes: { workspace: string; aux: string };
  network: string | null;
  limits: RunnerConfig['limits'];
  proxyUrl: string | null;
}): string[] {
  const { step } = input;
  if (!NAME_RE.test(input.containerName)) throw new Error(`不正なコンテナ名: ${input.containerName}`);
  for (const v of Object.values(input.volumes)) if (!NAME_RE.test(v)) throw new Error(`不正なボリューム名: ${v}`);
  const args = ['run', '--rm', '--init', '--name', input.containerName];
  args.push('--user', CONTAINER_USER);
  args.push('--cap-drop', 'ALL', '--security-opt', 'no-new-privileges');
  if (step.allowUserNamespaces) args.push('--security-opt', 'seccomp=unconfined');
  args.push('--pids-limit', String(input.limits.pids), '--cpus', String(input.limits.cpus), '--memory', input.limits.memory, '--memory-swap', input.limits.memory);
  args.push('--read-only');
  args.push('--tmpfs', '/tmp:rw,nosuid,size=512m');
  args.push('--tmpfs', `${CONTAINER_HOME}:rw,nosuid,uid=1001,gid=1001,mode=0700,size=256m`);
  if (input.network === null) args.push('--network', 'none');
  else args.push('--network', input.network);
  if (step.workspace !== 'none') args.push('--mount', `type=volume,source=${input.volumes.workspace},target=${CONTAINER_WORKSPACE}${step.workspace === 'ro' ? ',readonly' : ''}`);
  if (step.aux !== 'none') args.push('--mount', `type=volume,source=${input.volumes.aux},target=${CONTAINER_AUX}${step.aux === 'ro' ? ',readonly' : ''}`);
  args.push('-w', step.workdir);
  const env: Record<string, string> = { HOME: CONTAINER_HOME, ...step.env };
  if (input.proxyUrl) {
    Object.assign(env, { HTTP_PROXY: input.proxyUrl, HTTPS_PROXY: input.proxyUrl, http_proxy: input.proxyUrl, https_proxy: input.proxyUrl, NO_PROXY: 'localhost,127.0.0.1', no_proxy: 'localhost,127.0.0.1' });
  }
  for (const [k, v] of Object.entries(env)) {
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(k)) throw new Error(`不正な環境変数名: ${k}`);
    args.push('-e', `${k}=${v}`);
  }
  if (step.stdin !== undefined) args.push('-i');
  args.push('--label', 'agent-orchestrator=1');
  args.push(input.image, ...step.argv);
  assertNoForbiddenFlags(args);
  return args;
}

export class DockerSandbox implements SandboxExecutor {
  private readonly run: ProcessRunner;
  private readonly prefix: string;
  private readonly tar: string;
  private readonly prepared = new Set<string>();

  constructor(private readonly options: DockerSandboxOptions) {
    this.run = options.run ?? runProcess;
    this.prefix = options.prefix ?? 'ao';
    this.tar = options.tarCommand ?? 'tar';
  }

  private docker(args: string[], timeoutMs = 60_000, extra: Partial<Parameters<ProcessRunner>[0]> = {}): Promise<ProcessResult> {
    return this.run({ command: 'docker', args, inheritEnv: true, timeoutMs, ...extra });
  }

  private async dockerOk(args: string[], what: string, timeoutMs = 60_000): Promise<ProcessResult> {
    const r = await this.docker(args, timeoutMs);
    if (r.exitCode !== 0) throw new Error(`${what}: ${r.stderr.trim().slice(0, 400) || r.stdout.trim().slice(0, 200)}`);
    return r;
  }

  async prepare(runId: string): Promise<void> {
    if (this.prepared.has(runId)) return;
    if (!NAME_RE.test(runId)) throw new Error(`不正な runId: ${runId}`);
    const names = sandboxNames(this.prefix, runId);
    // ボリューム（root 作成 → 1001 に chown）
    for (const vol of [names.workspace, names.aux]) {
      const exists = await this.docker(['volume', 'inspect', '--format', '{{.Name}}', vol]);
      if (exists.exitCode !== 0) {
        await this.dockerOk(['volume', 'create', '--label', 'agent-orchestrator=1', vol], `ボリュームを作成できない (${vol})`);
      }
    }
    await this.dockerOk(
      ['run', '--rm', '--network', 'none', '--user', '0:0', '--mount', `type=volume,source=${names.workspace},target=${CONTAINER_WORKSPACE}`, '--mount', `type=volume,source=${names.aux},target=${CONTAINER_AUX}`, this.options.config.sandboxImage, 'chown', '1001:1001', CONTAINER_WORKSPACE, CONTAINER_AUX],
      'ボリュームの所有者を設定できない',
      120_000
    );
    // 内部ネットワーク + egress プロキシ
    const existing = await this.docker(['network', 'inspect', '--format', '{{.Internal}}', names.network]);
    if (existing.exitCode !== 0) {
      await this.dockerOk(['network', 'create', '--internal', '--label', 'agent-orchestrator=1', names.network], '内部ネットワークを作成できない');
    } else if (existing.stdout.trim() !== 'true') {
      throw new Error(`既存ネットワーク ${names.network} が internal ではない`);
    }
    const proxyRunning = await this.docker(['container', 'inspect', '--format', '{{.State.Running}}', names.proxy]);
    if (proxyRunning.exitCode !== 0 || proxyRunning.stdout.trim() !== 'true') {
      await this.docker(['rm', '-f', names.proxy]);
      await this.dockerOk(
        [
          'run', '-d', '--rm', '--name', names.proxy, '--init',
          '--user', CONTAINER_USER, '--cap-drop', 'ALL', '--security-opt', 'no-new-privileges', '--read-only',
          '--pids-limit', '64', '--memory', '256m', '--cpus', '0.5',
          '--network', names.network, '--network-alias', PROXY_ALIAS,
          '-e', `EGRESS_ALLOWLIST=${this.options.config.egressAllowlist.join(',')}`, '-e', `EGRESS_PORT=${PROXY_PORT}`,
          '--label', 'agent-orchestrator=1',
          this.options.config.egressProxyImage
        ],
        'egress プロキシを起動できない'
      );
      await this.dockerOk(['network', 'connect', 'bridge', names.proxy], 'egress プロキシを bridge に接続できない');
      const deadline = Date.now() + 20_000;
      let ready = false;
      while (Date.now() < deadline) {
        const logs = await this.docker(['logs', names.proxy]);
        if (logs.stdout.includes('"action":"start"') || logs.stderr.includes('"action":"start"')) {
          ready = true;
          break;
        }
        await new Promise((r) => setTimeout(r, 300));
      }
      if (!ready) throw new Error('egress プロキシが起動しない');
    }
    this.prepared.add(runId);
  }

  async exec(runId: string, step: SandboxStep): Promise<ProcessResult> {
    if (!NAME_RE.test(step.name)) throw new Error(`不正なステップ名: ${step.name}`);
    await this.prepare(runId);
    const names = sandboxNames(this.prefix, runId);
    const containerName = names.step(`${step.name}-${Date.now().toString(36)}`);
    const args = buildDockerRunArgs({
      containerName,
      image: this.options.config.sandboxImage,
      step,
      volumes: { workspace: names.workspace, aux: names.aux },
      network: step.network === 'egress' ? names.network : null,
      limits: this.options.config.limits,
      proxyUrl: step.network === 'egress' ? `http://${PROXY_ALIAS}:${PROXY_PORT}` : null
    });
    const secrets = [...(step.secrets ?? []), ...Object.entries(step.env).filter(([k]) => /TOKEN|KEY|SECRET|PASSWORD/i.test(k)).map(([, v]) => v)];
    let killed = false;
    const killer = async () => {
      killed = true;
      await this.docker(['kill', containerName], 15_000);
    };
    const onAbort = () => void killer();
    step.signal?.addEventListener('abort', onAbort, { once: true });
    const timer = setTimeout(() => void killer(), step.timeoutMs);
    try {
      const result = await this.run({
        command: 'docker',
        args,
        inheritEnv: true,
        timeoutMs: step.timeoutMs + 60_000,
        secrets,
        ...(step.stdin !== undefined ? { stdin: step.stdin } : {}),
        ...(step.onStdout ? { onStdout: step.onStdout } : {}),
        ...(step.onStderr ? { onStderr: step.onStderr } : {}),
        maxOutputBytes: this.options.config.maxLogBytes
      });
      const aborted = Boolean(step.signal?.aborted);
      return { ...result, timedOut: result.timedOut || (killed && !aborted), aborted: result.aborted || aborted };
    } finally {
      clearTimeout(timer);
      step.signal?.removeEventListener('abort', onAbort);
      await this.docker(['rm', '-f', containerName], 15_000).catch(() => undefined);
    }
  }

  /** ホスト → ワークスペースボリューム。tar をストリームし、コンテナ内（uid 1001）で展開する。 */
  async pushWorkspace(runId: string, hostDir: string): Promise<void> {
    await this.prepare(runId);
    const names = sandboxNames(this.prefix, runId);
    const containerName = names.step(`push-${Date.now().toString(36)}`);
    // 既存内容を消してから展開（ミラー）
    await this.dockerOk(['run', '--rm', '--network', 'none', '--user', CONTAINER_USER, '--mount', `type=volume,source=${names.workspace},target=${CONTAINER_WORKSPACE}`, this.options.config.sandboxImage, 'sh', '-c', 'find /workspace -mindepth 1 -maxdepth 1 -exec rm -rf {} +'], 'ワークスペースボリュームを初期化できない', 120_000);
    // ホスト側パス（C:\...）を argv に出さない: GNU tar はコロンをリモートホスト指定と解釈する。cwd で指定する
    const tarArgs = ['-cf', '-', ...SYNC_EXCLUDES.flatMap((e) => ['--exclude', `./${e}`]), '.'];
    const dockerArgs = ['run', '--rm', '-i', '--name', containerName, '--network', 'none', '--user', CONTAINER_USER, '--mount', `type=volume,source=${names.workspace},target=${CONTAINER_WORKSPACE}`, this.options.config.sandboxImage, 'tar', '-xf', '-', '--no-same-owner', '--no-same-permissions', '-C', CONTAINER_WORKSPACE];
    await pipeProcesses({ command: this.tar, args: tarArgs, cwd: hostDir }, { command: 'docker', args: dockerArgs }, 600_000);
  }

  /** ワークスペースボリューム → ホスト。ホスト側の内容は置き換える（ミラー）。 */
  async pullWorkspace(runId: string, hostDir: string): Promise<void> {
    await this.prepare(runId);
    const names = sandboxNames(this.prefix, runId);
    const containerName = names.step(`pull-${Date.now().toString(36)}`);
    const staging = mkdtempSync(join(tmpdir(), 'ao-pull-'));
    try {
      const dockerArgs = ['run', '--rm', '--name', containerName, '--network', 'none', '--user', CONTAINER_USER, '--mount', `type=volume,source=${names.workspace},target=${CONTAINER_WORKSPACE},readonly`, this.options.config.sandboxImage, 'tar', '-cf', '-', ...SYNC_EXCLUDES.flatMap((e) => ['--exclude', `./${e}`]), '-C', CONTAINER_WORKSPACE, '.'];
      await pipeProcesses({ command: 'docker', args: dockerArgs }, { command: this.tar, args: ['-xf', '-'], cwd: staging }, 600_000);
      // 置き換え: ホスト側を空にして移動
      mkdirSync(hostDir, { recursive: true });
      for (const entry of readdirSync(hostDir)) rmSync(join(hostDir, entry), { recursive: true, force: true });
      for (const entry of readdirSync(staging)) {
        const { renameSync, cpSync } = await import('node:fs');
        try {
          renameSync(join(staging, entry), join(hostDir, entry));
        } catch {
          cpSync(join(staging, entry), join(hostDir, entry), { recursive: true });
        }
      }
    } finally {
      rmSync(staging, { recursive: true, force: true });
    }
  }

  async putFile(runId: string, containerPath: string, content: string): Promise<void> {
    await this.prepare(runId);
    const rel = auxRelative(containerPath);
    const names = sandboxNames(this.prefix, runId);
    const tmp = mkdtempSync(join(tmpdir(), 'ao-put-'));
    try {
      const local = join(tmp, posix.basename(rel));
      writeFileSync(local, content, 'utf8');
      const dir = posix.dirname(rel);
      const mkdir = dir === '.' ? 'true' : `mkdir -p ${shellQuote(posix.join(CONTAINER_AUX, dir))}`;
      await this.dockerOk(['run', '--rm', '--network', 'none', '--user', CONTAINER_USER, '--mount', `type=volume,source=${names.aux},target=${CONTAINER_AUX}`, this.options.config.sandboxImage, 'sh', '-c', mkdir], 'aux ディレクトリを作成できない');
      await this.docker(['rm', '-f', names.helper]);
      await this.dockerOk(['create', '--name', names.helper, '--network', 'none', '--mount', `type=volume,source=${names.aux},target=${CONTAINER_AUX}`, this.options.config.sandboxImage, 'true'], 'ヘルパーコンテナを作成できない');
      try {
        await this.dockerOk(['cp', local, `${names.helper}:${posix.join(CONTAINER_AUX, rel)}`], 'aux へコピーできない');
      } finally {
        await this.docker(['rm', '-f', names.helper]);
      }
      await this.dockerOk(['run', '--rm', '--network', 'none', '--user', '0:0', '--mount', `type=volume,source=${names.aux},target=${CONTAINER_AUX}`, this.options.config.sandboxImage, 'sh', '-c', `chown 1001:1001 ${shellQuote(posix.join(CONTAINER_AUX, rel))} && chmod 0600 ${shellQuote(posix.join(CONTAINER_AUX, rel))}`], 'aux ファイルの権限を設定できない');
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  }

  async getFile(runId: string, containerPath: string): Promise<string | null> {
    const rel = auxRelative(containerPath);
    const names = sandboxNames(this.prefix, runId);
    const tmp = mkdtempSync(join(tmpdir(), 'ao-get-'));
    try {
      await this.docker(['rm', '-f', names.helper]);
      await this.dockerOk(['create', '--name', names.helper, '--network', 'none', '--mount', `type=volume,source=${names.aux},target=${CONTAINER_AUX}`, this.options.config.sandboxImage, 'true'], 'ヘルパーコンテナを作成できない');
      try {
        const local = join(tmp, 'file');
        const r = await this.docker(['cp', `${names.helper}:${posix.join(CONTAINER_AUX, rel)}`, local]);
        if (r.exitCode !== 0 || !existsSync(local)) return null;
        return readFileSync(local, 'utf8');
      } finally {
        await this.docker(['rm', '-f', names.helper]);
      }
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  }

  async egressLog(runId: string): Promise<string> {
    const names = sandboxNames(this.prefix, runId);
    const logs = await this.docker(['logs', names.proxy]);
    return `${logs.stdout}${logs.stderr}`;
  }

  async cleanup(runId: string): Promise<void> {
    const names = sandboxNames(this.prefix, runId);
    const ps = await this.docker(['ps', '-aq', '--filter', `name=^${this.prefix}-${runId}-`]);
    for (const id of ps.stdout.split(/\s+/).filter(Boolean)) await this.docker(['rm', '-f', id]);
    await this.docker(['network', 'rm', '-f', names.network]);
    await this.docker(['volume', 'rm', '-f', names.workspace, names.aux]);
    this.prepared.delete(runId);
  }
}

function auxRelative(containerPath: string): string {
  const normalized = posix.normalize(containerPath);
  if (!normalized.startsWith(`${CONTAINER_AUX}/`) || normalized.includes('..')) throw new Error(`aux 配下のパスではない: ${containerPath}`);
  return normalized.slice(CONTAINER_AUX.length + 1);
}

function shellQuote(s: string): string {
  return `'${s.replace(/'/g, `'\\''`)}'`;
}

/** producer の stdout を consumer の stdin に直接つなぐ（shell:false、パイプは Node 内）。 */
export function pipeProcesses(producer: { command: string; args: string[]; cwd?: string }, consumer: { command: string; args: string[]; cwd?: string }, timeoutMs: number): Promise<void> {
  return new Promise((resolve, reject) => {
    const p = spawn(producer.command, producer.args, { stdio: ['ignore', 'pipe', 'pipe'], shell: false, windowsHide: true, ...(producer.cwd ? { cwd: producer.cwd } : {}) });
    const c = spawn(consumer.command, consumer.args, { stdio: ['pipe', 'pipe', 'pipe'], shell: false, windowsHide: true, ...(consumer.cwd ? { cwd: consumer.cwd } : {}) });
    let pErr = '';
    let cErr = '';
    let settled = false;
    const timer = setTimeout(() => {
      p.kill();
      c.kill();
      finish(new Error(`同期がタイムアウト (${timeoutMs}ms)`));
    }, timeoutMs);
    const finish = (err?: Error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (err) reject(err);
      else resolve();
    };
    p.stderr.setEncoding('utf8');
    c.stderr.setEncoding('utf8');
    p.stderr.on('data', (d: string) => (pErr += d));
    c.stderr.on('data', (d: string) => (cErr += d));
    p.on('error', (e) => finish(new Error(`${producer.command} を起動できない: ${e.message}`)));
    c.on('error', (e) => finish(new Error(`${consumer.command} を起動できない: ${e.message}`)));
    p.stdout.pipe(c.stdin);
    let pCode: number | null = null;
    let cCode: number | null = null;
    const check = () => {
      if (pCode === null || cCode === null) return;
      if (pCode !== 0) finish(new Error(`${producer.command} が失敗 (exit ${pCode}): ${pErr.trim().slice(0, 400)}`));
      else if (cCode !== 0) finish(new Error(`${consumer.command} が失敗 (exit ${cCode}): ${cErr.trim().slice(0, 400)}`));
      else finish();
    };
    p.on('close', (code) => {
      pCode = code ?? 1;
      check();
    });
    c.on('close', (code) => {
      cCode = code ?? 1;
      check();
    });
  });
}
