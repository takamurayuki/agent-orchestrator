import { describe, expect, it } from 'vitest';
import type { DiffFile } from '@agent-orchestrator/contracts';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { classifyScriptChange, collectSuppressComments, collectTestSkips, eslintRelaxations, evaluatePolicyGate, parsePolicyExceptions, syntaxErrors, testConfigRelaxations, tsconfigRelaxations, verifyScriptChanges } from '../../src/policy-gate.js';

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

  it('regression (v2.1 live run): a trailing eslint-disable-line after a template literal with substitutions is detected', () => {
    const after = "export function makeBanner(title: string, width: number): string {\n  const left = 1;\n  return `${'='.repeat(left)}${title}${'='.repeat(left)}`; // eslint-disable-line no-restricted-syntax\n}\n/* eslint-disable @typescript-eslint/no-explicit-any */ export const z: any = 1; // @ts-ignore\nconst tail = 1; /* eslint-disable-next-line */\n";
    const hits = collectSuppressComments('src/banner.ts', after);
    expect(hits.map((h) => `${h.kind}:${h.line}`)).toEqual(['eslint-disable:3', 'eslint-disable:5', 'ts-suppress:5', 'eslint-disable:6']);
    const r = gate([added('src/banner.ts')], {}, { 'src/banner.ts': after });
    expect(r.blocking.map((f) => f.ruleId)).toEqual(['PG-ESLINT-DISABLE', 'PG-ESLINT-DISABLE', 'PG-TS-SUPPRESS', 'PG-ESLINT-DISABLE']);
    // テンプレートリテラルの本文に書かれた文字列はコメントではない
    expect(collectSuppressComments('x.ts', 'const s = `// eslint-disable-line ${1} // @ts-ignore`;\n')).toEqual([]);
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
    expect(verifyScriptChanges(before, JSON.stringify({ scripts: { typecheck: 'tsc --noEmit', lint: 'eslint . --max-warnings 0', 'test:run': 'vitest run' } }), ['typecheck', 'lint', 'test:run'])[0]?.severity).toBe('warning');
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

describe('Policy Gate v2.2 — robustness (template literals, regex, JSX/TSX, multi-line, CRLF, Unicode, incomplete code)', () => {
  it('regex literals and strings that look like directives are not comments', () => {
    const src = "const re = /\\/\\/ eslint-disable-next-line/;\nconst re2 = /\\/\\* @ts-ignore \\*\\//g;\nconst s = 'x // eslint-disable-line';\nconst t = `// @ts-nocheck ${re.source}`;\nexport { re, re2, s, t };\n";
    expect(collectSuppressComments('src/r.ts', src)).toEqual([]);
    expect(gate([added('src/r.ts')], {}, { 'src/r.ts': src }).findings).toEqual([]);
  });

  it('JSX/TSX: directive comments inside JSX expression containers are detected; JSX text is not', () => {
    const tsx = "export function C() {\n  return (\n    <div>\n      {/* eslint-disable-next-line react/jsx-key */}\n      {[1].map((i) => <span>{i}</span>)}\n      eslint-disable-next-line is just text here\n    </div>\n  );\n}\n";
    const hits = collectSuppressComments('src/C.tsx', tsx);
    expect(hits.map((h) => `${h.kind}:${h.line}`)).toEqual(['eslint-disable:4']);
    const jsx = "export const D = () => <p title=\"// eslint-disable\">{'/* eslint-disable */'}</p>; // eslint-disable-line\n";
    expect(collectSuppressComments('src/D.jsx', jsx).map((h) => h.line)).toEqual([1]);
  });

  it('multi-line block comments and leading banners', () => {
    const src = "/**\n * eslint-disable\n */\nexport const a = 1;\n/* eslint-disable\n   no-console */\nconsole.log(a);\n";
    // JSDoc 形式（先頭が /** で次行が ' * eslint-disable'）は ESLint のディレクティブではない。/* eslint-disable ... */ は複数行でも有効
    expect(collectSuppressComments('src/m.ts', src).map((h) => h.line)).toEqual([5]);
  });

  it('CRLF line endings produce correct line numbers and no spurious findings', () => {
    const before = "export const a = 1;\r\nconsole.log(a);\r\n";
    const after = "export const a = 1;\r\n// eslint-disable-next-line no-console\r\nconsole.log(a);\r\n";
    const r = gate([mod('src/crlf.ts')], { 'src/crlf.ts': before }, { 'src/crlf.ts': after });
    expect(r.blocking.map((f) => `${f.ruleId}:${f.line}`)).toEqual(['PG-ESLINT-DISABLE:2']);
    // 改行コードだけが変わった（LF → CRLF）既存コメントは新規ではない
    const b2 = "// eslint-disable-next-line no-console\nconsole.log(1);\n";
    const a2 = b2.replace(/\n/g, '\r\n');
    expect(gate([mod('src/x.ts')], { 'src/x.ts': b2 }, { 'src/x.ts': a2 }).findings).toEqual([]);
  });

  it('Unicode (Japanese, emoji, astral chars) does not shift lines or hide directives', () => {
    const src = "// 日本語のコメント 🎉\nconst 挨拶 = '𠮷野家 // eslint-disable';\n// eslint-disable-next-line no-console ― 理由: デバッグ\nconsole.log(挨拶);\n";
    expect(collectSuppressComments('src/u.ts', src).map((h) => `${h.kind}:${h.line}`)).toEqual(['eslint-disable:3']);
  });

  it('syntactically incomplete code is analysed as far as possible and reported as undeterminable (never a silent pass)', () => {
    const broken = "export function f( {\n  // eslint-disable-next-line no-console\n  console.log(1\n";
    expect(syntaxErrors('src/b.ts', broken).length).toBeGreaterThan(0);
    const r = gate([added('src/b.ts')], {}, { 'src/b.ts': broken });
    const ids = r.blocking.map((f) => f.ruleId);
    expect(ids).toContain('PG-UNPARSEABLE');
    expect(ids).toContain('PG-ESLINT-DISABLE'); // 可能な範囲で解析
    expect(r.passed).toBe(false);
    expect(gate([added('tsconfig.json')], {}, { 'tsconfig.json': '{ not json' }).blocking.map((f) => f.ruleId)).toEqual(['PG-UNPARSEABLE']);
  });

  it('false-positive check: every source and test file of this repository, taken as a new file, yields no findings', () => {
    const roots = [join(import.meta.dirname, '..', '..', 'src'), join(import.meta.dirname, '..')];
    const files: string[] = [];
    const walk = (p: string) => {
      for (const e of readdirSync(p)) {
        const full = join(p, e);
        if (statSync(full).isDirectory()) walk(full);
        else if (/\.ts$/.test(e) && !/schemas\.generated/.test(e)) files.push(full);
      }
    };
    for (const r of roots) walk(r);
    expect(files.length).toBeGreaterThan(30);
    const diff = files.map((f) => ({ path: f.replace(/\\/g, '/').replace(/^.*\/apps\/runner\//, ''), status: 'added' as const, additions: 1, deletions: 0, abs: f }));
    const current = Object.fromEntries(diff.map((f) => [f.path, readFileSync(f.abs, 'utf8')]));
    const r = evaluatePolicyGate({ files: diff.map(({ abs: _a, ...rest }) => rest), baseContents: {}, currentContents: current });
    expect(r.findings.map((f) => `${f.ruleId} ${f.file}:${f.line}`)).toEqual([]);
  });
});

describe('Policy Gate v2.2 — verification script change classification (Phase 4)', () => {
  it('classifies removal/no-op as blocking, mechanical strengthening as warning, and anything else as blocking (human approval needed)', () => {
    expect(classifyScriptChange('vitest run', 'vitest run')).toBe('unchanged');
    expect(classifyScriptChange('vitest run', 'echo skip')).toBe('noop');
    expect(classifyScriptChange('eslint .', 'eslint . --max-warnings 0')).toBe('strengthened');
    expect(classifyScriptChange('tsc --noEmit', 'tsc --noEmit && eslint .')).toBe('strengthened');
    expect(classifyScriptChange('pnpm -r run typecheck', 'pnpm --filter x run build && pnpm -r run typecheck')).toBe('strengthened');
    expect(classifyScriptChange('eslint .', 'eslint src')).toBe('unknown');
    expect(classifyScriptChange('vitest run', 'vitest run --passWithNoTests')).toBe('unknown');
    const before = JSON.stringify({ scripts: { typecheck: 'tsc --noEmit', lint: 'eslint .', 'test:run': 'vitest run' } });
    const strengthened = JSON.stringify({ scripts: { typecheck: 'tsc --noEmit', lint: 'eslint . --max-warnings 0', 'test:run': 'vitest run' } });
    const r1 = gate([mod('package.json')], { 'package.json': before }, { 'package.json': strengthened });
    expect(r1.passed).toBe(true);
    expect(r1.findings.map((f) => `${f.ruleId}:${f.severity}`)).toEqual(['PG-VERIFY-SCRIPT:warning']);
    expect(r1.findings[0]?.message).toContain('強化');
    const unknown = JSON.stringify({ scripts: { typecheck: 'tsc --noEmit', lint: 'eslint src', 'test:run': 'vitest run' } });
    const r2 = gate([mod('package.json')], { 'package.json': before }, { 'package.json': unknown });
    expect(r2.passed).toBe(false);
    expect(r2.blocking[0]?.evidence).toContain('人間の承認');
    // 人間がベースコミットに例外を置けば通る
    expect(gate([mod('package.json')], { 'package.json': before }, { 'package.json': unknown }, JSON.stringify({ allow: [{ ruleId: 'PG-VERIFY-SCRIPT', reason: 'lint 対象を src に限定することを承認' }] })).passed).toBe(true);
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
