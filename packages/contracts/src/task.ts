import { z } from 'zod';

export const SEVERITIES = ['critical', 'high', 'medium', 'low'] as const;
export type Severity = (typeof SEVERITIES)[number];

export const VERIFICATION_PROFILES = ['node-pnpm'] as const;
export type VerificationProfileName = (typeof VERIFICATION_PROFILES)[number];

export const AcceptanceCriterionSchema = z.strictObject({
  id: z.string().min(1),
  given: z.string().min(1),
  when: z.string().min(1),
  then: z.string().min(1)
});
export type AcceptanceCriterion = z.infer<typeof AcceptanceCriterionSchema>;

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
  conflictRisks: z.array(z.string().min(1)).optional()
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
