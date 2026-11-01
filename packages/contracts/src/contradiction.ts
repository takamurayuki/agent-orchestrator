import { z } from 'zod';

/** Requirements Contradictions v1（schemas/contradiction.schema.json と等価）。 */
export const ContradictionOptionSchema = z.strictObject({
  value: z.string().min(1),
  label: z.string().min(1),
  consequence: z.string().min(1)
});
export type ContradictionOption = z.infer<typeof ContradictionOptionSchema>;

export const ContradictionSchema = z.strictObject({
  id: z.string().min(1),
  kind: z.enum(['requirement_vs_requirement', 'requirement_vs_project']),
  severity: z.enum(['blocking', 'minor']),
  description: z.string().min(1),
  evidence: z.array(z.string().min(1)),
  options: z.array(ContradictionOptionSchema).min(2),
  recommendation: z.string()
});
export type Contradiction = z.infer<typeof ContradictionSchema>;

export const ContradictionReportSchema = z.strictObject({
  contradictions: z.array(ContradictionSchema)
});
export type ContradictionReport = z.infer<typeof ContradictionReportSchema>;

/** 意思決定ログ（矛盾に対するユーザーの判断）。SQLite と tasks/<id>/revisions/<rev>/decisions.json に保存。 */
export const DecisionRecordSchema = z.strictObject({
  contradictionId: z.string(),
  kind: z.enum(['requirement_vs_requirement', 'requirement_vs_project']),
  question: z.string(),
  chosen: z.string(),
  chosenLabel: z.string(),
  consequence: z.string(),
  evidence: z.array(z.string()),
  decidedAt: z.string()
});
export type DecisionRecord = z.infer<typeof DecisionRecordSchema>;

/** 矛盾質問の ID 接頭辞（通常の質問と区別し、回答時に意思決定ログへ記録する） */
export const CONTRADICTION_QUESTION_PREFIX = 'CONTRA-';
