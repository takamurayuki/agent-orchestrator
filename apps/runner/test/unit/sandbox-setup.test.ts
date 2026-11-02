import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { SandboxSetupState } from '@agent-orchestrator/contracts';
import { loadConfig } from '../../src/config.js';
import type { ProcessRequest, ProcessResult } from '../../src/process-runner.js';
import { SANDBOX_MANIFEST } from '../../src/sandbox/assets.generated.js';
import { SandboxSetupService } from '../../src/sandbox/setup.js';

/** docker の固定引数だけを受け付けるスクリプト化ランナー。呼び出しを記録し、シナリオに応じて失敗させる。 */
function scripted(opts: { baseDigest?: string; failBuild?: string; labels?: string; abortOn?: string; controller?: AbortController } = {}) {
  const calls: string[][] = [];
  const result = (over: Partial<ProcessResult>): ProcessResult => ({ command: 'docker', args: [], exitCode: 0, signal: null, stdout: '', stderr: '', truncated: false, timedOut: false, aborted: false, durationMs: 1, spawnError: null, ...over });
  const run = async (req: ProcessRequest): Promise<ProcessResult> => {
    expect(req.command).toBe('docker');
    calls.push(req.args);
    const [sub] = req.args;
    if (opts.abortOn && req.args.join(' ').includes(opts.abortOn)) {
      opts.controller?.abort();
      return result({ exitCode: null, aborted: true });
    }
    if (req.signal?.aborted) return result({ exitCode: null, aborted: true });
    if (sub === 'info') return result({ stdout: '29.8.2|linux\n' });
    if (sub === 'pull') {
      req.onStdout?.('Digest: sha256:deadbeef\nStatus: Downloaded\n');
      return result({});
    }
    if (sub === 'image' && req.args[1] === 'inspect' && req.args[3]?.includes('RepoDigests')) return result({ stdout: `["node@${opts.baseDigest ?? SANDBOX_MANIFEST.baseDigest}"]\n` });
    if (sub === 'image' && req.args[1] === 'inspect' && req.args[3]?.includes('Labels') && opts.labels === 'echo-build') {
      const build = calls.find((c) => c[0] === 'build')!;
      const label = (k: string) => build.find((x) => x.startsWith(`${k}=`))!.slice(k.length + 1);
      return result({ stdout: `${label(SANDBOX_MANIFEST.labels.version)}|${label(SANDBOX_MANIFEST.labels.baseDigest)}\n` });
    }
    if (sub === 'build') {
      const tag = req.args[req.args.indexOf('-t') + 1]!;
      req.onStdout?.(`#1 [internal] load build definition\nSECRET=sk-ant-api03-abcdefghijklmnopqrstuvwxyz0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZ-abcdefghijklmnopqrstAA\n`);
      if (opts.failBuild && tag.includes(opts.failBuild)) return result({ exitCode: 1, stderr: 'npm ERR! network request failed' });
      return result({});
    }
    if (sub === 'image' && req.args[1] === 'inspect' && req.args[3]?.includes('Labels')) return result({ stdout: `${opts.labels ?? `${SANDBOX_MANIFEST.version}|${SANDBOX_MANIFEST.baseDigest}`}\n` });
    if (sub === 'rmi') return result({});
    throw new Error(`unexpected docker args: ${req.args.join(' ')}`);
  };
  return { run, calls };
}

let appData: string;
beforeEach(() => {
  appData = mkdtempSync(join(tmpdir(), 'ao-sandbox-'));
});
afterEach(() => rmSync(appData, { recursive: true, force: true }));

const service = (runner: ReturnType<typeof scripted>, progress: SandboxSetupState[] = []) =>
  new SandboxSetupService({ config: loadConfig({ AGENT_ORCHESTRATOR_APP_DATA: appData }), run: runner.run, onProgress: (s) => progress.push(s) });

const settle = async (svc: SandboxSetupService) => {
  for (let i = 0; i < 200 && svc.status().state === 'running'; i++) await new Promise((r) => setTimeout(r, 5));
  return svc.status();
};

