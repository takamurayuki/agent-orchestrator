import type { EgressSummary, FailureDiagnosis, RoundRecord, RunStatus, VerificationCommandResult } from '@agent-orchestrator/contracts';

/**
 * 実行失敗の診断（v0.2.2、D-43）。AI ではなく、構造化された記録（状態・理由コード・検証コマンドの終了コードと出力・
 * Builder の結果・Reviewer の判定・egress 集計）から決定的に原因を分類し、利用者向けの日本語（何が起きたか / 開発結果への影響 /
 * 自動修復可能か / 次に取る操作）を返す。原因を特定できないものは unknown のまま返し、推測で確定しない。
 * 権限や Docker の制約を緩める案内はしない。
 */
export interface FailureDiagnosisInput {
  run: RunStatus;
  rounds: readonly RoundRecord[];
  egress?: EgressSummary | null;
}

const DENIAL_RE = /(permission|command|tool|bash|shell)[^.\n]{0,80}(denied|refused|blocked|not allowed|rejected)|was denied|denied because|expansion obfuscation|requires approval|no way to approve|cannot be approved/i;
const DOCKER_RE = /docker: Error|Cannot connect to the Docker daemon|error during connect|no such container|OCI runtime|spawn error|ENOENT: no such file or directory, spawn|exec format error/i;
const NETWORK_RE = /ENOTFOUND|ECONNREFUSED|ETIMEDOUT|ECONNRESET|EAI_AGAIN|407 Proxy|403 Forbidden|tunnel(ing)? socket|getaddrinfo|network is unreachable|socket hang up/i;
const SUPPLY_CHAIN_RE = /ERR_PNPM_MINIMUM_RELEASE_AGE_VIOLATION|minimumReleaseAge/;
const FETCH_RE = /ERR_PNPM_FETCH_\d+|ERR_PNPM_NO_MATCHING_VERSION|ERR_PNPM_OUTDATED_LOCKFILE|ERR_PNPM_LOCKFILE|ERR_PNPM_TARBALL|ERR_PNPM_META_FETCH_FAIL|integrity checksum failed|404 Not Found/;

const text = (c: VerificationCommandResult) => `${c.stdoutExcerpt}\n${c.stderrExcerpt}`;
const failedCommand = (round: RoundRecord | undefined) => round?.verification?.commands.find((c) => c.timedOut || c.exitCode !== 0) ?? null;

function base(d: Partial<FailureDiagnosis> & Pick<FailureDiagnosis, 'category' | 'whatHappened'>): FailureDiagnosis {
  return {
    confidence: 'confirmed',
    impact: '変更は途中の状態で作業用コピーに残っています。そのまま取り込まないでください。',
    autoRecoverable: 'no',
    autoRecoveryNote: '',
    nextSteps: [],
    evidence: [],
    ...d
  };
}

