#!/usr/bin/env node
// Reviewer（Codex）コンテナ用の seccomp プロファイルを Docker 既定プロファイルから最小差分で導出する（D-22 強化）。
//   1. Docker 既定プロファイル（moby/profiles seccomp/default.json）を読む
//   2. bubblewrap（非特権 user namespace）に必要な syscall を「CAP_SYS_ADMIN 無しでも許可」に追加
//   3. 追加した syscall を 1 つずつ外して bwrap が動くか実測し、不要なものを落として最小集合にする
//   4. docker/sandbox/seccomp-reviewer.json と apps/runner/src/isolation/seccomp-profile.ts を生成
// 使い方: node scripts/derive-seccomp-profile.mjs <docker-default.json> [--image agent-orchestrator-sandbox:0.1.0]
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const [, , defaultPath, ...rest] = process.argv;
if (!defaultPath) throw new Error('usage: derive-seccomp-profile.mjs <docker-default.json> [--image <image>]');
const image = rest.includes('--image') ? rest[rest.indexOf('--image') + 1] : 'agent-orchestrator-sandbox:0.1.0';
const BWRAP = '/usr/local/lib/node_modules/@openai/codex/node_modules/@openai/codex-linux-x64/vendor/x86_64-unknown-linux-musl/codex-resources/bwrap';

const base = JSON.parse(readFileSync(defaultPath, 'utf8'));
// bwrap が user namespace 内で使う可能性のある syscall（既定では CAP_SYS_ADMIN が必要）
const CANDIDATES = ['unshare', 'clone', 'clone3', 'mount', 'umount2', 'pivot_root', 'setns', 'chroot', 'sethostname', 'mount_setattr', 'open_tree', 'move_mount'];

function profileWith(allowed) {
  const p = structuredClone(base);
  // 既定の clone 制限（namespace フラグをマスクで拒否）と clone3 の ERRNO は、allowed に含まれる場合だけ上書きする
  p.syscalls = p.syscalls.filter((g) => !(g.names.length === 1 && g.names[0] === 'clone3' && g.action === 'SCMP_ACT_ERRNO' && allowed.includes('clone3')));
  if (allowed.includes('clone')) {
    p.syscalls = p.syscalls.filter((g) => !(g.names.length === 1 && g.names[0] === 'clone' && g.args && g.excludes?.caps?.includes('CAP_SYS_ADMIN')));
  }
  p.syscalls.push({ names: allowed, action: 'SCMP_ACT_ALLOW', comment: 'agent-orchestrator reviewer: bubblewrap (unprivileged user namespace) without CAP_SYS_ADMIN' });
  return p;
}

const work = mkdtempSync(join(tmpdir(), 'ao-seccomp-'));
function bwrapWorks(allowed) {
  const file = join(work, `p-${allowed.length}-${Date.now().toString(36)}.json`);
  writeFileSync(file, JSON.stringify(profileWith(allowed)));
  const r = spawnSync(
    'docker',
    ['run', '--rm', '--user', '1001:1001', '--cap-drop', 'ALL', '--security-opt', 'no-new-privileges', '--security-opt', `seccomp=${file}`, '--read-only', '--tmpfs', '/tmp', '--network', 'none', image, 'sh', '-c', `${BWRAP} --unshare-all --ro-bind / / --proc /proc --dev /dev --tmpfs /tmp --die-with-parent -- /bin/sh -c 'echo bwrap-ok' 2>&1`],
    { encoding: 'utf8', env: { ...process.env, MSYS_NO_PATHCONV: '1' } }
  );
  return r.stdout.includes('bwrap-ok');
}

try {
  console.log('[seccomp] baseline (default profile): bwrap works?', bwrapWorks([]));
  if (!bwrapWorks(CANDIDATES)) throw new Error('全候補を許可しても bwrap が動きません（カーネル側の制限の可能性）');
  let minimal = [...CANDIDATES];
  for (const name of CANDIDATES) {
    const trial = minimal.filter((n) => n !== name);
    const ok = bwrapWorks(trial);
    console.log(`[seccomp] without ${name}: ${ok ? 'still works → drop' : 'breaks → keep'}`);
    if (ok) minimal = trial;
  }
  if (!bwrapWorks(minimal)) throw new Error('最小集合の再検証に失敗');
  const profile = profileWith(minimal);
  const outJson = join(root, 'docker', 'sandbox', 'seccomp-reviewer.json');
  writeFileSync(outJson, `${JSON.stringify(profile, null, 2)}\n`);
  const outTs = join(root, 'apps', 'runner', 'src', 'isolation', 'seccomp-profile.ts');
  writeFileSync(
    outTs,
    `// 自動生成: node scripts/derive-seccomp-profile.mjs（編集しない）。元: docker/sandbox/seccomp-reviewer.json\n// Docker 既定 seccomp プロファイル + bubblewrap に必要な最小の syscall（CAP_SYS_ADMIN 無しで許可）: ${minimal.join(', ')}\nexport const REVIEWER_SECCOMP_ALLOWED_EXTRA = ${JSON.stringify(minimal)} as const;\nexport const REVIEWER_SECCOMP_PROFILE: Record<string, unknown> = ${JSON.stringify(profile)};\n`
  );
  console.log(`[seccomp] minimal extra allow set: ${minimal.join(', ')}`);
  console.log(`[seccomp] wrote ${outJson} and ${outTs}`);
} finally {
  rmSync(work, { recursive: true, force: true });
}