describe('SandboxSetupService (GUI-driven image setup, D-36)', () => {
  it('requires explicit consent before pulling anything from the registry', () => {
    const runner = scripted();
    const svc = service(runner);
    expect(() => svc.start({ acknowledgePull: false })).toThrow(/同意/);
    expect(runner.calls).toEqual([]);
    expect(svc.status().state).toBe('idle');
  });

  it('runs the fixed sequence: docker info → pull pinned base → verify digest → build both images with labels → verify labels', async () => {
    const runner = scripted();
    const progress: SandboxSetupState[] = [];
    const svc = service(runner, progress);
    svc.start({ acknowledgePull: true });
    const final = await settle(svc);
    expect(final.state).toBe('succeeded');
    expect(final.steps.map((s) => s.status)).toEqual(['ok', 'ok', 'ok', 'ok', 'ok', 'ok']);
    const base = `${SANDBOX_MANIFEST.baseImage}@${SANDBOX_MANIFEST.baseDigest}`;
    expect(runner.calls[1]).toEqual(['pull', base]);
    const builds = runner.calls.filter((c) => c[0] === 'build');
    expect(builds).toHaveLength(2);
    for (const b of builds) {
      expect(b).toContain('--pull=false');
      expect(b).toContain(`NODE_IMAGE=${base}`);
      expect(b).toContain(`${SANDBOX_MANIFEST.labels.version}=${SANDBOX_MANIFEST.version}`);
      expect(b).toContain(`${SANDBOX_MANIFEST.labels.baseDigest}=${SANDBOX_MANIFEST.baseDigest}`);
      // コンテキストは app-data 配下の一時ディレクトリ（埋め込みアセットから書き出し）。終了後に削除される
      expect(b[b.length - 1]).toContain(appData);
    }
    expect(builds[0]![builds[0]!.indexOf('-t') + 1]).toContain('egress-proxy');
    expect(builds[1]![builds[1]!.indexOf('-t') + 1]).toContain('sandbox');
    // 進捗イベントが流れ、ログは秘密情報をマスキング
    expect(progress.length).toBeGreaterThan(6);
    expect(final.logTail.join('\n')).not.toContain('sk-ant-api03-abcdefghijklmnopqrstuvwxyz');
    expect(final.logTail.join('\n')).toContain('load build definition');
    expect(final.manifest.images.map((i) => i.tag)).toEqual(['agent-orchestrator-egress-proxy:0.1.0', 'agent-orchestrator-sandbox:0.1.0']);
  });

  it('stops before building when the pulled base image digest does not match the manifest', async () => {
    const runner = scripted({ baseDigest: 'sha256:0000000000000000000000000000000000000000000000000000000000000000' });
    const svc = service(runner);
    svc.start({ acknowledgePull: true });
    const final = await settle(svc);
    expect(final.state).toBe('failed');
    expect(final.error?.code).toBe('BASE_DIGEST_MISMATCH');
    expect(final.error?.fix).toContain('停止');
    expect(final.steps.find((s) => s.id === 'base.verify')?.status).toBe('fail');
    expect(runner.calls.some((c) => c[0] === 'build')).toBe(false);
  });

  it('reports a build failure with cause and recovery, leaving the other image untouched', async () => {
    const runner = scripted({ failBuild: 'sandbox' });
    const svc = service(runner);
    svc.start({ acknowledgePull: true });
    const final = await settle(svc);
    expect(final.state).toBe('failed');
    expect(final.error?.code).toBe('BUILD_FAILED');
    expect(final.error?.message).toContain('npm ERR!');
    expect(final.error?.fix).toContain('再試行');
    expect(final.steps.find((s) => s.id === 'build.proxy')?.status).toBe('ok');
    expect(final.steps.find((s) => s.id === 'build.sandbox')?.status).toBe('fail');
    expect(final.steps.find((s) => s.id === 'verify')?.status).toBe('pending');
  });

  it('removes an image whose labels do not match the manifest and fails (the unverified image is never used)', async () => {
    const runner = scripted({ labels: '0.0.9|sha256:bad' });
    const svc = service(runner);
    svc.start({ acknowledgePull: true });
    const final = await settle(svc);
    expect(final.state).toBe('failed');
    expect(final.error?.code).toBe('IMAGE_VERIFY_FAILED');
    expect(runner.calls.some((c) => c[0] === 'rmi' && c.includes('agent-orchestrator-egress-proxy:0.1.0'))).toBe(true);
  });

  it('can be cancelled while running and then retried', async () => {
    const controller = new AbortController();
    const runner = scripted({ abortOn: 'pull', controller });
    const svc = service(runner);
    svc.start({ acknowledgePull: true });
    // ランナーが pull 中に abort させる（cancel() 相当の signal を共有できないため、サービス側の signal を使う）
    await new Promise((r) => setTimeout(r, 10));
    let final = svc.status();
    if (final.state === 'running') {
      svc.cancel();
      final = await settle(svc);
    }
    expect(['cancelled', 'failed']).toContain(final.state);
    expect(() => svc.cancel()).toThrow(/実行中/);
    // 再試行できる
    const runner2 = scripted();
    const svc2 = new SandboxSetupService({ config: loadConfig({ AGENT_ORCHESTRATOR_APP_DATA: appData }), run: runner2.run });
    svc2.start({ acknowledgePull: true });
    expect((await settle(svc2)).state).toBe('succeeded');
  });

  it('refuses a second concurrent setup', async () => {
    const runner = scripted();
    const svc = service(runner);
    svc.start({ acknowledgePull: true });
    expect(() => svc.start({ acknowledgePull: true })).toThrow(/既に実行中/);
    await settle(svc);
  });

  it('v0.3 (D-46): latest policy pulls the floating tag, pins the build to the digest it got, and labels the policy', async () => {
    const got = `sha256:${'b'.repeat(64)}`;
    const runner = scripted({ baseDigest: got, labels: 'echo-build' });
    const svc = service(runner);
    svc.start({ acknowledgePull: true, versionPolicy: 'latest' });
    const final = await settle(svc);
    expect(final.state).toBe('succeeded');
    expect(runner.calls[1]).toEqual(['pull', SANDBOX_MANIFEST.baseImageLatest]);
    const builds = runner.calls.filter((c) => c[0] === 'build');
    expect(builds).toHaveLength(2);
    for (const b of builds) {
      expect(b).toContain(`NODE_IMAGE=${SANDBOX_MANIFEST.baseImageLatest}@${got}`);
      expect(b).toContain('VERSION_POLICY=latest');
      expect(b).toContain('CLAUDE_CODE_VERSION=latest');
      expect(b).toContain('CODEX_VERSION=latest');
      expect(b).toContain(`${SANDBOX_MANIFEST.labels.baseDigest}=${got}`);
      expect(b).toContain(`${SANDBOX_MANIFEST.labels.versionPolicy}=latest`);
      expect(b.some((a) => a.startsWith(`${SANDBOX_MANIFEST.labels.builtAt}=20`))).toBe(true);
    }
    expect(final.steps.find((s) => s.id === 'base.verify')?.detail).toContain(got);
  });

  it('v0.3 (D-46): pinned policy (default) keeps the manifest digest check and never passes latest build args', async () => {
    const runner = scripted({ labels: 'echo-build' });
    const svc = service(runner);
    svc.start({ acknowledgePull: true, versionPolicy: 'pinned' });
    const final = await settle(svc);
    expect(final.state).toBe('succeeded');
    for (const b of runner.calls.filter((c) => c[0] === 'build')) {
      expect(b).toContain('VERSION_POLICY=pinned');
      expect(b.some((a) => a.includes('=latest'))).toBe(false);
      expect(b).toContain(`${SANDBOX_MANIFEST.labels.versionPolicy}=pinned`);
    }
    expect(() => service(scripted()).start({ acknowledgePull: true, versionPolicy: 'nightly' as unknown as 'pinned' })).toThrow(/versionPolicy/);
  });
});
