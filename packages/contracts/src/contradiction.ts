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

/** 判断の 1 履歴（v2.2）。戻る/再回答で積み上がる。retracted は「戻る」で取り消された判断 */
export const DecisionHistoryEntrySchema = z.strictObject({
  chosen: z.string(),
  chosenLabel: z.string(),
  decidedAt: z.string(),
  retracted: z.boolean(),
  note: z.string()
});
export type DecisionHistoryEntry = z.infer<typeof DecisionHistoryEntrySchema>;

/**
 * 意思決定ログ（v2.2 で通常ヒアリング・矛盾解消・要件修正を共通モデルに統一）。
 * SQLite `decisions` と tasks/<id>/revisions/<rev>/decisions.json に保存。
 * - topicKey: 同一事項の識別子（質問 ID / 矛盾 ID / 修正対象フィールド）。同じ topicKey の判断は履歴として積み、最新の非取消が現在値
 * - source: interview（通常質問）/ contradiction（矛盾解消）/ revision（承認前後の要件修正）
 * - supersededBy: 後続の明示的な判断で置き換えられたときの topicKey（古い判断が新しい指示を上書きしないための印）
 */
export const DecisionRecordSchema = z.strictObject({
  topicKey: z.string(),
  /** 旧フィールド名との互換: 矛盾 ID（contradiction 以外では topicKey と同じ） */
  contradictionId: z.string(),
  source: z.enum(['interview', 'contradiction', 'revision']),
  kind: z.enum(['requirement_vs_requirement', 'requirement_vs_project', 'scope', 'design', 'acceptance', 'other']),
  question: z.string(),
  options: z.array(z.strictObject({ value: z.string(), label: z.string() })),
  chosen: z.string(),
  chosenLabel: z.string(),
  /** 採用理由（推奨案の根拠、ユーザーの自由入力、または「ユーザーが選択」） */
  rationale: z.string(),
  consequence: z.string(),
  evidence: z.array(z.string()),
  /** 対象要件（分かる範囲で。requirements の文言や AC の id） */
  relatedRequirements: z.array(z.string()),
  decidedAt: z.string(),
  history: z.array(DecisionHistoryEntrySchema),
  supersededBy: z.string().nullable(),
  /** active: 現在拘束力のある判断 / retracted: 「戻る」で取り消し / superseded: 同一事項の新しい判断で置き換え */
  status: z.enum(['active', 'retracted', 'superseded'])
});
export type DecisionRecord = z.infer<typeof DecisionRecordSchema>;

/** 矛盾質問の ID 接頭辞（通常の質問と区別し、回答時に意思決定ログへ記録する） */
export const CONTRADICTION_QUESTION_PREFIX = 'CONTRA-';
