import {
  isTerminalRunState,
  type BuilderOutcome,
  type DiffSummary,
  type PolicyFinding,
  type PolicyViolation,
  type ResolvedTask,
  type ReviewFinding,
  type ReviewOutcome,
  type RoundRecord,
  type RunEvent,
  type RunReasonCode,
  type RunState,
  type RunStatus,
  type VerificationResult
} from '@agent-orchestrator/contracts';
import type { GeneratedArtifact, ScopeCheck } from '@agent-orchestrator/contracts';
import { evaluateCompletionGate, type GateResult } from './gate.js';
import { checkDiffPolicy } from './policy.js';
import { evaluatePolicyGate, parsePolicyExceptions, renderPolicyFeedback } from './policy-gate.js';
import { evaluateScope, renderScopeFeedback } from './scope.js';
import { checkStructure, structureCommandResult } from './verification/structure.js';
import { generatedCommandNames } from './verification/generated.js';

/**
 * 実行状態機械（SPEC §6）。外部副作用はすべて EngineDeps 経由で注入し、単体テストではモックする。
 *
 * CREATED → PREFLIGHT → IMPLEMENTING → VERIFYING → REVIEWING → COMPLETED
 *   - VERIFYING 失敗 → 次の IMPLEMENTING（残試行があれば）。レビューは実行しない
 *   - REVIEWING changes_requested → 次の IMPLEMENTING（残試行があれば）
 *   - REVIEWING unknown / JSON 不正 / 内容不整合 → NEEDS_HUMAN
 *   - CLI 異常終了・ポリシー違反・修正上限・時間切れ → NEEDS_HUMAN（preflight 失敗は PRECHECK_FAILED）
 *   - キャンセル → 子プロセス停止後 INTERRUPTED
 *   - 予期しない例外 → INTERNAL_ERROR
 */

export interface ApprovedTaskSnapshot {
  approvedTaskId: string;
  task: ResolvedTask;
  /** ユーザー承認済みフラグ（承認 API を通ったときだけ true） */
  approved: boolean;
  approvedAt: string | null;
  taskYaml: string;
}

export interface PreflightCheck {
  id: string;
  label: string;
  status: 'ok' | 'fail' | 'warn' | 'unverified';
  detail: string;
  fix: string | null;
}
export interface PreflightReport {
  ok: boolean;
  checks: PreflightCheck[];
}

export interface WorkspaceHandle {
  path: string;
  baseSha: string;
}

export interface DiffCapture {
  summary: DiffSummary;
  /** 全体の unified diff（未追跡ファイルも含む、サイズ上限で打ち切り） */
  patch: string;
  /** ファイルごとの patch（ポリシー検査用） */
  patches: Record<string, string>;
}

export interface BuilderInput {
  runId: string;
  round: number;
  workspace: WorkspaceHandle;
  task: ResolvedTask;
  taskYaml: string;
  feedback: BuilderFeedback | null;
  timeoutMs: number;
  signal: AbortSignal;
  onLog: (chunk: string) => void;
}
export interface BuilderFeedback {
  previousRound: number;
  verificationFailures: string[];
  reviewFindings: ReviewFinding[];
  requirementsUnverified: string[];
  reviewSummary: string | null;
  /** Policy Gate の未承認 blocking 検出（v2.1）。ルールを無効化せずコードを直すよう Builder に返す */
  policyFindings: string[];
  /** 重大なスコープ逸脱（v0.2.0）。期待範囲に収めるか理由を述べるよう Builder に返す */
  scopeDeviation?: string | null;
}

export interface VerifierInput {
  runId: string;
  round: number;
  workspace: WorkspaceHandle;
  profile: ResolvedTask['verificationProfile'];
  /** 生成物の更新検証（v0.2.1）。ベースライン（round 0）では渡さない */
  generatedArtifacts?: GeneratedArtifact[];
  timeoutMs: number;
  signal: AbortSignal;
  onLog: (chunk: string) => void;
}

export interface ReviewerInput {
  runId: string;
  round: number;
  workspace: WorkspaceHandle;
  task: ResolvedTask;
  taskYaml: string;
  diff: DiffCapture;
  verification: VerificationResult;
  /** スコープ判定（v0.2.0）。Reviewer への文脈 */
  scopeCheck?: ScopeCheck | null;
  timeoutMs: number;
  signal: AbortSignal;
  onLog: (chunk: string) => void;
}

