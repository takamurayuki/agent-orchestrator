import type { ResolvedTask, RoundRecord, RunStatus } from '@agent-orchestrator/contracts';
import { maskSecrets } from './masking.js';

/** report.md 生成（純粋関数）。秘密情報はマスキングし、完了/要確認/中断を明示する。 */
export interface ReportInput {
  status: RunStatus;
  task: ResolvedTask;
  rounds: RoundRecord[];
  preflight?: Array<{ id: string; status: string; detail: string; fix: string | null }>;
}

const STATE_LABEL: Record<RunStatus['state'], string> = {
  CREATED: '作成',
  PREFLIGHT: '起動前検査中',
  IMPLEMENTING: '実装中',
  VERIFYING: '検証中',
  REVIEWING: 'レビュー中',
  COMPLETED: '完了（ゲート通過）',
  NEEDS_HUMAN: '要確認（人間の判断が必要）',
  PRECHECK_FAILED: '起動前検査失敗',
  INTERRUPTED: '中断',
  INTERNAL_ERROR: '内部エラー'
};

export function stateLabel(state: RunStatus['state']): string {
  return STATE_LABEL[state];
}

export function renderReport(input: ReportInput): string {
  const { status, task, rounds } = input;
  const lines: string[] = [];
  lines.push(`# 実行レポート: ${task.title}`);
  lines.push('');
  lines.push(`- Run ID: ${status.runId}`);
  lines.push(`- Task ID: ${task.id}（approved task: ${status.approvedTaskId}）`);
  lines.push(`- 状態: **${STATE_LABEL[status.state]}**（${status.state}${status.reasonCode ? ` / ${status.reasonCode}` : ''}）`);
  if (status.reasonDetail) lines.push(`- 理由: ${maskSecrets(status.reasonDetail)}`);
  lines.push(`- リポジトリ: ${task.repository}`);
  lines.push(`- ベース: ${task.baseRef}${status.baseSha ? ` @ ${status.baseSha}` : ''}`);
  lines.push(`- worktree: ${status.worktreePath ?? '（未作成）'}`);
  lines.push(`- ラウンド: ${status.currentRound}/${status.maxRounds}`);
  lines.push(`- 開始: ${status.startedAt} / 終了: ${status.finishedAt ?? '-'}`);
  lines.push('');
  lines.push('> 「完了」は定めた完了ゲートを通過したことを意味し、バグがないことやセキュリティの完全性を保証しません。元ブランチへの反映・push・merge・deploy はユーザーが手動で行います。');
  lines.push('');

  lines.push('## 次の手動操作');
  for (const a of status.nextActions.length > 0 ? status.nextActions : ['（なし）']) lines.push(`- ${a}`);
  lines.push('');

  lines.push('## 要件');
  for (const r of task.requirements) lines.push(`- ${r}`);
  lines.push('');
  lines.push('## 受入条件');
  for (const ac of task.acceptanceCriteria) lines.push(`- ${ac.id}: Given ${ac.given} / When ${ac.when} / Then ${ac.then}`);
  lines.push('');

  if (input.preflight && input.preflight.length > 0) {
    lines.push('## 起動前検査');
    for (const c of input.preflight) lines.push(`- [${c.status}] ${c.id}: ${maskSecrets(c.detail)}${c.fix && c.status !== 'ok' ? ` → ${c.fix}` : ''}`);
    lines.push('');
  }

  const last = rounds[rounds.length - 1];
  if (last?.diff) {
    lines.push('## 変更ファイル（最終ラウンド）');
    for (const f of last.diff.files) lines.push(`- ${f.status} ${f.path} (+${f.additions} -${f.deletions})`);
    if (last.diff.truncated) lines.push('- （差分はサイズ上限で打ち切られました）');
    lines.push('');
  }

  const lastPolicy = last?.policyFindings ?? [];
  if (lastPolicy.length > 0) {
    lines.push('## Policy Gate（静的チェック、最終ラウンド）');
    for (const p of lastPolicy) lines.push(`- [${p.approved ? '承認済み例外' : '未承認 blocking'}] ${p.ruleId} ${p.file}:${p.line} — ${maskSecrets(p.message)}（${maskSecrets(p.evidence)}${p.approvalReason ? `／理由: ${maskSecrets(p.approvalReason)}` : ''}）`);
    lines.push('');
  }

  const lastReview = [...rounds].reverse().find((r) => r.review?.parsed)?.review?.parsed ?? null;
  if (lastReview) {
    lines.push('## レビュー概要（最終）');
    lines.push(`- verdict: ${lastReview.verdict}`);
    lines.push(`- summary: ${maskSecrets(lastReview.summary)}`);
    if (lastReview.findings.length > 0) {
      lines.push('- 指摘:');
      for (const f of lastReview.findings) lines.push(`  - [${f.severity}] ${f.id} ${f.file}:${f.line} — ${maskSecrets(f.description)}（推奨: ${maskSecrets(f.recommendation)}）`);
    }
    if (lastReview.requirementsUnverified.length > 0) {
      lines.push('- 未検証要件:');
      for (const r of lastReview.requirementsUnverified) lines.push(`  - ${r}`);
    }
    lines.push('');
  }

  lines.push('## ラウンド詳細');
  for (const r of rounds) {
    lines.push(`### Round ${r.round}`);
    lines.push(`- 開始 ${r.startedAt} / 終了 ${r.finishedAt ?? '-'}`);
    if (r.builder) lines.push(`- Builder: exit=${r.builder.exitCode ?? 'null'} timedOut=${r.builder.timedOut} isError=${r.builder.isError} ${r.builder.durationMs}ms`);
    if (r.diff) lines.push(`- 差分: ${r.diff.files.length} ファイル${r.diff.isEmpty ? '（変更なし）' : ''}`);
    if (r.policyViolations.length > 0) {
      lines.push('- ポリシー違反:');
      for (const v of r.policyViolations) lines.push(`  - ${v.code} ${v.file}: ${v.detail}`);
    }
    if (r.verification) {
      lines.push(`- 検証: ${r.verification.passed ? 'PASS' : 'FAIL'}`);
      for (const c of r.verification.commands) {
        lines.push(`  - ${c.name}: exit=${c.exitCode ?? 'null'}${c.timedOut ? ' TIMEOUT' : ''} ${c.durationMs}ms`);
        if (c.exitCode !== 0 || c.timedOut) {
          const out = maskSecrets((c.stderrExcerpt || c.stdoutExcerpt).trim());
          if (out) lines.push('', '```', out.slice(0, 3000), '```');
        }
      }
      if (r.verification.missing.length > 0) lines.push(`  - 欠落: ${r.verification.missing.join(', ')}`);
    }
    if (r.review) {
      lines.push(`- レビュー: ${r.review.parsed ? r.review.parsed.verdict : `不正（${r.review.parseError ?? 'unknown'}）`}${r.review.timedOut ? ' TIMEOUT' : ''}`);
      lines.push(`- ワークスペースハッシュ一致: ${r.workspaceHashBeforeReview !== null && r.workspaceHashBeforeReview === r.workspaceHashAfterReview ? 'yes' : 'no'}`);
    }
    lines.push('');
  }
  return lines.join('\n');
}
