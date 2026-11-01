#!/usr/bin/env node
// サンドボックスイメージと egress プロキシイメージをローカルでビルドする（ピン留めタグ）。
// 使い方: node scripts/build-images.mjs [--force]
import { spawnSync } from 'node:child_process';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const VERSION = '0.1.0';
const images = [
  { tag: `agent-orchestrator-egress-proxy:${VERSION}`, file: 'docker/egress-proxy/Dockerfile', context: 'docker/egress-proxy' },
  { tag: `agent-orchestrator-sandbox:${VERSION}`, file: 'docker/sandbox/Dockerfile', context: 'docker/sandbox' }
];
const force = process.argv.includes('--force');
for (const img of images) {
  const exists = spawnSync('docker', ['image', 'inspect', '--format', '{{.Id}}', img.tag], { encoding: 'utf8' });
  if (exists.status === 0 && !force) {
    console.log(`[images] ${img.tag} exists (${exists.stdout.trim().slice(0, 19)}), skip (use --force to rebuild)`);
    continue;
  }
  console.log(`[images] building ${img.tag}`);
  const r = spawnSync('docker', ['build', '-f', join(root, img.file), '-t', img.tag, join(root, img.context)], { stdio: 'inherit' });
  if (r.status !== 0) {
    console.error(`[images] build failed: ${img.tag}`);
    process.exit(r.status ?? 1);
  }
}
console.log('[images] done');
