import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { loadConfig } from '../../apps/runner/src/config.js';
import { LocalEnvironmentAdapter } from '../../apps/runner/src/environment.js';
import { DockerSandbox } from '../../apps/runner/src/isolation/docker.js';
import { CONTAINER_AUX, CONTAINER_WORKSPACE } from '../../apps/runner/src/isolation/types.js';

/**
 * 実 Docker を使うサンドボックス隔離の実測（SEC-01..04、SEC-09 の OS レベル検証、ワークスペース同期）。
 * RUN_DOCKER_TESTS=1 かつ `pnpm sandbox:build` 済みのときだけ実行する。
 */
const enabled = process.env.RUN_DOCKER_TESTS === '1';
const d = enabled ? describe : describe.skip;

d('Docker sandbox (live docker)', () => {
  const config = loadConfig({ AGENT_ORCHESTRATOR_APP_DATA: mkdtempSync(join(tmpdir(), 'ao-docker-')) });
  const runId = `t${Date.now().toString(36)}`;
  const sandbox = new DockerSandbox({ config, prefix: 'ao-test' });
  const noAccess = { workspace: 'none' as const, aux: 'none' as const, workdir: CONTAINER_WORKSPACE, env: {}, network: 'none' as const };
  afterAll(async () => {
    await sandbox.cleanup(runId);
    rmSync(config.appDataDir, { recursive: true, force: true });
  });

  it('SEC-02: probe confirms direct egress blocked, allowlist enforced, read-only volume and non-root', async () => {
    const adapter = new LocalEnvironmentAdapter({ config });
    const checks = await adapter.probeIsolation(`${runId}p`);
    const byId = Object.fromEntries(checks.map((c) => [c.id, c]));
    for (const id of ['docker.egress.direct', 'docker.egress.deny', 'docker.egress.allow', 'docker.readonly', 'docker.nonroot']) {
      expect(byId[id]?.status, JSON.stringify(byId[id] ?? checks)).toBe('ok');
    }
  }, 300_000);

  it('workspace push/pull mirrors files (including .git and deletions) and excludes node_modules', async () => {
    const host = mkdtempSync(join(tmpdir(), 'ao-ws-'));
    mkdirSync(join(host, 'src'));
    writeFileSync(join(host, 'src', 'a.txt'), 'a');
    writeFileSync(join(host, 'keep.txt'), 'keep');
    execFileSync('git', ['init', '-q'], { cwd: host });
    await sandbox.pushWorkspace(runId, host);
    // コンテナ内で変更: 追加・削除・node_modules 作成
    const r = await sandbox.exec(runId, { ...noAccess, name: 'mutate', argv: ['sh', '-c', 'ls -la /workspace && rm /workspace/src/a.txt && echo new > /workspace/src/b.txt && mkdir -p /workspace/node_modules/x && echo m > /workspace/node_modules/x/i.js && test -d /workspace/.git && echo gitok'], workspace: 'rw', timeoutMs: 60_000 });
    expect(r.stdout).toContain('gitok');
    await sandbox.pullWorkspace(runId, host);
    expect(existsSync(join(host, 'src', 'a.txt'))).toBe(false);
    expect(readFileSync(join(host, 'src', 'b.txt'), 'utf8').trim()).toBe('new');
    expect(readFileSync(join(host, 'keep.txt'), 'utf8')).toBe('keep');
    expect(existsSync(join(host, 'node_modules'))).toBe(false);
    expect(existsSync(join(host, '.git'))).toBe(true);
    rmSync(host, { recursive: true, force: true });
  }, 300_000);

  it('SEC-03 / SEC-04: writes to a read-only workspace and outside the workspace are refused; --network none has no DNS', async () => {
    const ro = await sandbox.exec(runId, { ...noAccess, name: 'ro', argv: ['node', '-e', 'try{require("fs").writeFileSync("/workspace/x.txt","x");console.log("wrote")}catch(e){console.log("denied:"+e.code)}'], workspace: 'ro', timeoutMs: 60_000 });
    expect(ro.stdout.trim()).toMatch(/^denied:(EROFS|EACCES|EPERM)$/);
    const outside = await sandbox.exec(runId, { ...noAccess, name: 'outside', argv: ['node', '-e', 'try{require("fs").writeFileSync("/usr/local/evil","x");console.log("wrote")}catch(e){console.log("denied:"+e.code)}'], timeoutMs: 60_000 });
    expect(outside.stdout.trim()).toMatch(/^denied:/);
    const net = await sandbox.exec(runId, { ...noAccess, name: 'nonet', argv: ['node', '-e', 'require("dns").lookup("example.com",(e)=>console.log(e?"nodns:"+e.code:"resolved"))'], timeoutMs: 60_000 });
    expect(net.stdout.trim()).toMatch(/^nodns:/);
  }, 300_000);

  it('aux putFile/getFile round-trips with owner 1001 and mode 0600', async () => {
    await sandbox.putFile(runId, `${CONTAINER_AUX}/t/secret.json`, '{"a":1}');
    const r = await sandbox.exec(runId, { ...noAccess, name: 'aux', argv: ['sh', '-c', 'stat -c "%u %a" /aux/t/secret.json && cat /aux/t/secret.json && echo out > /aux/t/out.txt'], aux: 'rw', timeoutMs: 60_000 });
    expect(r.stdout).toContain('1001 600');
    expect(r.stdout).toContain('{"a":1}');
    expect((await sandbox.getFile(runId, `${CONTAINER_AUX}/t/out.txt`))?.trim()).toBe('out');
    expect(await sandbox.getFile(runId, `${CONTAINER_AUX}/t/missing.txt`)).toBeNull();
  }, 300_000);

  it('D-22: the reviewer seccomp profile lets bubblewrap create a user namespace, while the default profile does not', async () => {
    const bwrap = '/usr/local/lib/node_modules/@openai/codex/node_modules/@openai/codex-linux-x64/vendor/x86_64-unknown-linux-musl/codex-resources/bwrap';
    const cmd = ['sh', '-c', `${bwrap} --unshare-all --ro-bind / / --proc /proc --dev /dev --tmpfs /tmp --die-with-parent -- /bin/sh -c 'echo bwrap-ok' 2>&1`];
    const blocked = await sandbox.exec(runId, { ...noAccess, name: 'bwrap-default', argv: cmd, timeoutMs: 60_000 });
    expect(blocked.stdout).toContain('No permissions to create a new namespace');
    const allowed = await sandbox.exec(runId, { ...noAccess, name: 'bwrap-profile', argv: cmd, timeoutMs: 60_000, allowUserNamespaces: true });
    expect(allowed.stdout.trim()).toBe('bwrap-ok');
    expect(allowed.args.join(' ')).toContain('seccomp-reviewer.json');
    expect(allowed.args.join(' ')).not.toContain('unconfined');
    // capability は落ちたまま: root 所有ファイルへの書込・hostname 変更は拒否される
    const caps = await sandbox.exec(runId, { ...noAccess, name: 'bwrap-caps', argv: ['sh', '-c', 'hostname evil 2>&1; echo x > /etc/evil 2>&1; cat /proc/self/status | grep CapEff'], timeoutMs: 60_000, allowUserNamespaces: true });
    expect(caps.stdout).toContain('CapEff:	0000000000000000');
    expect(caps.stdout).toMatch(/Operation not permitted|Permission denied|Read-only file system|must be root/);
  }, 180_000);

  it('EX-12: timeout kills the container', async () => {
    const started = Date.now();
    const r = await sandbox.exec(runId, { ...noAccess, name: 'sleep', argv: ['node', '-e', 'setInterval(()=>{},1000)'], timeoutMs: 3000 });
    expect(Date.now() - started).toBeLessThan(60_000);
    expect(r.timedOut).toBe(true);
  }, 120_000);

  it('image contains pinned CLIs and runs as uid 1001', async () => {
    const r = await sandbox.exec(runId, { ...noAccess, name: 'versions', argv: ['node', '-e', 'const {execFileSync:x}=require("child_process");console.log(JSON.stringify({node:process.version,claude:x("claude",["--version"]).toString().trim(),codex:x("codex",["--version"]).toString().trim(),pnpm:x("pnpm",["--version"]).toString().trim(),uid:process.getuid()}))'], timeoutMs: 120_000 });
    const out = JSON.parse(r.stdout.trim().split('\n').pop() ?? '{}') as Record<string, string | number>;
    expect(String(out.claude)).toContain('2.1.316');
    expect(String(out.codex)).toContain('0.163.0');
    expect(out.uid).toBe(1001);
  }, 180_000);
});
