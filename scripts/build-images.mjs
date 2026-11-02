#!/usr/bin/env node
// サンドボックスイメージと egress プロキシイメージをローカルでビルドする（docker/manifest.json のピン留め）。
// - ベースイメージはタグ + ダイジェストで固定し（FROM node:<tag>@sha256:...）、Docker がダイジェスト照合する
// - ビルド後にラベル（version / base-digest）がマニフェストと一致することを検証する
// アプリ（GUI）の「サンドボックスを準備する」は同じ手順を runner（apps/runner/src/sandbox/setup.ts）で行う。
// 使い方: node scripts/build-images.mjs [--force] [--policy pinned|latest]（latest: 浮動タグと各ツールの最新版を取得し、取得した版をラベルと /etc/agent-orchestrator/versions.json に記録。D-46）
import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const manifest = JSON.parse(readFileSync(join(root, 'docker', 'manifest.json'), 'utf8'));
const force = process.argv.includes('--force');
const policyIdx = process.argv.indexOf('--policy');
const policy = policyIdx >= 0 ? process.argv[policyIdx + 1] : 'pinned';
if (policy !== 'pinned' && policy !== 'latest') throw new Error(`--policy は pinned | latest: ${policy}`);
const latest = policy === 'latest';
const base = latest ? manifest.baseImageLatest : `${manifest.baseImage}@${manifest.baseDigest}`;
let resolvedDigest = manifest.baseDigest;

const docker = (args, opts = {}) => spawnSync('docker', args, { encoding: 'utf8', ...opts });

console.log(`[images] pulling pinned base ${base}`);
const pull = docker(['pull', base], { stdio: 'inherit' });
if (pull.status !== 0) {
  console.error('[images] base image pull failed');
  process.exit(pull.status ?? 1);
}
const digests = docker(['image', 'inspect', '--format', '{{json .RepoDigests}}', base]);
if (latest) {
  const m = /@(sha256:[0-9a-f]{64})/.exec(digests.stdout);
  if (digests.status !== 0 || !m) {
    console.error(`[images] cannot read base image digest: ${digests.stdout.trim()}`);
    process.exit(1);
  }
  resolvedDigest = m[1];
  console.log(`[images] latest policy: base resolved to ${resolvedDigest}`);
} else if (digests.status !== 0 || !digests.stdout.includes(manifest.baseDigest)) {
  console.error(`[images] base image digest mismatch: ${digests.stdout.trim()} (expected ${manifest.baseDigest})`);
  process.exit(1);
}

for (const img of manifest.images) {
  const exists = docker(['image', 'inspect', '--format', `{{index .Config.Labels "${manifest.labels.baseDigest}"}}`, img.tag]);
  if (exists.status === 0 && exists.stdout.trim() === resolvedDigest && !force && !latest) {
    console.log(`[images] ${img.tag} exists and matches manifest, skip (use --force to rebuild)`);
    continue;
  }
  console.log(`[images] building ${img.tag}`);
  const context = join(root, 'docker', img.context);
  const r = docker(
    [
      'build',
      '--pull=false',
      '-f',
      join(context, 'Dockerfile'),
      '-t',
      img.tag,
      '--build-arg',
      `NODE_IMAGE=${latest ? `${base}@${resolvedDigest}` : base}`,
      ...(latest ? ['--build-arg', 'VERSION_POLICY=latest', '--build-arg', 'PNPM_VERSION=latest', '--build-arg', 'CLAUDE_CODE_VERSION=latest', '--build-arg', 'CODEX_VERSION=latest', '--build-arg', 'UV_VERSION=latest'] : ['--build-arg', 'VERSION_POLICY=pinned']),
      '--label',
      `${manifest.labels.version}=${manifest.version}`,
      '--label',
      `${manifest.labels.baseDigest}=${resolvedDigest}`,
      '--label',
      `${manifest.labels.versionPolicy}=${policy}`,
      '--label',
      `${manifest.labels.builtAt}=${new Date().toISOString()}`,
      context
    ],
    { stdio: 'inherit' }
  );
  if (r.status !== 0) {
    console.error(`[images] build failed: ${img.tag}`);
    process.exit(r.status ?? 1);
  }
  const verify = docker(['image', 'inspect', '--format', `{{index .Config.Labels "${manifest.labels.version}"}}|{{index .Config.Labels "${manifest.labels.baseDigest}"}}`, img.tag]);
  if (verify.status !== 0 || verify.stdout.trim() !== `${manifest.version}|${resolvedDigest}`) {
    console.error(`[images] verification failed for ${img.tag}: ${verify.stdout.trim()}`);
    docker(['rmi', img.tag]);
    process.exit(1);
  }
  console.log(`[images] verified ${img.tag}`);
}
console.log('[images] done');
