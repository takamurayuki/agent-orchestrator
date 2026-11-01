import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { VerificationProfileName, VerificationReadiness } from '@agent-orchestrator/contracts';

/**
 * 検証プロファイル（SPEC §7）。あらかじめ定義されたコマンドだけを実行し、task.yaml から任意コマンドは実行しない。
 * `node-pnpm` はプロジェクトの package.json に typecheck / lint / test:run scripts を要求する。
 */
export interface VerificationCommand {
  name: string;
  argv: string[];
  /** ネットワーク（依存取得）が必要か */
  network: 'egress' | 'none';
}

export interface VerificationProfile {
  name: VerificationProfileName;
  requiredScripts: string[];
  commands: VerificationCommand[];
}

export const PROFILES: Record<VerificationProfileName, VerificationProfile> = {
  'node-pnpm': {
    name: 'node-pnpm',
    requiredScripts: ['typecheck', 'lint', 'test:run'],
    commands: [
      { name: 'install', argv: ['pnpm', 'install', '--frozen-lockfile', '--ignore-scripts'], network: 'egress' },
      { name: 'typecheck', argv: ['pnpm', 'run', 'typecheck'], network: 'none' },
      { name: 'lint', argv: ['pnpm', 'run', 'lint'], network: 'none' },
      { name: 'test:run', argv: ['pnpm', 'run', 'test:run'], network: 'none' }
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
  const hasLock = existsSync(join(repoPath, 'pnpm-lock.yaml'));
  if (!hasLock) {
    return { profile: name, ready: false, missingScripts: missing, detail: 'pnpm-lock.yaml が見つかりません（node-pnpm プロファイルは pnpm lockfile を要求します）' };
  }
  return {
    profile: name,
    ready: missing.length === 0,
    missingScripts: missing,
    detail: missing.length === 0 ? '必要な scripts（typecheck / lint / test:run）が定義されています' : `package.json に scripts が不足: ${missing.join(', ')}`
  };
}
