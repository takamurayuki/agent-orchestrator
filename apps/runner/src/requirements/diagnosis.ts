import type { ProjectDiagnosis, ProjectDiagnosisCheck } from '@agent-orchestrator/contracts';
import { SANDBOX_FILES, SANDBOX_MANIFEST } from '../sandbox/assets.generated.js';

/**
 * プロジェクト事前診断（v0.2.0、D-38）。プロジェクト選択直後に読み取り専用で行い、ヒアリング前に
 * 「実行可能 / 要確認 / 実行不可」を示す。実際に依存解決しなければ分からないことは unverified として表示し、
 * 自動修復（設定の書き換え、allowlist の拡張）は行わない。
 *
 * 入力はファイル一覧とテキスト読み取り関数だけ（ネットワークもコマンド実行も使わない）。
 */
export interface DiagnosisInput {
  files: readonly string[];
  readText: (path: string) => string | null;
  packageManager: string | null;
  verificationReady: boolean;
  verificationDetail: string;
  isClean: boolean | null;
  egressAllowlist: readonly string[];
  /** ルート以外の workspace package.json（モノレポ） */
  workspacePackages?: readonly string[];
}

/** サンドボックスに固定されている Node / pnpm（docker/sandbox/Dockerfile の ARG と manifest から） */
export function sandboxVersions(): { node: string; pnpm: string } {
  const nodeMatch = /^node:(\d+\.\d+\.\d+)/.exec(SANDBOX_MANIFEST.baseImage);
  const pnpmMatch = /ARG PNPM_VERSION=([\d.]+)/.exec(SANDBOX_FILES['sandbox/Dockerfile'] ?? '');
  return { node: nodeMatch?.[1] ?? '22', pnpm: pnpmMatch?.[1] ?? '12' };
}

/** pnpm 12 の既定 minimumReleaseAge（分）。実測: cutoff = now − 24h（docs/BETA_VERIFICATION.md） */
export const PNPM_DEFAULT_MINIMUM_RELEASE_AGE_MINUTES = 1440;

/** 依存名 → インストール / 検証時に必要になる外部ホスト（--ignore-scripts でも検証コマンドから呼ばれ得る） */
const DEP_HOSTS: Array<[RegExp, string, string]> = [
  [/^(prisma|@prisma\/client)$/, 'binaries.prisma.sh', 'prisma generate が Prisma エンジンを取得する'],
  [/^puppeteer$/, 'storage.googleapis.com', 'puppeteer が Chromium を取得する'],
  [/^(playwright|@playwright\/test)$/, 'playwright.azureedge.net', 'playwright install がブラウザを取得する'],
  [/^cypress$/, 'download.cypress.io', 'cypress がバイナリを取得する'],
  [/^(sharp)$/, 'github.com', 'sharp が libvips バイナリを取得する（prebuild）'],
  [/^(better-sqlite3|node-gyp|canvas)$/, 'github.com', 'ネイティブモジュールのビルド / prebuild を取得する']
];

interface PackageJson {
  name?: string;
  packageManager?: string;
  engines?: { node?: string; pnpm?: string };
  scripts?: Record<string, string>;
  dependencies?: Record<string, string>;
  devDependencies?: Record<string, string>;
  optionalDependencies?: Record<string, string>;
}

function parseJson<T>(text: string | null): T | null {
  if (!text) return null;
  try {
    const v = JSON.parse(text) as unknown;
    return v && typeof v === 'object' ? (v as T) : null;
  } catch {
    return null;
  }
}

