#!/usr/bin/env node
// Node サイドカーを単一実行ファイル（Node SEA）としてビルドする（LIVE-03）。
//   1. esbuild で apps/runner を 1 本の CommonJS にバンドル（node:sqlite 等の組み込みは外部参照）
//   2. node --experimental-sea-config で blob を生成
//   3. 実行中の node.exe をコピーし、postject で blob を注入
//   4. apps/desktop/src-tauri/binaries/agent-orchestrator-runner-<target-triple>.exe に配置（Tauri の externalBin）
// 使い方: node scripts/build-sidecar.mjs [--target x86_64-pc-windows-msvc]
import { execFileSync } from 'node:child_process';
import { copyFileSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { build } from 'esbuild';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const argTarget = process.argv.indexOf('--target');
const triple = argTarget >= 0 ? process.argv[argTarget + 1] : process.platform === 'win32' ? 'x86_64-pc-windows-msvc' : process.platform === 'darwin' ? (process.arch === 'arm64' ? 'aarch64-apple-darwin' : 'x86_64-apple-darwin') : 'x86_64-unknown-linux-gnu';
const ext = process.platform === 'win32' ? '.exe' : '';
const version = JSON.parse(readFileSync(join(root, 'apps', 'runner', 'package.json'), 'utf8')).version;
const work = join(root, '.tmp', 'sea');
rmSync(work, { recursive: true, force: true });
mkdirSync(work, { recursive: true });

console.log('[sidecar] bundling runner with esbuild');
await build({
  entryPoints: [join(root, 'apps', 'runner', 'src', 'main.ts')],
  bundle: true,
  platform: 'node',
  target: 'node22',
  format: 'cjs',
  outfile: join(work, 'runner.cjs'),
  define: { __RUNNER_VERSION__: JSON.stringify(version) },
  external: ['node:*'],
  logLevel: 'warning',
  banner: { js: '// agent-orchestrator runner (bundled, CommonJS, for Node SEA)' }
});

const seaConfig = { main: join(work, 'runner.cjs'), output: join(work, 'runner.blob'), disableExperimentalSEAWarning: true, useCodeCache: false };
writeFileSync(join(work, 'sea-config.json'), JSON.stringify(seaConfig, null, 2));
console.log('[sidecar] generating SEA blob');
execFileSync(process.execPath, ['--experimental-sea-config', join(work, 'sea-config.json')], { stdio: 'inherit' });

const outDir = join(root, 'apps', 'desktop', 'src-tauri', 'binaries');
mkdirSync(outDir, { recursive: true });
const outFile = join(outDir, `agent-orchestrator-runner-${triple}${ext}`);
console.log(`[sidecar] copying ${process.execPath} → ${outFile}`);
copyFileSync(process.execPath, outFile);
if (process.platform === 'win32') {
  // 署名を外す（署名済み node.exe に注入すると署名が壊れるため）。signtool が無ければスキップ
  try {
    execFileSync('signtool', ['remove', '/s', outFile], { stdio: 'ignore' });
  } catch {
    /* optional */
  }
}
console.log('[sidecar] injecting blob with postject');
const postject = join(root, 'node_modules', 'postject', 'dist', 'cli.js');
if (!existsSync(postject)) throw new Error('postject が見つかりません（pnpm install）');
execFileSync(process.execPath, [postject, outFile, 'NODE_SEA_BLOB', join(work, 'runner.blob'), '--sentinel-fuse', 'NODE_SEA_FUSE_fce680ab2cc467b6e072b8b5df1996b2', ...(process.platform === 'darwin' ? ['--macho-segment-name', 'NODE_SEA'] : [])], { stdio: 'inherit' });

console.log('[sidecar] smoke test: --version');
const v = execFileSync(outFile, ['--version'], { encoding: 'utf8' }).trim();
if (v !== version) throw new Error(`サイドカーの --version が一致しない: ${v} != ${version}`);
console.log(`[sidecar] ok: ${outFile} (v${v}, node ${process.version})`);