export interface EngineDeps {
  preflight(input: { task: ResolvedTask; signal: AbortSignal }): Promise<PreflightReport>;
  workspace: {
    resolveBaseSha(repository: string, baseRef: string): Promise<string>;
    create(input: { runId: string; repository: string; baseSha: string }): Promise<WorkspaceHandle>;
    captureDiff(workspace: WorkspaceHandle): Promise<DiffCapture>;
    hash(workspace: WorkspaceHandle): Promise<string>;
    /** ベースコミット時点のファイル内容（Policy Gate の比較・人間管理の例外ファイル用） */
    readBaseFile(workspace: WorkspaceHandle, relPath: string): Promise<string | null>;
    /** 作業ツリーのファイル内容 */
    readWorkspaceFile(workspace: WorkspaceHandle, relPath: string): string | null;
  };
  builder: { implement(input: BuilderInput): Promise<BuilderOutcome> };
  verifier: {
    expectedCommands(profile: ResolvedTask['verificationProfile']): string[];
    verify(input: VerifierInput): Promise<VerificationResult>;
  };
  reviewer: { review(input: ReviewerInput): Promise<ReviewOutcome> };
  /** ホストのワークスペースと隔離実行環境（ボリューム）の同期。push: 作成直後、pull: Builder/Reviewer 実行後 */
  transport: {
    push(runId: string, workspace: WorkspaceHandle): Promise<void>;
    pull(runId: string, workspace: WorkspaceHandle): Promise<void>;
  };
  recorder: RunRecorder;
  /** 進行中 Run の有無（並行起動の禁止 EX-13）。engine 外の RunService が保証するが、二重防御として確認する */
  hasActiveRun(exceptRunId: string): boolean;
  now(): number;
}

/** 状態・イベント・成果物の永続化。SQLite + ファイル（runs/<runId>/...）。 */
export interface RunRecorder {
  createRun(status: RunStatus, snapshot: ApprovedTaskSnapshot): Promise<void>;
  updateStatus(status: RunStatus): Promise<void>;
  /** イベントを連番付きで永続化し、永続化後に返す */
  appendEvent(event: Omit<RunEvent, 'sequence' | 'timestamp'>): Promise<RunEvent>;
  saveRound(runId: string, round: RoundRecord): Promise<void>;
  saveArtifact(runId: string, round: number, name: string, content: string): Promise<void>;
  saveReport(runId: string, markdown: string): Promise<void>;
  /** 永続化済みイベント数（完了ゲート 7） */
  persistedEventCount(runId: string): Promise<number>;
}

export interface EngineRunInput {
  runId: string;
  snapshot: ApprovedTaskSnapshot;
  runDir: string;
  signal: AbortSignal;
}

export class RunCancelledError extends Error {
  constructor() {
    super('run cancelled');
    this.name = 'RunCancelledError';
  }
}

export const NEXT_ACTIONS: Record<RunReasonCode, string[]> = {
  COMPLETED: ['worktree の差分を確認し、問題なければ手動で元ブランチへ取り込んでください（push/merge はツールが行いません）'],
  MAX_ROUNDS: ['修正上限（3 回）に達しました。レポートの失敗理由と指摘を確認し、要件を見直すか手動で修正してください'],
  REVIEW_UNKNOWN: ['Reviewer が判断不能（unknown）を返しました。差分を人間がレビューしてください'],
  REVIEW_INVALID_JSON: ['Reviewer の出力が契約（review.schema.json）に適合しません。rounds/<n>/review.raw.txt を確認してください'],
  REVIEW_INCONSISTENT: ['Reviewer の verdict と指摘が矛盾しています。指摘内容を人間が確認してください'],
  BUILDER_FAILED: ['Builder（Claude Code）が異常終了しました。rounds/<n>/builder.log を確認し、認証・通信・権限を確認してください'],
  BUILDER_TIMEOUT: ['Builder がタイムアウトしました。cliTimeoutSeconds の見直し、またはタスクの分割を検討してください'],
  NO_CHANGES: ['Builder が変更を生成しませんでした。要件が既に満たされているか、依頼内容が不明確な可能性があります'],
  SCOPE_DEVIATION: ['承認した範囲（expectedChanges）の外に重大な変更があります。rounds/<n>/diff.patch と Builder の変更理由を確認し、意図どおりなら要件の変更範囲を広げて新しい依頼として再実行するか、不要な変更を手動で取り除いてください'],
  POLICY_VIOLATION: ['差分にポリシー違反（eslint-disable / ts-ignore の追加、テストの skip・削除、検証設定の緩和、禁止パス）があります。rounds/<n>/policy.json を確認し、手動で修正するか、意図的な例外ならベースコミットの .agent-orchestrator/policy.json に理由付きで登録して再実行してください'],
  WORKSPACE_MODIFIED_DURING_REVIEW: ['レビュー中に worktree が変更されました。Reviewer の read-only 隔離を確認してください'],
  TIMEOUT: ['maxDurationSeconds を超過しました。途中成果は worktree に残っています'],
  GATE_FAILED: ['完了ゲートを満たしていません。レポートのゲート失敗一覧を確認してください'],
  PRECHECK_FAILED: ['起動前検査に失敗しました。各チェックの修正方法に従って環境を整えてから再実行してください'],
  TASK_NOT_APPROVED: ['タスクが承認されていません。承認画面で内容を確認し承認してください'],
  CANCELLED: ['ユーザーがキャンセルしました。途中成果は worktree に残っています'],
  RECOVERED_AFTER_RESTART: ['アプリ再起動時に実行中だったため中断扱いにしました。worktree を確認し、必要なら新しい Run を開始してください'],
  INTERNAL_ERROR: ['内部エラーです。runs/<runId>/events.jsonl と status.json を確認してください']
};

