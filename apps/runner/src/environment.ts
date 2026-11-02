import { accessSync, constants, existsSync, mkdirSync, rmSync, statfsSync, writeFileSync } from 'node:fs';
import { homedir, platform, release } from 'node:os';
import { join } from 'node:path';
import type { EnvironmentCheck, EnvironmentReport } from '@agent-orchestrator/contracts';
import { CLAUDE_REQUIRED_FLAGS } from './agents/claude.js';
import { CODEX_REQUIRED_FLAGS } from './agents/codex.js';
import type { RunnerConfig } from './config.js';
import { runProcess, type ProcessRunner } from './process-runner.js';
import { CONTAINER_AUX, CONTAINER_WORKSPACE, PROXY_ALIAS, PROXY_PORT } from './isolation/types.js';
import { SANDBOX_MANIFEST } from './sandbox/assets.generated.js';

/** 'a.b.c' 同士の比較（数値部分のみ） */
export function compareVersions(a: string, b: string): number {
  const pa = a.split('.').map((x) => Number.parseInt(x, 10) || 0);
  const pb = b.split('.').map((x) => Number.parseInt(x, 10) || 0);
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    const d = (pa[i] ?? 0) - (pb[i] ?? 0);
    if (d !== 0) return d;
  }
  return 0;
}

/**
 * EnvironmentAdapter（SPEC §2 クロス OS）。Tauri/Rust ↔ Node ↔ Docker(WSL2) の引き渡しとパス変換をここに閉じ込める。
 * - windows + Docker Desktop: docker CLI は Windows 側、コンテナは WSL2 の Linux VM で動く。bind mount は Windows パスをそのまま渡す
 * - linux / wsl: docker CLI と同じファイルシステム
 * 実機で確認できない構成は executionMode='unavailable' とし、実行を禁止する（fail-closed）。
 */
export type ExecutionMode = EnvironmentReport['executionMode'];

/** npm 製 CLI の JS エントリ（Windows の .cmd シム回避用） */
const NPM_CLI_ENTRIES: Record<string, string> = { claude: '@anthropic-ai/claude-code/cli.js', codex: '@openai/codex/bin/codex.js', npm: 'npm/bin/npm-cli.js' };

export interface EnvironmentAdapter {
  mode: ExecutionMode;
  /** ホストのパスを Docker の bind mount source に変換する */
  toMountSource(hostPath: string): string;
  check(): Promise<EnvironmentReport>;
  /** Docker と egress 制限の実測（Run の preflight から呼ぶ。サンドボックスイメージが必要） */
  probeIsolation(runId: string): Promise<EnvironmentCheck[]>;
}

export interface EnvironmentAdapterOptions {
  config: RunnerConfig;
  run?: ProcessRunner;
  env?: NodeJS.ProcessEnv;
}

export function detectExecutionMode(env: NodeJS.ProcessEnv = process.env, os: NodeJS.Platform = platform(), osRelease: string = release()): ExecutionMode {
  if (os === 'win32') return 'docker-desktop-windows';
  if (os === 'linux') {
    if (env.WSL_DISTRO_NAME || /microsoft/i.test(osRelease)) return 'docker-wsl';
    return 'docker-linux';
  }
  return 'unavailable';
}

export class LocalEnvironmentAdapter implements EnvironmentAdapter {
  readonly mode: ExecutionMode;
  private readonly run: ProcessRunner;
  private readonly env: NodeJS.ProcessEnv;

  constructor(private readonly options: EnvironmentAdapterOptions) {
    this.run = options.run ?? runProcess;
    this.env = options.env ?? process.env;
    this.mode = detectExecutionMode(this.env);
  }

  toMountSource(hostPath: string): string {
    // Docker Desktop (Windows) は C:\path 形式をそのまま受け付ける。WSL/Linux はそのまま。
    return hostPath;
  }

