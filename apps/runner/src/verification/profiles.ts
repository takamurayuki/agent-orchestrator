import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { VerificationProfileName, VerificationReadiness } from '@agent-orchestrator/contracts';
import { parsePyproject, parseRequirements } from '../requirements/python-project.js';

/**
 * 検証プロファイル（SPEC §7。v0.3 で npm / yarn（D-44）と Python（D-45）に拡張）。
 * あらかじめ定義されたコマンドだけを実行し、task.yaml から任意コマンドは実行しない。
 * プロファイルは lockfile から決まる:
 *   pnpm-lock.yaml → node-pnpm、yarn.lock（v1）→ node-yarn、package-lock.json → node-npm、
 *   uv.lock → python-uv、requirements.txt → python-pip
 * Node は package.json の typecheck / lint / test:run scripts を要求する。Python は依存に ruff と pytest（任意で mypy / pyright）が
 * あることを要求し、pyproject.toml の [tool.agent-orchestrator.scripts] で上書きできる（許可したツール名で始まるコマンドのみ）。
 */
export type PackageManager = 'pnpm' | 'npm' | 'yarn' | 'uv' | 'pip';
export type Language = 'node' | 'python';

export interface VerificationCommand {
  name: string;
  argv: string[];
  /** ネットワーク（依存取得）が必要か */
  network: 'egress' | 'none';
}

export interface VerificationProfile {
  name: VerificationProfileName;
  language: Language;
  packageManager: PackageManager;
  /** いずれかがあればこのプロファイル */
  lockfiles: string[];
  /** 完了ゲートが要求するコマンド名（順序どおり） */
  commandNames: string[];
  /** Node: package.json に必要な scripts。Python: 依存に必要なツール */
  requiredScripts: string[];
  /** package.json の script / 許可ツールを実行する argv の接頭辞（例: ['pnpm', 'run']） */
  runPrefix: string[];
}

const NODE_REQUIRED = ['typecheck', 'lint', 'test:run'];
const NODE_NAMES = ['install', 'typecheck', 'lint', 'test:run'];

/** Python の検証で実行してよいツール（[tool.agent-orchestrator.scripts] の先頭トークンもこの中に限る） */
export const PYTHON_ALLOWED_TOOLS = new Set(['python', 'python3', 'ruff', 'mypy', 'pyright', 'pytest', 'flake8', 'black', 'isort', 'pylint', 'bandit', 'coverage']);

export const PROFILES: Record<VerificationProfileName, VerificationProfile> = {
  'node-pnpm': { name: 'node-pnpm', language: 'node', packageManager: 'pnpm', lockfiles: ['pnpm-lock.yaml'], commandNames: NODE_NAMES, requiredScripts: NODE_REQUIRED, runPrefix: ['pnpm', 'run'] },
  'node-npm': { name: 'node-npm', language: 'node', packageManager: 'npm', lockfiles: ['package-lock.json', 'npm-shrinkwrap.json'], commandNames: NODE_NAMES, requiredScripts: NODE_REQUIRED, runPrefix: ['npm', 'run'] },
  'node-yarn': { name: 'node-yarn', language: 'node', packageManager: 'yarn', lockfiles: ['yarn.lock'], commandNames: NODE_NAMES, requiredScripts: NODE_REQUIRED, runPrefix: ['yarn', 'run'] },
  'python-uv': { name: 'python-uv', language: 'python', packageManager: 'uv', lockfiles: ['uv.lock'], commandNames: ['install', 'typecheck', 'lint', 'test:run'], requiredScripts: ['lint', 'test:run'], runPrefix: ['uv', 'run', '--frozen', '--no-sync'] },
  'python-pip': { name: 'python-pip', language: 'python', packageManager: 'pip', lockfiles: ['requirements.txt'], commandNames: ['venv', 'install', 'typecheck', 'lint', 'test:run'], requiredScripts: ['lint', 'test:run'], runPrefix: ['.venv/bin/python', '-m'] }
};

export function getProfile(name: VerificationProfileName): VerificationProfile {
  const p = PROFILES[name];
  if (!p) throw new Error(`unknown verification profile: ${name}`);
  return p;
}

export function expectedCommandNames(name: VerificationProfileName): string[] {
  return getProfile(name).commandNames;
}

