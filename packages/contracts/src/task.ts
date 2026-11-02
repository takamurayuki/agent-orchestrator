import { z } from 'zod';

export const SEVERITIES = ['critical', 'high', 'medium', 'low'] as const;
export type Severity = (typeof SEVERITIES)[number];

export const VERIFICATION_PROFILES = ['node-pnpm', 'node-npm', 'node-yarn'] as const;
export type VerificationProfileName = (typeof VERIFICATION_PROFILES)[number];

export const AcceptanceCriterionSchema = z.strictObject({
  id: z.string().min(1),
  given: z.string().min(1),
  when: z.string().min(1),
  then: z.string().min(1)
});
export type AcceptanceCriterion = z.infer<typeof AcceptanceCriterionSchema>;

/**
 * 生成物の更新要件（v0.2.1、D-41）。script は package.json の scripts 名（任意のシェルコマンドは不可）。
 * Verifier が `pnpm run <script>` を実行して生成物が最新であることを確認する。
 */
/** 生成スクリプトの入力の分類（v0.2.2、D-42）。tracked: Git 追跡 / ignored: .gitignore 対象 / missing: 未追跡または存在しない / unknown: 静的に確定できない */
export const GeneratedInputSchema = z.strictObject({
  path: z.string().min(1),
  status: z.enum(['tracked', 'ignored', 'missing', 'unknown']),
  detail: z.string()
});
export type GeneratedInput = z.infer<typeof GeneratedInputSchema>;

export const GeneratedArtifactSchema = z.strictObject({
  path: z.string().min(1),
  script: z.string().min(1).regex(/^[A-Za-z0-9_:.@/-]+$/, 'script は package.json の scripts 名'),
  reason: z.string().min(1),
  /** リポジトリ調査が付与する入力の分類（モデル出力には無くてよい） */
  inputs: z.array(GeneratedInputSchema).optional(),
  /** ok: 入力はすべて Git 追跡 / missing: Git 管理外の入力がある（隔離ワークスペースでは再現できない） / unknown: 静的解析で確定できない */
  inputStatus: z.enum(['ok', 'missing', 'unknown']).optional()
});
export type GeneratedArtifact = z.infer<typeof GeneratedArtifactSchema>;

export const TaskLimitsSchema = z.strictObject({
  maxImplementationAttempts: z.number().int().min(1).max(3).default(3),
  maxDurationSeconds: z.number().int().min(60).default(2700),
  cliTimeoutSeconds: z.number().int().min(1).default(900),
  verificationTimeoutSeconds: z.number().int().min(1).default(300)
});
export type TaskLimits = z.infer<typeof TaskLimitsSchema>;

export const TaskReviewSchema = z.strictObject({
  blockingSeverities: z
    .array(z.enum(SEVERITIES))
    .default(['critical', 'high'])
    .refine((arr) => new Set(arr).size === arr.length, { message: 'blockingSeverities must be unique' })
});
export type TaskReview = z.infer<typeof TaskReviewSchema>;

/** task.yaml（Approved Task v2）。contracts/task.schema.json と等価。 */
export const TaskSchema = z.strictObject({
  schemaVersion: z.literal(2),
  id: z.string().min(1),
  title: z.string().min(1),
  repository: z.string().min(1),
  baseRef: z.string().min(1),
  requirements: z.array(z.string().min(1)).min(1),
  acceptanceCriteria: z.array(AcceptanceCriterionSchema).min(1),
  verificationProfile: z.enum(VERIFICATION_PROFILES),
  limits: TaskLimitsSchema.optional(),
  review: TaskReviewSchema.optional(),
  /** 変更が予想されるファイル・領域（v0.2.0）。空ならスコープ判定を行わない */
  expectedChanges: z.array(z.string().min(1)).optional(),
  /** 既存機能との衝突の可能性（v0.2.0、Builder / Reviewer への注意喚起） */
  conflictRisks: z.array(z.string().min(1)).optional(),
  /** 生成物の更新要件（v0.2.1）。Verifier が再生成して最新であることを確認する */
  generatedArtifacts: z.array(GeneratedArtifactSchema).optional()
});
export type Task = z.infer<typeof TaskSchema>;
export type TaskInput = z.input<typeof TaskSchema>;

/** limits/review を既定値で埋めた実行用タスク。 */
export interface ResolvedTask extends Omit<Task, 'limits' | 'review'> {
  limits: TaskLimits;
  review: TaskReview;
}

export function resolveTask(task: Task): ResolvedTask {
  return {
    ...task,
    limits: TaskLimitsSchema.parse(task.limits ?? {}),
    review: TaskReviewSchema.parse(task.review ?? {})
  };
}
