import type { RunEvent, RunReportResult, RunStatus } from '@agent-orchestrator/contracts';
import { isTerminalRunState, type Tone } from './labels';

/**
 * 非 CLI 利用者向けの「結果の説明」（v2.3）。Runner の state / reasonCode を、原因・影響・次にできる操作の
 * 平易な日本語に変換する純粋関数群。バックエンドの状態遷移は変更しない（表示だけ）。
 */
export interface Guidance {
  /** 何が起きたか */
  cause: string;
  /** 利用者への影響（変更の状態） */
  impact: string;
  /** GUI から安全に行える次の操作 */
  next: string[];
}

export const REASON_GUIDANCE: Record<string, Guidance> = {
  COMPLETED: {
    cause: '検証コマンドがすべて成功し、AI レビューも承認しました。',
    impact: '変更は作業用コピー（ワークツリー）に保存されています。元のプロジェクトはまだ変わっていません。',
    next: ['「変更内容」で変更されたファイルと差分を確認する', '問題なければ、お使いの Git ツールでワークツリーの変更を取り込む（このアプリは自動では反映しません）']
  },
  MAX_ROUNDS: {
    cause: 'AI が修正を上限回数まで試みても、レビューの指摘または検証の失敗が残りました。',
    impact: '変更は途中の状態で作業用コピーに残っています。そのまま使わないでください。',
    next: ['「未解決の指摘」で何が残っているかを確認する', '依頼内容を見直して新しい依頼を作る、または残った指摘の対応を開発者に相談する']
  },
  POLICY_VIOLATION: {
    cause: 'AI の変更に、ルールの無効化（eslint-disable など）やテストの削除・スキップが含まれ、静的チェック（Policy Gate）で止まりました。',
    impact: 'この判定は AI では解除できません。変更は未完成の状態です。',
    next: ['「ポリシー違反の内容」で何が検出されたかを確認する', '意図した変更であれば開発者に例外の登録を依頼する。そうでなければ依頼内容を見直して新しい依頼を作る']
  },
  SCOPE_DEVIATION: {
    cause: 'AI の変更が、承認した「変更が予想されるファイル・領域」の外に大きく広がりました（設定ファイルの変更や多数の予想外ファイル）。',
    impact: '要件に必要な最小限の変更かどうかを人が判断する必要があるため、検証・レビューの前に止めました。変更は未完成の状態です。',
    next: ['「承認した範囲外の変更」で予想外のファイルと、AI が述べた変更理由を確認する', '意図どおりなら要件の変更範囲を広げて新しい依頼として再実行する。不要な変更なら依頼内容を具体的にして再実行する']
  },
  REVIEW_UNKNOWN: {
    cause: 'AI レビューが「判断できない」と回答しました。',
    impact: '変更が正しいかどうか確認できていません。',
    next: ['開発者に変更内容のレビューを依頼する']
  },
  REVIEW_INVALID_JSON: {
    cause: 'AI レビューの結果を読み取れませんでした（出力形式の不備）。',
    impact: 'レビューが完了していないため、完了扱いにしていません。',
    next: ['同じ内容を新しい依頼として再実行する', '繰り返し起きる場合は開発者に相談する']
  },
  REVIEW_INCONSISTENT: {
    cause: 'AI レビューの判定と指摘内容が食い違っていました。',
    impact: 'レビュー結果を信頼できないため停止しました。',
    next: ['開発者に変更内容の確認を依頼する']
  },
  BUILDER_FAILED: {
    cause: '実装を行う AI（Claude Code）が異常終了しました。',
    impact: '変更は作られていないか、途中の状態です。',
    next: ['ホーム画面のセットアップチェックで AI の認証と接続を確認する', '時間をおいて新しい依頼として再実行する']
  },
  BUILDER_TIMEOUT: {
    cause: '実装を行う AI が制限時間内に終わりませんでした。',
    impact: '変更は途中の状態です。',
    next: ['依頼を小さく分けて新しい依頼として再実行する']
  },
  NO_CHANGES: {
    cause: 'AI が変更を作りませんでした（既に満たされている、依頼が不明確、または AI が安全のため作業を止めた、のいずれか）。',
    impact: 'プロジェクトは変わっていません。',
    next: ['「技術情報」にある AI の報告内容を確認する', '依頼内容を具体的にして新しい依頼を作る']
  },
  WORKSPACE_MODIFIED_DURING_REVIEW: {
    cause: 'レビュー中に作業用コピーが変更されました。',
    impact: 'レビュー結果が変更後の内容と一致しない可能性があるため停止しました。',
    next: ['開発者に相談する（隔離設定の確認が必要です）']
  },
  TIMEOUT: {
    cause: '実行全体の制限時間を超えました。',
    impact: '変更は途中の状態です。',
    next: ['依頼を小さく分けて新しい依頼として再実行する']
  },
  GATE_FAILED: {
    cause: '完了条件（検証成功・レビュー承認・未解決の指摘なし）を満たしていません。',
    impact: '変更は未完成の状態です。',
    next: ['「未解決の指摘」と「技術情報」で満たしていない条件を確認する']
  },
  PRECHECK_FAILED: {
    cause: '実行前の確認（環境・リポジトリ・検証コマンド）で問題が見つかりました。AI は実行していません。',
    impact: 'プロジェクトは変わっていません。AI の利用料金も発生していません。',
    next: ['下の「問題の内容」を確認する', 'ホーム画面のセットアップチェックとプロジェクトの状態を直してから、新しい依頼として再実行する']
  },
  TASK_NOT_APPROVED: {
    cause: '要件が承認されていませんでした。',
    impact: '実行していません。',
    next: ['ヒアリング画面で要件を確認して承認する']
  },
  CANCELLED: {
    cause: 'ユーザーの操作で停止しました。',
    impact: '変更は途中の状態で作業用コピーに残っています。元のプロジェクトは変わっていません。',
    next: ['不要であれば作業用コピーの変更はそのまま無視して構いません', '続ける場合は新しい依頼として再実行する']
  },
  RECOVERED_AFTER_RESTART: {
    cause: 'アプリの再起動時に実行中だったため、中断として記録しました。',
    impact: '変更は途中の状態です。',
    next: ['新しい依頼として再実行する']
  },
  INTERNAL_ERROR: {
    cause: 'アプリ内部でエラーが発生しました。',
    impact: '実行は不完全です。',
    next: ['「技術情報」の内容を添えて開発者に報告する', '新しい依頼として再実行する']
  }
};