/** パッケージマネージャ名 → プロファイル名（poetry / bun 等の未対応は null） */
export function profileForPackageManager(pm: string | null | undefined): VerificationProfileName | null {
  if (pm === 'pnpm') return 'node-pnpm';
  if (pm === 'npm') return 'node-npm';
  if (pm === 'yarn') return 'node-yarn';
  if (pm === 'uv') return 'python-uv';
  if (pm === 'pip') return 'python-pip';
  return null;
}

/** lockfile の有無からプロファイルを決める。Node（package.json）を優先し、無ければ Python。無ければ null */
export function detectProfileFromFiles(files: readonly string[]): VerificationProfileName | null {
  const set = new Set(files);
  if (set.has('package.json')) {
    if (set.has('pnpm-lock.yaml')) return 'node-pnpm';
    if (set.has('yarn.lock')) return 'node-yarn';
    if (set.has('package-lock.json') || set.has('npm-shrinkwrap.json')) return 'node-npm';
    return null;
  }
  if (set.has('uv.lock')) return 'python-uv';
  if (set.has('requirements.txt')) return 'python-pip';
  return null;
}

export function detectProfile(repoPath: string): VerificationProfileName | null {
  const names = ['package.json', 'pnpm-lock.yaml', 'yarn.lock', 'package-lock.json', 'npm-shrinkwrap.json', 'uv.lock', 'requirements.txt', 'pyproject.toml'].filter((f) => existsSync(join(repoPath, f)));
  return detectProfileFromFiles(names);
}

/** yarn.lock が Yarn 1（classic）形式か。Yarn 2+（Berry）の lockfile は `__metadata:` を持つ */
export function isYarnClassicLockfile(content: string): boolean {
  return /^# yarn lockfile v1/m.test(content) && !/^__metadata:/m.test(content);
}

function readIf(repoPath: string, rel: string): string | null {
  try {
    return existsSync(join(repoPath, rel)) ? readFileSync(join(repoPath, rel), 'utf8') : null;
  } catch {
    return null;
  }
}

/** Python 用: 検証ツールの選択結果 */
export interface PythonToolPlan {
  typecheck: string[] | null;
  lint: string[] | null;
  test: string[] | null;
  /** 上書き（[tool.agent-orchestrator.scripts]）が使われた項目 */
  overridden: string[];
  /** 判定に使った依存名 */
  dependencies: string[];
  /** 許可外のツールで始まる上書き */
  rejectedOverrides: string[];
}

function tokens(cmd: string): string[] {
  return cmd.trim().split(/\s+/).filter(Boolean);
}

/** pyproject.toml / requirements*.txt から、typecheck / lint / test のコマンド（接頭辞なし）を決める。推測で補わない */
export function planPythonTools(repoPath: string): PythonToolPlan {
  const py = parsePyproject(readIf(repoPath, 'pyproject.toml'));
  const deps = new Set(py?.dependencies ?? []);
  for (const f of ['requirements.txt', 'requirements-dev.txt', 'requirements-test.txt', 'dev-requirements.txt']) {
    const r = parseRequirements(readIf(repoPath, f));
    for (const n of r?.names ?? []) deps.add(n);
  }
  const scripts = py?.scripts ?? {};
  const overridden: string[] = [];
  const rejected: string[] = [];
  const pick = (key: string, fallback: string[] | null): string[] | null => {
    const override = scripts[key];
    if (override) {
      const t = tokens(override);
      if (t.length > 0 && PYTHON_ALLOWED_TOOLS.has(t[0]!)) {
        overridden.push(key);
        return t;
      }
      rejected.push(`${key} = ${override}`);
    }
    return fallback;
  };
  const typecheck = pick('typecheck', deps.has('mypy') ? ['mypy', '.'] : deps.has('pyright') ? ['pyright'] : ['python', '-m', 'compileall', '-q', '.']);
  const lint = pick('lint', deps.has('ruff') ? ['ruff', 'check', '.'] : deps.has('flake8') ? ['flake8', '.'] : null);
  const test = pick('test:run', deps.has('pytest') ? ['pytest', '-q'] : null);
  return { typecheck, lint, test, overridden, dependencies: [...deps].sort(), rejectedOverrides: rejected };
}