export function diagnoseFailure(input: FailureDiagnosisInput): FailureDiagnosis | null {
  const { run, rounds } = input;
  if (run.state === 'COMPLETED' || run.state === 'CREATED' || run.state === 'PREFLIGHT' || run.state === 'IMPLEMENTING' || run.state === 'VERIFYING' || run.state === 'REVIEWING' || run.state === 'POLICY_BLOCKED') return null;
  const last = rounds[rounds.length - 1];
  const detail = run.reasonDetail ?? '';
  const code = run.reasonCode;
  const builderText = last?.builder?.resultExcerpt ?? '';
  const egress = input.egress ?? null;
  const deniedHosts = egress?.deniedHosts.map((h) => h.host) ?? [];

  if (code === 'CANCELLED' || code === 'RECOVERED_AFTER_RESTART') {
    return base({
      category: 'cancelled',
      whatHappened: code === 'CANCELLED' ? '利用者の操作で実行を止めました。' : 'アプリの再起動時に実行中だったため、中断扱いにしました。',
      autoRecoverable: 'no',
      autoRecoveryNote: '自動では再開しません。',
      nextSteps: ['途中の変更が必要なければ作業用コピーを無視して新しい依頼を作る']
    });
  }
  if (code === 'PRECHECK_FAILED') {
    if (SUPPLY_CHAIN_RE.test(detail)) return supplyChain(detail, true);
    if (DOCKER_RE.test(detail) || /Docker/.test(detail)) {
      return base({ category: 'docker_error', whatHappened: '実行前の確認で Docker（隔離環境）を使えませんでした。AI は実行していません。', impact: 'プロジェクトは変わっていません。', autoRecoverable: 'no', autoRecoveryNote: 'Docker が使える状態になれば、新しい依頼として再実行できます。', nextSteps: ['Docker Desktop が起動しているか確認する', 'ホーム画面のセットアップチェックを再実行する'], evidence: [detail.slice(0, 200)] });
    }
    return base({ category: 'precheck', whatHappened: '実行前の確認で問題が見つかったため、AI は実行していません。', impact: 'プロジェクトは変わっていません。', autoRecoverable: 'no', autoRecoveryNote: '環境を整えてから再実行してください。', nextSteps: ['「問題の内容」の対処に従って環境を整える', 'ホーム画面のセットアップチェックで確認してから新しい依頼を作る'], evidence: detail ? [detail.slice(0, 200)] : [] });
  }
  if (code === 'POLICY_VIOLATION') {
    return base({ category: 'policy_violation', whatHappened: 'AI の変更にルールの無効化やテストの削除・スキップなどが含まれ、静的チェック（Policy Gate）で止まりました。', autoRecoverable: 'no', autoRecoveryNote: 'この判定は AI では解除できず、権限や制約を緩めて回避することもしません。', nextSteps: ['「ポリシー違反の内容」を確認する', '意図した変更なら開発者に例外の登録を依頼し、そうでなければ依頼内容を見直して新しい依頼を作る'], evidence: (last?.policyFindings ?? []).filter((p) => !p.approved).slice(0, 3).map((p) => `${p.ruleId} ${p.file}:${p.line}`) });
  }
  if (code === 'SCOPE_DEVIATION') {
    return base({ category: 'scope_deviation', whatHappened: 'AI の変更が承認した範囲の外に大きく広がったため、検証・レビューの前に止めました。', autoRecoverable: 'no', autoRecoveryNote: '1 回は AI に差し戻しましたが、範囲外の変更が残りました。', nextSteps: ['「承認した範囲外の変更」で予想外のファイルと AI の理由を確認する', '意図どおりなら変更範囲を広げて新しい依頼として再実行する'], evidence: last?.scopeCheck?.unexpected.slice(0, 5) ?? [] });
  }
  if (code === 'REVIEW_UNKNOWN' || code === 'REVIEW_INVALID_JSON' || code === 'REVIEW_INCONSISTENT') {
    return base({
      category: 'review_undecidable',
      whatHappened: code === 'REVIEW_UNKNOWN' ? 'AI レビュー（Codex）が「判断できない」と回答しました。' : code === 'REVIEW_INVALID_JSON' ? 'AI レビューの出力を契約どおりに読み取れませんでした。' : 'AI レビューの判定と指摘内容が矛盾していました。',
      impact: '変更が正しいかどうかは確認できていません。完了扱いにはしていません。',
      autoRecoverable: 'no',
      autoRecoveryNote: 'レビューの判定を AI の推測で補うことはしません。',
      nextSteps: ['開発者に変更内容のレビューを依頼する', '同じ内容を新しい依頼として再実行する（一時的な不調なら解消することがあります）'],
      evidence: last?.review?.parseError ? [last.review.parseError.slice(0, 200)] : []
    });
  }
  if (code === 'BUILDER_FAILED' || code === 'BUILDER_TIMEOUT' || code === 'NO_CHANGES') {
    if (DENIAL_RE.test(builderText)) return builderDenied(builderText, code === 'NO_CHANGES' ? 'プロジェクトは変わっていません。' : undefined);
    if (code === 'BUILDER_TIMEOUT') return base({ category: 'limit_reached', whatHappened: '実装を行う AI（Claude Code）が制限時間内に終わりませんでした。', autoRecoverable: 'no', autoRecoveryNote: '時間上限は自動では延長しません。', nextSteps: ['依頼を小さく分けて新しい依頼として再実行する'] });
    if (code === 'NO_CHANGES') return base({ category: 'no_changes', whatHappened: 'AI が変更を作りませんでした。', impact: 'プロジェクトは変わっていません。', autoRecoverable: 'unknown', autoRecoveryNote: '理由（既に満たされている / 依頼が不明確 / AI が安全のため止めた）は AI の報告からしか分からず、確定できません。', nextSteps: ['「技術情報」の AI の報告を確認する', '依頼内容を具体的にして新しい依頼を作る'], confidence: 'unknown', evidence: builderText ? [builderText.slice(0, 200)] : [] });
    return base({ category: 'builder_failed', whatHappened: '実装を行う AI（Claude Code）が異常終了しました。', autoRecoverable: 'no', autoRecoveryNote: '認証・接続の問題は自動では直りません。', nextSteps: ['ホーム画面のセットアップチェックで AI の認証と接続を確認する', '時間をおいて新しい依頼として再実行する'], evidence: builderText ? [builderText.slice(0, 200)] : [] });
  }
  if (code === 'MAX_ROUNDS' || code === 'GATE_FAILED' || code === 'TIMEOUT') {
    const failed = failedCommand(last);
    if (failed) {
      const out = text(failed);
      if (failed.name.startsWith('generate:')) {
        const stale = /最新ではありません/.test(out);
        return base({
          category: 'generated_artifact',
          whatHappened: stale ? `生成物の更新確認（${failed.name}）で、生成スクリプトを再実行すると内容が変わりました。AI が生成物を再生成していない、または手で編集した状態です。` : `生成物の更新確認（${failed.name}）で生成スクリプトが失敗しました（ネットワークは遮断されています）。`,
          autoRecoverable: 'no',
          autoRecoveryNote: '検証の失敗は毎ラウンド AI に差し戻していますが、上限内では解消しませんでした。生成物の内容を AI の判断で合格にすることはしません。',
          nextSteps: ['作業用コピーで生成スクリプトを自分で実行し、結果を確認する', '生成スクリプトが Git 管理外の入力に依存していないか確認する（依存している場合は隔離環境では正しく再生成できません）'],
          evidence: [`${failed.name} exit=${failed.exitCode ?? 'timeout'}`, out.trim().slice(0, 200)]
        });
      }
      if (SUPPLY_CHAIN_RE.test(out)) return supplyChain(out, false);
      if (DOCKER_RE.test(out) || failed.exitCode === 125 || failed.exitCode === 126 || failed.exitCode === 127) {
        return base({ category: 'docker_error', whatHappened: `検証コマンド ${failed.name} が隔離環境（Docker）の問題で実行できませんでした。`, autoRecoverable: 'no', autoRecoveryNote: 'Docker 側の問題は自動では直りません。隔離設定を緩めて回避することもしません。', nextSteps: ['Docker Desktop の状態を確認し、ホーム画面のセットアップチェックを再実行する', '解消後に新しい依頼として再実行する'], evidence: [`${failed.name} exit=${failed.exitCode ?? 'timeout'}`, out.trim().slice(0, 200)] });
      }
      if (NETWORK_RE.test(out) || (deniedHosts.length > 0 && failed.name === 'install')) {
        return base({
          category: 'network_blocked',
          whatHappened: `検証コマンド ${failed.name} が、許可されていない通信先への接続または通信エラーで失敗しました。`,
          autoRecoverable: 'no',
          autoRecoveryNote: '通信の許可先（egress allowlist）は自動では広げません。',
          nextSteps: ['レポートの「通信の記録」で拒否された通信先を確認する', '必要な通信先が正当なら開発者に allowlist への追加を相談する。不要ならプロジェクト側の設定（レジストリ・取得先）を見直す'],
          evidence: [`${failed.name} exit=${failed.exitCode ?? 'timeout'}`, ...deniedHosts.slice(0, 5).map((h) => `拒否: ${h}`), out.trim().slice(0, 160)],
          confidence: NETWORK_RE.test(out) ? 'confirmed' : 'inferred'
        });
      }
      if (FETCH_RE.test(out)) {
        return base({ category: 'dependency_fetch_failed', whatHappened: `依存関係の取得（${failed.name}）に失敗しました。lockfile と公開パッケージの不一致、または取得先の問題です。`, autoRecoverable: 'no', autoRecoveryNote: 'lockfile や依存は AI も本ツールも自動では変更しません。', nextSteps: ['プロジェクトで pnpm install --frozen-lockfile が通るか確認する', 'lockfile を更新してコミットしてから新しい依頼を作る'], evidence: [`${failed.name} exit=${failed.exitCode ?? 'timeout'}`, out.trim().slice(0, 200)] });
      }
      return base({
        category: 'verification_failed',
        whatHappened: `検証コマンド ${failed.name} が${failed.timedOut ? 'タイムアウトしました' : `失敗しました（exit ${failed.exitCode}）`}。AI は毎ラウンド結果を受けて修正を試みましたが、上限内で解消しませんでした。`,
        autoRecoverable: 'no',
        autoRecoveryNote: '検証の失敗は自動で AI に差し戻しています（修正上限 ' + run.maxRounds + ' 回）。上限を超えたため人の判断が必要です。',
        nextSteps: ['「技術情報」で失敗したコマンドの出力を確認する', '依頼を小さく分ける、または失敗箇所を開発者に相談する'],
        evidence: [`${failed.name} exit=${failed.exitCode ?? 'timeout'}`, out.trim().slice(0, 200)]
      });
    }
    if (DENIAL_RE.test(builderText)) return builderDenied(builderText);
    const review = last?.review?.parsed ?? null;
    if (review && review.verdict === 'changes_requested') {
      return base({
        category: 'limit_reached',
        whatHappened: `AI レビューの指摘が${code === 'TIMEOUT' ? '制限時間内' : `修正上限（${run.maxRounds} 回）内`}に解消しませんでした。検証コマンドはすべて成功しています。`,
        autoRecoverable: 'no',
        autoRecoveryNote: '指摘は毎ラウンド AI に差し戻しています。上限を超えたため人の判断が必要です。',
        nextSteps: ['「未解決の指摘」を確認し、妥当なら開発者に修正を依頼する', '指摘が要件の解釈違いなら、依頼内容を具体的にして新しい依頼を作る'],
        evidence: review.findings.slice(0, 3).map((f) => `[${f.severity}] ${f.file}:${f.line} ${f.description.slice(0, 120)}`)
      });
    }
    return base({ category: code === 'TIMEOUT' ? 'limit_reached' : 'unknown', whatHappened: code === 'TIMEOUT' ? '実行全体の制限時間を超えました。' : '修正上限に達しましたが、記録から原因を特定できませんでした。', autoRecoverable: code === 'TIMEOUT' ? 'no' : 'unknown', autoRecoveryNote: code === 'TIMEOUT' ? '時間上限は自動では延長しません。' : '原因不明のため、自動修復の可否は判断できません。', nextSteps: ['レポートと「技術情報」を確認する', '依頼を小さく分けて新しい依頼として再実行する'], confidence: code === 'TIMEOUT' ? 'confirmed' : 'unknown', evidence: detail ? [detail.slice(0, 200)] : [] });
  }
  if (code === 'WORKSPACE_MODIFIED_DURING_REVIEW') {
    return base({ category: 'unknown', whatHappened: 'レビュー中に作業用コピーが変更されました。', impact: 'レビュー結果が最終の内容と一致しない可能性があるため停止しました。', autoRecoverable: 'no', autoRecoveryNote: '隔離設定の確認が必要です。', nextSteps: ['開発者に相談する'], confidence: 'confirmed' });
  }
  if (code === 'INTERNAL_ERROR') {
    if (DOCKER_RE.test(detail)) return base({ category: 'docker_error', whatHappened: '隔離環境（Docker）の操作でエラーが起きました。', autoRecoverable: 'no', autoRecoveryNote: 'Docker 側の問題は自動では直りません。', nextSteps: ['Docker Desktop の状態を確認し、ホーム画面のセットアップチェックを再実行する'], evidence: [detail.slice(0, 200)] });
    return base({ category: 'unknown', whatHappened: '内部エラーで停止しました。', autoRecoverable: 'unknown', autoRecoveryNote: '原因不明のため、自動修復の可否は判断できません。', nextSteps: ['「技術情報」の記録を確認し、再現する場合は開発者に報告する'], confidence: 'unknown', evidence: detail ? [detail.slice(0, 200)] : [] });
  }
  return base({ category: 'unknown', whatHappened: detail || '記録から原因を特定できませんでした。', autoRecoverable: 'unknown', autoRecoveryNote: '原因不明のため、自動修復の可否は判断できません。', nextSteps: ['レポートと「技術情報」を確認する'], confidence: 'unknown' });
}

