import { readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { ulid } from 'ulid';
import { resolveTask, type RunEvent, type RunReportResult, type RunStatus, type RunStatusResult } from '@agent-orchestrator/contracts';
import { nowIso } from './config.js';
import { NEXT_ACTIONS, RunEngine, type ApprovedTaskSnapshot, type EngineDeps } from './engine.js';
import { excerpt, maskSecrets } from './masking.js';
import type { SandboxExecutor } from './isolation/types.js';
import { renderReport } from './report.js';
import { parseAndValidateTaskYaml } from './requirements/task-generator.js';
import type { FileAndDbRecorder } from './storage/recorder.js';
import type { Repository } from './storage/repository.js';

/**
 * Run のライフサイクル管理（IPC の run.* の実装）。
 * - 同時実行 1 件（EX-13）。進行中があれば起動を拒否
 * - 承認済み task（approved_tasks）以外は実行しない
 * - 起動時復旧: 実行中のまま残っている Run を INTERRUPTED として提示する（AUD-03）。自動再開はしない
 */
export class RunServiceError extends Error {
  constructor(
    readonly code: 'NOT_FOUND' | 'RUN_IN_PROGRESS' | 'TASK_NOT_APPROVED' | 'VALIDATION_FAILED' | 'INVALID_STATE',
    message: string
  ) {
    super(message);
    this.name = 'RunServiceError';
  }
}

export interface RunServiceDeps {
  repo: Repository;
  recorder: FileAndDbRecorder;
  runsDir: string;
  engineDeps: Omit<EngineDeps, 'recorder' | 'hasActiveRun' | 'now'>;
  sandbox: SandboxExecutor;
  onRunUpdated?: (status: RunStatus) => void;
  onRunEvent?: (event: RunEvent) => void;
}

interface ActiveRun {
  runId: string;
  controller: AbortController;
  promise: Promise<RunStatus>;
}

export class RunService {
  private active: ActiveRun | null = null;

  constructor(private readonly deps: RunServiceDeps) {
    deps.recorder.onEvent((e) => deps.onRunEvent?.(e));
  }

  /** 起動時復旧（AUD-03）。 */
  recoverInterruptedRuns(): RunStatus[] {
    const recovered: RunStatus[] = [];
    for (const run of this.deps.repo.listActiveRuns()) {
      const status: RunStatus = { ...run, state: 'INTERRUPTED', reasonCode: 'RECOVERED_AFTER_RESTART', reasonDetail: 'アプリ再起動時に実行中だったため中断扱いにしました', finishedAt: nowIso(), nextActions: NEXT_ACTIONS.RECOVERED_AFTER_RESTART };
      this.deps.repo.updateRun(status);
      try {
        const ev = this.deps.repo.appendEvent({ runId: run.runId, type: 'run.recovered', round: null, payload: { from: run.state, to: 'INTERRUPTED' } });
        status.lastSequence = ev.sequence;
        this.deps.repo.updateRun(status);
      } catch {
        /* events テーブルへの追記失敗は復旧を妨げない */
      }
      recovered.push(status);
    }
    return recovered;
  }

  hasActiveRun(exceptRunId?: string): boolean {
    return this.active !== null && this.active.runId !== exceptRunId;
  }

  async start(approvedTaskId: string): Promise<RunStatus> {
    if (this.active) throw new RunServiceError('RUN_IN_PROGRESS', `別の Run（${this.active.runId}）が進行中です。完了またはキャンセル後に開始してください`);
    const approved = this.deps.repo.getApprovedTask(approvedTaskId);
    if (!approved) throw new RunServiceError('TASK_NOT_APPROVED', `承認済みタスクが見つかりません: ${approvedTaskId}`);
    const parsed = parseAndValidateTaskYaml(approved.taskYaml);
    if (!parsed.ok) throw new RunServiceError('VALIDATION_FAILED', `承認済み task.yaml が契約に適合しません: ${parsed.errors.join('; ')}`);
    const snapshot: ApprovedTaskSnapshot = { approvedTaskId: approved.id, task: resolveTask(parsed.task), approved: true, approvedAt: approved.approvedAt, taskYaml: approved.taskYaml };
    const runId = ulid();
    const controller = new AbortController();
    const engine = new RunEngine({
      ...this.deps.engineDeps,
      preflight: (input) => this.deps.engineDeps.preflight({ ...input, runId } as Parameters<EngineDeps['preflight']>[0]),
      recorder: this.deps.recorder,
      hasActiveRun: (except) => this.hasActiveRun(except),
      now: () => Date.now()
    });
    const runDir = join(this.deps.runsDir, runId);
    const promise = engine
      .run({ runId, snapshot, runDir, signal: controller.signal })
      .then(async (status) => {
        await this.writeReport(status);
        return status;
      })
      .finally(async () => {
        await this.deps.sandbox.cleanup(runId).catch(() => undefined);
        if (this.active?.runId === runId) this.active = null;
      });
    this.active = { runId, controller, promise };
    // 作成直後の状態を返す（CREATED が永続化されるまで少し待つ）
    const deadline = Date.now() + 5000;
    while (Date.now() < deadline && !this.deps.repo.getRun(runId)) await new Promise((r) => setTimeout(r, 20));
    void promise.then((s) => this.deps.onRunUpdated?.(s));
    const status = this.deps.repo.getRun(runId);
    if (!status) throw new RunServiceError('INVALID_STATE', 'Run の初期化に失敗しました');
    return status;
  }

  async cancel(runId: string): Promise<RunStatus> {
    const run = this.deps.repo.getRun(runId);
    if (!run) throw new RunServiceError('NOT_FOUND', `Run が見つかりません: ${runId}`);
    if (!this.active || this.active.runId !== runId) {
      throw new RunServiceError('INVALID_STATE', `Run ${runId} は進行中ではありません（${run.state}）`);
    }
    this.active.controller.abort();
    const status = await this.active.promise;
    return status;
  }

  /** 進行中 Run の完了を待つ（テスト・終了処理用）。 */
  async waitForActive(): Promise<RunStatus | null> {
    return this.active ? this.active.promise : null;
  }

  status(runId: string, sinceSequence = 0): RunStatusResult {
    const run = this.deps.repo.getRun(runId);
    if (!run) throw new RunServiceError('NOT_FOUND', `Run が見つかりません: ${runId}`);
    return { run, events: this.deps.repo.listEvents(runId, sinceSequence) };
  }

  list(limit = 50): RunStatus[] {
    return this.deps.repo.listRuns(limit);
  }

  report(runId: string): RunReportResult {
    const run = this.deps.repo.getRun(runId);
    if (!run) throw new RunServiceError('NOT_FOUND', `Run が見つかりません: ${runId}`);
    const rounds = this.deps.repo.listRounds(runId);
    const last = rounds[rounds.length - 1];
    const reportPath = join(run.runDir, 'report.md');
    let reportMarkdown = '';
    if (existsSync(reportPath)) reportMarkdown = readFileSync(reportPath, 'utf8');
    else {
      const approved = this.deps.repo.getApprovedTask(run.approvedTaskId);
      const parsed = approved ? parseAndValidateTaskYaml(approved.taskYaml) : null;
      if (parsed?.ok) reportMarkdown = renderReport({ status: run, task: resolveTask(parsed.task), rounds });
    }
    let diff = '';
    if (last) {
      const diffPath = join(run.runDir, 'rounds', String(last.round), 'diff.patch');
      if (existsSync(diffPath)) diff = readFileSync(diffPath, 'utf8');
    }
    const diffExcerpt = excerpt(maskSecrets(diff), 200_000);
    const lastReview = [...rounds].reverse().find((r) => r.review?.parsed)?.review?.parsed ?? null;
    const blocking = new Set((this.deps.repo.getApprovedTask(run.approvedTaskId)?.task.review?.blockingSeverities ?? ['critical', 'high']) as string[]);
    const openFindings = run.state === 'COMPLETED' ? [] : (lastReview?.findings ?? []).filter((f) => blocking.has(f.severity) || lastReview?.verdict !== 'approved').map((f) => ({ id: f.id, severity: f.severity, file: f.file, line: f.line, description: f.description, recommendation: f.recommendation }));
    return {
      run,
      reportMarkdown,
      diffExcerpt,
      diffTruncated: diffExcerpt.length < diff.length,
      changedFiles: last?.diff?.files.map((f) => `${f.status} ${f.path}`) ?? [],
      openFindings,
      requirementsUnverified: lastReview?.requirementsUnverified ?? [],
      reportPath,
      worktreePath: run.worktreePath
    };
  }

  private async writeReport(status: RunStatus): Promise<void> {
    try {
      const approved = this.deps.repo.getApprovedTask(status.approvedTaskId);
      const parsed = approved ? parseAndValidateTaskYaml(approved.taskYaml) : null;
      if (!parsed?.ok) return;
      const rounds = this.deps.repo.listRounds(status.runId);
      const preflight = this.deps.repo
        .listEvents(status.runId)
        .filter((e) => e.type === 'preflight.check')
        .map((e) => ({ id: String(e.payload.id), status: String(e.payload.status), detail: String(e.payload.detail ?? ''), fix: (e.payload.fix as string | null) ?? null }));
      await this.deps.recorder.saveReport(status.runId, renderReport({ status, task: resolveTask(parsed.task), rounds, preflight }));
    } catch {
      /* レポート生成失敗は Run 結果を変えない */
    }
  }
}
