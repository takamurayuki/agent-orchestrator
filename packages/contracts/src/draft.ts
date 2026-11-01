import { z } from 'zod';
import { FactSchema, QuestionSchema } from './interview.js';
import { TaskProposalSchema } from './task-proposal.js';
import { ContradictionSchema, DecisionRecordSchema } from './contradiction.js';

/** 会話状態機械（SPEC §5）。 */
export const DRAFT_STATES = [
  'DRAFT_CREATED',
  'REPO_ANALYZING',
  'GAP_ANALYZING',
  'ASKING',
  'ANSWERING',
  'SUMMARY_READY',
  'AWAITING_APPROVAL',
  'APPROVED',
  'YAML_VALIDATED',
  'READY_TO_RUN',
  'BLOCKED',
  'DRAFT_CANCELLED'
] as const;
export type DraftState = (typeof DRAFT_STATES)[number];

export const AnswerSchema = z.strictObject({
  questionId: z.string(),
  round: z.number().int().min(1),
  /** 自由入力または選択肢 value。skipped のとき null */
  value: z.string().nullable(),
  skipped: z.boolean(),
  answeredAt: z.string()
});
export type Answer = z.infer<typeof AnswerSchema>;

export const AskedQuestionSchema = QuestionSchema.extend({
  round: z.number().int().min(1)
});
export type AskedQuestion = z.infer<typeof AskedQuestionSchema>;

export const VerificationReadinessSchema = z.strictObject({
  profile: z.string(),
  ready: z.boolean(),
  missingScripts: z.array(z.string()),
  detail: z.string()
});
export type VerificationReadiness = z.infer<typeof VerificationReadinessSchema>;

/** UI に返す Draft のビュー。質問・選択肢は表示時にエスケープする（UI 側責務）。 */
export const DraftViewSchema = z.strictObject({
  id: z.string(),
  projectPath: z.string(),
  request: z.string(),
  state: z.enum(DRAFT_STATES),
  revision: z.number().int().min(1),
  round: z.number().int().min(0),
  totalQuestionsAsked: z.number().int().min(0),
  facts: z.array(FactSchema),
  /** 現在ラウンドの質問（最大 3） */
  currentQuestions: z.array(AskedQuestionSchema).max(3),
  askedQuestions: z.array(AskedQuestionSchema),
  answers: z.array(AnswerSchema),
  /** 未回答の blocking 質問 ID */
  blockingQuestions: z.array(z.string()),
  summary: z.string(),
  proposal: TaskProposalSchema.nullable(),
  taskYaml: z.string().nullable(),
  validationErrors: z.array(z.string()),
  blockedReason: z.string().nullable(),
  /** 依頼文に含まれていた禁止操作（push/merge/deploy 等）。実行せず手動対応を案内する */
  prohibitedOperations: z.array(z.string()),
  verificationReadiness: VerificationReadinessSchema.nullable(),
  /** 未解消の矛盾（v2.1）。blocking が残る間は承認できない */
  contradictions: z.array(ContradictionSchema).default([]),
  /** 意思決定ログ（矛盾へのユーザー判断、v2.1） */
  decisions: z.array(DecisionRecordSchema).default([]),
  approved: z.boolean(),
  approvedTaskId: z.string().nullable(),
  createdAt: z.string(),
  updatedAt: z.string()
});
export type DraftView = z.infer<typeof DraftViewSchema>;
