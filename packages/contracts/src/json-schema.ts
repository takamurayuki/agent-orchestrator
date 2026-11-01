import { Ajv2020, type ValidateFunction } from 'ajv/dist/2020.js';
import addFormats from 'ajv-formats';
import { EMBEDDED_SCHEMAS } from './schemas.generated.js';

/**
 * contracts/*.schema.json を Ajv(draft 2020-12) でコンパイルする。Zod と二重に検証し、両方で成功した入力だけを受理する（fail-closed）。
 * スキーマは src/schemas.generated.ts に埋め込む（実行時にファイルシステムを読まないので、単一実行ファイル（SEA）に同梱できる）。
 */
export const SCHEMA_FILES = {
  task: 'task.schema.json',
  review: 'review.schema.json',
  interview: 'interview.schema.json',
  ipc: 'ipc.schema.json',
  taskProposal: 'task-proposal.schema.json'
} as const;
export type SchemaName = keyof typeof SCHEMA_FILES;

const ajv = new Ajv2020({ allErrors: true, strict: true, useDefaults: false, allowUnionTypes: true });
const applyFormats = (addFormats as unknown as { default?: (a: Ajv2020) => void }).default ?? (addFormats as unknown as (a: Ajv2020) => void);
applyFormats(ajv);

const cache = new Map<SchemaName, ValidateFunction>();

export function loadJsonSchema(name: SchemaName): Record<string, unknown> {
  const schema = EMBEDDED_SCHEMAS[SCHEMA_FILES[name]];
  if (!schema) throw new Error(`embedded schema missing: ${SCHEMA_FILES[name]}（pnpm --filter @agent-orchestrator/contracts run gen:schemas）`);
  return structuredClone(schema);
}

export function getValidator(name: SchemaName): ValidateFunction {
  let v = cache.get(name);
  if (!v) {
    v = ajv.compile(loadJsonSchema(name));
    cache.set(name, v);
  }
  return v;
}

export interface JsonSchemaResult {
  valid: boolean;
  errors: string[];
}

export function validateAgainstJsonSchema(name: SchemaName, value: unknown): JsonSchemaResult {
  const validate = getValidator(name);
  const valid = validate(value) as boolean;
  const errors = (validate.errors ?? []).map((e) => `${e.instancePath || '/'} ${e.message ?? 'invalid'}`.trim());
  return { valid, errors };
}
