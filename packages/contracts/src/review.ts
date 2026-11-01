import { z } from 'zod';
import { SEVERITIES } from './task.js';

export const REVIEW_VERDICTS = ['approved', 'changes_requested', 'unknown'] as const;
export type ReviewVerdict = (typeof REVIEW_VERDICTS)[number];

export const ReviewFindingSchema = z.strictObject({
  id: z.string().min(1),
  severity: z.enum(SEVERITIES),
  file: z.string().min(1),
  line: z.number().int().min(1),
  description: z.string().min(1),
  evidence: z.string().min(1),
  recommendation: z.string().min(1)
});
export type ReviewFinding = z.infer<typeof ReviewFindingSchema>;

/** Codex Review v1。contracts/review.schema.json と等価。 */
export const ReviewSchema = z.strictObject({
  verdict: z.enum(REVIEW_VERDICTS),
  findings: z.array(ReviewFindingSchema),
  requirementsUnverified: z.array(z.string().min(1)),
  summary: z.string().min(1)
});
export type Review = z.infer<typeof ReviewSchema>;
