import { z } from 'zod';
import { DraftViewSchema } from './draft.js';
import { PolicyFindingSchema, RunEventSchema, RunStatusSchema } from './run.js';
import { AcceptanceCriterionSchema } from './task.js';

/** MVP で許可する IPC method（contracts/ipc.schema.json と同一の allowlist）。 */
export const IPC_METHODS = [
  'environment.check',
  'project.inspect',
  'draft.create',
  'draft.answer',
  'draft.revise',
  'draft.approve',
  'run.start',
  'run.cancel',
  'run.status',
  'run.list',
  'run.report'
] as const;
export type IpcMethod = (typeof IPC_METHODS)[number];

export const IpcRequestSchema = z.strictObject({
  id: z.string(),
  method: z.enum(IPC_METHODS),
  params: z.record(z.string(), z.unknown())
});
export type IpcRequest = z.infer<typeof IpcRequestSchema>;

export const IpcErrorSchema = z.object({
  code: z.string(),
  message: z.string(),
  details: z.unknown().optional()
});
export type IpcError = z.infer<typeof IpcErrorSchema>;

export const IpcResponseSchema = z.strictObject({
  id: z.string(),
  ok: z.boolean(),
  result: z.unknown().optional(),
  error: IpcErrorSchema.optional()
});
export type IpcResponse = z.infer<typeof IpcResponseSchema>;

export const IpcEventSchema = z.strictObject({
  event: z.string(),
  runId: z.string().optional(),
  payload: z.record(z.string(), z.unknown())
});
export type IpcEvent = z.infer<typeof IpcEventSchema>;

export const IpcMessageSchema = z.union([IpcRequestSchema, IpcResponseSchema, IpcEventSchema]);
export type IpcMessage = z.infer<typeof IpcMessageSchema>;

/** エラーコード。UI はコードで分岐し、message は表示用の日本語。 */
export const IPC_ERROR_CODES = [
  'INVALID_REQUEST',
  'METHOD_NOT_ALLOWED',
  'INVALID_PARAMS',
  'NOT_FOUND',
  'INVALID_STATE',
  'DRAFT_BLOCKED',
  'TASK_NOT_APPROVED',
  'VALIDATION_FAILED',
  'RUN_IN_PROGRESS',
  'POLICY_REJECTED',
  'ENVIRONMENT_UNAVAILABLE',
  'INTERNAL_ERROR'
] as const;
export type IpcErrorCode = (typeof IPC_ERROR_CODES)[number];

// ---- method ごとの params / result ----

export const EnvironmentCheckStatusSchema = z.enum(['ok', 'warn', 'fail', 'skipped', 'unverified']);
export const EnvironmentCheckSchema = z.strictObject({
  id: z.string(),
  label: z.string(),
  status: EnvironmentCheckStatusSchema,
  detail: z.string(),
  fix: z.string().nullable()
});
export type EnvironmentCheck = z.infer<typeof EnvironmentCheckSchema>;

export const EnvironmentReportSchema = z.strictObject({
  platform: z.string(),
  executionMode: z.enum(['docker-desktop-windows', 'docker-linux', 'docker-wsl', 'unavailable']),
  canRun: z.boolean(),
  checks: z.array(EnvironmentCheckSchema),
  checkedAt: z.string()
});
export type EnvironmentReport = z.infer<typeof EnvironmentReportSchema>;

export const EnvironmentCheckParams = z.strictObject({});

export const ProjectInspectParams = z.strictObject({ path: z.string().min(1) });
export const ProjectInfoSchema = z.strictObject({
  path: z.string(),
  status: z.enum(['ok', 'not_git', 'unusable']),
  gitRoot: z.string().nullable(),
  currentBranch: z.string().nullable(),
  headSha: z.string().nullable(),
  isClean: z.boolean().nullable(),
  defaultBaseRef: z.string().nullable(),
  packageManager: z.string().nullable(),
  frameworks: z.array(z.string()),
  testFrameworks: z.array(z.string()),
  verificationProfile: z.strictObject({ name: z.string(), ready: z.boolean(), missingScripts: z.array(z.string()) }).nullable(),
  problems: z.array(z.strictObject({ code: z.string(), message: z.string(), fix: z.string().nullable() })),
  fileCount: z.number().int().min(0),
  inspectedAt: z.string()
});
export type ProjectInfo = z.infer<typeof ProjectInfoSchema>;