const FALLBACK_GUIDANCE: Guidance = {
  cause: '詳細は「技術情報」を確認してください。',
  impact: '変更が完了しているかどうかは確認が必要です。',
  next: ['開発者に相談する']
};

export interface Outcome {
  /** 平易な見出し */
  headline: string;
  tone: Tone;
  /** 1〜2 文の説明 */
  summary: string;
  /** 完了条件を通過したか */
  done: boolean;
  /** 「完了」と誤認させないための注意（なければ null） */
  caution: string | null;
  guidance: Guidance;
}

type ReportFacts = Pick<RunReportResult, 'openFindings' | 'requirementsUnverified' | 'policyFindings'>;

export function describeOutcome(run: RunStatus, report?: ReportFacts | null): Outcome {
  const guidance = (run.reasonCode && REASON_GUIDANCE[run.reasonCode]) || (run.state === 'COMPLETED' ? REASON_GUIDANCE['COMPLETED']! : FALLBACK_GUIDANCE);
  const openFindings = report?.openFindings.length ?? 0;
  const unverified = report?.requirementsUnverified.length ?? 0;
  const unapprovedPolicy = report?.policyFindings.filter((p) => !p.approved && p.severity === 'blocking').length ?? 0;
  switch (run.state) {
    case 'COMPLETED': {
      const notes: string[] = [];
      if (openFindings > 0) notes.push(`レビューで未解決の指摘が ${openFindings} 件あります（完了を妨げない重要度のものです）`);
      if (unverified > 0) notes.push(`レビューで確認できなかった要件が ${unverified} 件あります`);
      return {
        headline: '開発が完了しました（元のプロジェクトへの取り込みはまだです）',
        tone: 'success',
        summary: '検証とレビューを通過した変更が作業用コピーに保存されています。内容を確認してから取り込んでください。',
        done: true,
        caution: notes.length > 0 ? `${notes.join('。')}。「完了」は完了条件を通過したことを示し、すべての問題がないことを保証しません。` : null,
        guidance
      };
    }
    case 'NEEDS_HUMAN':
      return {
        headline: '人の判断が必要です（AI は停止しました）',
        tone: 'warning',
        summary: 'AI だけでは解決できない問題が残ったため、安全のため途中で止めました。変更は完成していません。',
        done: false,
        caution: `この結果は「完了」ではありません。作業用コピーの変更をそのまま取り込まないでください${unapprovedPolicy > 0 ? `（未承認のポリシー違反 ${unapprovedPolicy} 件）` : ''}。`,
        guidance
      };
    case 'PRECHECK_FAILED':
      return {
        headline: '実行前の確認で止まりました（AI は実行していません）',
        tone: 'danger',
        summary: '環境やプロジェクトの状態に問題があるため、開発を始めませんでした。プロジェクトは変わっていません。',
        done: false,
        caution: null,
        guidance
      };
    case 'INTERRUPTED':
      return {
        headline: '途中で止まりました',
        tone: 'warning',
        summary: '実行は中断されました。変更は途中の状態で作業用コピーに残っています。',
        done: false,
        caution: 'この結果は「完了」ではありません。途中の変更を取り込まないでください。',
        guidance
      };
    case 'INTERNAL_ERROR':
      return {
        headline: 'エラーで停止しました',
        tone: 'danger',
        summary: 'アプリ内部の問題で実行を続けられませんでした。',
        done: false,
        caution: 'この結果は「完了」ではありません。',
        guidance
      };
    default:
      return {
        headline: '実行中です',
        tone: 'info',
        summary: '開発はまだ終わっていません。実行画面で進捗を確認できます。',
        done: false,
        caution: null,
        guidance: { cause: '実行中です。', impact: 'まだ結果はありません。', next: ['実行画面で進捗を見る'] }
      };
  }
}

