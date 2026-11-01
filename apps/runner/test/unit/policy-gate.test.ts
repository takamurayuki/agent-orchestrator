import { describe, expect, it } from 'vitest';
import type { DiffFile } from '@agent-orchestrator/contracts';
import { collectSuppressComments, collectTestSkips, eslintRelaxations, evaluatePolicyGate, parsePolicyExceptions, testConfigRelaxations, tsconfigRelaxations, verifyScriptChanges } from '../../src/policy-gate.js';

const mod = (path: string): DiffFile => ({ path, status: 'modified', additions: 1, deletions: 0 });
const added = (path: string): DiffFile => ({ path, status: 'added', additions: 1, deletions: 0 });
const gate = (files: DiffFile[], base: Record<string, string | null>, current: Record<string, string | null>, exceptionsJson: string | null = null) =>
  evaluatePolicyGate({ files, baseContents: base, currentContents: current, exceptions: parsePolicyExceptions(exceptionsJson) });

describe('Policy Gate v2.1 — suppress comments (case 1 / 2 / 3)', () => {
  it('case 1: a newly added eslint-disable comment is detected with file, line, rule id and evidence', () => {
    const before = "export const a = 1;\nconsole.log(a);\n";
    const after = "export const a = 1;\n// eslint-disable-next-line no-console\nconsole.log(a);\n";
    const r = gate([mod('src/a.ts')], { 'src/a.ts': before }, { 'src/a.ts': after });
    expect(r.passed).toBe(false);
    expect(r.blocking).toHaveLength(1);
    expect(r.blocking[0]).toMatchObject({ ruleId: 'PG-ESLINT-DISABLE', file: 'src/a.ts', line: 2, approved: false });
    expect(r.blocking[0]?.evidence).toContain('eslint-disable-next-line no-console');
  });

  it('case 2: pre-existing eslint-disable comments are not reported, even when the file changes or the comment moves', () => {
    const before = "/* eslint-disable no-console */\nconsole.log(1);\nexport const x = 1;\n";
    const afterMoved = "export const x = 1;\n\n/* eslint-disable no-console */\nconsole.log(1);\nconsole.log(2);\n";
    const r = gate([mod('src/a.ts')], { 'src/a.ts': before }, { 'src/a.ts': afterMoved });
    expect(r.findings).toEqual([]);
    // 同じ既存コメントに加えてもう 1 つ増えたときだけ 1 件
    const afterPlusOne = `${afterMoved}// eslint-disable-line no-console\nconsole.log(3);\n`;
    expect(gate([mod('src/a.ts')], { 'src/a.ts': before }, { 'src/a.ts': afterPlusOne }).blocking).toHaveLength(1);
  });

  it('does not treat "eslint-disable" inside a string literal as a comment (AST/scanner based)', () => {
    const after = "export const msg = '// eslint-disable-next-line is not a comment here';\nexport const t = `/* eslint-disable */`;\n";
    expect(collectSuppressComments('src/s.ts', after)).toEqual([]);
    expect(gate([added('src/s.ts')], {}, { 'src/s.ts': after }).findings).toEqual([]);
  });

  it('case 3: new @ts-ignore / @ts-nocheck are detected; @ts-expect-error is allowed', () => {
    const after = "// @ts-nocheck\nexport function f(x: number) {\n  // @ts-ignore\n  return x.foo;\n}\n// @ts-expect-error intentional\nconst y: number = 'a';\n";
    const r = gate([added('src/t.ts')], {}, { 'src/t.ts': after });
    expect(r.blocking.map((f) => `${f.ruleId}:${f.line}`)).toEqual(['PG-TS-SUPPRESS:1', 'PG-TS-SUPPRESS:3']);
  });
});

