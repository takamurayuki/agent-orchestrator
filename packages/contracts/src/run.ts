import { z } from 'zod';
import { ReviewSchema } from './review.js';
import { SEVERITIES } from './task.js';

/** 実行状態機械（SPEC §6）。 */
export const RUN_STATES = [
  'CREATED',
  'PREFLIGHT',
  'IMPLEMENTING',
  'VERIFYING',
  'REVIEWING',
  /** Policy Gate の未承認違反で Builder に差し戻す直前の状態（v2.2。次のラウンドで IMPLEMENTING へ） */
  'POLICY_BLOCKED',
  'COMPLETED',
  'NEEDS_HUMAN',
  'PRECHECK_FAILED',
  'INTERRUPTED',
  'INTERNAL_ERROR'
] as const;
export type RunState = (typeof RUN_STATES)[number];

export const TERMINAL_RUN_STATES: readonly RunState[] = ['COMPLETED', 'NEEDS_HUMAN', 'PRECHECK_FAILED', 'INTERRUPTED', 'INTERNAL_ERROR'];
export function isTerminalRunState(state: RunState): boolean {
  return TERMINAL_RUN_STATES.includes(state);
}

/** 終了理由コード。UI とレポートはこのコードで「次の手動操作」を案内する。 */
export const RUN_REASON_CODES = [
  'COMPLETED',
  'MAX_ROUNDS',
  'REVIEW_UNKNOWN',
  'REVIEW_INVALID_JSON',
  'REVIEW_INCONSISTENT',
  'BUILDER_FAILED',
  'BUILDER_TIMEOUT',
  'NO_CHANGES',
  'POLICY_VIOLATION',
  'SCOPE_DEVIATION',
  'WORKSPACE_MODIFIED_DURING_REVIEW',
  'TIMEOUT',
  'GATE_FAILED',
  'PRECHECK_FAILED',
  'TASK_NOT_APPROVED',
  'CANCELLED',
  'RECOVERED_AFTER_RESTART',
  'INTERNAL_ERROR'
] as const;
export type RunReasonCode = (typeof RUN_REASON_CODES)[number];

export const VerificationCommandResultSchema = z.strictObject({
  name: z.string(),
  argv: z.array(z.string()),
  exitCode: z.number().int().nullable(),
  timedOut: z.boolean(),
  durationMs: z.number().int().min(0),
  stdoutExcerpt: z.string(),
  stderrExcerpt: z.string(),
  truncated: z.boolean()
});
export type VerificationCommandResult = z.infer<typeof VerificationCommandResultSchema>;

export const VerificationResultSchema = z.strictObject({
  profile: z.string(),
  passed: z.boolean(),
  commands: z.array(VerificationCommandResultSchema),
  /** 期待した検証コマンドのうち実行されなかったもの（欠落） */
  missing: z.array(z.string()),
  startedAt: z.string(),
  finishedAt: z.string()
});
export type VerificationResult = z.infer<typeof VerificationResultSchema>;

export const POLICY_VIOLATION_CODES = [
  'TEST_FILE_DELETED',
  'TEST_SKIPPED',
  'VERIFICATION_CONFIG_WEAKENED',
  'FORBIDDEN_PATH',
  'PATH_ESCAPE',
  'SYMLINK_ESCAPE'
] as const;
export const PolicyViolationSchema = z.strictObject({
  code: z.enum(POLICY_VIOLATION_CODES),
  file: z.string(),
  detail: z.string()
});
export type PolicyViolation = z.infer<typeof PolicyViolationSchema>;

/** Policy Gate（v2.1）の検出結果。AI レビューとは独立した静的チェック。approved はベースコミットの人間管理の例外に一致した場合のみ true */
export const POLICY_RULE_IDS = ['PG-ESLINT-DISABLE', 'PG-TS-SUPPRESS', 'PG-TEST-SKIP', 'PG-TEST-DELETED', 'PG-VERIFY-SCRIPT', 'PG-TSCONFIG-RELAXED', 'PG-ESLINT-RELAXED', 'PG-TESTCONFIG-RELAXED', 'PG-UNPARSEABLE', 'PG-ANALYSIS-ERROR'] as const;
export const PolicyFindingSchema = z.strictObject({
  ruleId: z.enum(POLICY_RULE_IDS),
  severity: z.enum(['blocking', 'warning']),
  file: z.string(),
  line: z.number().int().min(1),
  evidence: z.string(),
  message: z.string(),
  approved: z.boolean(),
  approvalReason: z.string().nullable()
});
export type PolicyFinding = z.infer<typeof PolicyFindingSchema>;