/** Python のツール呼び出しをプロファイルの実行形式へ（uv run … / .venv/bin/python -m …）。任意コマンドは組み立てない */
export function pythonArgv(name: VerificationProfileName, tool: readonly string[]): string[] {
  const [first, ...rest] = tool;
  if (!first || !PYTHON_ALLOWED_TOOLS.has(first)) throw new Error(`許可されていないツールです: ${first ?? ''}`);
  if (name === 'python-uv') return ['uv', 'run', '--frozen', '--no-sync', first, ...rest];
  // pip: 仮想環境の python からモジュールとして呼ぶ（python / python3 はそのまま）
  if (first === 'python' || first === 'python3') return ['.venv/bin/python', ...rest];
  return ['.venv/bin/python', '-m', first, ...rest];
}

/**
 * プロジェクトに合わせた検証コマンド列。Node は固定、Python は pyproject / requirements から決める（ツールが無い項目は null → 不合格扱いの説明用に残す）。
 * 名前は expectedCommandNames と一致する。
 */
export function commandsFor(name: VerificationProfileName, repoPath: string): VerificationCommand[] {
  const p = getProfile(name);
  if (p.language === 'node') {
    const install: Record<string, string[]> = {
      'node-pnpm': ['pnpm', 'install', '--frozen-lockfile', '--ignore-scripts'],
      'node-npm': ['npm', 'ci', '--ignore-scripts', '--no-audit', '--no-fund'],
      // Yarn 1 は lockfile の resolved URL（通常 registry.yarnpkg.com）から取得する。--registry を付けても resolved URL は置き換わらない（v0.3 実測）
      'node-yarn': ['yarn', 'install', '--frozen-lockfile', '--ignore-scripts', '--non-interactive']
    };
    return [
      { name: 'install', argv: install[name]!, network: 'egress' },
      { name: 'typecheck', argv: [...p.runPrefix, 'typecheck'], network: 'none' },
      { name: 'lint', argv: [...p.runPrefix, 'lint'], network: 'none' },
      { name: 'test:run', argv: [...p.runPrefix, 'test:run'], network: 'none' }
    ];
  }
  const plan = planPythonTools(repoPath);
  // ツールが無い項目は、明確に失敗する固定コマンド（推測で別のツールに置き換えない）
  const missing = (what: string): string[] => ['python3', '-c', `import sys; sys.stderr.write('${what} のツールが依存に無く、[tool.agent-orchestrator.scripts] にも定義がありません\\n'); sys.exit(1)`];
  const run = (tool: string[] | null, what: string) => (tool ? pythonArgv(name, tool) : missing(what));
  if (name === 'python-uv') {
    return [
      { name: 'install', argv: ['uv', 'sync', '--frozen'], network: 'egress' },
      { name: 'typecheck', argv: run(plan.typecheck, 'typecheck'), network: 'none' },
      { name: 'lint', argv: run(plan.lint, 'lint'), network: 'none' },
      { name: 'test:run', argv: run(plan.test, 'test'), network: 'none' }
    ];
  }
  const reqs = ['requirements.txt', 'requirements-dev.txt', 'requirements-test.txt', 'dev-requirements.txt'].filter((f) => existsSync(join(repoPath, f)));
  return [
    { name: 'venv', argv: ['python3', '-m', 'venv', '.venv'], network: 'none' },
    { name: 'install', argv: ['.venv/bin/python', '-m', 'pip', 'install', '--no-input', '--disable-pip-version-check', ...reqs.flatMap((f) => ['-r', f])], network: 'egress' },
    { name: 'typecheck', argv: run(plan.typecheck, 'typecheck'), network: 'none' },
    { name: 'lint', argv: run(plan.lint, 'lint'), network: 'none' },
    { name: 'test:run', argv: run(plan.test, 'test'), network: 'none' }
  ];
}

/**
 * script 名を実行する argv。Node は package.json の script 名、Python は [tool.agent-orchestrator.scripts] の名前（値は許可ツールで始まるコマンド）。
 * Python で定義が無い / 許可外なら null（呼び出し側が失敗として扱う）
 */
export function runScriptArgv(name: VerificationProfileName, script: string, projectScripts?: Record<string, string>): string[] | null {
  const p = getProfile(name);
  if (p.language === 'node') return [...p.runPrefix, script];
  const value = projectScripts?.[script];
  if (!value) return null;
  const t = tokens(value);
  if (t.length === 0 || !PYTHON_ALLOWED_TOOLS.has(t[0]!)) return null;
  return pythonArgv(name, t);
}