describe('Policy Gate v2.1 — tests (case 4 / 5)', () => {
  it('case 4: added it.skip / describe.only / xit / test.todo are detected via AST; existing ones are not', () => {
    const before = "import { it, describe } from 'vitest';\nit.skip('old skip', () => {});\nit('a', () => {});\n";
    const after = "import { it, describe } from 'vitest';\nit.skip('old skip', () => {});\nit.only('a', () => {});\ndescribe.skip('b', () => {});\nxit('c', () => {});\ntest.todo('d');\nconst s = 'it.skip(\"not code\")';\n";
    const r = gate([mod('test/a.test.ts')], { 'test/a.test.ts': before }, { 'test/a.test.ts': after });
    expect(r.blocking.map((f) => f.evidence)).toEqual(['it.only', 'describe.skip', 'xit', 'test.todo']);
    expect(r.blocking.every((f) => f.ruleId === 'PG-TEST-SKIP')).toBe(true);
    expect(collectTestSkips('x.test.ts', "it.skip.each([[1]])('n', () => {});").map((h) => h.text)).toEqual(['it.skip.each']);
  });

  it('case 5: deleting a test file is detected', () => {
    const r = gate([{ path: 'src/auth/login.test.ts', status: 'deleted', additions: 0, deletions: 40 }], { 'src/auth/login.test.ts': 'it(...)' }, {});
    expect(r.blocking[0]).toMatchObject({ ruleId: 'PG-TEST-DELETED', file: 'src/auth/login.test.ts' });
    // 非テストファイルの削除は対象外
    expect(gate([{ path: 'src/old.ts', status: 'deleted', additions: 0, deletions: 4 }], { 'src/old.ts': 'x' }, {}).findings).toEqual([]);
  });
});

describe('Policy Gate v2.1 — verification config (case 6)', () => {
  it('detects required scripts removed, no-op\'d or changed in the root package.json', () => {
    const before = JSON.stringify({ scripts: { typecheck: 'tsc --noEmit', lint: 'eslint .', 'test:run': 'vitest run' } });
    expect(verifyScriptChanges(before, JSON.stringify({ scripts: { typecheck: 'tsc --noEmit', lint: 'eslint .' } }), ['typecheck', 'lint', 'test:run']).map((h) => h.text)).toEqual(['scripts.test:run が削除された（was: vitest run）']);
    expect(verifyScriptChanges(before, JSON.stringify({ scripts: { typecheck: 'tsc --noEmit', lint: 'echo skipped', 'test:run': 'vitest run' } }), ['typecheck', 'lint', 'test:run'])[0]?.text).toContain('無効化');
    expect(verifyScriptChanges(before, JSON.stringify({ scripts: { typecheck: 'tsc --noEmit', lint: 'eslint src', 'test:run': 'vitest run' } }), ['typecheck', 'lint', 'test:run'])[0]?.text).toContain('変更された');
    expect(verifyScriptChanges(before, before, ['typecheck', 'lint', 'test:run'])).toEqual([]);
    // ワークスペース内の package.json は対象外、ルートは対象
    const r = gate([mod('package.json'), mod('packages/x/package.json')], { 'package.json': before, 'packages/x/package.json': before }, { 'package.json': JSON.stringify({ scripts: { typecheck: 'tsc --noEmit', lint: 'eslint .', 'test:run': 'true' } }), 'packages/x/package.json': '{"scripts":{}}' });
    expect(r.blocking.map((f) => `${f.ruleId}:${f.file}`)).toEqual(['PG-VERIFY-SCRIPT:package.json']);
  });

  it('detects tsconfig strictness relaxation and new excludes (JSONC tolerant)', () => {
    const before = '{\n  // comment\n  "compilerOptions": { "strict": true, "noUnusedLocals": true },\n  "exclude": ["dist"]\n}\n';
    const after = '{\n  "compilerOptions": { "strict": false, "noUnusedLocals": true, },\n  "exclude": ["dist", "src/legacy/**"]\n}\n';
    const hits = tsconfigRelaxations('tsconfig.json', before, after).map((h) => h.text);
    expect(hits).toEqual(['compilerOptions.strict: true → false', 'exclude += "src/legacy/**"']);
    expect(tsconfigRelaxations('tsconfig.json', before, before)).toEqual([]);
    // 新規 tsconfig（ベース無し）は緩和とみなさない
    expect(tsconfigRelaxations('tsconfig.build.json', null, after)).toEqual([]);
  });

  it('detects ESLint rules turned off / downgraded and new ignores in flat config (AST) and legacy JSON', () => {
    const before = "import js from '@eslint/js';\nexport default [js.configs.recommended, { rules: { 'no-console': 'error', 'no-restricted-syntax': ['error', { selector: 'TemplateLiteral' }] }, ignores: ['dist/**'] }];\n";
    const after = "import js from '@eslint/js';\nexport default [js.configs.recommended, { rules: { 'no-console': 'warn', 'no-restricted-syntax': 'off', 'eqeqeq': 'off' }, ignores: ['dist/**', 'src/banner.ts'] }];\n";
    const hits = eslintRelaxations('eslint.config.js', before, after).map((h) => h.text);
    expect(hits).toEqual(['rule no-console を格下げ（2 → 1）', 'rule no-restricted-syntax を格下げ（2 → 0）', 'rule eqeqeq を off に設定（新規）', 'ignores += "src/banner.ts"']);
    expect(eslintRelaxations('eslint.config.js', before, before)).toEqual([]);
    // ルールの強化・追加は検出しない
    const stricter = before.replace("'no-console': 'error'", "'no-console': 'error', 'eqeqeq': 'error'");
    expect(eslintRelaxations('eslint.config.js', before, stricter)).toEqual([]);
    const json = eslintRelaxations('.eslintrc.json', '{"rules":{"no-console":"error"}}', '{"rules":{"no-console":0},"ignorePatterns":["lib/"]}').map((h) => h.text);
    expect(json).toEqual(['rule no-console を格下げ（2 → 0）', 'ignores += "lib/"']);
  });

  it('detects Vitest / Jest / Playwright exclusions and passWithNoTests (AST, strings ignored)', () => {
    const before = "export default defineConfig({ test: { include: ['test/**/*.test.ts'], exclude: ['**/node_modules/**'] } });\n";
    const after = "export default defineConfig({ test: { include: ['test/**/*.test.ts'], exclude: ['**/node_modules/**', 'test/slow/**'], passWithNoTests: true }, note: 'exclude: [\"fake\"]' });\n";
    expect(testConfigRelaxations('vitest.config.ts', before, after).map((h) => h.text)).toEqual(["テスト除外 += 'test/slow/**'", 'passWithNoTests: true が追加された']);
    expect(testConfigRelaxations('vitest.config.ts', before, before)).toEqual([]);
    const r = gate([mod('vitest.config.ts')], { 'vitest.config.ts': before }, { 'vitest.config.ts': after });
    expect(r.blocking.map((f) => f.ruleId)).toEqual(['PG-TESTCONFIG-RELAXED', 'PG-TESTCONFIG-RELAXED']);
  });
});

