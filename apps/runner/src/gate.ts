import { reviewConsistencyErrors, type DiffSummary, type PolicyFinding, type PolicyViolation, type Review, type ReviewOutcome, type VerificationResult } from '@agent-orchestrator/contracts';

/**
 * 完了ゲート（SPEC §6.1）。純粋関数。すべて満たしたときだけ COMPLETED にできる。
 * 「approved」は定めたゲートを通過したという意味であり、バグなしを保証しない。
 */
export interface GateInput {
  taskApproved: boolean;
  verification: VerificationResult | null;
  expectedVerificationCommands: readonly string[];
  diff: DiffSummary | null;
  review: ReviewOutcome | null;
  blockingSeverities: readonly string[];
  workspaceHashBeforeReview: string | null;
  workspaceHashAfterReview: string | null;
  withinTimeLimit: boolean;
  policyViolations: readonly PolicyViolation[];
  /** Policy Gate（v2.1）の未承認 blocking 検出。1 件でもあれば COMPLETED にしない。AI レビューの approved では上書きできない */
  unapprovedPolicyFindings?: readonly PolicyFinding[];
  allEventsPersisted: boolean;
}

export interface GateResult {
  passed: boolean;
  failures: Array<{ gate: number; code: GateFailureCode; detail: string }>;
}

export type GateFailureCode =
  | 'TASK_NOT_APPROVED'
  | 'VERIFICATION_MISSING'
  | 'VERIFICATION_FAILED'
  | 'VERIFICATION_TIMEOUT'
  | 'VERIFICATION_INCOMPLETE'
  | 'NO_DIFF'
  | 'REVIEW_MISSING'
  | 'REVIEW_INVALID'
  | 'REVIEW_NOT_APPROVED'
  | 'REVIEW_INCONSISTENT'
  | 'BLOCKING_FINDINGS'
  | 'REQUIREMENTS_UNVERIFIED'
  | 'WORKSPACE_HASH_MISMATCH'
  | 'TIME_LIMIT_EXCEEDED'
  | 'POLICY_VIOLATION'
  | 'EVENTS_NOT_PERSISTED';

export function evaluateCompletionGate(input: GateInput): GateResult {
  const failures: GateResult['failures'] = [];
  const fail = (gate: number, code: GateFailureCode, detail: string) => failures.push({ gate, code, detail });

  // 1. 承認済み task snapshot
  if (!input.taskApproved) fail(1, 'TASK_NOT_APPROVED', 'task snapshot がユーザー承認済みではない');

  // 2. 検証コマンドの終了コード 0、タイムアウト/欠落なし
  if (!input.verification) {
    fail(2, 'VERIFICATION_MISSING', '検証結果がない');
  } else {
    const v = input.verification;
    for (const c of v.commands) {
      if (c.timedOut) fail(2, 'VERIFICATION_TIMEOUT', `検証 ${c.name} がタイムアウト`);
      else if (c.exitCode !== 0) fail(2, 'VERIFICATION_FAILED', `検証 ${c.name} の終了コード ${c.exitCode ?? 'null'}`);
    }
    const ran = new Set(v.commands.map((c) => c.name));
    for (const expected of input.expectedVerificationCommands) {
      if (!ran.has(expected)) fail(2, 'VERIFICATION_INCOMPLETE', `検証 ${expected} が実行されていない`);
    }
    if (v.missing.length > 0) fail(2, 'VERIFICATION_INCOMPLETE', `検証欠落: ${v.missing.join(', ')}`);
    if (!v.passed && failures.every((f) => f.gate !== 2)) fail(2, 'VERIFICATION_FAILED', '検証が失敗と記録されている');
  }

  // 3. 差分が存在する（未追跡含む）
  if (!input.diff || input.diff.isEmpty || input.diff.files.length === 0) fail(3, 'NO_DIFF', '要件に対応する変更差分がない');

  // 4. レビュー JSON の形式・整合性、verdict=approved
  let review: Review | null = null;
  if (!input.review) {
    fail(4, 'REVIEW_MISSING', 'レビュー結果がない');
  } else if (!input.review.parsed) {
    fail(4, 'REVIEW_INVALID', `レビュー JSON が不正: ${input.review.parseError ?? 'unknown'}`);
  } else {
    review = input.review.parsed;
    if (review.verdict !== 'approved') fail(4, 'REVIEW_NOT_APPROVED', `verdict=${review.verdict}`);
    for (const e of reviewConsistencyErrors(review, input.blockingSeverities)) fail(4, 'REVIEW_INCONSISTENT', e);
  }

  // 5. critical/high（blocking）未解決 0、requirementsUnverified=[]
  if (review) {
    const blocking = review.findings.filter((f) => input.blockingSeverities.includes(f.severity));
    if (blocking.length > 0) fail(5, 'BLOCKING_FINDINGS', `未解決の blocking 指摘 ${blocking.length} 件: ${blocking.map((b) => b.id).join(', ')}`);
    if (review.requirementsUnverified.length > 0) fail(5, 'REQUIREMENTS_UNVERIFIED', `未検証要件: ${review.requirementsUnverified.join(' / ')}`);
  }

  // 6. レビュー前後のワークスペースハッシュ一致
  if (!input.workspaceHashBeforeReview || !input.workspaceHashAfterReview) {
    fail(6, 'WORKSPACE_HASH_MISMATCH', 'レビュー前後のワークスペースハッシュが記録されていない');
  } else if (input.workspaceHashBeforeReview !== input.workspaceHashAfterReview) {
    fail(6, 'WORKSPACE_HASH_MISMATCH', 'レビュー中にワークスペースが変更された');
  }

  // 7. 制限時間内、禁止操作なし、イベント永続化
  if (!input.withinTimeLimit) fail(7, 'TIME_LIMIT_EXCEEDED', '制限時間を超過した');
  for (const p of input.policyViolations) fail(7, 'POLICY_VIOLATION', `${p.code}: ${p.file} ${p.detail}`);
  for (const p of (input.unapprovedPolicyFindings ?? []).filter((x) => !x.approved && x.severity === 'blocking')) fail(7, 'POLICY_VIOLATION', `${p.ruleId}: ${p.file}:${p.line} ${p.message}`);
  if (!input.allEventsPersisted) fail(7, 'EVENTS_NOT_PERSISTED', 'イベントの永続化が確認できない');

  return { passed: failures.length === 0, failures };
}
