import type {
  DraftApproveResult,
  DraftView,
  EnvironmentReport,
  IpcEvent,
  IpcMethod,
  ProjectInfo,
  RunReportResult,
  RunStatus,
  RunStatusResult,
  AcceptanceCriterion,
  SandboxSetupState
} from '@agent-orchestrator/contracts';

/** Params per IPC method (mirrors packages/contracts/src/ipc.ts; types only). */
export interface IpcParams {
  'environment.check': Record<string, never>;
  'project.inspect': { path: string };
  'draft.create': { projectPath: string; request: string };
  'draft.answer': {
    draftId: string;
    answers?: Array<{ questionId: string; value: string | null; skipped: boolean }>;
    back?: boolean;
  };
  'draft.revise': {
    draftId: string;
    edits: {
      title?: string;
      requirements?: string[];
      outOfScope?: string[];
      acceptanceCriteria?: AcceptanceCriterion[];
      approach?: string;
    };
  };
  'draft.approve': { draftId: string; revision: number; acknowledgeDataSharing: true };
  'run.start': { approvedTaskId: string };
  'run.cancel': { runId: string };
  'run.status': { runId: string; sinceSequence?: number };
  'run.list': { limit?: number };
  'run.report': { runId: string };
  'sandbox.setup': { acknowledgePull: true };
  'sandbox.cancel': Record<string, never>;
  'sandbox.status': Record<string, never>;
}

export interface IpcResults {
  'environment.check': EnvironmentReport;
  'project.inspect': ProjectInfo;
  'draft.create': DraftView;
  'draft.answer': DraftView;
  'draft.revise': DraftView;
  'draft.approve': DraftApproveResult;
  'run.start': RunStatus;
  'run.cancel': RunStatus;
  'run.status': RunStatusResult;
  'run.list': { runs: RunStatus[] };
  'run.report': RunReportResult;
  'sandbox.setup': SandboxSetupState;
  'sandbox.cancel': SandboxSetupState;
  'sandbox.status': SandboxSetupState;
}

export type { IpcMethod };

/** Error shape returned by the Rust side / runner (contracts IpcError). */
export interface TransportError {
  code: string;
  message: string;
  details?: unknown;
}

export class IpcCallError extends Error {
  readonly code: string;
  readonly details: unknown;
  constructor(err: TransportError) {
    super(err.message);
    this.name = 'IpcCallError';
    this.code = err.code;
    this.details = err.details;
  }
}

export function toIpcCallError(e: unknown): IpcCallError {
  if (e instanceof IpcCallError) return e;
  if (e && typeof e === 'object' && 'code' in e && 'message' in e) {
    const obj = e as { code: unknown; message: unknown; details?: unknown };
    return new IpcCallError({
      code: String(obj.code),
      message: String(obj.message),
      details: obj.details
    });
  }
  if (e instanceof Error) return new IpcCallError({ code: 'INTERNAL_ERROR', message: e.message });
  return new IpcCallError({ code: 'INTERNAL_ERROR', message: String(e) });
}

export interface RunnerState {
  alive: boolean;
  ready: boolean;
  pid: number | null;
  version: string | null;
  program: string | null;
  restarts: number;
}

export interface Transport {
  /** Human-readable name shown in the footer. */
  readonly kind: 'tauri' | 'mock';
  /** Whether a native folder picker is available. */
  readonly hasFolderPicker: boolean;
  /** 作業用コピーのフォルダーを OS のファイルマネージャーで開けるか（Tauri のみ。worktrees 配下に限定） */
  readonly canRevealWorktree: boolean;
  revealWorktree(path: string): Promise<void>;
  call<M extends IpcMethod>(method: M, params: IpcParams[M]): Promise<IpcResults[M]>;
  /** Subscribe to runner events (`run.event`, `run.updated`, `draft.updated`, `runner.ready`). Returns unsubscribe. */
  onEvent(cb: (event: IpcEvent) => void): () => void;
  pickProjectFolder(): Promise<string | null>;
  runnerState(): Promise<RunnerState>;
}
