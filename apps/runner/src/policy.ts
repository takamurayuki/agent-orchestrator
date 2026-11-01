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

const FORBIDDEN_PATH_RE = /(^|\/)(\.git\/|\.github\/workflows\/|\.husky\/|\.env(\..*)?$|.*\.pem$|.*\.key$|id_rsa|\.npmrc$|\.pypirc$)/i;

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
    // テスト削除・skip・検証設定の緩和は v2.1 から Policy Gate（policy-gate.ts、AST 解析・ベース比較）が担当する。
    // ここは即時停止すべきセキュリティ系（worktree 外・禁止パス）だけを残す
  }
  return violations;
}
