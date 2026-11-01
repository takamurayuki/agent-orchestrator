import type { DiffFile, PolicyViolation } from '@agent-orchestrator/contracts';

/**
 * ポリシー検査（純粋関数）。
 * - 依頼文・要件に含まれる禁止操作（push/merge/deploy/外部送信）の検出（SEC-10）
 * - Builder の差分に対する検査: テスト削除・skip 化、検証設定の弱体化、禁止パス（SPEC §7, §9）
 * - 危険な CLI フラグの拒否（SEC-08）
 */

export interface ProhibitedOperation {
  code: 'PUSH' | 'MERGE' | 'DEPLOY' | 'EXTERNAL_POST' | 'FORCE' | 'HISTORY_REWRITE';
  match: string;
  guidance: string;
}

const PROHIBITED_PATTERNS: Array<{ code: ProhibitedOperation['code']; re: RegExp; guidance: string }> = [
  { code: 'PUSH', re: /\bgit\s+push\b|\bpush\s+(to|it|them|the)\b|push\s*(して|し|する)|プッシュ|リモートに(反映|送信|アップ)/i, guidance: 'push はツールが行いません。結果の worktree を確認後、手動で git push してください。' },
  { code: 'MERGE', re: /\bgit\s+merge\b|\bmerge\s+(to|into|it|the)\b|merge\s*(して|し|する)|マージ|\bPR\s*(を|作成|作って)|\bpull\s*request\b|プルリク/i, guidance: 'merge / PR 作成はツールが行いません。差分を確認後、手動で行ってください。' },
  { code: 'DEPLOY', re: /\bdeploy\b|デプロイ|本番(に|へ)(反映|公開|リリース)|\brelease\s+to\s+prod\b|\bpublish\s+to\b/i, guidance: 'deploy はツールが行いません。手動のリリース手順に従ってください。' },
  { code: 'EXTERNAL_POST', re: /\b(slack|twitter|discord|teams)\b|\bx\.com\b|メール(で|を)送(信|って)|投稿して|ツイート|\bsend\s+(an?\s+)?(email|message)\s+to\b/i, guidance: '外部サービスへの送信・投稿はツールが行いません。' },
  { code: 'FORCE', re: /--force\b|\bforce\s*push\b|強制(push|プッシュ)/i, guidance: 'force push は禁止です。' },
  { code: 'HISTORY_REWRITE', re: /\brebase\s+-i\b|\bgit\s+rebase\b|\breset\s+--hard\b|\bfilter-branch\b|履歴(を)?(書き換え|改変)/i, guidance: 'Git 履歴の改変はツールが行いません。' }
];

export function detectProhibitedOperations(text: string): ProhibitedOperation[] {
  const found: ProhibitedOperation[] = [];
  for (const p of PROHIBITED_PATTERNS) {
    const m = p.re.exec(text);
    if (m) found.push({ code: p.code, match: m[0], guidance: p.guidance });
  }
  return found;
}

/** 危険な権限フラグ（SEC-08）。argv に含まれていれば実行を拒否する。 */
export const FORBIDDEN_CLI_FLAGS = [
  '--dangerously-skip-permissions',
  '--allow-dangerously-skip-permissions',
  '--dangerously-bypass-approvals-and-sandbox',
  '--dangerously-bypass-hook-trust',
  '--privileged',
  'danger-full-access',
  'bypassPermissions'
] as const;

export function findForbiddenFlags(argv: readonly string[]): string[] {
  const hits: string[] = [];
  for (const arg of argv) {
    for (const flag of FORBIDDEN_CLI_FLAGS) {
      if (arg === flag || arg.includes(flag)) hits.push(flag);
    }
  }
  return [...new Set(hits)];
}

export function assertNoForbiddenFlags(argv: readonly string[]): void {
  const hits = findForbiddenFlags(argv);
  if (hits.length > 0) throw new Error(`forbidden CLI flags: ${hits.join(', ')}`);
}

// ---- diff policy ----