  private async version(command: string, args: string[]): Promise<{ ok: boolean; text: string; command: string; prefixArgs: string[] }> {
    // Windows では npm 製 CLI が .cmd シムで、Node は shell:false で .cmd を起動できない（EINVAL）。
    // そのため PATH 上の <cmd>.cmd を探し、同じ場所の node_modules 内の JS エントリを node で直接実行する。
    const candidates: Array<{ command: string; prefixArgs: string[] }> = [{ command, prefixArgs: [] }];
    if (process.platform === 'win32') {
      candidates.push({ command: `${command}.exe`, prefixArgs: [] });
      const entry = NPM_CLI_ENTRIES[command];
      if (entry) {
        for (const dir of (this.env.PATH ?? '').split(';')) {
          const shim = join(dir, `${command}.cmd`);
          const js = join(dir, 'node_modules', ...entry.split('/'));
          if (dir && existsSync(shim) && existsSync(js)) candidates.push({ command: 'node', prefixArgs: [js] });
        }
      }
    }
    let last = { ok: false, text: 'not found', command, prefixArgs: [] as string[] };
    for (const c of candidates) {
      const r = await this.run({ command: c.command, args: [...c.prefixArgs, ...args], inheritEnv: true, timeoutMs: 30_000 });
      const text = `${r.stdout}${r.stderr}`.trim().split('\n')[0] ?? '';
      last = { ok: r.exitCode === 0 && !r.spawnError, text: r.spawnError ? r.spawnError : text, command: c.command, prefixArgs: c.prefixArgs };
      if (last.ok) return last;
    }
    return last;
  }