/** 単純な semver 範囲チェック（>=, ^, ~, x, 完全一致、|| の OR）。判定できない書式は null */
export function satisfiesMajor(range: string, version: string): boolean | null {
  const major = Number(version.split('.')[0]);
  const minor = Number(version.split('.')[1] ?? 0);
  const alts = range.split('||').map((s) => s.trim()).filter(Boolean);
  if (alts.length === 0) return null;
  let decided = false;
  for (const alt of alts) {
    const parts = alt.split(/\s+/).filter(Boolean);
    let ok = true;
    let parsed = false;
    for (const p of parts) {
      const m = /^(>=|>|<=|<|\^|~|=)?\s*v?(\d+)(?:\.(\d+|x|\*))?(?:\.(\d+|x|\*))?$/.exec(p);
      if (!m) {
        ok = false;
        break;
      }
      parsed = true;
      const op = m[1] ?? '';
      const pMajor = Number(m[2]);
      const pMinor = m[3] && m[3] !== 'x' && m[3] !== '*' ? Number(m[3]) : null;
      if (op === '>=' ) ok &&= major > pMajor || (major === pMajor && (pMinor === null || minor >= pMinor));
      else if (op === '>') ok &&= major > pMajor || (major === pMajor && pMinor !== null && minor > pMinor);
      else if (op === '<=') ok &&= major < pMajor || (major === pMajor && (pMinor === null || minor <= pMinor));
      else if (op === '<') ok &&= major < pMajor || (major === pMajor && pMinor !== null && minor < pMinor);
      else if (op === '^' || op === '' || op === '=') ok &&= major === pMajor && (pMinor === null || op === '^' ? true : minor === pMinor);
      else if (op === '~') ok &&= major === pMajor && (pMinor === null || minor === pMinor);
    }
    if (parsed) decided = true;
    if (parsed && ok) return true;
  }
  return decided ? false : null;
}

function hostOf(url: string): string | null {
  try {
    return new URL(url).hostname;
  } catch {
    return null;
  }
}