const TEST_FILE_RE = /(^|\/)(__tests__|tests?|spec|e2e)\/|\.(test|spec)\.[cm]?[jt]sx?$|\.(test|spec)\.(py|rb|go|rs)$|_test\.(go|py)$/i;
const VERIFICATION_CONFIG_RE = /(^|\/)(package\.json|pnpm-lock\.yaml|package-lock\.json|yarn\.lock|tsconfig(\..*)?\.json|vitest\.config\.[cm]?[jt]s|jest\.config\.[cm]?[jt]s|playwright\.config\.[cm]?[jt]s|\.eslintrc(\..*)?|eslint\.config\.[cm]?[jt]s|biome\.json)$/i;
const FORBIDDEN_PATH_RE = /(^|\/)(\.git\/|\.github\/workflows\/|\.husky\/|\.env(\..*)?$|.*\.pem$|.*\.key$|id_rsa|\.npmrc$|\.pypirc$)/i;
const SKIP_ADDED_RE = /^\+.*\b(it|test|describe)\.(skip|todo)\s*\(|^\+.*\b(xit|xtest|xdescribe)\s*\(|^\+.*@pytest\.mark\.skip|^\+.*\bt\.Skip\(/m;
const SCRIPT_WEAKENED_RE = /^-\s*"(typecheck|lint|test:run|test)"\s*:/m;
const TS_STRICT_WEAKENED_RE = /^\+\s*"strict"\s*:\s*false|^\+\s*"noEmit"\s*:\s*true.*lint|^-\s*"strict"\s*:\s*true/m;

export interface DiffPolicyInput {
  files: readonly DiffFile[];
  /** ファイルごとの unified diff（path → patch）。省略時はファイル状態のみで判定 */
  patches?: Record<string, string>;
}

export function checkDiffPolicy(input: DiffPolicyInput): PolicyViolation[] {
  const violations: PolicyViolation[] = [];
  for (const f of input.files) {
    const path = f.path.replace(/\\/g, '/');
    if (path.startsWith('../') || path.includes('/../') || /^[A-Za-z]:[\\/]/.test(path) || path.startsWith('/')) {
      violations.push({ code: 'PATH_ESCAPE', file: f.path, detail: 'worktree 外のパスへの変更' });
      continue;
    }
    if (FORBIDDEN_PATH_RE.test(path)) {
      violations.push({ code: 'FORBIDDEN_PATH', file: f.path, detail: '変更が禁止されたパス（.git/CI/認証ファイル等）' });
    }
    if (TEST_FILE_RE.test(path) && f.status === 'deleted') {
      violations.push({ code: 'TEST_FILE_DELETED', file: f.path, detail: '既存テストファイルが削除された' });
    }
    const patch = input.patches?.[f.path];
    if (patch) {
      if (TEST_FILE_RE.test(path) && SKIP_ADDED_RE.test(patch)) {
        violations.push({ code: 'TEST_SKIPPED', file: f.path, detail: 'テストが skip/todo/x* に変更された' });
      }
      if (VERIFICATION_CONFIG_RE.test(path)) {
        if (/package\.json$/i.test(path) && SCRIPT_WEAKENED_RE.test(patch)) {
          violations.push({ code: 'VERIFICATION_CONFIG_WEAKENED', file: f.path, detail: '検証 scripts（typecheck/lint/test:run）が削除・変更された' });
        }
        if (/tsconfig/i.test(path) && TS_STRICT_WEAKENED_RE.test(patch)) {
          violations.push({ code: 'VERIFICATION_CONFIG_WEAKENED', file: f.path, detail: 'tsconfig の strict が弱められた' });
        }
        if (/(vitest|jest|playwright)\.config/i.test(path) && /^\+.*\b(testPathIgnorePatterns|exclude|testIgnore)\b/m.test(patch)) {
          violations.push({ code: 'VERIFICATION_CONFIG_WEAKENED', file: f.path, detail: 'テスト設定に除外が追加された' });
        }
      }
    }
    if (TEST_FILE_RE.test(path) && f.status === 'modified' && patch === undefined) {
      // patch が無い場合は判断不能。削除以外は許容するが、呼び出し側は patch を渡すべき
    }
  }
  return violations;
}
