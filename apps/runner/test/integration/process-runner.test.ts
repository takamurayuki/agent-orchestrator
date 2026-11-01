import { describe, expect, it } from 'vitest';
import { assertAllowedCommand, runProcess } from '../../src/process-runner.js';

describe('process runner (SEC-06 / SEC-05 / EX-12)', () => {
  it('passes shell metacharacters literally (shell:false)', async () => {
    const arg = 'hello; rm -rf / && echo $(whoami) | cat > x';
    const r = await runProcess({ command: 'node', args: ['-e', 'process.stdout.write(process.argv[1])', arg], inheritEnv: true, timeoutMs: 20_000 });
    expect(r.exitCode).toBe(0);
    expect(r.stdout).toBe(arg);
  });

  it('refuses commands outside the allowlist', async () => {
    expect(() => assertAllowedCommand('bash')).toThrow(/allowlist/);
    expect(() => assertAllowedCommand('powershell.exe')).toThrow(/allowlist/);
    expect(() => assertAllowedCommand('node')).not.toThrow();
    await expect(runProcess({ command: 'cmd.exe', args: ['/c', 'echo hi'] })).rejects.toThrow();
  });

  it('kills the process tree on timeout and reports timedOut', async () => {
    const r = await runProcess({ command: 'node', args: ['-e', 'setInterval(() => {}, 1000)'], inheritEnv: true, timeoutMs: 500 });
    expect(r.timedOut).toBe(true);
    expect(r.exitCode === null || r.exitCode !== 0).toBe(true);
    expect(r.durationMs).toBeLessThan(10_000);
  });

  it('aborts via AbortSignal', async () => {
    const controller = new AbortController();
    setTimeout(() => controller.abort(), 200);
    const r = await runProcess({ command: 'node', args: ['-e', 'setInterval(() => {}, 1000)'], inheritEnv: true, signal: controller.signal, timeoutMs: 10_000 });
    expect(r.aborted).toBe(true);
  });

  it('masks secrets and truncates oversized output', async () => {
    const r = await runProcess({ command: 'node', args: ['-e', 'console.log("ANTHROPIC_API_KEY=sk-ant-api03-abcdefghijklmnop1234 " + "x".repeat(5000))'], inheritEnv: true, maxOutputBytes: 1000, timeoutMs: 20_000 });
    expect(r.stdout).not.toContain('sk-ant-api03');
    expect(r.truncated).toBe(true);
  });

  it('does not leak the parent environment unless inheritEnv is set', async () => {
    const r = await runProcess({ command: 'node', args: ['-e', 'process.stdout.write(String(process.env.AO_TEST_SECRET ?? "undefined"))'], env: {}, timeoutMs: 20_000 });
    expect(r.stdout).toBe('undefined');
  });
});

describe('process runner allowlist (Windows CLI shims)', () => {
  it('accepts .exe/.cmd variants of the fixed CLIs and tar, but nothing else', () => {
    for (const c of ['claude.exe', 'codex.exe', 'pnpm.cmd', 'tar', 'tar.exe', 'C:\\nvm4w\\nodejs\\node.exe']) expect(() => assertAllowedCommand(c)).not.toThrow();
    for (const c of ['curl', 'cmd.exe', 'powershell', 'sh', 'codex.ps1']) expect(() => assertAllowedCommand(c)).toThrow(/allowlist/);
  });
});
