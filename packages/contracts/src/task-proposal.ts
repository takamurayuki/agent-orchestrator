import { z } from 'zod';
import { AcceptanceCriterionSchema } from './task.js';

/** Requirements Agent が blockingQuestions=[] 到達後に生成する task.yaml の素案（schemas/task-proposal.schema.json と等価）。 */
export const TaskProposalSchema = z.strictObject({
  title: z.string().min(1).max(200),
  objective: z.string().min(1),
  requirements: z.array(z.string().min(1)).min(1),
  outOfScope: z.array(z.string().min(1)),
  approach: z.string().min(1),
  acceptanceCriteria: z.array(AcceptanceCriterionSchema).min(1),
  openItems: z.array(z.string().min(1)),
  /** 変更が予想されるファイル・領域（パス、ディレクトリ、glob。v0.2.0 最小実装の原則）。モデルに必須（1 件以上）。保存済みの旧素案は読み出し時に [] で補う */
  expectedChanges: z.array(z.string().min(1)).min(1),
  /** 既存機能・既存実装との衝突の可能性（v0.2.0）。無ければ [] */
  conflictRisks: z.array(z.string().min(1))
});
export type TaskProposal = z.infer<typeof TaskProposalSchema>;
