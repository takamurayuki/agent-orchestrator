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
  /** lockfile から決めた検証プロファイル（未対応・lockfile 無しは null） */
  verificationProfile?: string | null;
  verificationReady: boolean;
  verificationDetail: string;
  isClean: boolean | null;
  egressAllowlist: readonly string[];
  /** ルート以外の workspace package.json（モノレポ） */
  workspacePackages?: readonly string[];
}

/** サンドボックスに固定されている Node / pnpm（docker/sandbox/Dockerfile の ARG と manifest から） */
/** node:22 ベースイメージ同梱の npm / yarn（classic）。Dockerfile では固定していないため、イメージ検証時に確認した版（メジャーのみ使う） */
export const SANDBOX_NPM_VERSION = '10.9';
export const SANDBOX_YARN_VERSION = '1.22';

export function sandboxVersions(): { node: string; pnpm: string; npm: string; yarn: string } {
  const nodeMatch = /^node:(\d+\.\d+\.\d+)/.exec(SANDBOX_MANIFEST.baseImage);
  const pnpmMatch = /ARG PNPM_VERSION=([\d.]+)/.exec(SANDBOX_FILES['sandbox/Dockerfile'] ?? '');
  return { node: nodeMatch?.[1] ?? '22', pnpm: pnpmMatch?.[1] ?? '12', npm: SANDBOX_NPM_VERSION, yarn: SANDBOX_YARN_VERSION };
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
  const add = (c: Omit<ProjectDiagnosisCheck, 'howToVerify'> & { howToVerify?: string | null }) => checks.push({ howToVerify: null, ...c });
  const versions = sandboxVersions();
  const pkg = parseJson<PackageJson>(input.readText('package.json'));
  const allow = new Set(input.egressAllowlist.map((h) => h.toLowerCase()));

  // 1. パッケージマネージャと lockfile（pnpm / npm / yarn 1 に対応。v0.3、D-44）
  const pmDetected = input.packageManager;
  if (pmDetected === 'pnpm' && input.files.includes('pnpm-lock.yaml')) {
    const lock = input.readText('pnpm-lock.yaml') ?? '';
    const ver = /^lockfileVersion:\s*['"]?([\d.]+)/m.exec(lock)?.[1] ?? null;
    if (ver && Number(ver.split('.')[0]) < 9) add({ id: 'lockfile', label: 'lockfile', status: 'warn', detail: `pnpm-lock.yaml は lockfileVersion ${ver}。サンドボックスの pnpm ${versions.pnpm} は v9 形式を期待するため --frozen-lockfile が失敗する可能性があります`, fix: 'プロジェクト側で pnpm 12 系により pnpm install を実行して lockfile を更新・コミットしてください' });
    else add({ id: 'lockfile', label: 'lockfile', status: 'ok', detail: `pnpm-lock.yaml（lockfileVersion ${ver ?? '不明'}）`, fix: null });
  } else if (pmDetected === 'npm') {
    const lockName = input.files.includes('package-lock.json') ? 'package-lock.json' : 'npm-shrinkwrap.json';
    const lock = parseJson<{ lockfileVersion?: number }>(input.readText(lockName));
    const ver = lock?.lockfileVersion ?? null;
    if (ver !== null && ver < 2) add({ id: 'lockfile', label: 'lockfile', status: 'warn', detail: `${lockName} は lockfileVersion ${ver}（npm 6 形式）。サンドボックスの npm ${versions.npm} の npm ci は動きますが、形式が古いため依存解決に時間がかかることがあります`, fix: 'プロジェクト側で npm 10 系により npm install を実行して lockfile を更新・コミットしてください' });
    else add({ id: 'lockfile', label: 'lockfile', status: 'ok', detail: `${lockName}（lockfileVersion ${ver ?? '不明'}）。npm ci --ignore-scripts で復元します`, fix: null });
  } else if (pmDetected === 'yarn') {
    const lock = input.readText('yarn.lock') ?? '';
    const classic = /^# yarn lockfile v1/m.test(lock) && !/^__metadata:/m.test(lock);
    if (classic) add({ id: 'lockfile', label: 'lockfile', status: 'ok', detail: 'yarn.lock（Yarn 1 形式）。yarn install --frozen-lockfile --ignore-scripts で復元します', fix: null });
    else add({ id: 'lockfile', label: 'lockfile', status: 'fail', detail: 'yarn.lock が Yarn 2+（Berry）形式です。サンドボックスは Yarn 1（classic）のみ同梱しており、Berry は未対応です', fix: 'Yarn 1 に戻すか、npm / pnpm の lockfile に移行してください（対応予定: Berry は corepack と yarnpkg への通信許可が必要）' });
  } else if (pmDetected) {
    add({ id: 'lockfile', label: 'パッケージマネージャ', status: 'fail', detail: `${pmDetected} の lockfile を検出。サンドボックスで対応しているのは pnpm / npm / yarn 1 です`, fix: 'pnpm / npm / yarn 1 のいずれかに移行して lockfile をコミットしてください' });
  } else {
    add({ id: 'lockfile', label: 'lockfile', status: 'fail', detail: 'lockfile（pnpm-lock.yaml / package-lock.json / yarn.lock）が見つかりません', fix: 'プロジェクト側で install を実行して lockfile をコミットしてください' });
  }

  // 2. Node / pnpm のバージョン
  const enginesNode = pkg?.engines?.node;
  if (enginesNode) {
    const ok = satisfiesMajor(enginesNode, versions.node);
    add({ id: 'node', label: 'Node.js バージョン', status: ok === null ? 'unverified' : ok ? 'ok' : 'warn', detail: ok === null ? `engines.node "${enginesNode}" を判定できません（サンドボックスは Node ${versions.node}）` : ok ? `engines.node "${enginesNode}" はサンドボックスの Node ${versions.node} を満たします` : `engines.node "${enginesNode}" はサンドボックスの Node ${versions.node} と一致しません。検証コマンドが失敗する可能性があります`, fix: ok === false ? 'プロジェクトが Node 22 で動くことを確認するか、engines.node を見直してください（サンドボックスの Node は固定です）' : null, howToVerify: ok === null ? `Node ${versions.node} で typecheck / lint / test:run が通るか確認する` : null });
  } else {
    add({ id: 'node', label: 'Node.js バージョン', status: 'ok', detail: `engines.node の指定なし（サンドボックスは Node ${versions.node}）`, fix: null });
  }
  const pm = pkg?.packageManager ?? '';
  const pmMatch = /^(pnpm|npm|yarn|bun)@(\d+)(?:\.(\d+))?/.exec(pm);
  const sandboxOf: Record<string, string> = { pnpm: versions.pnpm, npm: versions.npm, yarn: versions.yarn };
  if (pmMatch && pmDetected && pmMatch[1] !== pmDetected) {
    add({ id: 'package_manager', label: 'パッケージマネージャ', status: 'warn', detail: `packageManager は ${pm} ですが lockfile は ${pmDetected} のものです。サンドボックスは lockfile に合わせて ${pmDetected} で検証します`, fix: 'packageManager と lockfile を揃えてください' });
  } else if (pmMatch && !(pmMatch[1]! in sandboxOf)) {
    add({ id: 'package_manager', label: 'パッケージマネージャ', status: 'fail', detail: `packageManager が ${pmMatch[1]} です。サンドボックスで対応しているのは pnpm / npm / yarn 1 です`, fix: 'pnpm / npm / yarn 1 のいずれかを使うプロジェクトにしてください' });
  } else if (pmMatch) {
    const sandbox = sandboxOf[pmMatch[1]!]!;
    const sameMajor = pmMatch[2] === sandbox.split('.')[0];
    const berry = pmMatch[1] === 'yarn' && Number(pmMatch[2]) >= 2;
    if (berry) add({ id: 'package_manager', label: 'パッケージマネージャ', status: 'fail', detail: `packageManager ${pm}（Yarn 2+）ですが、サンドボックスは Yarn ${versions.yarn}（classic）のみ対応です`, fix: 'Yarn 1 に戻すか、npm / pnpm に移行してください' });
    else add({ id: 'package_manager', label: 'パッケージマネージャ', status: sameMajor ? 'ok' : 'warn', detail: sameMajor ? `packageManager ${pm}（サンドボックスは ${pmMatch[1]} ${sandbox}。同じメジャー）` : `packageManager ${pm} ですが、サンドボックスは固定の ${pmMatch[1]} ${sandbox} で実行します（packageManager の自動切替は無効）。lockfile 互換性に注意`, fix: sameMajor ? null : `${pmMatch[1]} ${sandbox.split('.')[0]} 系で install が通ることをプロジェクト側で確認してください` });
  } else {
    const detectedVersion = pmDetected && sandboxOf[pmDetected] ? `${pmDetected} ${sandboxOf[pmDetected]}` : `pnpm ${versions.pnpm} / npm ${versions.npm} / yarn ${versions.yarn}`;
    add({ id: 'package_manager', label: 'パッケージマネージャ', status: 'ok', detail: `packageManager の指定なし（サンドボックスは ${detectedVersion}）`, fix: null });
  }

  // 3. サプライチェーン設定（minimumReleaseAge）: pnpm のみ（npm / yarn 1 には同等の既定ポリシーが無い）
  const ws = input.readText('pnpm-workspace.yaml') ?? '';
  const npmrc = input.readText('.npmrc') ?? '';
  const mraWs = /^\s*minimumReleaseAge\s*:\s*(\d+)/m.exec(ws)?.[1];
  const mraRc = /^\s*minimum-release-age\s*=\s*(\d+)/m.exec(npmrc)?.[1];
  const mra = mraWs ?? mraRc ?? null;
  if (pmDetected !== 'pnpm') {
    // 該当なし（項目は出さない）
  } else if (mra !== null) {
    add({ id: 'supply_chain', label: 'サプライチェーン設定（minimumReleaseAge）', status: 'ok', detail: `minimumReleaseAge = ${mra} 分（プロジェクト設定、${mraWs ? 'pnpm-workspace.yaml' : '.npmrc'}）`, fix: null });
  } else {
    add({ id: 'supply_chain', label: 'サプライチェーン設定（minimumReleaseAge）', status: 'unverified', detail: `プロジェクトに設定が無いため、サンドボックスの pnpm ${versions.pnpm} の既定（公開から ${PNPM_DEFAULT_MINIMUM_RELEASE_AGE_MINUTES / 60} 時間未満のパッケージを拒否）が適用されます。lockfile に直近 24 時間以内に公開されたパッケージがあると install が失敗します（公開日時は依存解決しないと分からないため未確認）`, fix: '問題ではありません。失敗した場合は pnpm-workspace.yaml に minimumReleaseAge / minimumReleaseAgeExclude を明示するか、依存を更新してから 1 日空けて再実行してください', howToVerify: `プロジェクトで pnpm ${versions.pnpm.split('.')[0]} 系を使い \`pnpm install --frozen-lockfile\` が通るか確認する（公開 24 時間未満の依存があれば ERR_PNPM_MINIMUM_RELEASE_AGE_VIOLATION で失敗する）。直近に依存を更新していなければ通常は問題ありません` });
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
  if (lifecycle.length > 0) add({ id: 'install_scripts', label: 'インストール時スクリプト', status: 'unverified', detail: `${lifecycle.join(', ')} は --ignore-scripts のため実行されません。生成物に依存する検証は失敗する可能性があります（実行しないと分からないため未確認）`, fix: '失敗した場合は、生成物をコミットするか、検証コマンドからその手順を外してください', howToVerify: `プロジェクトで \`${pmDetected === 'npm' ? 'npm ci --ignore-scripts' : pmDetected === 'yarn' ? 'yarn install --frozen-lockfile --ignore-scripts' : 'pnpm install --ignore-scripts'}\` の後に typecheck / lint / test:run が通るか確認する` });
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
  // npm / yarn の lockfile は各パッケージの取得 URL を持つ（registry.npmjs.org / registry.yarnpkg.com は既定で許可）
  const npmLock = pmDetected === 'npm' ? (input.readText(input.files.includes('package-lock.json') ? 'package-lock.json' : 'npm-shrinkwrap.json') ?? '') : '';
  for (const m of npmLock.matchAll(/"resolved":\s*"(https?:\/\/[^"]+)"/g)) {
    const h = hostOf(m[1]!);
    if (h) needed.set(h, 'package-lock.json の resolved');
  }
  const yarnLock = pmDetected === 'yarn' ? (input.readText('yarn.lock') ?? '') : '';
  for (const m of yarnLock.matchAll(/resolved\s+"(https?:\/\/[^"#]+)/g)) {
    const h = hostOf(m[1]!);
    if (h) needed.set(h, 'yarn.lock の resolved');
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
  add({ id: 'verification', label: `検証プロファイル ${input.verificationProfile ?? '未判定'}`, status: input.verificationReady ? 'ok' : 'fail', detail: input.verificationDetail, fix: input.verificationReady ? null : 'package.json に typecheck / lint / test:run を定義し、pnpm / npm / yarn 1 のいずれかの lockfile をコミットしてください' });
  if (input.isClean === false) add({ id: 'worktree', label: '作業ツリー', status: 'fail', detail: '未コミットの変更があります（ベース SHA を固定できません）', fix: '実行前に commit または stash してください' });

  // 実行不可（fail）> 問題あり（warn: 実行に影響）> 未確認（unverified: 失敗する可能性はあるが問題と断定しない）> 実行可能
  const verdict: ProjectDiagnosis['verdict'] = checks.some((c) => c.status === 'fail') ? 'blocked' : checks.some((c) => c.status === 'warn') ? 'issues' : checks.some((c) => c.status === 'unverified') ? 'unverified' : 'ready';
  return { verdict, checks };
}