export const DiffFileSchema = z.strictObject({
  path: z.string(),
  status: z.enum(['added', 'modified', 'deleted', 'renamed', 'untracked']),
  additions: z.number().int().min(0),
  deletions: z.number().int().min(0)
});
export type DiffFile = z.infer<typeof DiffFileSchema>;

export const DiffSummarySchema = z.strictObject({
  /** 変更ファイル一覧。未追跡ファイルも含む */
  files: z.array(DiffFileSchema),
  isEmpty: z.boolean(),
  patchBytes: z.number().int().min(0),
  truncated: z.boolean()
});
export type DiffSummary = z.infer<typeof DiffSummarySchema>;

/** Reviewer アダプタの戻り値。JSON 不正は parsed=null で表し、engine は NEEDS_HUMAN へ倒す。 */
export const ReviewOutcomeSchema = z.strictObject({
  parsed: ReviewSchema.nullable(),
  parseError: z.string().nullable(),
  exitCode: z.number().int().nullable(),
  timedOut: z.boolean(),
  durationMs: z.number().int().min(0),
  rawExcerpt: z.string()
});
export type ReviewOutcome = z.infer<typeof ReviewOutcomeSchema>;

export const BuilderOutcomeSchema = z.strictObject({
  exitCode: z.number().int().nullable(),
  timedOut: z.boolean(),
  durationMs: z.number().int().min(0),
  isError: z.boolean(),
  resultExcerpt: z.string(),
  sessionId: z.string().nullable(),
  costUsd: z.number().nullable()
});
export type BuilderOutcome = z.infer<typeof BuilderOutcomeSchema>;

/** スコープ判定（v0.2.0、D-39）: 承認済み task の expectedChanges と差分の比較 */
export const ScopeCheckSchema = z.strictObject({
  expected: z.array(z.string()),
  unexpected: z.array(z.string()),
  /** none=逸脱なし / minor=軽微（記録のみ） / major=重大（人間の判断） */
  severity: z.enum(['none', 'minor', 'major']),
  detail: z.string(),
  /** Builder が最終報告で述べた変更理由（抜粋、マスキング済み） */
  builderReason: z.string().nullable()
});
export type ScopeCheck = z.infer<typeof ScopeCheckSchema>;

export const RoundRecordSchema = z.strictObject({
  round: z.number().int().min(1),
  builder: BuilderOutcomeSchema.nullable(),
  diff: DiffSummarySchema.nullable(),
  /** スコープ判定（v0.2.0）。古い記録では省略 */
  scopeCheck: ScopeCheckSchema.nullable().default(null),
  policyViolations: z.array(PolicyViolationSchema),
  /** Policy Gate の検出（v2.1）。古い記録では省略 */
  policyFindings: z.array(PolicyFindingSchema).default([]),
  verification: VerificationResultSchema.nullable(),
  review: ReviewOutcomeSchema.nullable(),
  workspaceHashBeforeReview: z.string().nullable(),
  workspaceHashAfterReview: z.string().nullable(),
  startedAt: z.string(),
  finishedAt: z.string().nullable()
});
export type RoundRecord = z.infer<typeof RoundRecordSchema>;

export const RunEventSchema = z.strictObject({
  runId: z.string(),
  sequence: z.number().int().min(1),
  timestamp: z.string(),
  type: z.string(),
  round: z.number().int().min(1).nullable(),
  payload: z.record(z.string(), z.unknown())
});
export type RunEvent = z.infer<typeof RunEventSchema>;

export const RunStatusSchema = z.strictObject({
  runId: z.string(),
  approvedTaskId: z.string(),
  taskId: z.string(),
  taskTitle: z.string(),
  repository: z.string(),
  baseRef: z.string(),
  baseSha: z.string().nullable(),
  state: z.enum(RUN_STATES),
  reasonCode: z.enum(RUN_REASON_CODES).nullable(),
  reasonDetail: z.string().nullable(),
  currentRound: z.number().int().min(0),
  maxRounds: z.number().int().min(1),
  worktreePath: z.string().nullable(),
  runDir: z.string(),
  startedAt: z.string(),
  finishedAt: z.string().nullable(),
  lastSequence: z.number().int().min(0),
  /** 未解決の blocking 指摘件数（最終レビュー） */
  openBlockingFindings: z.number().int().min(0),
  nextActions: z.array(z.string())
});
export type RunStatus = z.infer<typeof RunStatusSchema>;

export const SeveritySchema = z.enum(SEVERITIES);