function supplyChain(out: string, precheck: boolean): FailureDiagnosis {
  return base({
    category: 'supply_chain_policy',
    whatHappened: 'pnpm のサプライチェーンポリシー（minimumReleaseAge: 公開から間もないパッケージを拒否）により、依存関係のインストールが拒否されました。' + (precheck ? ' AI は実行していません。' : ''),
    impact: precheck ? 'プロジェクトは変わっていません。' : '変更は途中の状態で作業用コピーに残っています。',
    autoRecoverable: 'no',
    autoRecoveryNote: 'ポリシーは安全のための設定で、本ツールは自動で緩めません。',
    nextSteps: ['プロジェクトの pnpm 設定（pnpm-workspace.yaml の minimumReleaseAge / minimumReleaseAgeExclude）を確認する', '依存を更新した直後なら 1 日おいて再実行する'],
    evidence: [out.trim().slice(0, 200)]
  });
}

function builderDenied(builderText: string, impact?: string): FailureDiagnosis {
  return base({
    category: 'builder_command_denied',
    whatHappened: '実装を行う AI（Claude Code）が、自身の安全規則によりコマンドの実行を拒否されたと報告しています。本ツールの隔離設定ではなく、AI 側 CLI の判断です。',
    impact: impact ?? '変更は途中の状態で作業用コピーに残っています。検証やコマンド実行を伴う作業が完了していない可能性があります。',
    autoRecoverable: 'unknown',
    autoRecoveryNote: '次のラウンドで AI が別の書き方で実行し直すことはありますが、保証はありません。本ツールが AI の権限を広げることはしません。',
    nextSteps: ['「技術情報」の AI の報告で、拒否されたコマンドを確認する', '必要なら作業用コピーでそのコマンドを自分で実行して結果を確認する'],
    evidence: [builderText.slice(0, 240)],
    confidence: 'inferred'
  });
}
