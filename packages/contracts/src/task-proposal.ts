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
  openItems: z.array(z.string().min(1))
});
export type TaskProposal = z.infer<typeof TaskProposalSchema>;