  async check(): Promise<EnvironmentReport> {
    const checks: EnvironmentCheck[] = [];
    const add = (c: EnvironmentCheck) => checks.push(c);

    add({ id: 'os', label: 'OS / 実行モード', status: this.mode === 'unavailable' ? 'fail' : 'ok', detail: `${platform()} ${release()} → ${this.mode}`, fix: this.mode === 'unavailable' ? 'Windows 11 + WSL2 + Docker Desktop、または Linux + Docker が必要です' : null });

    const git = await this.version('git', ['--version']);
    add({ id: 'git', label: 'Git', status: git.ok ? 'ok' : 'fail', detail: git.text, fix: git.ok ? null : 'Git をインストールして PATH に追加してください' });

    const docker = await this.version('docker', ['--version']);
    add({ id: 'docker.cli', label: 'Docker CLI', status: docker.ok ? 'ok' : 'fail', detail: docker.text, fix: docker.ok ? null : 'Docker Desktop をインストールし、起動してください' });
    if (docker.ok) {
      const info = await this.run({ command: 'docker', args: ['info', '--format', '{{.ServerVersion}}|{{.OperatingSystem}}|{{.OSType}}'], inheritEnv: true, timeoutMs: 60_000 });
      const ok = info.exitCode === 0;
      const [server, os, osType] = info.stdout.trim().split('|');
      add({ id: 'docker.daemon', label: 'Docker デーモン', status: ok ? (osType === 'linux' ? 'ok' : 'fail') : 'fail', detail: ok ? `server ${server} (${os}, ${osType})` : info.stderr.trim().slice(0, 300) || 'docker info が失敗', fix: ok ? (osType === 'linux' ? null : 'Linux コンテナモードに切り替えてください') : 'Docker Desktop を起動してください（WSL2 バックエンド）' });
      if (this.mode === 'docker-desktop-windows') {
        add({ id: 'wsl', label: 'WSL2', status: ok && /docker desktop/i.test(os ?? '') ? 'ok' : 'warn', detail: ok ? `Docker Desktop（WSL2 バックエンド）: ${os}` : 'Docker Desktop の状態を確認できません', fix: ok ? null : 'wsl --status で WSL2 が有効か確認してください' });
      }
      // サンドボックスイメージ: 存在だけでなく、マニフェスト（version / ベースイメージのダイジェスト）と一致することを検証する（v0.1.0 公開準備）
      const setupFix = 'ホーム画面の「サンドボックスを準備する」から取得・ビルドしてください（開発環境では pnpm sandbox:build）';
      let sandboxImageInfo: { policy: 'pinned' | 'latest'; builtAt: string | null } | null = null;
      for (const [id, label, image] of [
        ['docker.image.sandbox', 'サンドボックスイメージ', this.options.config.sandboxImage],
        ['docker.image.proxy', 'egress プロキシイメージ', this.options.config.egressProxyImage]
      ] as const) {
        const r = await this.run({ command: 'docker', args: ['image', 'inspect', '--format', `{{.Id}}|{{index .Config.Labels "${SANDBOX_MANIFEST.labels.version}"}}|{{index .Config.Labels "${SANDBOX_MANIFEST.labels.baseDigest}"}}|{{index .Config.Labels "${SANDBOX_MANIFEST.labels.versionPolicy}"}}|{{index .Config.Labels "${SANDBOX_MANIFEST.labels.builtAt}"}}`, image], inheritEnv: true, timeoutMs: 30_000 });
        if (r.exitCode !== 0) {
          add({ id, label, status: 'fail', detail: `${image} が見つかりません`, fix: setupFix });
          continue;
        }
        const [imageId, version, baseDigest, policy, builtAt] = r.stdout.trim().split('|');
        // pinned（ラベル無しの旧イメージを含む）: マニフェストのダイジェストと一致 / latest: 取得時に固定したダイジェスト（sha256）が記録されていること（v0.3、D-46）
        const latestPolicy = policy === 'latest';
        const verified = version === SANDBOX_MANIFEST.version && (latestPolicy ? /^sha256:[0-9a-f]{64}$/.test(baseDigest ?? '') : baseDigest === SANDBOX_MANIFEST.baseDigest);
        if (id === 'docker.image.sandbox') sandboxImageInfo = { policy: latestPolicy ? 'latest' : 'pinned', builtAt: builtAt || null };
        add({ id, label, status: verified ? 'ok' : 'fail', detail: verified ? `${image} (${(imageId ?? '').slice(0, 19)}) 検証済み: version ${version}, base ${(baseDigest ?? '').slice(0, 19)}${latestPolicy ? `（最新版方針、取得 ${builtAt || '不明'}）` : '（固定版）'}` : `${image} はマニフェストと一致しません（version=${version || '（なし）'}, base=${(baseDigest || '（なし）').slice(0, 19)}）。使用しません`, fix: verified ? null : `${setupFix}。既存のイメージは作り直されます` });
      }
      // 同梱ツールチェーンの版（イメージ内 /etc/agent-orchestrator/versions.json）と更新の有無（v0.3、D-46）
      if (sandboxImageInfo) await this.toolchainVersions(add, sandboxImageInfo);
    }
    // CLI（ホスト側）。実行はコンテナ内のピン留め版で行うが、ホスト版の存在とフラグ互換をここで確認する
    const claude = await this.version('claude', ['--version']);
    add({ id: 'cli.claude', label: 'Claude Code CLI', status: claude.ok ? 'ok' : 'warn', detail: claude.text, fix: claude.ok ? null : 'ホストに Claude Code が無くても、サンドボックスイメージ内の版で実行します（認証ファイルは必要）' });
    if (claude.ok) {
      const help = await this.run({ command: claude.command, args: [...claude.prefixArgs, '--help'], inheritEnv: true, timeoutMs: 30_000 });
      const missing = CLAUDE_REQUIRED_FLAGS.filter((f) => !help.stdout.includes(f) && !help.stderr.includes(f));
      add({ id: 'cli.claude.flags', label: 'Claude Code フラグ互換', status: missing.length === 0 ? 'ok' : 'fail', detail: missing.length === 0 ? `必要なフラグを確認: ${CLAUDE_REQUIRED_FLAGS.length} 個` : `未対応フラグ: ${missing.join(', ')}`, fix: missing.length === 0 ? null : 'Claude Code を対応バージョン（2.1.x）に更新してください' });
    }
    const codex = await this.version('codex', ['--version']);
    add({ id: 'cli.codex', label: 'Codex CLI', status: codex.ok ? 'ok' : 'warn', detail: codex.text, fix: codex.ok ? null : 'ホストに Codex が無くても、サンドボックスイメージ内の版で実行します（認証ファイルは必要）' });
    if (codex.ok) {
      const help = await this.run({ command: codex.command, args: [...codex.prefixArgs, 'exec', '--help'], inheritEnv: true, timeoutMs: 30_000 });
      const missing = CODEX_REQUIRED_FLAGS.filter((f) => !help.stdout.includes(f) && !help.stderr.includes(f));
      add({ id: 'cli.codex.flags', label: 'Codex フラグ互換', status: missing.length === 0 ? 'ok' : 'fail', detail: missing.length === 0 ? `必要なフラグを確認: ${CODEX_REQUIRED_FLAGS.length} 個` : `未対応フラグ: ${missing.join(', ')}`, fix: missing.length === 0 ? null : 'Codex CLI を対応バージョン（0.16x）に更新してください' });
    }

    // 認証（存在のみ確認。値は読まない・表示しない）
    const home = homedir();
    const claudeAuth = Boolean(this.env.ANTHROPIC_API_KEY || this.env.CLAUDE_CODE_OAUTH_TOKEN) || existsSync(join(home, '.claude', '.credentials.json'));
    add({ id: 'auth.claude', label: 'Claude 認証', status: claudeAuth ? 'ok' : 'fail', detail: claudeAuth ? '認証情報を検出（内容は表示しません）' : '認証情報が見つかりません', fix: claudeAuth ? null : 'ホストで `claude` を一度起動してログインするか、ANTHROPIC_API_KEY を設定してください' });
    const codexAuth = Boolean(this.env.OPENAI_API_KEY) || existsSync(join(this.env.CODEX_HOME ?? join(home, '.codex'), 'auth.json'));
    add({ id: 'auth.codex', label: 'Codex 認証', status: codexAuth ? 'ok' : 'fail', detail: codexAuth ? '認証情報を検出（内容は表示しません）' : '認証情報が見つかりません', fix: codexAuth ? null : 'ホストで `codex login` を実行するか、OPENAI_API_KEY を設定してください' });

    // app-data の書き込み権限とディスク容量
    try {
      mkdirSync(this.options.config.appDataDir, { recursive: true });
      const probe = join(this.options.config.appDataDir, '.write-probe');
      writeFileSync(probe, 'ok');
      rmSync(probe);
      accessSync(this.options.config.appDataDir, constants.W_OK);
      add({ id: 'appdata.writable', label: 'app-data 書き込み', status: 'ok', detail: this.options.config.appDataDir, fix: null });
    } catch (err) {
      add({ id: 'appdata.writable', label: 'app-data 書き込み', status: 'fail', detail: `${this.options.config.appDataDir}: ${(err as Error).message}`, fix: 'AGENT_ORCHESTRATOR_APP_DATA を書き込み可能な場所に設定してください' });
    }
    try {
      const fs = statfsSync(this.options.config.appDataDir);
      const freeGb = (Number(fs.bavail) * Number(fs.bsize)) / 1024 ** 3;
      add({ id: 'disk.free', label: 'ディスク空き容量', status: freeGb >= 2 ? 'ok' : 'fail', detail: `${freeGb.toFixed(1)} GB`, fix: freeGb >= 2 ? null : '2 GB 以上の空き容量を確保してください' });
    } catch {
      add({ id: 'disk.free', label: 'ディスク空き容量', status: 'unverified', detail: '取得できません', fix: null });
    }

    add({ id: 'egress.policy', label: 'egress allowlist', status: this.options.config.egressAllowlist.length > 0 ? 'ok' : 'fail', detail: this.options.config.egressAllowlist.join(', '), fix: this.options.config.egressAllowlist.length > 0 ? null : 'AGENT_ORCHESTRATOR_EGRESS_ALLOWLIST を設定してください' });

    const canRun = this.mode !== 'unavailable' && checks.every((c) => c.status === 'ok' || c.status === 'warn');
    return { platform: `${platform()} ${release()}`, executionMode: this.mode, canRun, checks, checkedAt: new Date().toISOString() };
  }

