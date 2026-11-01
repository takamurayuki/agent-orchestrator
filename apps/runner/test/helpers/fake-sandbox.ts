import type { SandboxExecutor, SandboxStep } from '../../src/isolation/types.js';
import type { ProcessResult } from '../../src/process-runner.js';

export type StepHandler = (step: SandboxStep) => Promise<Partial<ProcessResult>> | Partial<ProcessResult>;

/** SandboxExecutor のフェイク。ステップ名のパターンごとに結果を返し、受け取った step を記録する。 */
export class FakeSandbox implements SandboxExecutor {
  steps: SandboxStep[] = [];
  prepared: string[] = [];
  cleaned: string[] = [];
  constructor(private readonly handler: StepHandler = () => ({})) {}

  async prepare(runId: string): Promise<void> {
    this.prepared.push(runId);
  }

  async exec(_runId: string, step: SandboxStep): Promise<ProcessResult> {
    this.steps.push(step);
    const partial = await this.handler(step);
    const result: ProcessResult = {
      command: 'docker',
      args: step.argv,
      exitCode: 0,
      signal: null,
      stdout: '',
      stderr: '',
      truncated: false,
      timedOut: false,
      aborted: false,
      durationMs: 1,
      spawnError: null,
      ...partial
    };
    if (result.stdout) step.onStdout?.(result.stdout);
    if (result.stderr) step.onStderr?.(result.stderr);
    return result;
  }

  files = new Map<string, string>();
  pushed: string[] = [];
  pulled: string[] = [];
  async pushWorkspace(_runId: string, hostDir: string): Promise<void> {
    this.pushed.push(hostDir);
  }
  async pullWorkspace(_runId: string, hostDir: string): Promise<void> {
    this.pulled.push(hostDir);
  }
  async putFile(_runId: string, containerPath: string, content: string): Promise<void> {
    this.files.set(containerPath, content);
  }
  async getFile(_runId: string, containerPath: string): Promise<string | null> {
    return this.files.get(containerPath) ?? null;
  }
  async egressLog(): Promise<string> {
    return '';
  }

  async cleanup(runId: string): Promise<void> {
    this.cleaned.push(runId);
  }
}