/**
 * ベースライン検証の失敗から、利用者が対処できる既知の原因を特定する（β版検証で見つかった事例。見つからなければ null）。
 * 制約は緩めない（pnpm の供給チェーンポリシーは有効のまま）。原因と対処だけを平易に示す。
 */
export function diagnoseBaselineFailure(commands: ReadonlyArray<{ name: string; exitCode: number | null; timedOut: boolean; stdoutExcerpt: string; stderrExcerpt: string }>): string | null {
  for (const c of commands) {
    if (c.exitCode === 0 && !c.timedOut) continue;
    const out = `${c.stdoutExcerpt}\n${c.stderrExcerpt}`;
    if (/ERR_PNPM_MINIMUM_RELEASE_AGE_VIOLATION|minimumReleaseAge/.test(out)) {
      return 'pnpm のサプライチェーンポリシー（minimumReleaseAge）により、公開から間もない依存パッケージのインストールが拒否されました。プロジェクトの pnpm 設定（pnpm-workspace.yaml の minimumReleaseAge / minimumReleaseAgeExclude）を見直すか、時間をおいて再実行してください。AI は実行していません';
    }
    if (/ERR_PNPM_OUTDATED_LOCKFILE|frozen-lockfile|lockfile is not up to date|npm ci.*can only install|not in sync|Missing: .* from lock file|lockfile needs to be updated|Your lockfile needs to be updated/i.test(out)) {
      return 'lockfile（pnpm-lock.yaml / package-lock.json / yarn.lock）が package.json と一致しません。プロジェクト側でパッケージマネージャの install を実行してロックファイルを更新・コミットしてから再実行してください。AI は実行していません';
    }
    if (/ENOTFOUND|ECONNREFUSED|ETIMEDOUT|EAI_AGAIN|403 Forbidden|getaddrinfo/i.test(out)) {
      return `依存パッケージの取得で通信エラーが発生しました（${c.name}）。ネットワークとレジストリ（registry.npmjs.org）への到達性を確認して再実行してください。allowlist 外のレジストリは遮断されます。AI は実行していません`;
    }
    if (c.timedOut) return `${c.name} が制限時間内に終わりませんでした。プロジェクトの検証コマンドの所要時間を確認するか、verificationTimeoutSeconds を見直してください。AI は実行していません`;
  }
  return null;
}

export class RunEngine {
  constructor(private readonly deps: EngineDeps) {}

