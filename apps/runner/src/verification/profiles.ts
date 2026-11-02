import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { VerificationProfileName, VerificationReadiness } from '@agent-orchestrator/contracts';

/**
 * 検証プロファイル（SPEC §7、v0.3 で npm / yarn に拡張。D-44）。
 * あらかじめ定義されたコマンドだけを実行し、task.yaml から任意コマンドは実行しない。
 * プロファイルは lockfile から決まる（pnpm-lock.yaml → node-pnpm、package-lock.json → node-npm、yarn.lock（v1）→ node-yarn）。
 * どのプロファイルも package.json に typecheck / lint / test:run scripts を要求し、install は lockfile 固定 + --ignore-scripts で行う。
 */
export type PackageManager = 'pnpm' | 'npm' | 'yarn';

export interface VerificationCommand {
  name: string;
  argv: string[];
  /** ネットワーク（依存取得）が必要か */
  network: 'egress' | 'none';
}

export interface VerificationProfile {
  name: VerificationProfileName;
  packageManager: PackageManager;
  /** いずれかがあればこのプロファイル */
  lockfiles: string[];
  requiredScripts: string[];
  commands: VerificationCommand[];
  /** package.json の script を実行する argv の接頭辞（例: ['pnpm', 'run']） */
  runPrefix: string[];
}

const REQUIRED = ['typecheck', 'lint', 'test:run'];

export const PROFILES: Record<VerificationProfileName, VerificationProfile> = {
  'node-pnpm': {
    name: 'node-pnpm',
    packageManager: 'pnpm',
    lockfiles: ['pnpm-lock.yaml'],
    requiredScripts: REQUIRED,
    runPrefix: ['pnpm', 'run'],
    commands: [
      { name: 'install', argv: ['pnpm', 'install', '--frozen-lockfile', '--ignore-scripts'], network: 'egress' },
      { name: 'typecheck', argv: ['pnpm', 'run', 'typecheck'], network: 'none' },
      { name: 'lint', argv: ['pnpm', 'run', 'lint'], network: 'none' },
      { name: 'test:run', argv: ['pnpm', 'run', 'test:run'], network: 'none' }
    ]
  },
  'node-npm': {
    name: 'node-npm',
    packageManager: 'npm',
    lockfiles: ['package-lock.json', 'npm-shrinkwrap.json'],
    requiredScripts: REQUIRED,
    runPrefix: ['npm', 'run'],
    commands: [
      { name: 'install', argv: ['npm', 'ci', '--ignore-scripts', '--no-audit', '--no-fund'], network: 'egress' },
      { name: 'typecheck', argv: ['npm', 'run', 'typecheck'], network: 'none' },
      { name: 'lint', argv: ['npm', 'run', 'lint'], network: 'none' },
      { name: 'test:run', argv: ['npm', 'run', 'test:run'], network: 'none' }
    ]
  },
  'node-yarn': {
    name: 'node-yarn',
    packageManager: 'yarn',
    lockfiles: ['yarn.lock'],
    requiredScripts: REQUIRED,
    runPrefix: ['yarn', 'run'],
    commands: [
      // Yarn 1 は lockfile の resolved URL（通常 registry.yarnpkg.com）から取得する。--registry を付けても resolved URL は置き換わらない（v0.3 実測）
      { name: 'install', argv: ['yarn', 'install', '--frozen-lockfile', '--ignore-scripts', '--non-interactive'], network: 'egress' },
      { name: 'typecheck', argv: ['yarn', 'run', 'typecheck'], network: 'none' },
      { name: 'lint', argv: ['yarn', 'run', 'lint'], network: 'none' },
      { name: 'test:run', argv: ['yarn', 'run', 'test:run'], network: 'none' }
    ]
  }
};

export function getProfile(name: VerificationProfileName): VerificationProfile {
  const p = PROFILES[name];
  if (!p) throw new Error(`unknown verification profile: ${name}`);
  return p;
}

