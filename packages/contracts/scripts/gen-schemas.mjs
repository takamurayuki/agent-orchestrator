#!/usr/bin/env node
// schemas/*.schema.json を src/schemas.generated.ts に埋め込む（実行時にファイルを読まない。SEA 同梱のため）。
import { readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const schemasDir = join(root, 'schemas');
const files = readdirSync(schemasDir).filter((f) => f.endsWith('.schema.json')).sort();
const entries = files.map((f) => {
  const json = JSON.parse(readFileSync(join(schemasDir, f), 'utf8'));
  return `  ${JSON.stringify(f)}: ${JSON.stringify(json, null, 2).replace(/\n/g, '\n  ')}`;
});
const out = `// 自動生成: pnpm --filter @agent-orchestrator/contracts run gen:schemas（編集しない）\n// 元: packages/contracts/schemas/*.schema.json\nexport const EMBEDDED_SCHEMAS: Record<string, Record<string, unknown>> = {\n${entries.join(',\n')}\n};\n`;
writeFileSync(join(root, 'src', 'schemas.generated.ts'), out, 'utf8');
console.log(`generated ${files.length} schemas → src/schemas.generated.ts`);
