import { parse as parseToml } from 'smol-toml';

/**
 * Python プロジェクトの読み取り（v0.3、D-45）。pyproject.toml / requirements.txt から
 *   - 依存名（検証ツール ruff / pytest / mypy / pyright の有無）
 *   - requires-python
 *   - [tool.agent-orchestrator.scripts]（検証コマンドの上書きと、生成物の生成スクリプト）
 *   - 追加のインデックス URL（allowlist との照合用）
 * を純粋に抽出する。解釈できないファイルは null（推測で埋めない）。
 */
export interface PyProjectInfo {
  name: string | null;
  /** 正規化した依存名（小文字、extras / 版指定を除く） */
  dependencies: string[];
  requiresPython: string | null;
  /** [tool.agent-orchestrator.scripts] */
  scripts: Record<string, string>;
  /** [tool.uv] index-url / extra-index-url、[[tool.uv.index]] の url */
  indexUrls: string[];
  /** [tool.ruff] / [tool.mypy] / [tool.pyright] / [tool.pytest.ini_options] の有無 */
  toolSections: string[];
}

/** 'pytest[xdist]>=8,<9; python_version >= "3.9"' → 'pytest' */
export function depName(spec: string): string {
  const m = /^\s*([A-Za-z0-9][A-Za-z0-9._-]*)/.exec(spec);
  return (m?.[1] ?? '').toLowerCase().replace(/_/g, '-');
}

function asStringArray(v: unknown): string[] {
  return Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string') : [];
}

function asRecord(v: unknown): Record<string, unknown> {
  return v && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : {};
}

export function parsePyproject(text: string | null): PyProjectInfo | null {
  if (text === null) return null;
  let doc: Record<string, unknown>;
  try {
    doc = parseToml(text) as Record<string, unknown>;
  } catch {
    return null;
  }
  const project = asRecord(doc['project']);
  const tool = asRecord(doc['tool']);
  const deps = new Set<string>();
  for (const d of asStringArray(project['dependencies'])) deps.add(depName(d));
  for (const group of Object.values(asRecord(project['optional-dependencies']))) for (const d of asStringArray(group)) deps.add(depName(d));
  for (const group of Object.values(asRecord(doc['dependency-groups']))) {
    for (const d of asStringArray(group)) deps.add(depName(d));
  }
  const uv = asRecord(tool['uv']);
  for (const d of asStringArray(uv['dev-dependencies'])) deps.add(depName(d));
  // poetry 形式の依存（lockfile が無ければプロファイルは選ばれないが、ツールの有無は読む）
  const poetry = asRecord(tool['poetry']);
  for (const k of Object.keys(asRecord(poetry['dependencies']))) deps.add(depName(k));
  for (const k of Object.keys(asRecord(poetry['dev-dependencies']))) deps.add(depName(k));
  for (const group of Object.values(asRecord(poetry['group']))) for (const k of Object.keys(asRecord(asRecord(group)['dependencies']))) deps.add(depName(k));
  deps.delete('');
  deps.delete('python');

  const ao = asRecord(asRecord(tool['agent-orchestrator'])['scripts']);
  const scripts: Record<string, string> = {};
  for (const [k, v] of Object.entries(ao)) if (typeof v === 'string' && v.trim()) scripts[k] = v.trim();

  const indexUrls: string[] = [];
  for (const key of ['index-url', 'extra-index-url']) {
    const v = uv[key];
    if (typeof v === 'string') indexUrls.push(v);
    for (const s of asStringArray(v)) indexUrls.push(s);
  }
  for (const idx of Array.isArray(uv['index']) ? uv['index'] : []) {
    const url = asRecord(idx)['url'];
    if (typeof url === 'string') indexUrls.push(url);
  }

  const toolSections = ['ruff', 'mypy', 'pyright', 'pytest'].filter((t) => t in tool);
  return {
    name: typeof project['name'] === 'string' ? project['name'] : null,
    dependencies: [...deps].sort(),
    requiresPython: typeof project['requires-python'] === 'string' ? project['requires-python'] : null,
    scripts,
    indexUrls,
    toolSections
  };
}

export interface RequirementsInfo {
  names: string[];
  /** `==` で固定されていない行 */
  unpinned: string[];
  indexUrls: string[];
  /** -r / -c で参照している別ファイル */
  includes: string[];
}

export function parseRequirements(text: string | null): RequirementsInfo | null {
  if (text === null) return null;
  const names: string[] = [];
  const unpinned: string[] = [];
  const indexUrls: string[] = [];
  const includes: string[] = [];
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.replace(/\s+#.*$/, '').trim();
    if (!line || line.startsWith('#')) continue;
    const opt = /^(--?[a-z-]+)\s*=?\s*(\S*)/.exec(line);
    if (opt) {
      const [, flag, value] = opt;
      if ((flag === '-r' || flag === '--requirement' || flag === '-c' || flag === '--constraint') && value) includes.push(value);
      if ((flag === '-i' || flag === '--index-url' || flag === '--extra-index-url' || flag === '--find-links' || flag === '-f') && value) indexUrls.push(value);
      continue;
    }
    if (/^(https?|git\+|file:)/.test(line) || line.includes('@')) {
      // URL / VCS / ローカル参照: 名前は取れないことがある
      const m = /^([A-Za-z0-9][A-Za-z0-9._-]*)\s*@/.exec(line);
      if (m) names.push(depName(m[1]!));
      unpinned.push(line);
      continue;
    }
    const name = depName(line);
    if (!name) continue;
    names.push(name);
    if (!/==/.test(line)) unpinned.push(line);
  }
  return { names: [...new Set(names)], unpinned, indexUrls, includes };
}

/** requires-python（例 ">=3.10", "^3.11", ">=3.9,<3.13"）がサンドボックスの Python（major.minor）を許すか。判定できなければ null */
export function requiresPythonSatisfied(spec: string | null, sandbox: string): boolean | null {
  if (!spec) return null;
  const [maj, min] = sandbox.split('.').map(Number);
  if (maj === undefined || min === undefined) return null;
  const value = maj * 100 + min;
  let decided = false;
  for (const part of spec.split(',')) {
    const m = /^\s*(>=|<=|>|<|==|~=|\^|!=)?\s*(\d+)(?:\.(\d+))?(?:\.\d+)?(?:\.\*)?\s*$/.exec(part);
    if (!m) return null;
    const op = m[1] ?? '==';
    const v = Number(m[2]) * 100 + Number(m[3] ?? 0);
    decided = true;
    if (op === '>=' && !(value >= v)) return false;
    if (op === '>' && !(value > v)) return false;
    if (op === '<=' && !(value <= v)) return false;
    if (op === '<' && !(value < v)) return false;
    if (op === '==' && m[3] !== undefined && value !== v) return false;
    if (op === '==' && m[3] === undefined && Math.floor(value / 100) !== Number(m[2])) return false;
    if (op === '!=' && value === v) return false;
    if ((op === '~=' || op === '^') && !(value >= v && Math.floor(value / 100) === Number(m[2]))) return false;
  }
  return decided ? true : null;
}
