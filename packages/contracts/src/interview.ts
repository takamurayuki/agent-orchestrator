import { z } from 'zod';

export const FACT_CONFIDENCES = ['confirmed', 'inferred', 'unknown'] as const;
export type FactConfidence = (typeof FACT_CONFIDENCES)[number];

export const DECISION_IMPACTS = ['blocking', 'non_blocking'] as const;
export type DecisionImpact = (typeof DECISION_IMPACTS)[number];

export const FactSchema = z.strictObject({
  key: z.string(),
  value: z.string(),
  source: z.string(),
  confidence: z.enum(FACT_CONFIDENCES)
});
export type Fact = z.infer<typeof FactSchema>;

export const QuestionOptionSchema = z.strictObject({
  value: z.string(),
  label: z.string()
});
export type QuestionOption = z.infer<typeof QuestionOptionSchema>;

export const QuestionSchema = z.strictObject({
  id: z.string(),
  question: z.string().min(1),
  decisionImpact: z.enum(DECISION_IMPACTS),
  options: z.array(QuestionOptionSchema),
  recommendation: z.string()
});
export type Question = z.infer<typeof QuestionSchema>;

/** Requirements Interview v1。contracts/interview.schema.json と等価。1 ラウンドは最大 3 問。 */
export const InterviewSchema = z.strictObject({
  facts: z.array(FactSchema),
  questions: z.array(QuestionSchema).max(3),
  blockingQuestions: z.array(z.string()),
  summary: z.string()
});
export type Interview = z.infer<typeof InterviewSchema>;

export const MAX_QUESTIONS_PER_ROUND = 3;
export const MAX_INTERVIEW_ROUNDS = 5;
export const MAX_INTERVIEW_QUESTIONS = 15;
