import type { AcceptanceCriterion, DraftView, IpcEvent, RunEvent, RunStatus } from '@agent-orchestrator/contracts';
import { getTransport, toIpcCallError, type IpcParams } from '../api';
import { isTerminalRunState, runStateLabel } from '../labels';
import { app } from './app.svelte';

/** Wraps a transport call with busy/error bookkeeping. Returns null on failure. */
async function guarded<T>(label: string, fn: () => Promise<T>): Promise<T | null> {
  app.busy = label;
  app.error = null;
  try {
    return await fn();
  } catch (e) {
    const err = toIpcCallError(e);
    app.setError({ code: err.code, message: err.message });
    return null;
  } finally {
    app.busy = null;
  }
}

export async function initApp(): Promise<void> {
  const transport = getTransport();
  app.transportKind = transport.kind;
  transport.onEvent(handleRunnerEvent);
  try {
    const state = await transport.runnerState();
    app.runnerAlive = state.alive;
  } catch {
    app.runnerAlive = false;
  }
  await Promise.all([checkEnvironment(), loadHistory()]);
}

export async function checkEnvironment(): Promise<void> {
  const transport = getTransport();
  app.environmentError = null;
  try {
    app.environment = await transport.call('environment.check', {});
    app.runnerAlive = true;
    app.announce(app.environment.canRun ? '環境チェックが完了しました。実行可能です' : '環境チェックで問題が見つかりました。セットアップが必要です');
  } catch (e) {
    const err = toIpcCallError(e);
    app.environment = null;
    app.environmentError = { code: err.code, message: err.message };
    if (err.code === 'RUNNER_UNAVAILABLE' || err.code === 'RUNNER_TIMEOUT') app.runnerAlive = false;
  }
}

export async function pickFolder(): Promise<void> {
  const transport = getTransport();
  const path = await guarded('フォルダー選択', () => transport.pickProjectFolder());
  if (path) {
    app.projectPath = path;
    await inspectProject(path);
  }
}

export async function inspectProject(path: string): Promise<void> {
  const transport = getTransport();
  const trimmed = path.trim();
  app.project = null;
  app.projectError = null;
  if (!trimmed) {
    app.projectError = { code: 'INVALID_PARAMS', message: 'フォルダーのパスを入力してください' };
    return;
  }
  app.busy = 'プロジェクト調査';
  try {
    app.project = await transport.call('project.inspect', { path: trimmed });
    app.announce(app.project.status === 'ok' ? 'プロジェクトを確認しました。利用可能です' : 'プロジェクトに問題があります。原因と修正案を確認してください');
  } catch (e) {
    const err = toIpcCallError(e);
    app.projectError = { code: err.code, message: err.message };
    app.announce(`プロジェクト調査に失敗しました: ${err.message}`);
  } finally {
    app.busy = null;
  }
}

export async function createDraft(): Promise<void> {
  if (!app.canStart || !app.project) return;
  const transport = getTransport();
  const draft = await guarded('draft 作成', () => transport.call('draft.create', { projectPath: app.project!.path, request: app.request.trim() }));
  if (draft) {
    app.draft = draft;
    app.approval = null;
    app.navigate('interview');
    app.announce(`ヒアリングを開始しました。ラウンド ${draft.round}、質問 ${draft.currentQuestions.length} 件`);
  }
}

export async function answerRound(answers: NonNullable<IpcParams['draft.answer']['answers']>): Promise<void> {
  if (!app.draft) return;
  const transport = getTransport();
  const draft = await guarded('回答送信', () => transport.call('draft.answer', { draftId: app.draft!.id, answers }));
  if (draft) applyDraft(draft, '回答を送信しました');
}

export async function goBack(): Promise<void> {
  if (!app.draft) return;
  const transport = getTransport();
  const draft = await guarded('戻る', () => transport.call('draft.answer', { draftId: app.draft!.id, back: true }));
  if (draft) applyDraft(draft, `ラウンド ${draft.round} に戻りました`);
}

export async function reviseDraft(edits: {
  title?: string;
  requirements?: string[];
  outOfScope?: string[];
  acceptanceCriteria?: AcceptanceCriterion[];
  approach?: string;
}): Promise<boolean> {
  if (!app.draft) return false;
  const transport = getTransport();
  const draft = await guarded('要件修正', () => transport.call('draft.revise', { draftId: app.draft!.id, edits }));
  if (draft) applyDraft(draft, `要件を修正しました。リビジョン ${draft.revision} を作成し、承認をリセットしました`);
  return draft !== null;
}