describe('Policy Gate v2.1 — approvals (human-managed, base commit only)', () => {
  it('exceptions from the base commit mark matching findings approved; malformed or AI-style entries are ignored', () => {
    const after = "// eslint-disable-next-line no-console\nconsole.log(1);\n";
    const files = [added('src/log.ts')];
    const approved = gate(files, {}, { 'src/log.ts': after }, JSON.stringify({ allow: [{ ruleId: 'PG-ESLINT-DISABLE', file: 'src/**', reason: 'console ログは許容' }] }));
    expect(approved.passed).toBe(true);
    expect(approved.findings[0]).toMatchObject({ approved: true, approvalReason: 'console ログは許容' });
    // file glob が合わない / 理由が無い / ruleId が不正 → 承認にならない
    expect(gate(files, {}, { 'src/log.ts': after }, JSON.stringify({ allow: [{ ruleId: 'PG-ESLINT-DISABLE', file: 'test/**', reason: 'x' }] })).passed).toBe(false);
    expect(gate(files, {}, { 'src/log.ts': after }, JSON.stringify({ allow: [{ ruleId: 'PG-ESLINT-DISABLE' }] })).passed).toBe(false);
    expect(gate(files, {}, { 'src/log.ts': after }, JSON.stringify({ allow: [{ ruleId: 'PG-EVERYTHING', reason: 'x' }] })).passed).toBe(false);
    expect(gate(files, {}, { 'src/log.ts': after }, 'not json').passed).toBe(false);
  });

  it('a clean change (new code and tests, no suppressions) passes with no findings', () => {
    const r = gate(
      [added('src/greet.ts'), added('test/greet.test.ts')],
      {},
      { 'src/greet.ts': "export const greet = (n: string) => 'Hello, ' + n + '!';\n", 'test/greet.test.ts': "import { it, expect } from 'vitest';\nit('x', () => expect(1).toBe(1));\n" }
    );
    expect(r).toEqual({ findings: [], blocking: [], passed: true });
  });
});