export const DraftCreateParams = z.strictObject({
  projectPath: z.string().min(1),
  request: z.string().min(1).max(20_000)
});

export const DraftAnswerParams = z.strictObject({
  draftId: z.string().min(1),
  answers: z
    .array(
      z.strictObject({
        questionId: z.string().min(1),
        value: z.string().max(4000).nullable(),
        skipped: z.boolean()
      })
    )
    .max(3)
    .optional(),
  /** true のとき直前のラウンドへ戻る（回答を取り消して再質問） */
  back: z.boolean().optional()
});

export const DraftReviseParams = z.strictObject({
  draftId: z.string().min(1),
  edits: z.strictObject({
    title: z.string().min(1).max(200).optional(),
    requirements: z.array(z.string().min(1)).min(1).optional(),
    outOfScope: z.array(z.string().min(1)).optional(),
    acceptanceCriteria: z.array(AcceptanceCriterionSchema).min(1).optional(),
    approach: z.string().min(1).optional()
  })
});

export const DraftApproveParams = z.strictObject({
  draftId: z.string().min(1),
  revision: z.number().int().min(1),
  /** モデルへのリポジトリ送信が発生し得ることへの同意（SPEC §8.4） */
  acknowledgeDataSharing: z.literal(true)
});
export const DraftApproveResultSchema = z.strictObject({
  draft: DraftViewSchema,
  approvedTaskId: z.string(),
  taskYaml: z.string(),
  taskYamlPath: z.string()
});
export type DraftApproveResult = z.infer<typeof DraftApproveResultSchema>;

export const RunStartParams = z.strictObject({ approvedTaskId: z.string().min(1) });
export const RunCancelParams = z.strictObject({ runId: z.string().min(1) });
export const RunStatusParams = z.strictObject({
  runId: z.string().min(1),
  sinceSequence: z.number().int().min(0).optional()
});
export const RunStatusResultSchema = z.strictObject({
  run: RunStatusSchema,
  events: z.array(RunEventSchema)
});
export type RunStatusResult = z.infer<typeof RunStatusResultSchema>;

export const RunListParams = z.strictObject({ limit: z.number().int().min(1).max(200).optional() });
export const RunListResultSchema = z.strictObject({ runs: z.array(RunStatusSchema) });

export const RunReportParams = z.strictObject({ runId: z.string().min(1) });
export const EgressSummarySchema = z.strictObject({
  available: z.boolean(),
  /** allowlist 内への通常の AI/レジストリ通信 */
  allowed: z.number().int().min(0),
  /** allowlist 外で拒否した接続 */
  denied: z.number().int().min(0),
  /** 許可先への接続エラー（ネットワーク障害など） */
  errors: z.number().int().min(0),
  allowedHosts: z.array(z.string()),
  deniedHosts: z.array(z.strictObject({ host: z.string(), count: z.number().int().min(0) })),
  errorHosts: z.array(z.string())
});
export type EgressSummary = z.infer<typeof EgressSummarySchema>;
export const RunReportResultSchema = z.strictObject({
  run: RunStatusSchema,
  reportMarkdown: z.string(),
  /** 最終ラウンドの差分（マスキング済み、サイズ上限あり） */
  diffExcerpt: z.string(),
  diffTruncated: z.boolean(),
  changedFiles: z.array(z.string()),
  openFindings: z.array(
    z.strictObject({
      id: z.string(),
      severity: z.string(),
      file: z.string(),
      line: z.number().int(),
      description: z.string(),
      recommendation: z.string()
    })
  ),
  requirementsUnverified: z.array(z.string()),
  reportPath: z.string(),
  worktreePath: z.string().nullable(),
  /** egress プロキシのログ集計（ホスト名のみ。認証情報・URL パスは含まない）。ログが無い Run では available=false */
  egress: EgressSummarySchema,
  /** 最終ラウンドの Policy Gate 検出（v2.1）。未承認 blocking があれば COMPLETED にならない */
  policyFindings: z.array(PolicyFindingSchema)
});
export type RunReportResult = z.infer<typeof RunReportResultSchema>;

/** Runner → UI のイベント名。 */
export const IPC_EVENTS = ['runner.ready', 'draft.updated', 'run.event', 'run.updated'] as const;
export type IpcEventName = (typeof IPC_EVENTS)[number];
