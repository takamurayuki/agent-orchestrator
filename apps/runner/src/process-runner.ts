import { spawn, type ChildProcess } from 'node:child_process';
import { maskSecrets, truncateBytes } from './masking.js';

/**
 * 子プロセス実行器。常に `shell:false`、argv 配列のみ（SEC-06）。
 * タイムアウトで停止し、出力はサイズ上限で打ち切り、マスキングして返す。
 */
export interface ProcessRequest {
  command: string;
  args: string[];
  cwd?: string;
  env?: Record<string, string>;
  /** 親の環境変数を継承するか（既定 false。CLI 認証などは明示的に env で渡す） */
  inheritEnv?: boolean;
  stdin?: string;
  timeoutMs?: number;
  maxOutputBytes?: number;
  /** ログからマスキングすべき値（認証トークンなど） */
  secrets?: readonly string[];
  signal?: AbortSignal;
  onStdout?: (chunk: string) => void;
  onStderr?: (chunk: string) => void;
}

export interface ProcessResult {
  command: string;
  args: string[];
  exitCode: number | null;
  signal: NodeJS.Signals | null;
  stdout: string;
  stderr: string;
  truncated: boolean;
  timedOut: boolean;
  aborted: boolean;
  durationMs: number;
  spawnError: string | null;
}

export type ProcessRunner = (request: ProcessRequest) => Promise<ProcessResult>;

// コマンド名に許さない文字（shell:false なので解釈はされないが、allowlist の名前解決を素直に保つ）。バックスラッシュは Windows のパス区切りとして許可
const SHELL_META = /[;&|<>`$(){}[\]!*?~\n\r]/;

/** argv に明らかなシェルメタ文字が含まれていても、shell:false なので解釈はされない。ただし CLI 名は固定の allowlist に限定する。 */
export const ALLOWED_COMMANDS = new Set(['git', 'docker', 'claude', 'codex', 'node', 'pnpm', 'tar', 'wsl', 'wsl.exe', 'docker.exe', 'git.exe', 'node.exe', 'tar.exe', 'claude.exe', 'codex.exe', 'pnpm.cmd', 'claude.cmd', 'codex.cmd']);

export function assertAllowedCommand(command: string): void {
  const base = command.replace(/\\/g, '/').split('/').pop() ?? command;
  if (!ALLOWED_COMMANDS.has(base)) throw new Error(`command not in allowlist: ${command}`);
  if (SHELL_META.test(command)) throw new Error(`command contains shell metacharacters: ${command}`);
}

export function killProcessTree(child: ChildProcess): void {
  if (child.pid === undefined || child.exitCode !== null) return;
  if (process.platform === 'win32') {
    // Windows: taskkill でプロセスツリーを止める（shell:false）
    try {
      spawn('taskkill', ['/pid', String(child.pid), '/T', '/F'], { stdio: 'ignore', windowsHide: true });
    } catch {
      child.kill();
    }
  } else {
    try {
      process.kill(-child.pid, 'SIGTERM');
    } catch {
      child.kill('SIGTERM');
    }
    setTimeout(() => {
      try {
        if (child.exitCode === null) process.kill(-child.pid!, 'SIGKILL');
      } catch {
        /* already gone */
      }
    }, 3000).unref();
  }
}

export const runProcess: ProcessRunner = (request) => {
  try {
    assertAllowedCommand(request.command);
  } catch (err) {
    return Promise.reject(err);
  }
  const startedAt = Date.now();
  const maxBytes = request.maxOutputBytes ?? 2 * 1024 * 1024;
  return new Promise<ProcessResult>((resolve) => {
    let child: ChildProcess;
    const env = request.inheritEnv ? { ...process.env, ...(request.env ?? {}) } : { PATH: process.env.PATH ?? '', ...(process.platform === 'win32' ? { SYSTEMROOT: process.env.SYSTEMROOT ?? '', USERPROFILE: process.env.USERPROFILE ?? '', PATHEXT: process.env.PATHEXT ?? '' } : { HOME: process.env.HOME ?? '' }), ...(request.env ?? {}) };
    try {
      child = spawn(request.command, request.args, {
        cwd: request.cwd,
        env,
        shell: false,
        windowsHide: true,
        detached: process.platform !== 'win32',
        stdio: [request.stdin === undefined ? 'ignore' : 'pipe', 'pipe', 'pipe']
      });
    } catch (err) {
      resolve({ command: request.command, args: request.args, exitCode: null, signal: null, stdout: '', stderr: '', truncated: false, timedOut: false, aborted: false, durationMs: Date.now() - startedAt, spawnError: (err as Error).message });
      return;
    }
    let stdout = '';
    let stderr = '';
    let outBytes = 0;
    let truncated = false;
    let timedOut = false;
    let aborted = false;
    let spawnError: string | null = null;

    const push = (chunk: string, target: 'stdout' | 'stderr') => {
      outBytes += Buffer.byteLength(chunk);
      if (outBytes > maxBytes) {
        truncated = true;
        return;
      }
      if (target === 'stdout') {
        stdout += chunk;
        request.onStdout?.(maskSecrets(chunk, request.secrets));
      } else {
        stderr += chunk;
        request.onStderr?.(maskSecrets(chunk, request.secrets));
      }
    };
    child.stdout?.setEncoding('utf8');
    child.stderr?.setEncoding('utf8');
    child.stdout?.on('data', (c: string) => push(c, 'stdout'));
    child.stderr?.on('data', (c: string) => push(c, 'stderr'));

    const timer = request.timeoutMs !== undefined ? setTimeout(() => { timedOut = true; killProcessTree(child); }, request.timeoutMs) : undefined;
    const onAbort = () => { aborted = true; killProcessTree(child); };
    request.signal?.addEventListener('abort', onAbort, { once: true });
    if (request.signal?.aborted) onAbort();

    child.on('error', (err) => { spawnError = err.message; });
    child.on('close', (code, signal) => {
      if (timer) clearTimeout(timer);
      request.signal?.removeEventListener('abort', onAbort);
      const out = truncateBytes(maskSecrets(stdout, request.secrets), maxBytes);
      const errOut = truncateBytes(maskSecrets(stderr, request.secrets), maxBytes);
      resolve({ command: request.command, args: request.args, exitCode: code, signal, stdout: out.text, stderr: errOut.text, truncated: truncated || out.truncated || errOut.truncated, timedOut, aborted, durationMs: Date.now() - startedAt, spawnError });
    });
    if (request.stdin !== undefined && child.stdin) {
      child.stdin.end(request.stdin);
    }
  });
};