export const SEVERITY_LABELS: Record<string, string> = { critical: '重大', high: '高', medium: '中', low: '低' };

/** 指摘の重要度が完了に与える影響（既定の blocking 重要度は critical / high） */
export function severityImpact(severity: string): { blocking: boolean; text: string } {
  if (severity === 'critical' || severity === 'high') return { blocking: true, text: 'この指摘が残っている間は完了になりません（対応が必要）' };
  if (severity === 'medium') return { blocking: false, text: '完了は妨げませんが、対応を推奨します' };
  return { blocking: false, text: '任意対応です（完了は妨げません）' };
}

export function severityTone(severity: string): Tone {
  if (severity === 'critical' || severity === 'high') return 'danger';
  if (severity === 'medium') return 'warning';
  return 'neutral';
}

export interface Activity {
  /** 今なにをしているか（日本語） */
  title: string;
  detail: string;
  /** 修正ラウンド（フィードバック付きの実装）か */
  fixing: boolean;
}

/** 実行画面の「現在の処理」。state と直近イベントから推定し、終了時刻の予測はしない。 */
export function describeActivity(run: RunStatus, events: readonly RunEvent[]): Activity {
  const last = events.length > 0 ? events[events.length - 1]! : null;
  const round = run.currentRound;
  const builderStart = [...events].reverse().find((e) => e.type === 'builder.started');
  const hasFeedback = builderStart?.payload['hasFeedback'] === true;
  const fixing = run.state === 'IMPLEMENTING' && (hasFeedback || round > 1);
  if (isTerminalRunState(run.state)) {
    const o = describeOutcome(run);
    return { title: o.headline, detail: o.summary, fixing: false };
  }
  switch (run.state) {
    case 'CREATED':
      return { title: '開始準備中', detail: '実行を登録しています。', fixing: false };
    case 'PREFLIGHT':
      return { title: '実行前の確認中', detail: 'Docker の隔離、Git の状態、検証コマンドの有無を確認しています。AI はまだ動いていません。', fixing: false };
    case 'IMPLEMENTING': {
      let detail = fixing ? '前回の指摘（検証エラー・レビュー・ポリシー違反）をもとに Claude Code が修正しています。' : 'Claude Code が隔離されたコンテナ内でコードを書いています。';
      if (last?.type === 'builder.completed') detail = '実装が終わり、変更内容を集めています。';
      else if (last?.type === 'diff.collected') detail = '変更内容の静的チェック（Policy Gate）を行っています。';
      else if (last?.type === 'verification.completed' || last?.type === 'baseline.completed') detail = '変更前のプロジェクトで検証コマンドが通ることを確認しています。';
      return { title: fixing ? `修正中（ラウンド ${round}）` : `実装中（ラウンド ${round}）`, detail, fixing };
    }
    case 'POLICY_BLOCKED':
      return { title: `ポリシー違反の修正を依頼中（ラウンド ${round}）`, detail: '静的チェックで未承認の違反が見つかったため、検証・レビューを行わずに AI へ修正を依頼しています。', fixing: true };
    case 'VERIFYING':
      return { title: `検証中（ラウンド ${round}）`, detail: 'プロジェクトの検証コマンド（型チェック・lint・テスト）をコンテナ内で実行しています。', fixing: false };
    case 'REVIEWING':
      return { title: `レビュー中（ラウンド ${round}）`, detail: 'Codex が変更内容を読み取り専用でレビューしています。', fixing: false };
    default:
      return { title: '処理中', detail: '', fixing: false };
  }
}

/** 実行画面のステップ表示（要件分析は承認済みのため常に完了） */
export const RUN_STEPS = ['ANALYSIS', 'PREFLIGHT', 'IMPLEMENTING', 'VERIFYING', 'REVIEWING', 'COMPLETED'] as const;
export type RunStep = (typeof RUN_STEPS)[number];
export const RUN_STEP_LABELS: Record<RunStep, string> = {
  ANALYSIS: '要件分析',
  PREFLIGHT: '実行前の確認',
  IMPLEMENTING: '実装',
  VERIFYING: '検証',
  REVIEWING: 'レビュー',
  COMPLETED: '完了'
};

export function currentStepIndex(state: RunStatus['state']): number {
  if (state === 'CREATED') return 0;
  if (state === 'POLICY_BLOCKED') return RUN_STEPS.indexOf('IMPLEMENTING');
  const i = RUN_STEPS.indexOf(state as RunStep);
  return i;
}