export function expectedCommandNames(name: VerificationProfileName): string[] {
  return getProfile(name).commands.map((c) => c.name);
}

/** package.json の script を実行する argv（例: ['npm', 'run', 'typecheck']）。任意コマンドは組み立てない */
export function runScriptArgv(name: VerificationProfileName, script: string): string[] {
  return [...getProfile(name).runPrefix, script];
}

/** パッケージマネージャ名 → プロファイル名（bun 等の未対応は null） */
export function profileForPackageManager(pm: string | null | undefined): VerificationProfileName | null {
  if (pm === 'pnpm') return 'node-pnpm';
  if (pm === 'npm') return 'node-npm';
  if (pm === 'yarn') return 'node-yarn';
  return null;
}

/** lockfile の有無からプロファイルを決める（優先順: pnpm → yarn → npm）。無ければ null */
export function detectProfileFromFiles(files: readonly string[]): VerificationProfileName | null {
  const set = new Set(files);
  if (set.has('pnpm-lock.yaml')) return 'node-pnpm';
  if (set.has('yarn.lock')) return 'node-yarn';
  if (set.has('package-lock.json') || set.has('npm-shrinkwrap.json')) return 'node-npm';
  return null;
}

export function detectProfile(repoPath: string): VerificationProfileName | null {
  const names = ['pnpm-lock.yaml', 'yarn.lock', 'package-lock.json', 'npm-shrinkwrap.json'].filter((f) => existsSync(join(repoPath, f)));
  return detectProfileFromFiles(names);
}

/** yarn.lock が Yarn 1（classic）形式か。Yarn 2+（Berry）の lockfile は `__metadata:` を持つ */
export function isYarnClassicLockfile(content: string): boolean {
  return /^# yarn lockfile v1/m.test(content) && !/^__metadata:/m.test(content);
}

/** リポジトリの package.json を読んで、プロファイルが実行可能か判定する（read-only）。 */
export function checkProfileReadiness(repoPath: string, name: VerificationProfileName): VerificationReadiness {
  const profile = getProfile(name);
  const pkgPath = join(repoPath, 'package.json');
  if (!existsSync(pkgPath)) {
    return { profile: name, ready: false, missingScripts: profile.requiredScripts, detail: 'package.json が見つかりません' };
  }
  let scripts: Record<string, unknown> = {};
  try {
    const pkg = JSON.parse(readFileSync(pkgPath, 'utf8')) as { scripts?: Record<string, unknown> };
    scripts = pkg.scripts ?? {};
  } catch {
    return { profile: name, ready: false, missingScripts: profile.requiredScripts, detail: 'package.json を解析できません' };
  }
  const missing = profile.requiredScripts.filter((s) => typeof scripts[s] !== 'string' || (scripts[s] as string).trim() === '');
  const lock = profile.lockfiles.find((f) => existsSync(join(repoPath, f)));
  if (!lock) {
    return { profile: name, ready: false, missingScripts: missing, detail: `${profile.lockfiles.join(' / ')} が見つかりません（${name} プロファイルは ${profile.packageManager} の lockfile を要求します）` };
  }
  if (name === 'node-yarn') {
    let content = '';
    try {
      content = readFileSync(join(repoPath, lock), 'utf8');
    } catch {
      content = '';
    }
    if (!isYarnClassicLockfile(content)) {
      return { profile: name, ready: false, missingScripts: missing, detail: 'yarn.lock が Yarn 1（classic）形式ではありません。Yarn 2+（Berry）はサンドボックスで未対応です（yarn 1.22 を同梱）' };
    }
  }
  return {
    profile: name,
    ready: missing.length === 0,
    missingScripts: missing,
    detail: missing.length === 0 ? `必要な scripts（typecheck / lint / test:run）が定義されています（${profile.packageManager}、${lock}）` : `package.json に scripts が不足: ${missing.join(', ')}`
  };
}
