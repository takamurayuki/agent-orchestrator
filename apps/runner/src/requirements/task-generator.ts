import { stringify as stringifyYaml, parse as parseYaml } from 'yaml';
import { ulid } from 'ulid';
import { validateTask, type Task, type TaskProposal, type VerificationProfileName } from '@agent-orchestrator/contracts';
import { detectProhibitedOperations } from '../policy.js';

/**
 * 合意済み内容を task.yaml（Approved Task v2）に整形し、Zod + JSON Schema で検証する（RA-10）。
 * verificationProfile はあらかじめ定義されたものだけ。任意コマンドは生成しない。
 */
export interface TaskGenerationInput {
  proposal: TaskProposal;
  repository: string;
  baseRef: string;
  verificationProfile: VerificationProfileName;
  taskId?: string;
}

export type TaskGenerationResult = { ok: true; task: Task; yaml: string } | { ok: false; errors: string[]; yaml: string | null };

export function newTaskId(title: string): string {
  const ascii = title
    .normalize('NFKD')
    .replace(/[^A-Za-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .toUpperCase()
    .slice(0, 24);
  return `TASK-${ascii ? `${ascii}-` : ''}${ulid().slice(-6)}`;
}

export function generateTask(input: TaskGenerationInput): TaskGenerationResult {
  const errors: string[] = [];
  for (const r of input.proposal.requirements) {
    for (const op of detectProhibitedOperations(r)) errors.push(`要件に禁止操作（${op.code}: "${op.match}"）が含まれています。${op.guidance}`);
  }
  const candidate = {
    schemaVersion: 2 as const,
    id: input.taskId ?? newTaskId(input.proposal.title),
    title: input.proposal.title,
    repository: input.repository,
    baseRef: input.baseRef,
    requirements: input.proposal.requirements,
    acceptanceCriteria: input.proposal.acceptanceCriteria,
    verificationProfile: input.verificationProfile,
    limits: { maxImplementationAttempts: 3, maxDurationSeconds: 2700, cliTimeoutSeconds: 900, verificationTimeoutSeconds: 300 },
    review: { blockingSeverities: ['critical', 'high'] as Array<'critical' | 'high'> },
    ...(input.proposal.expectedChanges.length > 0 ? { expectedChanges: input.proposal.expectedChanges } : {}),
    ...(input.proposal.conflictRisks.length > 0 ? { conflictRisks: input.proposal.conflictRisks } : {}),
    ...(input.proposal.generatedArtifacts.length > 0 ? { generatedArtifacts: input.proposal.generatedArtifacts } : {})
  };
  const yaml = stringifyYaml(candidate, { lineWidth: 0 });
  // 文字列化 → 再パースしたものを検証する（保存されるものと同じ内容を検証）
  const validated = validateTask(parseYaml(yaml));
  if (!validated.ok) errors.push(...validated.errors);
  if (errors.length > 0) return { ok: false, errors, yaml };
  return { ok: true, task: (validated as { ok: true; value: Task }).value, yaml };
}

/** 保存済み YAML を再検証する（承認時・実行時に二重確認）。 */
export function parseAndValidateTaskYaml(yaml: string): { ok: true; task: Task } | { ok: false; errors: string[] } {
  let parsed: unknown;
  try {
    parsed = parseYaml(yaml);
  } catch (err) {
    return { ok: false, errors: [`YAML parse error: ${(err as Error).message}`] };
  }
  const v = validateTask(parsed);
  return v.ok ? { ok: true, task: v.value } : { ok: false, errors: v.errors };
}