  /** イメージに記録された版を読み、npm レジストリで最新版を確認する（ホストから読み取りのみ。到達できなければ未確認） */
  private async toolchainVersions(add: (c: EnvironmentCheck) => void, info: { policy: 'pinned' | 'latest'; builtAt: string | null }): Promise<void> {
    const r = await this.run({ command: 'docker', args: ['run', '--rm', '--network', 'none', '--entrypoint', 'cat', this.options.config.sandboxImage, '/etc/agent-orchestrator/versions.json'], inheritEnv: true, timeoutMs: 60_000 });
    let v: Record<string, string | null> | null = null;
    try {
      v = r.exitCode === 0 ? (JSON.parse(r.stdout) as Record<string, string | null>) : null;
    } catch {
      v = null;
    }
    if (!v) {
      add({ id: 'toolchain.versions', label: '同梱ツールチェーンの版', status: 'unverified', detail: 'イメージに版の記録がありません（v0.3 より前のビルド）。再ビルドすると記録されます', fix: null });
      return;
    }
    const clean = (s: string | null | undefined) => (s ?? '').replace(/^.*?(\d+\.\d+\.\d+).*$/s, '$1') || '不明';
    const installed = { claudeCode: clean(v['claudeCode']), codex: clean(v['codex']), pnpm: clean(v['pnpm']), uv: clean(v['uv']) };
    const summary = `Claude Code ${installed.claudeCode} ／ Codex ${installed.codex} ／ pnpm ${installed.pnpm} ／ npm ${clean(v['npm'])} ／ yarn ${clean(v['yarn'])} ／ ${v['python'] ?? 'Python 不明'} ／ uv ${installed.uv}（方針: ${info.policy === 'latest' ? '最新版' : '固定版'}、取得 ${v['builtAt'] ?? info.builtAt ?? '不明'}）`;
    // 最新版の確認（npm レジストリ。読み取りのみ。失敗は未確認として扱う）
    const latest: Record<string, string | null> = {};
    const npm = await this.version('npm', ['--version']); // Windows の .cmd シムを回避した起動形（node <npm-cli.js>）を得る
    for (const [key, pkg] of [['claudeCode', '@anthropic-ai/claude-code'], ['codex', '@openai/codex'], ['pnpm', 'pnpm']] as const) {
      const q = npm.ok ? await this.run({ command: npm.command, args: [...npm.prefixArgs, 'view', pkg, 'version'], inheritEnv: true, timeoutMs: 20_000 }) : null;
      latest[key] = q && q.exitCode === 0 ? q.stdout.trim().split('\n').pop()?.trim() ?? null : null;
    }
    const newer = (a: string, b: string | null | undefined) => Boolean(b) && a !== '不明' && compareVersions(b!, a) > 0;
    const outdated = (['claudeCode', 'codex', 'pnpm'] as const).filter((k) => newer(installed[k], latest[k])).map((k) => `${k === 'claudeCode' ? 'Claude Code' : k === 'codex' ? 'Codex' : 'pnpm'} ${installed[k]} → ${latest[k]}`);
    const unreachable = Object.values(latest).every((x) => x === null);
    if (unreachable) add({ id: 'toolchain.versions', label: '同梱ツールチェーンの版', status: 'ok', detail: `${summary}。最新版の確認は未実施（npm レジストリに到達できません）`, fix: null });
    else if (outdated.length === 0) add({ id: 'toolchain.versions', label: '同梱ツールチェーンの版', status: 'ok', detail: `${summary}。いずれも最新です`, fix: null });
    else if (info.policy === 'latest') add({ id: 'toolchain.versions', label: '同梱ツールチェーンの版', status: 'warn', detail: `${summary}。更新あり: ${outdated.join('、')}`, fix: 'ホーム画面の「サンドボックスを更新する」で最新版を取り直してください（既存のイメージは置き換わります）' });
    else add({ id: 'toolchain.versions', label: '同梱ツールチェーンの版', status: 'ok', detail: `${summary}。固定版です。新しい版があります: ${outdated.join('、')}（更新する場合は「サンドボックスを更新する」で最新版を選ぶか、マニフェストの固定版を更新してください）`, fix: null });
  }

