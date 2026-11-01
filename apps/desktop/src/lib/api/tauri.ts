import { invoke } from '@tauri-apps/api/core';
import { listen } from '@tauri-apps/api/event';
import type { IpcEvent } from '@agent-orchestrator/contracts';
import { toIpcCallError, type IpcMethod, type IpcParams, type IpcResults, type RunnerState, type Transport } from './transport';

/** IPC method → Tauri command name. One command per method; no generic dispatcher. */
const COMMANDS: Record<IpcMethod, string> = {
  'environment.check': 'environment_check',
  'project.inspect': 'project_inspect',
  'draft.create': 'draft_create',
  'draft.answer': 'draft_answer',
  'draft.revise': 'draft_revise',
  'draft.approve': 'draft_approve',
  'run.start': 'run_start',
  'run.cancel': 'run_cancel',
  'run.status': 'run_status',
  'run.list': 'run_list',
  'run.report': 'run_report'
};

export const RUNNER_EVENT = 'runner://event';

export class TauriTransport implements Transport {
  readonly kind = 'tauri' as const;
  readonly hasFolderPicker = true;

  async call<M extends IpcMethod>(method: M, params: IpcParams[M]): Promise<IpcResults[M]> {
    const command = COMMANDS[method];
    if (!command) throw toIpcCallError({ code: 'METHOD_NOT_ALLOWED', message: `許可されていないメソッドです: ${method}` });
    try {
      return (await invoke(command, { params })) as IpcResults[M];
    } catch (e) {
      throw toIpcCallError(e);
    }
  }

  onEvent(cb: (event: IpcEvent) => void): () => void {
    let disposed = false;
    let unlisten: (() => void) | null = null;
    void listen<IpcEvent>(RUNNER_EVENT, (e) => {
      if (!disposed) cb(e.payload);
    }).then((fn) => {
      if (disposed) fn();
      else unlisten = fn;
    });
    return () => {
      disposed = true;
      unlisten?.();
    };
  }

  async pickProjectFolder(): Promise<string | null> {
    try {
      return (await invoke<string | null>('pick_project_folder')) ?? null;
    } catch (e) {
      throw toIpcCallError(e);
    }
  }

  async runnerState(): Promise<RunnerState> {
    try {
      return await invoke<RunnerState>('runner_state');
    } catch (e) {
      throw toIpcCallError(e);
    }
  }
}
