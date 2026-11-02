import type { DiffFile, ScopeCheck } from '@agent-orchestrator/contracts';
import { maskSecrets } from './masking.js';

/**
 * スコープ判定（v0.2.0、D-39）。承認済み task の expectedChanges（パス / ディレクトリ / glob）と実際の差分を比べ、
 * 予想外のファイル変更を記録する。重大（major）なら人間の判断を求める。
 * - expectedChanges が空なら判定しない（severity none）
 * - 設定・検証・CI・コンテナ定義など「影響範囲が広いファイル」への予想外の変更は 1 件でも major
 * - それ以外は予想外が 3 件以上で major、1〜2 件は minor（記録のみ）
 */
const SENSITIVE_RE = /(^|\/)(package\.json|pnpm-lock\.yaml|pnpm-workspace\.yaml|package-lock\.json|npm-shrinkwrap\.json|yarn\.lock|\.yarnrc(\.yml)?|\.npmrc|tsconfig(\.[^/]+)?\.json|eslint\.config\.[cm]?[jt]s|\.eslintrc[^/]*|vitest\.config\.[cm]?[jt]s|jest\.config\.[cm]?[jt]s|playwright\.config\.[cm]?[jt]s|vite\.config\.[cm]?[jt]s|Dockerfile|docker-compose\.[^/]+|\.github\/.*|\.agent-orchestrator\/.*|docker\/.*|\.env.*)$/i;

export const MAJOR_UNEXPECTED_THRESHOLD = 3;

function normalize(p: string): string {
  return p.replace(/\\/g, '/').replace(/^\.\//, '').replace(/\/+$/, '');
}

function globToRegExp(glob: string): RegExp {
  let re = '';
  for (let i = 0; i < glob.length; i++) {
    const c = glob[i]!;
    if (c === '*') {
      if (glob[i + 1] === '*') {
        re += '.*';
        i++;
        if (glob[i + 1] === '/') i++;
      } else re += '[^/]*';
    } else if (c === '?') re += '[^/]';
    else re += c.replace(/[.+^${}()|[\]\\]/g, '\\$&');
  }
  return new RegExp(`^${re}$`);
}

/** 期待パターン 1 つに対する一致: 完全一致 / ディレクトリ接頭辞 / glob */
export function matchesExpected(file: string, expected: string): boolean {
  const f = normalize(file);
  const e = normalize(expected);
  if (!e) return false;
  if (e.includes('*') || e.includes('?')) return globToRegExp(e).test(f);
  if (f === e) return true;
  if (f.startsWith(`${e}/`)) return true;
  // 「src/lib の time 周り」のような自由記述は、含まれるパス片で緩く照合する（誤検出より見逃しを避けない: 判定に使うのはパス片だけ）
  const tokens = e.split(/[\s（）()「」、。,:：;；]+/).filter((t) => t.includes('/') || /\.[a-z0-9]+$/i.test(t));
  return tokens.some((t) => f === normalize(t) || f.startsWith(`${normalize(t)}/`) || f.endsWith(`/${normalize(t)}`) || f === normalize(t).replace(/^\//, ''));
}

export function evaluateScope(files: readonly DiffFile[], expectedChanges: readonly string[] | undefined, builderSummary: string | null = null): ScopeCheck {
  const expected = (expectedChanges ?? []).map((e) => e.trim()).filter(Boolean);
  const reason = builderSummary ? maskSecrets(builderSummary).slice(0, 1200) : null;
  if (expected.length === 0) return { expected, unexpected: [], severity: 'none', detail: '期待される変更範囲が指定されていないため判定しません', builderReason: reason };
  const unexpected = files.map((f) => normalize(f.path)).filter((p) => !expected.some((e) => matchesExpected(p, e)));
  if (unexpected.length === 0) return { expected, unexpected, severity: 'none', detail: `変更 ${files.length} ファイルはすべて期待範囲内`, builderReason: reason };
  const sensitive = unexpected.filter((p) => SENSITIVE_RE.test(p));
  const major = sensitive.length > 0 || unexpected.length >= MAJOR_UNEXPECTED_THRESHOLD;
  const detail = major
    ? `期待範囲外の変更 ${unexpected.length} 件${sensitive.length > 0 ? `（設定・検証・CI など影響の大きいファイルを含む: ${sensitive.join(', ')}）` : `（${MAJOR_UNEXPECTED_THRESHOLD} 件以上）`}: ${unexpected.join(', ')}`
    : `期待範囲外の変更 ${unexpected.length} 件（軽微、記録のみ）: ${unexpected.join(', ')}`;
  return { expected, unexpected, severity: major ? 'major' : 'minor', detail, builderReason: reason };
}

/** Builder へのフィードバック文（重大なスコープ逸脱の修正依頼） */
export function renderScopeFeedback(check: ScopeCheck): string {
  return [
    `Your changes went outside the expected scope of the approved task (${check.detail}).`,
    `Expected files/areas: ${check.expected.join(', ')}.`,
    'Either revert the unexpected changes, or — only if they are strictly required to satisfy the requirements — keep the minimum and explain why in your final summary under a heading "Out-of-scope changes". Do not add new modules, abstractions, config changes or refactors that the requirements do not need.'
  ].join('\n');
}
