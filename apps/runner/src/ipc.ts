import { createInterface } from 'node:readline';
import type { Readable, Writable } from 'node:stream';
import {
  DraftAnswerParams,
  DraftApproveParams,
  DraftCreateParams,
  DraftReviseParams,
  EnvironmentCheckParams,
  IPC_METHODS,
  IpcRequestSchema,
  ProjectInspectParams,
  RunCancelParams,
  RunListParams,
  RunReportParams,
  RunStartParams,
  RunStatusParams,
  type IpcErrorCode,
  type IpcEvent,
  type IpcMethod,
  type IpcRequest,
  type IpcResponse
} from '@agent-orchestrator/contracts';
import type { ZodType } from 'zod';
import { maskSecrets } from './masking.js';

/**
 * ローカル IPC（stdio、行単位 JSON-RPC 風）。SPEC §10.1。
 * - method は allowlist（contracts/ipc.schema.json）のみ。それ以外は METHOD_NOT_ALLOWED
 * - params は method ごとの Zod スキーマで検証。不正は INVALID_PARAMS
 * - 1 行 1 メッセージ。イベントは順序を保って配送し、SQLite の連番で再取得できる
 * - ネットワーク待受は行わない
 */
export class IpcError extends Error {
  constructor(
    readonly code: IpcErrorCode,
    message: string,
    readonly details?: unknown
  ) {
    super(message);
    this.name = 'IpcError';
  }
}

export type Handler = (params: unknown) => Promise<unknown>;

const PARAM_SCHEMAS: Record<IpcMethod, ZodType> = {
  'environment.check': EnvironmentCheckParams,
  'project.inspect': ProjectInspectParams,
  'draft.create': DraftCreateParams,
  'draft.answer': DraftAnswerParams,
  'draft.revise': DraftReviseParams,
  'draft.approve': DraftApproveParams,
  'run.start': RunStartParams,
  'run.cancel': RunCancelParams,
  'run.status': RunStatusParams,
  'run.list': RunListParams,
  'run.report': RunReportParams
};

export class IpcServer {
  private readonly handlers = new Map<IpcMethod, Handler>();
  private writing = Promise.resolve();

  constructor(
    private readonly input: Readable,
    private readonly output: Writable,
    private readonly log: (line: string) => void = () => undefined
  ) {}

  register(method: IpcMethod, handler: Handler): void {
    if (!IPC_METHODS.includes(method)) throw new Error(`method not in allowlist: ${method}`);
    this.handlers.set(method, handler);
  }

  /** 1 行を処理して応答を返す（テストから直接呼べる）。 */
  async handleLine(line: string): Promise<IpcResponse | null> {
    const trimmed = line.trim();
    if (trimmed === '') return null;
    let raw: unknown;
    try {
      raw = JSON.parse(trimmed);
    } catch {
      return { id: '', ok: false, error: { code: 'INVALID_REQUEST', message: 'JSON として解釈できません' } };
    }
    const id = typeof (raw as { id?: unknown })?.id === 'string' ? ((raw as { id: string }).id) : '';
    const methodRaw = (raw as { method?: unknown })?.method;
    if (typeof methodRaw === 'string' && !(IPC_METHODS as readonly string[]).includes(methodRaw)) {
      return { id, ok: false, error: { code: 'METHOD_NOT_ALLOWED', message: `許可されていない method: ${methodRaw}` } };
    }
    const parsedReq = IpcRequestSchema.safeParse(raw);
    if (!parsedReq.success) {
      return { id, ok: false, error: { code: 'INVALID_REQUEST', message: 'request の形式が不正です', details: parsedReq.error.issues.map((i) => i.message) } };
    }
    return this.dispatch(parsedReq.data);
  }

  async dispatch(req: IpcRequest): Promise<IpcResponse> {
    const handler = this.handlers.get(req.method);
    if (!handler) return { id: req.id, ok: false, error: { code: 'METHOD_NOT_ALLOWED', message: `未実装の method: ${req.method}` } };
    const params = PARAM_SCHEMAS[req.method].safeParse(req.params);
    if (!params.success) {
      return { id: req.id, ok: false, error: { code: 'INVALID_PARAMS', message: `params が不正です: ${params.error.issues.map((i) => `${i.path.join('.')} ${i.message}`).join('; ')}` } };
    }
    try {
      const result = await handler(params.data);
      return { id: req.id, ok: true, result };
    } catch (err) {
      if (err instanceof IpcError) return { id: req.id, ok: false, error: { code: err.code, message: err.message, ...(err.details !== undefined ? { details: err.details } : {}) } };
      const e = err as { code?: string; message?: string };
      const code = (e.code && (['NOT_FOUND', 'INVALID_STATE', 'INVALID_PARAMS', 'DRAFT_BLOCKED', 'TASK_NOT_APPROVED', 'VALIDATION_FAILED', 'RUN_IN_PROGRESS', 'POLICY_REJECTED', 'ENVIRONMENT_UNAVAILABLE'] as string[]).includes(e.code) ? (e.code as IpcErrorCode) : 'INTERNAL_ERROR');
      this.log(`[ipc] ${req.method} failed: ${maskSecrets(String(e.message ?? err))}`);
      return { id: req.id, ok: false, error: { code, message: maskSecrets(String(e.message ?? '内部エラー')) } };
    }
  }

  private write(message: object): void {
    const line = `${JSON.stringify(message)}\n`;
    this.writing = this.writing.then(
      () =>
        new Promise<void>((resolve) => {
          this.output.write(line, () => resolve());
        })
    );
  }

  emit(event: IpcEvent): void {
    this.write(event);
  }

  /** stdin を読み始める。応答は順序通りに書く（処理は並行してよいが、書き込みは直列）。 */
  start(): void {
    const rl = createInterface({ input: this.input, crlfDelay: Infinity });
    rl.on('line', (line) => {
      void this.handleLine(line).then((res) => {
        if (res) this.write(res);
      });
    });
    rl.on('close', () => {
      this.log('[ipc] stdin closed');
    });
  }

  /** 書き込みキューが空になるまで待つ（終了処理・テスト用）。 */
  flush(): Promise<void> {
    return this.writing;
  }
}