function applyDraft(draft: DraftView, message: string): void {
  app.draft = draft;
  app.approval = null;
  const detail =
    draft.state === 'BLOCKED'
      ? 'ブロックされています。理由を確認してください'
      : draft.state === 'ASKING'
        ? `ラウンド ${draft.round}、質問 ${draft.currentQuestions.length} 件`
        : draft.proposal
          ? '要件サマリーを確認して承認できます'
          : '';
  app.announce(`${message}。${detail}`);
}

/** Approve the draft (fixes task.yaml) and immediately start the run. */
export async function approveAndStart(): Promise<void> {
  const draft = app.draft;
  if (!draft) return;
  const transport = getTransport();
  const approval = await guarded('承認', () =>
    transport.call('draft.approve', { draftId: draft.id, revision: draft.revision, acknowledgeDataSharing: true })
  );
  if (!approval) return;
  app.approval = approval;
  app.draft = approval.draft;
  app.announce('要件を承認し task.yaml を固定しました。実行を開始します');
  const run = await guarded('Run 開始', () => transport.call('run.start', { approvedTaskId: approval.approvedTaskId }));
  if (!run) return;
  app.resetRun();
  app.run = run;
  app.upsertHistory(run);
  app.navigate('running');
}

export async function cancelRun(): Promise<void> {
  if (!app.run) return;
  const transport = getTransport();
  const run = await guarded('キャンセル', () => transport.call('run.cancel', { runId: app.run!.runId }));
  if (run) applyRunStatus(run);
}

/** Reconnect: fetch status and any events after the last known sequence. */
export async function refreshRunStatus(): Promise<void> {
  if (!app.run) return;
  const transport = getTransport();
  try {
    const result = await transport.call('run.status', { runId: app.run.runId, sinceSequence: app.lastSequence });
    app.mergeEvents(result.events);
    applyRunStatus(result.run, { silent: true });
  } catch (e) {
    const err = toIpcCallError(e);
    app.setError({ code: err.code, message: err.message });
  }
}

export async function loadHistory(): Promise<void> {
  const transport = getTransport();
  try {
    const { runs } = await transport.call('run.list', { limit: 20 });
    app.history = runs;
  } catch (e) {
    const err = toIpcCallError(e);
    app.setError({ code: err.code, message: err.message });
  }
}

export async function openRunReport(runId: string): Promise<void> {
  const transport = getTransport();
  const report = await guarded('レポート取得', () => transport.call('run.report', { runId }));
  if (report) {
    app.report = report;
    app.reportRunId = runId;
    app.upsertHistory(report.run);
    if (app.run?.runId === runId) app.run = report.run;
  }
}

export async function showResult(runId: string): Promise<void> {
  app.navigate('result');
  await openRunReport(runId);
}

export async function resumeRun(run: RunStatus): Promise<void> {
  app.resetRun();
  app.run = run;
  app.navigate('running');
  await refreshRunStatus();
}

function applyRunStatus(run: RunStatus, opts: { silent?: boolean } = {}): void {
  const previous = app.run;
  app.run = run;
  app.upsertHistory(run);
  if (!opts.silent && previous?.state !== run.state) {
    app.announce(`実行状態が ${runStateLabel(run.state)} (${run.state}) に変わりました`);
  }
  // Navigate to the result only on an actual transition into a terminal state (not when
  // re-opening the running screen of an already finished run).
  const becameTerminal = isTerminalRunState(run.state) && (!previous || previous.runId !== run.runId || !isTerminalRunState(previous.state));
  if (becameTerminal && app.screen === 'running') {
    void showResult(run.runId);
    app.announce(`実行が終了しました: ${runStateLabel(run.state)} (${run.state})${run.reasonDetail ? `。${run.reasonDetail}` : ''}`);
  }
}

export function handleRunnerEvent(event: IpcEvent): void {
  switch (event.event) {
    case 'runner.ready':
      app.runnerAlive = true;
      return;
    case 'draft.updated': {
      const draft = event.payload as unknown as DraftView;
      if (app.draft && draft.id === app.draft.id && draft.updatedAt >= app.draft.updatedAt) app.draft = draft;
      return;
    }
    case 'run.event': {
      const runEvent = event.payload as unknown as RunEvent;
      if (app.run && runEvent.runId === app.run.runId) app.mergeEvents([runEvent]);
      return;
    }
    case 'run.updated': {
      const run = event.payload as unknown as RunStatus;
      if (app.run && run.runId === app.run.runId) applyRunStatus(run);
      else app.upsertHistory(run);
      return;
    }
    default:
      return;
  }
}