/** Python プロジェクトの script 表（generatedArtifacts の script 名の解決に使う）。pyproject が無ければ空 */
export function projectScripts(name: VerificationProfileName, repoPath: string): Record<string, string> {
  const p = getProfile(name);
  if (p.language === 'node') {
    try {
      const pkg = JSON.parse(readFileSync(join(repoPath, 'package.json'), 'utf8')) as { scripts?: Record<string, unknown> };
      return Object.fromEntries(Object.entries(pkg.scripts ?? {}).filter(([, v]) => typeof v === 'string')) as Record<string, string>;
    } catch {
      return {};
    }
  }
  return parsePyproject(readIf(repoPath, 'pyproject.toml'))?.scripts ?? {};
}

/** リポジトリを読んで、プロファイルが実行可能か判定する（read-only）。 */
export function checkProfileReadiness(repoPath: string, name: VerificationProfileName): VerificationReadiness {
  const profile = getProfile(name);
  if (profile.language === 'node') {
    const pkgPath = join(repoPath, 'package.json');
    if (!existsSync(pkgPath)) return { profile: name, ready: false, missingScripts: profile.requiredScripts, detail: 'package.json が見つかりません' };
    let scripts: Record<string, unknown> = {};
    try {
      const pkg = JSON.parse(readFileSync(pkgPath, 'utf8')) as { scripts?: Record<string, unknown> };
      scripts = pkg.scripts ?? {};
    } catch {
      return { profile: name, ready: false, missingScripts: profile.requiredScripts, detail: 'package.json を解析できません' };
    }
    const missing = profile.requiredScripts.filter((s) => typeof scripts[s] !== 'string' || (scripts[s] as string).trim() === '');
    const lock = profile.lockfiles.find((f) => existsSync(join(repoPath, f)));
    if (!lock) return { profile: name, ready: false, missingScripts: missing, detail: `${profile.lockfiles.join(' / ')} が見つかりません（${name} プロファイルは ${profile.packageManager} の lockfile を要求します）` };
    if (name === 'node-yarn' && !isYarnClassicLockfile(readIf(repoPath, lock) ?? '')) {
      return { profile: name, ready: false, missingScripts: missing, detail: 'yarn.lock が Yarn 1（classic）形式ではありません。Yarn 2+（Berry）はサンドボックスで未対応です（yarn 1.22 を同梱）' };
    }
    return { profile: name, ready: missing.length === 0, missingScripts: missing, detail: missing.length === 0 ? `必要な scripts（typecheck / lint / test:run）が定義されています（${profile.packageManager}、${lock}）` : `package.json に scripts が不足: ${missing.join(', ')}` };
  }
  // Python
  const lock = profile.lockfiles.find((f) => existsSync(join(repoPath, f)));
  if (!lock) return { profile: name, ready: false, missingScripts: profile.requiredScripts, detail: `${profile.lockfiles.join(' / ')} が見つかりません（${name} プロファイルは ${profile.packageManager} の lockfile を要求します）` };
  if (name === 'python-uv' && !existsSync(join(repoPath, 'pyproject.toml'))) return { profile: name, ready: false, missingScripts: profile.requiredScripts, detail: 'pyproject.toml が見つかりません（uv プロジェクトには必要です）' };
  const plan = planPythonTools(repoPath);
  const missing: string[] = [];
  if (!plan.lint) missing.push('lint');
  if (!plan.test) missing.push('test:run');
  const typecheckNote = plan.overridden.includes('typecheck') ? 'typecheck は [tool.agent-orchestrator.scripts] の定義' : plan.dependencies.includes('mypy') ? 'typecheck は mypy' : plan.dependencies.includes('pyright') ? 'typecheck は pyright' : 'typecheck は構文チェック（python -m compileall。mypy / pyright を依存に追加すると型検査になります）';
  if (plan.rejectedOverrides.length > 0) missing.push(...plan.rejectedOverrides.map((r) => `許可外のツール: ${r}`));
  return {
    profile: name,
    ready: missing.length === 0,
    missingScripts: missing,
    detail:
      missing.length === 0
        ? `検証ツールが揃っています（${profile.packageManager}、${lock}。lint は ${plan.lint!.join(' ')}、test は ${plan.test!.join(' ')}。${typecheckNote}）`
        : `検証ツールが不足: ${missing.join(', ')}。依存（dependency-groups / dev）に ruff と pytest を追加するか、pyproject.toml の [tool.agent-orchestrator.scripts] に lint / test:run を定義してください（許可ツール: ${[...PYTHON_ALLOWED_TOOLS].join(', ')}）`
  };
}