  /**
   * Docker 隔離と egress 制限の実測。
   *  1. internal ネットワーク + プロキシを起動（DockerSandbox.prepare と同じ構成）
   *  2. プロービングコンテナから (a) プロキシ無しで外部へ直接接続 → 失敗すること、(b) プロキシ経由で allowlist 外 → 403、(c) allowlist 内 → 接続成立
   *  3. read-only mount に書けないこと、root になれないこと
   * いずれかが確認できなければ fail（自律実行禁止）。
   */
  async probeIsolation(runId: string): Promise<EnvironmentCheck[]> {
    const { DockerSandbox } = await import('./isolation/docker.js');
    const sandbox = new DockerSandbox({ config: this.options.config, run: this.run, prefix: 'ao-probe' });
    const checks: EnvironmentCheck[] = [];
    try {
      await sandbox.prepare(runId);
      await sandbox.putFile(runId, `${CONTAINER_AUX}/probe/marker.txt`, 'ro');
      const script = [
        'const net=require("net");const http=require("http");const fs=require("fs");',
        'const out={};',
        'function tcp(host,port,ms){return new Promise(r=>{const s=net.connect(port,host);const t=setTimeout(()=>{s.destroy();r("timeout")},ms);s.on("connect",()=>{clearTimeout(t);s.destroy();r("connected")});s.on("error",e=>{clearTimeout(t);r("error:"+e.code)});});}',
        `function viaProxy(host){return new Promise(r=>{const req=http.request({host:"${PROXY_ALIAS}",port:${PROXY_PORT},method:"CONNECT",path:host+":443"});const t=setTimeout(()=>{req.destroy();r("timeout")},8000);req.on("connect",res=>{clearTimeout(t);req.destroy();r("status:"+res.statusCode)});req.on("error",e=>{clearTimeout(t);r("error:"+e.code)});req.end();});}`,
        '(async()=>{out.direct=await tcp("1.1.1.1",443,4000);out.directDns=await tcp("example.com",443,4000);',
        `out.proxyDenied=await viaProxy("example.com");out.proxyAllowed=await viaProxy(${JSON.stringify(this.options.config.egressAllowlist[0] ?? 'api.anthropic.com')});`,
        `try{fs.writeFileSync("${CONTAINER_AUX}/probe/x.txt","w");out.roWrite="wrote"}catch(e){out.roWrite="denied:"+e.code}`,
        'out.uid=process.getuid();try{fs.writeFileSync("/etc/probe","x");out.rootWrite="wrote"}catch(e){out.rootWrite="denied:"+e.code}',
        'console.log(JSON.stringify(out));})();'
      ].join('');
      const result = await sandbox.exec(runId, {
        name: 'probe',
        argv: ['node', '-e', script],
        workspace: 'none',
        aux: 'ro',
        workdir: CONTAINER_WORKSPACE,
        env: {},
        network: 'egress',
        timeoutMs: 60_000
      });
      let out: Record<string, string | number> = {};
      try {
        out = JSON.parse(result.stdout.trim().split('\n').pop() ?? '{}') as Record<string, string | number>;
      } catch {
        out = {};
      }
      if (result.exitCode !== 0 || Object.keys(out).length === 0) {
        checks.push({ id: 'docker.isolation', label: 'Docker 隔離の実測', status: 'fail', detail: `プロービングコンテナが失敗: exit ${result.exitCode ?? 'null'} ${result.stderr.trim().slice(0, 300)}`, fix: 'pnpm sandbox:build でイメージを作り直し、Docker Desktop を再起動してください' });
        return checks;
      }
      const directBlocked = out.direct !== 'connected' && out.directDns !== 'connected';
      checks.push({ id: 'docker.egress.direct', label: 'egress: 直接通信の遮断', status: directBlocked ? 'ok' : 'fail', detail: `direct=${out.direct} dns=${out.directDns}`, fix: directBlocked ? null : 'internal ネットワークが外部に到達できています。Docker のネットワーク設定を確認してください（制限できない場合は自律実行を禁止します）' });
      const denied = out.proxyDenied === 'status:403';
      checks.push({ id: 'docker.egress.deny', label: 'egress: allowlist 外の拒否', status: denied ? 'ok' : 'fail', detail: `example.com → ${out.proxyDenied}`, fix: denied ? null : 'egress プロキシが allowlist 外を拒否していません。イメージを再ビルドしてください' });
      const allowed = out.proxyAllowed === 'status:200';
      checks.push({ id: 'docker.egress.allow', label: 'egress: allowlist 内の到達', status: allowed ? 'ok' : 'fail', detail: `${this.options.config.egressAllowlist[0]} → ${out.proxyAllowed}`, fix: allowed ? null : 'インターネット接続と allowlist を確認してください' });
      const roOk = typeof out.roWrite === 'string' && out.roWrite.startsWith('denied');
      checks.push({ id: 'docker.readonly', label: 'read-only mount への書込拒否', status: roOk ? 'ok' : 'fail', detail: String(out.roWrite), fix: roOk ? null : 'bind mount の readonly が効いていません' });
      const nonRoot = out.uid === 1001 && typeof out.rootWrite === 'string' && out.rootWrite.startsWith('denied');
      checks.push({ id: 'docker.nonroot', label: '非 root 実行', status: nonRoot ? 'ok' : 'fail', detail: `uid=${out.uid} rootWrite=${out.rootWrite}`, fix: nonRoot ? null : 'コンテナが非 root で動いていません' });
    } catch (err) {
      checks.push({ id: 'docker.isolation', label: 'Docker 隔離の実測', status: 'fail', detail: (err as Error).message, fix: 'Docker Desktop の起動、イメージのビルド（pnpm sandbox:build）、ネットワーク作成権限を確認してください' });
    } finally {
      await sandbox.cleanup(runId).catch(() => undefined);
    }
    return checks;
  }
}