  async run(input: EngineRunInput): Promise<RunStatus> {
    const { runId, snapshot, signal } = input;
    const task = snapshot.task;
    const startedMs = this.deps.now();
    const deadlineMs = startedMs + task.limits.maxDurationSeconds * 1000;
    let lastSequence = 0;
    let workspace: WorkspaceHandle | null = null;
    let status: RunStatus = {
      runId,
      approvedTaskId: snapshot.approvedTaskId,
      taskId: task.id,
      taskTitle: task.title,
      repository: task.repository,
      baseRef: task.baseRef,
      baseSha: null,
      state: 'CREATED',
      reasonCode: null,
      reasonDetail: null,
      currentRound: 0,
      maxRounds: task.limits.maxImplementationAttempts,
      worktreePath: null,
      runDir: input.runDir,
      startedAt: new Date(startedMs).toISOString(),
      finishedAt: null,
      lastSequence: 0,
      openBlockingFindings: 0,
      nextActions: []
    };
    const rounds: RoundRecord[] = [];

    const emit = async (type: string, payload: Record<string, unknown>, round: number | null = null) => {
      const ev = await this.deps.recorder.appendEvent({ runId, type, round, payload });
      lastSequence = ev.sequence;
      status = { ...status, lastSequence };
      return ev;
    };
    const transition = async (state: RunState, extra: Partial<RunStatus> = {}) => {
      const from = status.state;
      status = { ...status, ...extra, state };
      await emit('run.state_changed', { from, to: state, ...(extra.reasonCode ? { reasonCode: extra.reasonCode, reasonDetail: extra.reasonDetail ?? null } : {}) }, status.currentRound || null);
      await this.deps.recorder.updateStatus(status);
    };
    const finish = async (state: RunState, reasonCode: RunReasonCode, reasonDetail: string, extra: Partial<RunStatus> = {}) => {
      await transition(state, {
        reasonCode,
        reasonDetail,
        finishedAt: new Date(this.deps.now()).toISOString(),
        nextActions: NEXT_ACTIONS[reasonCode],
        ...extra
      });
      await emit('run.finished', { state, reasonCode, reasonDetail });
      await this.deps.recorder.updateStatus(status);
      return status;
    };
    const checkCancelled = () => {
      if (signal.aborted) throw new RunCancelledError();
    };
    const withinTime = () => this.deps.now() <= deadlineMs;
    const remainingMs = () => Math.max(0, deadlineMs - this.deps.now());

    try {
      await this.deps.recorder.createRun(status, snapshot);
      await emit('run.created', { taskId: task.id, approvedTaskId: snapshot.approvedTaskId, maxRounds: task.limits.maxImplementationAttempts });

      // 承認されていないスナップショットは決して実行しない（RA-11, RA-12）
      if (!snapshot.approved || !snapshot.approvedAt) {
        return await finish('NEEDS_HUMAN', 'TASK_NOT_APPROVED', 'task snapshot がユーザー承認済みではない');
      }
      if (this.deps.hasActiveRun(runId)) {
        return await finish('NEEDS_HUMAN', 'INTERNAL_ERROR', '別の Run が進行中のため起動を拒否');
      }

      // ---- PREFLIGHT ----
      await transition('PREFLIGHT');
      checkCancelled();
      const preflight = await this.deps.preflight({ task, signal });
      for (const c of preflight.checks) await emit('preflight.check', { ...c });
      await emit('preflight.completed', { ok: preflight.ok, failed: preflight.checks.filter((c) => c.status === 'fail').map((c) => c.id) });
      // 起動前検査中のキャンセルは「検査失敗」ではなく INTERRUPTED / CANCELLED として記録する（RC 検証で発見、v2.3.1）
      checkCancelled();
      if (!preflight.ok) {
        const failed = preflight.checks.filter((c) => c.status === 'fail' || c.status === 'unverified');
        return await finish('PRECHECK_FAILED', 'PRECHECK_FAILED', failed.map((c) => `${c.id}: ${c.detail}`).join('; '));
      }
      checkCancelled();

      const baseSha = await this.deps.workspace.resolveBaseSha(task.repository, task.baseRef);
      status = { ...status, baseSha };
      workspace = await this.deps.workspace.create({ runId, repository: task.repository, baseSha });
      status = { ...status, worktreePath: workspace.path };
      await this.deps.recorder.updateStatus(status);
      await emit('workspace.created', { path: workspace.path, baseSha });
      await this.deps.transport.push(runId, workspace);
      await emit('workspace.synced', { direction: 'push' });

      // ベースライン検証（Builder を呼ぶ前）: 未変更のリポジトリで検証プロファイルが通らない場合は環境/プロジェクト側の問題なので、
      // AI を呼ばずに PRECHECK_FAILED で停止する（AI 起因の失敗と区別し、修正ラウンドの浪費を防ぐ。D-23）
      checkCancelled();
      if (!withinTime()) return await finish('NEEDS_HUMAN', 'TIMEOUT', `maxDurationSeconds(${task.limits.maxDurationSeconds}) を超過`);
      await emit('verify.baseline.started', { profile: task.verificationProfile });
      const baselineLog: string[] = [];
      const baseline = await this.deps.verifier.verify({
        runId,
        round: 0,
        workspace,
        profile: task.verificationProfile,
        timeoutMs: Math.min(task.limits.verificationTimeoutSeconds * 1000, remainingMs()),
        signal,
        onLog: (c) => baselineLog.push(c)
      });
      await this.deps.recorder.saveArtifact(runId, 0, 'verify.baseline.json', JSON.stringify(baseline, null, 2));
      await this.deps.recorder.saveArtifact(runId, 0, 'verify.baseline.log', baselineLog.join(''));
      const baselineFailed = baseline.commands.filter((c) => c.exitCode !== 0 || c.timedOut).map((c) => c.name);
      await emit('verify.baseline.finished', { passed: baseline.passed, failed: baselineFailed, missing: baseline.missing });
      checkCancelled();
      if (!baseline.passed) {
        const hint = diagnoseBaselineFailure(baseline.commands);
        return await finish('PRECHECK_FAILED', 'PRECHECK_FAILED', `ベースライン検証（変更前のリポジトリ）が失敗: ${[...baselineFailed, ...baseline.missing.map((m) => `${m}(未実行)`)].join(', ')}。${hint ?? 'プロジェクト側で typecheck / lint / test:run が通る状態にしてから再実行してください'}`);
      }

      let feedback: BuilderFeedback | null = null;
      const maxRounds = task.limits.maxImplementationAttempts;

      for (let round = 1; round <= maxRounds; round++) {
        checkCancelled();
        if (!withinTime()) return await finish('NEEDS_HUMAN', 'TIMEOUT', `maxDurationSeconds(${task.limits.maxDurationSeconds}) を超過`);
        const record: RoundRecord = {
          round,
          builder: null,
          diff: null,
          scopeCheck: null,
          policyViolations: [],
          policyFindings: [],
          verification: null,
          review: null,
          workspaceHashBeforeReview: null,
          workspaceHashAfterReview: null,
          startedAt: new Date(this.deps.now()).toISOString(),
          finishedAt: null
        };
        rounds.push(record);
        status = { ...status, currentRound: round };
        await emit('round.started', { round, maxRounds, hasFeedback: feedback !== null }, round);

        // ---- IMPLEMENTING ----
        await transition('IMPLEMENTING');
        await emit('builder.started', { round, hasFeedback: feedback !== null, feedbackKinds: feedback ? { verification: feedback.verificationFailures.length, review: feedback.reviewFindings.length, policy: feedback.policyFindings.length } : null }, round);
        // Builder に渡したフィードバックを成果物として保存（指摘が渡ったことをログで確認できるようにする。v2.2）
        if (feedback) await this.deps.recorder.saveArtifact(runId, round, 'feedback.json', JSON.stringify(feedback, null, 2));
        const builderLog: string[] = [];
        const builder = await this.deps.builder.implement({
          runId,
          round,
          workspace,
          task,
          taskYaml: snapshot.taskYaml,
          feedback,
          timeoutMs: Math.min(task.limits.cliTimeoutSeconds * 1000, remainingMs()),
          signal,
          onLog: (c) => builderLog.push(c)
        });
        record.builder = builder;
        await this.deps.recorder.saveArtifact(runId, round, 'builder.log', builderLog.join(''));
        await this.deps.transport.pull(runId, workspace);
        await emit('workspace.synced', { direction: 'pull', after: 'builder' }, round);
        await emit('builder.finished', { round, exitCode: builder.exitCode, timedOut: builder.timedOut, isError: builder.isError, durationMs: builder.durationMs }, round);
        checkCancelled();
        if (builder.timedOut) {
          record.finishedAt = new Date(this.deps.now()).toISOString();
          await this.deps.recorder.saveRound(runId, record);
          return await finish('NEEDS_HUMAN', 'BUILDER_TIMEOUT', `round ${round}: Builder がタイムアウト`);
        }
        if (builder.exitCode !== 0 || builder.isError) {
          record.finishedAt = new Date(this.deps.now()).toISOString();
          await this.deps.recorder.saveRound(runId, record);
          return await finish('NEEDS_HUMAN', 'BUILDER_FAILED', `round ${round}: Builder 終了コード ${builder.exitCode ?? 'null'}${builder.isError ? '（is_error）' : ''}`);
        }

        // ---- diff & policy ----
        const diff = await this.deps.workspace.captureDiff(workspace);
        record.diff = diff.summary;
        await this.deps.recorder.saveArtifact(runId, round, 'diff.patch', diff.patch);
        await emit('diff.captured', { round, files: diff.summary.files.length, isEmpty: diff.summary.isEmpty, truncated: diff.summary.truncated }, round);
        if (diff.summary.isEmpty) {
          record.finishedAt = new Date(this.deps.now()).toISOString();
          await this.deps.recorder.saveRound(runId, record);
          return await finish('NEEDS_HUMAN', 'NO_CHANGES', `round ${round}: Builder が変更を生成しなかった`);
        }
        // スコープ判定（v0.2.0、D-39）: 承認した expectedChanges と差分を比較。重大な逸脱は Builder に 1 度返し、残れば人間の判断
        const scopeCheck = evaluateScope(diff.summary.files, task.expectedChanges, builder.resultExcerpt);
        record.scopeCheck = scopeCheck;
        await emit('scope.checked', { round, severity: scopeCheck.severity, unexpected: scopeCheck.unexpected.length, detail: scopeCheck.detail }, round);
        if (scopeCheck.severity === 'major') {
          record.finishedAt = new Date(this.deps.now()).toISOString();
          await this.deps.recorder.saveRound(runId, record);
          if (round >= maxRounds) {
            return await finish('NEEDS_HUMAN', 'SCOPE_DEVIATION', `round ${round}: ${scopeCheck.detail}`);
          }
          feedback = { previousRound: round, verificationFailures: [], reviewFindings: [], requirementsUnverified: [], reviewSummary: null, policyFindings: [], scopeDeviation: renderScopeFeedback(scopeCheck) };
          continue; // 検証・レビューは行わない（範囲内に収めてから）
        }
        // セキュリティ系（worktree 外・禁止パス）は即停止
        const violations: PolicyViolation[] = checkDiffPolicy({ files: diff.summary.files, patches: diff.patches });
        record.policyViolations = violations;
        await emit('policy.checked', { round, violations: violations.length, codes: violations.map((v) => v.code) }, round);
        if (violations.length > 0) {
          record.finishedAt = new Date(this.deps.now()).toISOString();
          await this.deps.recorder.saveRound(runId, record);
          return await finish('NEEDS_HUMAN', 'POLICY_VIOLATION', violations.map((v) => `${v.code} ${v.file}`).join('; '));
        }

        // Policy Gate（v2.1）: AI レビューと独立した静的チェック。未承認 blocking は Builder に返して修正させる（残試行があれば）
        const baseContents: Record<string, string | null> = {};
        const currentContents: Record<string, string | null> = {};
        for (const f of diff.summary.files) {
          baseContents[f.path] = f.status === 'added' || f.status === 'untracked' ? null : await this.deps.workspace.readBaseFile(workspace, f.path);
          currentContents[f.path] = f.status === 'deleted' ? null : this.deps.workspace.readWorkspaceFile(workspace, f.path);
        }
        const exceptions = parsePolicyExceptions(await this.deps.workspace.readBaseFile(workspace, '.agent-orchestrator/policy.json'));
        const gateResult = evaluatePolicyGate({ files: diff.summary.files, baseContents, currentContents, exceptions, requiredScripts: this.deps.verifier.expectedCommands(task.verificationProfile).filter((c) => c !== 'install') });
        record.policyFindings = gateResult.findings;
        await this.deps.recorder.saveArtifact(runId, round, 'policy.json', JSON.stringify(gateResult, null, 2));
        await emit('policy.gate', { round, findings: gateResult.findings.length, blocking: gateResult.blocking.length, approved: gateResult.findings.filter((x) => x.approved).length, rules: [...new Set(gateResult.blocking.map((x) => x.ruleId))] }, round);
        const unapprovedPolicyFindings: PolicyFinding[] = gateResult.blocking;
        if (!gateResult.passed) {
          record.finishedAt = new Date(this.deps.now()).toISOString();
          await this.deps.recorder.saveRound(runId, record);
          // v2.2: 明示的な POLICY_BLOCKED 状態を経て Builder に差し戻す（UI / ログで遷移を追える）
          await transition('POLICY_BLOCKED');
          if (round >= maxRounds) {
            return await finish('NEEDS_HUMAN', 'POLICY_VIOLATION', `round ${round}: Policy Gate の未承認違反 ${gateResult.blocking.length} 件（${[...new Set(gateResult.blocking.map((x) => x.ruleId))].join(', ')}）、修正上限に到達`);
          }
          feedback = { previousRound: round, verificationFailures: [], reviewFindings: [], requirementsUnverified: [], reviewSummary: null, policyFindings: renderPolicyFeedback(gateResult.blocking) };
          continue; // 検証・レビューは実行しない
        }

        // ---- VERIFYING ----
        checkCancelled();
        if (!withinTime()) return await finish('NEEDS_HUMAN', 'TIMEOUT', `maxDurationSeconds(${task.limits.maxDurationSeconds}) を超過`);
        await transition('VERIFYING');
        await emit('verify.started', { round, profile: task.verificationProfile }, round);
        const verifyLog: string[] = [];
        const verification = await this.deps.verifier.verify({
          runId,
          round,
          workspace,
          profile: task.verificationProfile,
          generatedArtifacts: task.generatedArtifacts ?? [],
          timeoutMs: Math.min(task.limits.verificationTimeoutSeconds * 1000, remainingMs()),
          signal,
          onLog: (c) => verifyLog.push(c)
        });
        // 決定的な構造検証（v0.2.0、D-40）: 変更された JSON / YAML / Markdown をホスト側で機械的に確認し、検証結果に加える
        {
          const t0 = this.deps.now();
          const wsHandle = workspace;
          const issues = verification.commands.every((c) => c.exitCode === 0 && !c.timedOut) && verification.missing.length === 0 ? checkStructure(diff.summary.files, (p: string) => this.deps.workspace.readWorkspaceFile(wsHandle, p)) : [];
          const structure = structureCommandResult(issues, Math.max(0, this.deps.now() - t0));
          if (verification.commands.every((c) => c.exitCode === 0 && !c.timedOut) && verification.missing.length === 0) {
            verification.commands.push(structure);
            if (structure.exitCode !== 0) verification.passed = false;
          }
        }
        record.verification = verification;
        await this.deps.recorder.saveArtifact(runId, round, 'verify.json', JSON.stringify(verification, null, 2));
        await this.deps.recorder.saveArtifact(runId, round, 'verify.log', verifyLog.join(''));
        for (const c of verification.commands) await emit('verify.command', { round, name: c.name, exitCode: c.exitCode, timedOut: c.timedOut, durationMs: c.durationMs }, round);
        await emit('verify.finished', { round, passed: verification.passed, missing: verification.missing }, round);
        checkCancelled();
        if (!verification.passed) {
          record.finishedAt = new Date(this.deps.now()).toISOString();
          await this.deps.recorder.saveRound(runId, record);
          if (round >= maxRounds) {
            return await finish('NEEDS_HUMAN', 'MAX_ROUNDS', `round ${round}: 検証失敗、修正上限に到達`);
          }
          feedback = {
            previousRound: round,
            verificationFailures: verification.commands
              .filter((c) => c.exitCode !== 0 || c.timedOut)
              .map((c) => `${c.name}: exit=${c.exitCode ?? 'null'}${c.timedOut ? ' (timeout)' : ''}\n${c.stderrExcerpt || c.stdoutExcerpt}`),
            reviewFindings: [],
            requirementsUnverified: [],
            reviewSummary: null,
            policyFindings: []
          };
          continue; // レビューは実行しない
        }

        // ---- REVIEWING ----
        if (!withinTime()) return await finish('NEEDS_HUMAN', 'TIMEOUT', `maxDurationSeconds(${task.limits.maxDurationSeconds}) を超過`);
        await transition('REVIEWING');
        // 検証（install / test）はワークスペースにファイルを書き得る（node_modules 以外にもテスト結果等）。レビュー前のハッシュは
        // 検証後の状態から取るため、ここで再同期する（ドッグフーディングで検証成果物による偽の「レビュー中の変更」を実測。D-27）
        await this.deps.transport.pull(runId, workspace);
        await emit('workspace.synced', { direction: 'pull', after: 'verification' }, round);
        record.workspaceHashBeforeReview = await this.deps.workspace.hash(workspace);
        await emit('review.started', { round, workspaceHash: record.workspaceHashBeforeReview }, round);
        const reviewLog: string[] = [];
        const review = await this.deps.reviewer.review({
          scopeCheck: record.scopeCheck,
          runId,
          round,
          workspace,
          task,
          taskYaml: snapshot.taskYaml,
          diff,
          verification,
          timeoutMs: Math.min(task.limits.cliTimeoutSeconds * 1000, remainingMs()),
          signal,
          onLog: (c) => reviewLog.push(c)
        });
        record.review = review;
        await this.deps.transport.pull(runId, workspace);
        record.workspaceHashAfterReview = await this.deps.workspace.hash(workspace);
        await this.deps.recorder.saveArtifact(runId, round, 'review.json', JSON.stringify(review.parsed ?? { invalid: true, parseError: review.parseError }, null, 2));
        await this.deps.recorder.saveArtifact(runId, round, 'review.raw.txt', review.rawExcerpt);
        await this.deps.recorder.saveArtifact(runId, round, 'review.log', reviewLog.join(''));
        await emit(
          'review.finished',
          {
            round,
            verdict: review.parsed?.verdict ?? null,
            findings: review.parsed?.findings.length ?? 0,
            parseError: review.parseError,
            timedOut: review.timedOut,
            workspaceHashMatch: record.workspaceHashBeforeReview === record.workspaceHashAfterReview
          },
          round
        );
        checkCancelled();
        record.finishedAt = new Date(this.deps.now()).toISOString();
        await this.deps.recorder.saveRound(runId, record);

        if (record.workspaceHashBeforeReview !== record.workspaceHashAfterReview) {
          return await finish('NEEDS_HUMAN', 'WORKSPACE_MODIFIED_DURING_REVIEW', `round ${round}: レビュー前後でワークスペースハッシュが不一致`);
        }
        if (review.timedOut) {
          return await finish('NEEDS_HUMAN', 'REVIEW_UNKNOWN', `round ${round}: Reviewer がタイムアウト`);
        }
        if (!review.parsed) {
          return await finish('NEEDS_HUMAN', 'REVIEW_INVALID_JSON', `round ${round}: ${review.parseError ?? 'レビュー JSON 不正'}`);
        }
        const blockingSeverities = task.review.blockingSeverities;
        const blocking = review.parsed.findings.filter((f) => blockingSeverities.includes(f.severity));
        status = { ...status, openBlockingFindings: blocking.length };

        if (review.parsed.verdict === 'unknown') {
          return await finish('NEEDS_HUMAN', 'REVIEW_UNKNOWN', `round ${round}: Reviewer verdict=unknown`);
        }
        if (review.parsed.verdict === 'approved') {
          const persisted = await this.deps.recorder.persistedEventCount(runId);
          const gate: GateResult = evaluateCompletionGate({
            taskApproved: snapshot.approved,
            verification,
            expectedVerificationCommands: [...this.deps.verifier.expectedCommands(task.verificationProfile), ...generatedCommandNames(task.generatedArtifacts), 'structure'],
            diff: diff.summary,
            review,
            blockingSeverities,
            workspaceHashBeforeReview: record.workspaceHashBeforeReview,
            workspaceHashAfterReview: record.workspaceHashAfterReview,
            withinTimeLimit: withinTime(),
            policyViolations: violations,
            unapprovedPolicyFindings,
            scopeCheck: record.scopeCheck,
            allEventsPersisted: persisted >= lastSequence
          });
          await emit('gate.evaluated', { round, passed: gate.passed, failures: gate.failures }, round);
          if (gate.passed) {
            return await finish('COMPLETED', 'COMPLETED', `round ${round}: すべての完了ゲートを通過`);
          }
          const inconsistent = gate.failures.some((f) => f.code === 'REVIEW_INCONSISTENT' || f.code === 'BLOCKING_FINDINGS' || f.code === 'REQUIREMENTS_UNVERIFIED');
          return await finish('NEEDS_HUMAN', inconsistent ? 'REVIEW_INCONSISTENT' : 'GATE_FAILED', gate.failures.map((f) => `G${f.gate} ${f.code}: ${f.detail}`).join('; '));
        }
        // changes_requested
        if (round >= maxRounds) {
          return await finish('NEEDS_HUMAN', 'MAX_ROUNDS', `round ${round}: レビュー changes_requested、修正上限に到達`);
        }
        feedback = {
          previousRound: round,
          verificationFailures: [],
          reviewFindings: review.parsed.findings,
          requirementsUnverified: review.parsed.requirementsUnverified,
          reviewSummary: review.parsed.summary,
          policyFindings: []
        };
      }
      // ループを抜けるのは maxRounds=0 のような異常時のみ
      return await finish('NEEDS_HUMAN', 'MAX_ROUNDS', '修正上限に到達');
    } catch (err) {
      if (err instanceof RunCancelledError || signal.aborted) {
        try {
          return await finish('INTERRUPTED', 'CANCELLED', 'ユーザーによるキャンセル');
        } catch {
          return { ...status, state: 'INTERRUPTED', reasonCode: 'CANCELLED', reasonDetail: 'ユーザーによるキャンセル', nextActions: NEXT_ACTIONS.CANCELLED };
        }
      }
      const message = err instanceof Error ? `${err.name}: ${err.message}` : String(err);
      try {
        return await finish('INTERNAL_ERROR', 'INTERNAL_ERROR', message);
      } catch {
        return { ...status, state: 'INTERNAL_ERROR', reasonCode: 'INTERNAL_ERROR', reasonDetail: message, nextActions: NEXT_ACTIONS.INTERNAL_ERROR };
      }
    } finally {
      if (!isTerminalRunState(status.state)) {
        // ここに来るのは finish が例外を投げたときだけ。状態は呼び出し側が INTERNAL_ERROR として扱う
      }
    }
  }
}
