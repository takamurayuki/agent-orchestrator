#!/usr/bin/env node
// LIVE テスト用の小さなサンプルリポジトリを作る（node-pnpm プロファイル対応）。
// 使い方: node tests/fixtures/make-sample-repo.mjs <dir>
import { execFileSync } from 'node:child_process';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';

const dir = resolve(process.argv.slice(2).find((a) => !a.startsWith('--')) ?? 'sample-repo');
mkdirSync(join(dir, 'src'), { recursive: true });
mkdirSync(join(dir, 'test'), { recursive: true });
writeFileSync(join(dir, 'package.json'), JSON.stringify({
  name: 'sample-app', version: '0.0.1', private: true, type: 'module',
  scripts: { typecheck: 'tsc -p tsconfig.json --noEmit', lint: 'eslint src test', 'test:run': 'vitest run' },
  devDependencies: { typescript: '~5.9.3', vitest: '^4.1.12', eslint: '^9.39.0', '@eslint/js': '^9.39.0', 'typescript-eslint': '^8.72.1', '@types/node': '^22.20.5' }
}, null, 2));
writeFileSync(join(dir, 'tsconfig.json'), JSON.stringify({ compilerOptions: { target: 'ES2022', module: 'NodeNext', moduleResolution: 'NodeNext', strict: true, noEmit: true, types: ['node'] }, include: ['src', 'test'] }, null, 2));
// --strict-lint: no-console とテンプレートリテラル禁止を error にする（Phase 2「検証失敗 → 修正」シナリオ用）
const strictLint = process.argv.includes('--strict-lint');
writeFileSync(
  join(dir, 'eslint.config.js'),
  strictLint
    ? "import js from '@eslint/js';\nimport tseslint from 'typescript-eslint';\nexport default tseslint.config(js.configs.recommended, ...tseslint.configs.recommended, { rules: { 'no-console': 'error', 'no-restricted-syntax': ['error', { selector: 'TemplateLiteral', message: 'プロジェクト規約: テンプレートリテラルは使わず文字列連結を使う' }] } });\n"
    : "import js from '@eslint/js';\nimport tseslint from 'typescript-eslint';\nexport default tseslint.config(js.configs.recommended, ...tseslint.configs.recommended);\n"
);
writeFileSync(join(dir, 'src', 'greet.ts'), strictLint ? "export function greet(name: string): string {\n  return 'Hello, ' + name + '!';\n}\n" : "export function greet(name: string): string {\n  return `Hello, ${name}!`;\n}\n");
writeFileSync(join(dir, 'test', 'greet.test.ts'), "import { expect, it } from 'vitest';\nimport { greet } from '../src/greet.js';\n\nit('greets', () => {\n  expect(greet('world')).toBe('Hello, world!');\n});\n");
writeFileSync(join(dir, 'README.md'), '# sample-app\n\nA tiny TypeScript library used as the LIVE test target.\n');
writeFileSync(join(dir, '.gitignore'), 'node_modules/\n');
// Windows の pnpm は .cmd シムなので shell 経由で起動する（テスト用フィクスチャ。引数は固定）
const run = (cmd, args) => execFileSync(cmd, args, { cwd: dir, stdio: 'inherit', shell: cmd.endsWith('.cmd') });
run(process.platform === 'win32' ? 'pnpm.cmd' : 'pnpm', ['install', '--lockfile-only']);
run('git', ['init', '-q', '-b', 'main']);
run('git', ['add', '-A']);
run('git', ['-c', 'user.email=sample@example.com', '-c', 'user.name=sample', 'commit', '-q', '-m', 'init']);
console.log(`sample repo created at ${dir}`);
