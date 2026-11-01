import type { ZodType } from 'zod';
import { InterviewSchema, type Interview } from './interview.js';
import { validateAgainstJsonSchema, type SchemaName } from './json-schema.js';
import { ReviewSchema, type Review } from './review.js';
import { TaskProposalSchema, type TaskProposal } from './task-proposal.js';
import { TaskSchema, type Task } from './task.js';

export type ValidationResult<T> = { ok: true; value: T } | { ok: false; errors: string[] };

/** Zod と JSON Schema の両方で検証する。どちらかが失敗すれば不合格。 */
export function validateBoth<T>(schemaName: SchemaName, zodSchema: ZodType<T>, value: unknown): ValidationResult<T> {
  const errors: string[] = [];
  const json = validateAgainstJsonSchema(schemaName, value);
  if (!json.valid) errors.push(...json.errors.map((e) => `json-schema: ${e}`));
  const parsed = zodSchema.safeParse(value);
  if (!parsed.success) errors.push(...parsed.error.issues.map((i) => `zod: ${i.path.join('.') || '/'} ${i.message}`));
  if (errors.length > 0) return { ok: false, errors };
  return { ok: true, value: (parsed as { success: true; data: T }).data };
}

export function validateTask(value: unknown): ValidationResult<Task> {
  return validateBoth('task', TaskSchema, value);
}
export function validateReview(value: unknown): ValidationResult<Review> {
  return validateBoth('review', ReviewSchema, value);
}
export function validateInterview(value: unknown): ValidationResult<Interview> {
  return validateBoth('interview', InterviewSchema, value);
}
export function validateTaskProposal(value: unknown): ValidationResult<TaskProposal> {
  return validateBoth('taskProposal', TaskProposalSchema, value);
}

/**
 * レビュー結果の内容整合性（完了ゲート 4）。
 * - approved なのに blocking 指摘が残っている / requirementsUnverified が非空 → 不整合
 * - findings の id 重複 → 不整合
 */
export function reviewConsistencyErrors(review: Review, blockingSeverities: readonly string[]): string[] {
  const errors: string[] = [];
  const ids = new Set<string>();
  for (const f of review.findings) {
    if (ids.has(f.id)) errors.push(`finding id が重複: ${f.id}`);
    ids.add(f.id);
  }
  const blocking = review.findings.filter((f) => blockingSeverities.includes(f.severity));
  if (review.verdict === 'approved') {
    if (blocking.length > 0) errors.push(`verdict=approved だが blocking 指摘が ${blocking.length} 件ある`);
    if (review.requirementsUnverified.length > 0) errors.push(`verdict=approved だが requirementsUnverified が ${review.requirementsUnverified.length} 件ある`);
  }
  return errors;
}
