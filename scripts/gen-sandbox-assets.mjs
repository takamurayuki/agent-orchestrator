#!/usr/bin/env node
// docker/ 配下のビルドコンテキスト（Dockerfile、egress-proxy.mjs、seccomp）と docker/manifest.json を
// runner に埋め込む TypeScript を生成する（apps/runner/src/sandbox/assets.generated.ts）。
// 配布版（Node SEA サイドカー）はリポジトリを持たないため、GUI からのサンドボックス準備はこの埋め込みから
// 一時ディレクトリにコンテキストを書き出して docker build する。
import { mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs';
import { dirname, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const dockerDir = join(root, 'docker');
const out = join(root, 'apps', 'runner', 'src', 'sandbox', 'assets.generated.ts');
const manifest = JSON.parse(readFileSync(join(dockerDir, 'manifest.json'), 'utf8'));

const files = {};
const walk = (dir) => {
  for (const name of readdirSync(dir)) {
    const full = join(dir, name);
    if (statSync(full).isDirectory()) walk(full);
    else if (name !== 'manifest.json') files[relative(dockerDir, full).replace(/\\/g, '/')] = readFileSync(full, 'utf8');
  }
};
walk(dockerDir);

const header = `// 自動生成: scripts/gen-sandbox-assets.mjs（docker/ の内容を埋め込み）。手で編集しないこと。\n`;
const body = `export const SANDBOX_MANIFEST = ${JSON.stringify(manifest, null, 2)} as const;\n\nexport const SANDBOX_FILES: Record<string, string> = ${JSON.stringify(files, null, 2)};\n`;
mkdirSync(dirname(out), { recursive: true });
writeFileSync(out, header + body);
console.log(`[sandbox-assets] ${Object.keys(files).length} files → ${relative(root, out)}`);