export function diagnoseProject(input: DiagnosisInput): ProjectDiagnosis {
  const checks: ProjectDiagnosisCheck[] = [];
  const add = (c: ProjectDiagnosisCheck) => checks.push(c);
  const versions = sandboxVersions();
  const pkg = parseJson<PackageJson>(input.readText('package.json'));
  const allow = new Set(input.egressAllowlist.map((h) => h.toLowerCase()));

  // 1. パッケージマネージャと lockfile
  if (input.packageManager === 'pnpm' && input.files.includes('pnpm-lock.yaml')) {
    const lock = input.readText('pnpm-lock.yaml') ?? '';
    const ver = /^lockfileVersion:\s*['"]?([\d.]+)/m.exec(lock)?.[1] ?? null;
    if (ver && Number(ver.split('.')[0]) < 9) add({ id: 'lockfile', label: 'lockfile', status: 'warn', detail: `pnpm-lock.yaml は lockfileVersion ${ver}。サンドボックスの pnpm ${versions.pnpm} は v9 形式を期待するため --frozen-lockfile が失敗する可能性があります`, fix: 'プロジェクト側で pnpm 12 系により pnpm install を実行して lockfile を更新・コミットしてください' });
    else add({ id: 'lockfile', label: 'lockfile', status: 'ok', detail: `pnpm-lock.yaml（lockfileVersion ${ver ?? '不明'}）`, fix: null });
  } else if (input.packageManager && input.packageManager !== 'pnpm') {
    add({ id: 'lockfile', label: 'パッケージマネージャ', status: 'fail', detail: `${input.packageManager} の lockfile を検出。検証プロファイルは node-pnpm（pnpm-lock.yaml）のみ対応です`, fix: 'pnpm に移行して pnpm-lock.yaml をコミットするか、pnpm 対応のプロジェクトを選択してください' });
  } else {
    add({ id: 'lockfile', label: 'lockfile', status: 'fail', detail: 'pnpm-lock.yaml が見つかりません', fix: 'プロジェクト側で pnpm install を実行して pnpm-lock.yaml をコミットしてください' });
  }

  // 2. Node / pnpm のバージョン
  const enginesNode = pkg?.engines?.node;
  if (enginesNode) {
    const ok = satisfiesMajor(enginesNode, versions.node);
    add({ id: 'node', label: 'Node.js バージョン', status: ok === null ? 'unverified' : ok ? 'ok' : 'warn', detail: ok === null ? `engines.node "${enginesNode}" を判定できません（サンドボックスは Node ${versions.node}）` : ok ? `engines.node "${enginesNode}" はサンドボックスの Node ${versions.node} を満たします` : `engines.node "${enginesNode}" はサンドボックスの Node ${versions.node} と一致しません。検証コマンドが失敗する可能性があります`, fix: ok === false ? 'プロジェクトが Node 22 で動くことを確認するか、engines.node を見直してください（サンドボックスの Node は固定です）' : null });
  } else {
    add({ id: 'node', label: 'Node.js バージョン', status: 'ok', detail: `engines.node の指定なし（サンドボックスは Node ${versions.node}）`, fix: null });
  }
  const pm = pkg?.packageManager ?? '';
  const pmMatch = /^(pnpm|npm|yarn|bun)@(\d+)(?:\.(\d+))?/.exec(pm);
  if (pmMatch && pmMatch[1] !== 'pnpm') {
    add({ id: 'pnpm', label: 'pnpm バージョン', status: 'fail', detail: `packageManager が ${pmMatch[1]} です。node-pnpm プロファイルは pnpm のみ対応です`, fix: 'pnpm を使うプロジェクトを選択してください' });
  } else if (pmMatch) {
    const sameMajor = pmMatch[2] === versions.pnpm.split('.')[0];
    add({ id: 'pnpm', label: 'pnpm バージョン', status: sameMajor ? 'ok' : 'warn', detail: sameMajor ? `packageManager ${pm}（サンドボックスは pnpm ${versions.pnpm}。同じメジャー）` : `packageManager ${pm} ですが、サンドボックスは固定の pnpm ${versions.pnpm} で実行します（packageManager の自動切替は無効）。lockfile 互換性に注意`, fix: sameMajor ? null : `pnpm ${versions.pnpm.split('.')[0]} 系で pnpm install が通ることをプロジェクト側で確認してください` });
  } else {
    add({ id: 'pnpm', label: 'pnpm バージョン', status: 'ok', detail: `packageManager の指定なし（サンドボックスは pnpm ${versions.pnpm}）`, fix: null });
  }

  // 3. サプライチェーン設定（minimumReleaseAge）
  const ws = input.readText('pnpm-workspace.yaml') ?? '';
  const npmrc = input.readText('.npmrc') ?? '';
  const mraWs = /^\s*minimumReleaseAge\s*:\s*(\d+)/m.exec(ws)?.[1];
  const mraRc = /^\s*minimum-release-age\s*=\s*(\d+)/m.exec(npmrc)?.[1];
  const mra = mraWs ?? mraRc ?? null;
  if (mra !== null) {
    add({ id: 'supply_chain', label: 'サプライチェーン設定（minimumReleaseAge）', status: 'ok', detail: `minimumReleaseAge = ${mra} 分（プロジェクト設定、${mraWs ? 'pnpm-workspace.yaml' : '.npmrc'}）`, fix: null });
  } else {
    add({ id: 'supply_chain', label: 'サプライチェーン設定（minimumReleaseAge）', status: 'unverified', detail: `プロジェクトに設定が無いため、サンドボックスの pnpm ${versions.pnpm} の既定（公開から ${PNPM_DEFAULT_MINIMUM_RELEASE_AGE_MINUTES / 60} 時間未満のパッケージを拒否）が適用されます。lockfile に直近 24 時間以内に公開されたパッケージがあると install が失敗します（公開日時は依存解決しないと分からないため未確認）`, fix: 'pnpm-workspace.yaml に minimumReleaseAge / minimumReleaseAgeExclude を明示するか、依存を更新してから 1 日空けて実行してください' });
  }

  // 4. インストールスクリプト（--ignore-scripts で実行されない）
  const allPkgs: Array<{ path: string; pkg: PackageJson }> = [{ path: 'package.json', pkg: pkg ?? {} }];
  for (const wp of input.workspacePackages ?? []) {
    const p = parseJson<PackageJson>(input.readText(wp));
    if (p) allPkgs.push({ path: wp, pkg: p });
  }
  const lifecycle: string[] = [];
  for (const { path, pkg: p } of allPkgs) {
    for (const s of ['preinstall', 'install', 'postinstall', 'prepare']) if (typeof p.scripts?.[s] === 'string') lifecycle.push(`${path}#${s}`);
  }
  if (lifecycle.length > 0) add({ id: 'install_scripts', label: 'インストール時スクリプト', status: 'unverified', detail: `${lifecycle.join(', ')} は --ignore-scripts のため実行されません。生成物に依存する検証は失敗する可能性があります（実行しないと分からないため未確認）`, fix: '検証コマンド（typecheck / lint / test:run）がインストールスクリプト無しで通ることを確認してください' });
  else add({ id: 'install_scripts', label: 'インストール時スクリプト', status: 'ok', detail: 'preinstall / postinstall / prepare なし', fix: null });

  // 5. ネットワーク（allowlist との不一致）
  const needed = new Map<string, string>();
  const registryRc = /^\s*(?:@[^:]+:)?registry\s*=\s*(\S+)/gm;
  for (const m of npmrc.matchAll(registryRc)) {
    const h = hostOf(m[1]!);
    if (h) needed.set(h, `.npmrc の registry`);
  }
  const lock = input.readText('pnpm-lock.yaml') ?? '';
  for (const m of lock.matchAll(/tarball:\s*(https?:\/\/[^\s'"]+)/g)) {
    const h = hostOf(m[1]!);
    if (h) needed.set(h, 'pnpm-lock.yaml の tarball');
  }
  for (const m of lock.matchAll(/repo:\s*(https?:\/\/[^\s'"]+)/g)) {
    const h = hostOf(m[1]!);
    if (h) needed.set(h, 'pnpm-lock.yaml の git 依存');
  }
  const depNames = new Set<string>();
  for (const { pkg: p } of allPkgs) for (const k of Object.keys({ ...(p.dependencies ?? {}), ...(p.devDependencies ?? {}), ...(p.optionalDependencies ?? {}) })) depNames.add(k);
  const scriptsText = allPkgs.map(({ pkg: p }) => Object.values(p.scripts ?? {}).join(' ')).join(' ');
  const downloads: string[] = [];
  for (const [re, host, why] of DEP_HOSTS) {
    for (const d of depNames) {
      if (!re.test(d)) continue;
      const inVerify = /prisma generate|playwright install|puppeteer|cypress/.test(scriptsText) || /prisma/.test(d);
      if (inVerify && !allow.has(host)) downloads.push(`${host}（${why}: ${d}）`);
      break;
    }
  }
  const unresolvable = [...needed.entries()].filter(([h]) => !allow.has(h.toLowerCase()));
  if (unresolvable.length > 0) {
    add({ id: 'network', label: 'ネットワーク（allowlist）', status: 'fail', detail: `allowlist 外のホストが必要です: ${unresolvable.map(([h, why]) => `${h}（${why}）`).join(', ')}。サンドボックスからは遮断されるため install が失敗します`, fix: `運用者設定 AGENT_ORCHESTRATOR_EGRESS_ALLOWLIST に追加するか（信頼できるホストのみ）、public registry のみを使う構成に変更してください。アプリは allowlist を自動で広げません` });
  } else if (downloads.length > 0) {
    add({ id: 'network', label: 'ネットワーク（allowlist）', status: 'warn', detail: `検証中に allowlist 外への通信が必要になる可能性: ${downloads.join(', ')}。遮断されるため該当コマンドは失敗します`, fix: '該当の生成物をコミットする、または検証コマンドからその手順を外してください。allowlist は自動で広げません' });
  } else {
    add({ id: 'network', label: 'ネットワーク（allowlist）', status: 'ok', detail: `必要な通信先は allowlist 内（${[...allow].join(', ')}）に収まる見込み`, fix: null });
  }

  // 6. 検証プロファイル / 作業ツリー
  add({ id: 'verification', label: '検証プロファイル node-pnpm', status: input.verificationReady ? 'ok' : 'fail', detail: input.verificationDetail, fix: input.verificationReady ? null : 'package.json に typecheck / lint / test:run を定義し、pnpm-lock.yaml を用意してください' });
  if (input.isClean === false) add({ id: 'worktree', label: '作業ツリー', status: 'fail', detail: '未コミットの変更があります（ベース SHA を固定できません）', fix: '実行前に commit または stash してください' });

  const verdict: ProjectDiagnosis['verdict'] = checks.some((c) => c.status === 'fail') ? 'blocked' : checks.some((c) => c.status === 'warn' || c.status === 'unverified') ? 'needs_attention' : 'ready';
  return { verdict, checks };
}
