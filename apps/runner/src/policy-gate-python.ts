/**
 * Policy Gate の Python ルール（v0.3、D-45）。JS / TS 版（policy-gate.ts）と同じ原則: ベース内容に無い「新規」だけを検出し、
 * 文字列リテラル内の一致は行単位の簡易判定で除く。解釈は保守的で、確定できないものは warning として人の確認に回す。
 *   PG-PY-NOQA            新規の `# noqa` / `# ruff: noqa` / `# flake8: noqa`
 *   PG-PY-TYPE-IGNORE     新規の `# type: ignore` / `# pyright: ignore` / `# mypy: ignore-errors`
 *   PG-PY-TEST-SKIP       テストでの `pytest.mark.skip` / `pytest.skip(` / `unittest.skip` / `xfail` の追加
 *   PG-PY-CONFIG-RELAXED  ruff / mypy / pyright / pytest 設定（pyproject の tool 節、ruff.toml、mypy.ini、pytest.ini、setup.cfg、tox.ini、pyrightconfig.json）の変更。
 *                         ignore / exclude / per-file-ignores / disable_error_code / ignore_errors / deselect / -p no: の追加は blocking、それ以外は warning
 */
export const PY_FILE_RE = /\.pyi?$/i;
export const PY_TEST_FILE_RE = /(^|\/)(tests?|testing)\/|(^|\/)(test_[^/]*|[^/]*_test|conftest)\.py$/i;
export const PY_CONFIG_RE = /(^|\/)(pyproject\.toml|ruff\.toml|\.ruff\.toml|mypy\.ini|pytest\.ini|setup\.cfg|tox\.ini|pyrightconfig\.json|\.flake8)$/i;

export interface PyHit {
  line: number;
  text: string;
  kind: string;
}

const NOQA_RE = /#\s*(?:noqa\b|ruff:\s*noqa|flake8:\s*noqa|nosec\b)/i;
const TYPE_IGNORE_RE = /#\s*(?:type:\s*ignore|pyright:\s*ignore|mypy:\s*ignore-errors)/i;
const SKIP_RE = /(?:@?pytest\.mark\.(?:skip|skipif|xfail)\b|pytest\.skip\(|pytest\.xfail\(|@unittest\.skip|unittest\.skip\(|self\.skipTest\()/;

/** 行頭から最初の `#` までに引用符が偶数個なら、その `#` はコメントとみなす（簡易） */
function commentPart(line: string): string | null {
  const i = line.indexOf('#');
  if (i < 0) return null;
  const before = line.slice(0, i);
  const q = (before.match(/"/g) ?? []).length + (before.match(/'/g) ?? []).length;
  return q % 2 === 0 ? line.slice(i) : null;
}

export function collectPythonSuppressions(text: string): PyHit[] {
  const hits: PyHit[] = [];
  text.split(/\r?\n/).forEach((line, i) => {
    const c = commentPart(line);
    if (!c) return;
    if (NOQA_RE.test(c)) hits.push({ line: i + 1, text: line.trim(), kind: 'noqa' });
    if (TYPE_IGNORE_RE.test(c)) hits.push({ line: i + 1, text: line.trim(), kind: 'type-ignore' });
  });
  return hits;
}

export function collectPythonTestSkips(text: string): PyHit[] {
  const hits: PyHit[] = [];
  text.split(/\r?\n/).forEach((line, i) => {
    const code = commentPart(line) ? line.slice(0, line.indexOf('#')) : line;
    if (SKIP_RE.test(code)) hits.push({ line: i + 1, text: line.trim(), kind: 'skip' });
  });
  return hits;
}

const RELAX_KEY_RE = /^\s*(?:ignore|extend-ignore|exclude|extend-exclude|per-file-ignores|disable_error_code|ignore_errors|ignore_missing_imports|follow_imports|addopts|deselect|norecursedirs|testpaths|skip|allowlist_externals|reportGeneralTypeIssues|typeCheckingMode|strict)\b|-p\s+no:|--deselect|--ignore=|--no-cov|-k\s/;
const TOOL_SECTION_RE = /^\s*\[(?:tool\.(?:ruff|mypy|pyright|pytest|agent-orchestrator)|ruff|mypy|pytest|tool:pytest|flake8|pycodestyle|testenv)[^\]]*\]/i;

/** 設定ファイルの新規行のうち、検証ツールに関わるもの。緩和を示す鍵は blocking、それ以外は warning */
export function pythonConfigChanges(path: string, before: string | null, after: string | null): Array<PyHit & { severity: 'blocking' | 'warning' }> {
  if (after === null) return [{ line: 1, text: 'deleted', kind: 'config-deleted', severity: 'blocking' }];
  const base = new Map<string, number>();
  for (const l of (before ?? '').split(/\r?\n/)) base.set(l.trim(), (base.get(l.trim()) ?? 0) + 1);
  const hits: Array<PyHit & { severity: 'blocking' | 'warning' }> = [];
  const lines = after.split(/\r?\n/);
  const isPyproject = /pyproject\.toml$/i.test(path);
  let inTool = !isPyproject; // pyproject 以外（ruff.toml 等）は全体が対象
  lines.forEach((raw, i) => {
    const line = raw.trim();
    if (isPyproject && /^\[/.test(line)) inTool = TOOL_SECTION_RE.test(line);
    else if (!isPyproject && /^\[/.test(line)) inTool = /^\[(?:tool:pytest|mypy|flake8|pycodestyle|testenv|ruff|lint|format|tool\.)/i.test(line) || /\.(toml|ini|cfg)$/i.test(path) === false ? TOOL_SECTION_RE.test(line) || true : true;
    if (!line || line.startsWith('#')) return;
    const n = base.get(line) ?? 0;
    if (n > 0) {
      base.set(line, n - 1);
      return;
    }
    if (!inTool) return;
    const severity: 'blocking' | 'warning' = RELAX_KEY_RE.test(line) ? 'blocking' : 'warning';
    hits.push({ line: i + 1, text: line.slice(0, 160), kind: 'config', severity });
  });
  return hits;
}
