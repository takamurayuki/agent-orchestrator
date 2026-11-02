import type { ProjectDiagnosisCheck } from '@agent-orchestrator/contracts';
import { parsePyproject, parseRequirements, requiresPythonSatisfied } from './python-project.js';
import { planPythonTools, PYTHON_ALLOWED_TOOLS } from '../verification/profiles.js';

/**
 * Python プロジェクトの事前診断（v0.3、D-45）。diagnosis.ts と同じ原則（読み取り専用、確定できないものは unverified）。
 * 項目: lockfile / Python バージョン / 検証ツール / 通信先（index URL）/ ビルド時コード実行（sdist）
 */
export const SANDBOX_PYTHON_VERSION = '3.11';

export interface PythonDiagnosisInput {
  repoPath: string;
  files: readonly string[];
  readText: (path: string) => string | null;
  packageManager: 'uv' | 'pip';
  egressAllowlist: readonly string[];
}

function hostOf(url: string): string | null {
  try {
    return new URL(url).hostname.toLowerCase();
  } catch {
    return null;
  }
}

export function diagnosePythonProject(input: PythonDiagnosisInput): Array<Omit<ProjectDiagnosisCheck, 'howToVerify'> & { howToVerify?: string | null }> {
  const checks: Array<Omit<ProjectDiagnosisCheck, 'howToVerify'> & { howToVerify?: string | null }> = [];
  const allow = new Set(input.egressAllowlist.map((h) => h.toLowerCase()));
  const py = parsePyproject(input.readText('pyproject.toml'));
  const reqs = parseRequirements(input.readText('requirements.txt'));

  // 1. lockfile
  if (input.packageManager === 'uv') {
    const lock = input.readText('uv.lock') ?? '';
    const ver = /^version\s*=\s*(\d+)/m.exec(lock)?.[1] ?? null;
    if (!lock) checks.push({ id: 'lockfile', label: 'lockfile', status: 'fail', detail: 'uv.lock が見つかりません', fix: 'プロジェクト側で uv lock を実行して uv.lock をコミットしてください' });
    else if (!py) checks.push({ id: 'lockfile', label: 'lockfile', status: 'fail', detail: 'pyproject.toml を解釈できません（uv.lock はあります）', fix: 'pyproject.toml の構文を確認してください' });
    else checks.push({ id: 'lockfile', label: 'lockfile', status: 'ok', detail: `uv.lock（version ${ver ?? '不明'}）。uv sync --frozen で復元します`, fix: null });
  } else {
    if (!reqs) checks.push({ id: 'lockfile', label: 'lockfile', status: 'fail', detail: 'requirements.txt が見つかりません', fix: 'requirements.txt（pip freeze 等で == 固定）をコミットしてください' });
    else if (reqs.unpinned.length > 0) checks.push({ id: 'lockfile', label: 'lockfile', status: 'warn', detail: `requirements.txt に == で固定されていない依存があります: ${reqs.unpinned.slice(0, 5).join(', ')}${reqs.unpinned.length > 5 ? ' ほか' : ''}。実行のたびに版が変わり得ます`, fix: 'pip freeze や pip-compile で版を固定するか、uv（uv.lock）に移行してください' });
    else checks.push({ id: 'lockfile', label: 'lockfile', status: 'ok', detail: `requirements.txt（${reqs.names.length} 件、すべて == 固定）。仮想環境を作って pip install -r で復元します`, fix: null });
  }

  // 2. Python バージョン
  const req = py?.requiresPython ?? null;
  if (req) {
    const ok = requiresPythonSatisfied(req, SANDBOX_PYTHON_VERSION);
    checks.push({ id: 'python', label: 'Python バージョン', status: ok === null ? 'unverified' : ok ? 'ok' : 'fail', detail: ok === null ? `requires-python "${req}" を判定できません（サンドボックスは Python ${SANDBOX_PYTHON_VERSION}）` : ok ? `requires-python "${req}" はサンドボックスの Python ${SANDBOX_PYTHON_VERSION} を満たします` : `requires-python "${req}" はサンドボックスの Python ${SANDBOX_PYTHON_VERSION} を許しません（サンドボックスの Python は固定です）`, fix: ok === false ? 'requires-python を 3.11 を含む範囲にするか、3.11 で動くことを確認してください' : null, howToVerify: ok === null ? `Python ${SANDBOX_PYTHON_VERSION} で lint / test が通るか確認する` : null });
  } else {
    checks.push({ id: 'python', label: 'Python バージョン', status: 'ok', detail: `requires-python の指定なし（サンドボックスは Python ${SANDBOX_PYTHON_VERSION}）`, fix: null });
  }
  checks.push({ id: 'package_manager', label: 'パッケージマネージャ', status: 'ok', detail: input.packageManager === 'uv' ? 'uv（uv.lock）。サンドボックス同梱の uv で実行します' : 'pip（requirements.txt）。サンドボックス同梱の pip / venv で実行します', fix: null });

  // 3. 検証ツール（ruff / pytest 必須、mypy / pyright 任意、[tool.agent-orchestrator.scripts] で上書き）
  const plan = planPythonTools(input.repoPath);
  const missing = [...(plan.lint ? [] : ['lint（ruff または flake8）']), ...(plan.test ? [] : ['test（pytest）'])];
  if (plan.rejectedOverrides.length > 0) checks.push({ id: 'tools', label: '検証ツール', status: 'fail', detail: `[tool.agent-orchestrator.scripts] に許可外のツールがあります: ${plan.rejectedOverrides.join(' / ')}`, fix: `許可されたツール（${[...PYTHON_ALLOWED_TOOLS].join(', ')}）で始まるコマンドにしてください。任意のシェルコマンドは実行しません` });
  else if (missing.length > 0) checks.push({ id: 'tools', label: '検証ツール', status: 'fail', detail: `依存に検証ツールが足りません: ${missing.join(', ')}`, fix: 'dependency-groups（dev）か requirements-dev.txt に ruff と pytest を追加するか、pyproject.toml の [tool.agent-orchestrator.scripts] に lint / test:run を定義してください' });
  else checks.push({ id: 'tools', label: '検証ツール', status: 'ok', detail: `lint: ${plan.lint!.join(' ')} ／ test: ${plan.test!.join(' ')} ／ typecheck: ${plan.typecheck!.join(' ')}${plan.overridden.length ? `（上書き: ${plan.overridden.join(', ')}）` : ''}`, fix: null });

  // 4. 通信先（index URL）
  const needed = new Map<string, string>();
  for (const u of py?.indexUrls ?? []) {
    const h = hostOf(u);
    if (h) needed.set(h, 'pyproject.toml の [tool.uv] index');
  }
  for (const u of reqs?.indexUrls ?? []) {
    const h = hostOf(u);
    if (h) needed.set(h, 'requirements.txt の --index-url / --find-links');
  }
  for (const f of ['pip.conf', '.pip/pip.conf', 'uv.toml']) {
    const t = input.readText(f);
    if (!t) continue;
    for (const m of t.matchAll(/(?:index-url|extra-index-url|url)\s*=\s*"?(https?:\/\/[^\s"]+)/g)) {
      const h = hostOf(m[1]!);
      if (h) needed.set(h, `${f} の index`);
    }
  }
  const unresolvable = [...needed.entries()].filter(([h]) => !allow.has(h));
  if (unresolvable.length > 0) checks.push({ id: 'network', label: 'ネットワーク（allowlist）', status: 'fail', detail: `allowlist 外のインデックスが必要です: ${unresolvable.map(([h, why]) => `${h}（${why}）`).join(', ')}。サンドボックスからは遮断されるため install が失敗します`, fix: '運用者設定 AGENT_ORCHESTRATOR_EGRESS_ALLOWLIST に追加するか（信頼できるホストのみ）、PyPI のみを使う構成に変更してください。アプリは allowlist を自動で広げません' });
  else checks.push({ id: 'network', label: 'ネットワーク（allowlist）', status: allow.has('pypi.org') && allow.has('files.pythonhosted.org') ? 'ok' : 'fail', detail: allow.has('pypi.org') && allow.has('files.pythonhosted.org') ? '必要な通信先は allowlist 内（pypi.org, files.pythonhosted.org）に収まる見込み' : 'allowlist に pypi.org / files.pythonhosted.org がありません', fix: allow.has('pypi.org') ? null : '運用者設定 AGENT_ORCHESTRATOR_EGRESS_ALLOWLIST に pypi.org と files.pythonhosted.org を追加してください' });

  // 5. ビルド時コード実行（sdist）。Node の --ignore-scripts に相当する抑止は無い
  checks.push({ id: 'build_scripts', label: 'インストール時のコード実行（sdist）', status: 'unverified', detail: 'wheel が無い依存は sdist のビルド（setup.py 等）が隔離コンテナ内で実行されます。Node の --ignore-scripts に相当する抑止はありません（どの依存が該当するかは解決しないと分からないため未確認）', fix: null, howToVerify: input.packageManager === 'uv' ? 'uv.lock の sdist エントリ（`sdist = {` の行）を確認する' : 'pip download --only-binary=:all: -r requirements.txt が通るか確認する' });

  return checks;
}
