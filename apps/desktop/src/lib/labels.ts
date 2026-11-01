import type { DraftState, RunState } from '@agent-orchestrator/contracts';

/** Interview limits (SPEC §4.1); mirrored from contracts to keep this package type-only on contracts. */
export const MAX_QUESTIONS_PER_ROUND = 3;
export const MAX_INTERVIEW_ROUNDS = 5;
export const MAX_INTERVIEW_QUESTIONS = 15;

export const RUN_STATE_LABELS: Record<RunState, string> = {
  CREATED: '作成済み',
  PREFLIGHT: '起動前検査',
  IMPLEMENTING: '実装中',
  VERIFYING: '検証中',
  REVIEWING: 'レビュー中',
  POLICY_BLOCKED: 'ポリシー違反で差し戻し中',
  COMPLETED: '完了',
  NEEDS_HUMAN: '要確認',
  PRECHECK_FAILED: '起動前検査失敗',
  INTERRUPTED: '中断',
  INTERNAL_ERROR: '失敗（内部エラー）'
};

export type Tone = 'neutral' | 'info' | 'success' | 'warning' | 'danger';

export const RUN_STATE_TONES: Record<RunState, Tone> = {
  CREATED: 'neutral',
  PREFLIGHT: 'info',
  IMPLEMENTING: 'info',
  VERIFYING: 'info',
  REVIEWING: 'info',
  POLICY_BLOCKED: 'warning',
  COMPLETED: 'success',
  NEEDS_HUMAN: 'warning',
  PRECHECK_FAILED: 'danger',
  INTERRUPTED: 'warning',
  INTERNAL_ERROR: 'danger'
};

export function runStateLabel(state: RunState): string {
  return RUN_STATE_LABELS[state] ?? state;
}

export function isTerminalRunState(state: RunState): boolean {
  return state === 'COMPLETED' || state === 'NEEDS_HUMAN' || state === 'PRECHECK_FAILED' || state === 'INTERRUPTED' || state === 'INTERNAL_ERROR';
}

export const DRAFT_STATE_LABELS: Record<DraftState, string> = {
  DRAFT_CREATED: '作成済み',
  REPO_ANALYZING: 'リポジトリ調査中',
  GAP_ANALYZING: '不明点の抽出中',
  ASKING: '質問中',
  ANSWERING: '回答処理中',
  SUMMARY_READY: 'サマリー作成済み',
  AWAITING_APPROVAL: '承認待ち',
  APPROVED: '承認済み',
  YAML_VALIDATED: 'YAML 検証済み',
  READY_TO_RUN: '実行準備完了',
  BLOCKED: 'ブロック中',
  DRAFT_CANCELLED: 'キャンセル済み'
};

export const REASON_CODE_LABELS: Record<string, string> = {
  COMPLETED: '完了',
  MAX_ROUNDS: '修正回数の上限に到達',
  REVIEW_UNKNOWN: 'レビュー結果が判定不能',
  REVIEW_INVALID_JSON: 'レビュー出力が不正',
  REVIEW_INCONSISTENT: 'レビュー結果が不整合',
  BUILDER_FAILED: '実装 CLI が異常終了',
  BUILDER_TIMEOUT: '実装 CLI がタイムアウト',
  NO_CHANGES: '変更差分なし',
  POLICY_VIOLATION: 'ポリシー違反',
  SCOPE_DEVIATION: '承認した範囲外の変更',
  WORKSPACE_MODIFIED_DURING_REVIEW: 'レビュー中にワークスペースが変更された',
  TIMEOUT: '制限時間超過',
  GATE_FAILED: '完了ゲート未達',
  PRECHECK_FAILED: '起動前検査失敗',
  TASK_NOT_APPROVED: 'タスク未承認',
  CANCELLED: 'ユーザーによるキャンセル',
  RECOVERED_AFTER_RESTART: '再起動後に復旧',
  INTERNAL_ERROR: '内部エラー'
};

export const ENV_STATUS_LABELS: Record<string, string> = {
  ok: '正常',
  warn: '警告',
  fail: '失敗',
  skipped: '未実施',
  unverified: '未検証'
};

export const ENV_STATUS_TONES: Record<string, Tone> = {
  ok: 'success',
  warn: 'warning',
  fail: 'danger',
  skipped: 'neutral',
  unverified: 'warning'
};

export const PROJECT_STATUS_LABELS: Record<string, string> = {
  ok: '利用可能',
  not_git: 'Git リポジトリではありません',
  unusable: '実行不可'
};

export const CONFIDENCE_LABELS: Record<string, string> = {
  confirmed: '確認済み事実',
  inferred: '推測',
  unknown: '未確定'
};

export function formatDateTime(iso: string | null | undefined): string {
  if (!iso) return '—';
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  return d.toLocaleString('ja-JP', { hour12: false });
}

export function formatDuration(ms: number): string {
  if (ms < 0 || !Number.isFinite(ms)) return '0:00';
  const total = Math.floor(ms / 1000);
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = total % 60;
  const mm = h > 0 ? String(m).padStart(2, '0') : String(m);
  return `${h > 0 ? `${h}:` : ''}${mm}:${String(s).padStart(2, '0')}`;
}

/** AI 出力やコマンド出力の抜粋は秘密情報を含み得るため、イベント要約には載せない（v2.3）。 */
const HIDDEN_PAYLOAD_KEY = /excerpt|raw|stdout|stderr|output|log$|prompt|result$/i;

/** Short, safe one-line summary of an event payload (text only; raw output fields are hidden). */
export function summarizePayload(payload: Record<string, unknown>): string {
  const parts: string[] = [];
  for (const [key, value] of Object.entries(payload)) {
    if (value === null || value === undefined) continue;
    if (HIDDEN_PAYLOAD_KEY.test(key) && typeof value === 'string') {
      parts.push(`${key}: [非表示 ${value.length} 文字]`);
    } else if (typeof value === 'object') {
      parts.push(`${key}: ${Array.isArray(value) ? `[${value.length} 件]` : '{…}'}`);
    } else {
      const text = String(value);
      parts.push(`${key}: ${text.length > 80 ? `${text.slice(0, 80)}…` : text}`);
    }
    if (parts.length >= 4) break;
  }
  return parts.join(' / ');
}
