import { z } from 'zod';
import { DraftViewSchema } from './draft.js';
import { PolicyFindingSchema, RunEventSchema, RunStatusSchema, ScopeCheckSchema } from './run.js';
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
  'run.report',
  'sandbox.setup',
  'sandbox.cancel',
  'sandbox.status'
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
/** プロジェクト事前診断（v0.2.0、D-38）。読み取り専用。実際に依存解決しないと分からない項目は unverified */
export const ProjectDiagnosisCheckSchema = z.strictObject({
  id: z.string(),
  label: z.string(),
  status: z.enum(['ok', 'warn', 'fail', 'unverified']),
  detail: z.string(),
  fix: z.string().nullable(),
  /** unverified の確認方法（v0.2.1）。利用者が自分で確かめる手順 */
  howToVerify: z.string().nullable().default(null)
});
export type ProjectDiagnosisCheck = z.infer<typeof ProjectDiagnosisCheckSchema>;
export const ProjectDiagnosisSchema = z.strictObject({
  /** ready=実行可能 / unverified=未確認あり（実行は可能、失敗する可能性） / issues=問題あり（warn: 実行に影響） / blocked=実行不可（fail） */
  verdict: z.enum(['ready', 'unverified', 'issues', 'blocked']),
  checks: z.array(ProjectDiagnosisCheckSchema)
});
export type ProjectDiagnosis = z.infer<typeof ProjectDiagnosisSchema>;

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
  inspectedAt: z.string(),
  /** 事前診断（v0.2.0）。古い記録では省略 */
  diagnosis: ProjectDiagnosisSchema.default({ verdict: 'ready', checks: [] })
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
  policyFindings: z.array(PolicyFindingSchema),
  /** 最終ラウンドのスコープ判定（v0.2.0） */
  scopeCheck: ScopeCheckSchema.nullable().default(null)
});
export type RunReportResult = z.infer<typeof RunReportResultSchema>;

// ---- サンドボックス準備（v0.1.0 公開準備）: GUI から固定手順でイメージを取得・ビルド・検証する ----

export const SandboxSetupParams = z.strictObject({
  /** Docker Hub からピン留めしたベースイメージを取得することへの明示的な同意（これ無しでは外部取得しない） */
  acknowledgePull: z.literal(true)
});
export const SandboxCancelParams = z.strictObject({});
export const SandboxStatusParams = z.strictObject({});

export const SANDBOX_SETUP_STATES = ['idle', 'running', 'succeeded', 'failed', 'cancelled'] as const;
export const SandboxSetupStepSchema = z.strictObject({
  id: z.string(),
  label: z.string(),
  status: z.enum(['pending', 'running', 'ok', 'fail', 'skipped']),
  detail: z.string()
});
export type SandboxSetupStep = z.infer<typeof SandboxSetupStepSchema>;
export const SandboxManifestSchema = z.strictObject({
  version: z.string(),
  baseImage: z.string(),
  baseDigest: z.string(),
  images: z.array(z.strictObject({ id: z.string(), tag: z.string(), label: z.string() }))
});
export type SandboxManifest = z.infer<typeof SandboxManifestSchema>;
export const SandboxSetupStateSchema = z.strictObject({
  state: z.enum(SANDBOX_SETUP_STATES),
  startedAt: z.string().nullable(),
  finishedAt: z.string().nullable(),
  steps: z.array(SandboxSetupStepSchema),
  /** docker 出力の末尾（マスキング済み、最大 40 行） */
  logTail: z.array(z.string()),
  error: z.strictObject({ code: z.string(), message: z.string(), fix: z.string() }).nullable(),
  manifest: SandboxManifestSchema
});
export type SandboxSetupState = z.infer<typeof SandboxSetupStateSchema>;

/** Runner → UI のイベント名。 */
export const IPC_EVENTS = ['runner.ready', 'draft.updated', 'run.event', 'run.updated', 'sandbox.progress'] as const;
export type IpcEventName = (typeof IPC_EVENTS)[number];
