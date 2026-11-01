import type { Answer, DraftView, IpcEvent, RunEvent, RunReportResult, RunStatus, TaskProposal } from '@agent-orchestrator/contracts';
import {
  CHANGED_FILES,
  DIFF_EXCERPT,
  FACTS,
  QUESTION_ROUNDS,
  buildProposal,
  environmentReport,
  inspectProject,
  reportMarkdown,
  seedHistory,
  summarize,
  toTaskYaml
} from './mock-data';
import { IpcCallError, type IpcMethod, type IpcParams, type IpcResults, type RunnerState, type Transport } from './transport';

/**
 * In-browser simulation of the runner used for `vite dev` without Tauri and for Playwright.
 *
 * Query parameters:
 * - `env=fail`        environment.check reports Docker as failing (canRun=false)
 * - `mockDelay=<ms>`  delay between run state transitions (default 700)
 * - `mockLatency=<ms>` simulated IPC latency per call (default 60)
 */
export class MockTransport implements Transport {
  readonly kind = 'mock' as const;
  readonly hasFolderPicker = false;

  private readonly envFail: boolean;
  private readonly stepDelay: number;
  private readonly latency: number;
  private readonly listeners = new Set<(e: IpcEvent) => void>();
  private readonly drafts = new Map<string, DraftView>();
  private readonly runs = new Map<string, { run: RunStatus; events: RunEvent[]; report: RunReportResult | null; timer: ReturnType<typeof setTimeout> | null }>();
  private readonly approvedTasks = new Map<string, { draftId: string; proposal: TaskProposal; taskId: string; repository: string; baseRef: string }>();
  private seq = 0;

  constructor(query: URLSearchParams = new URLSearchParams()) {
    this.envFail = query.get('env') === 'fail';
    this.stepDelay = Number(query.get('mockDelay') ?? 700);
    this.latency = Number(query.get('mockLatency') ?? 60);
    for (const { run, report } of seedHistory()) {
      this.runs.set(run.runId, { run, events: [], report, timer: null });
    }
    queueMicrotask(() => this.emit({ event: 'runner.ready', payload: { version: '0.1.0-mock', pid: 4242 } }));
  }

  onEvent(cb: (event: IpcEvent) => void): () => void {
    this.listeners.add(cb);
    return () => this.listeners.delete(cb);
  }

  async pickProjectFolder(): Promise<string | null> {
    return null;
  }

  async runnerState(): Promise<RunnerState> {
    return { alive: true, ready: true, pid: 4242, version: '0.1.0-mock', program: 'mock', restarts: 0 };
  }

  async call<M extends IpcMethod>(method: M, params: IpcParams[M]): Promise<IpcResults[M]> {
    await sleep(this.latency);
    const handler = this.handlers[method] as (p: IpcParams[M]) => IpcResults[M];
    return structuredClone(handler(params));
  }

  private emit(event: IpcEvent): void {
    for (const cb of this.listeners) {
      try {
        cb(structuredClone(event));
      } catch (e) {
        console.error('mock listener failed', e);
      }
    }
  }

  private fail(code: string, message: string): never {
    throw new IpcCallError({ code, message });
  }

  private readonly handlers: { [M in IpcMethod]: (params: IpcParams[M]) => IpcResults[M] } = {
    'environment.check': () => environmentReport(this.envFail),

    'project.inspect': ({ path }) => {
      if (!path || !path.trim()) this.fail('INVALID_PARAMS', 'path は空にできません');
      return inspectProject(path.trim());
    },

    'draft.create': ({ projectPath, request }) => {
      if (!request.trim()) this.fail('INVALID_PARAMS', '依頼内容を入力してください');
      const project = inspectProject(projectPath);
      if (project.status !== 'ok') this.fail('INVALID_STATE', 'プロジェクトが利用可能な状態ではありません');
      const now = new Date().toISOString();
      const id = `draft-${(++this.seq).toString().padStart(3, '0')}-${Math.random().toString(36).slice(2, 8)}`;
      const prohibited = /push|merge|deploy|デプロイ|マージ|プッシュ/i.test(request) ? ['push/merge/deploy は自動実行しません。手動で実施してください。'] : [];
      const draft: DraftView = {
        id,
        projectPath,
        request,
        state: 'ASKING',
        revision: 1,
        round: 1,
        totalQuestionsAsked: QUESTION_ROUNDS[0]!.length,
        facts: FACTS,
        currentQuestions: QUESTION_ROUNDS[0]!,
        askedQuestions: [...QUESTION_ROUNDS[0]!],
        answers: [],
        blockingQuestions: QUESTION_ROUNDS[0]!.filter((q) => q.decisionImpact === 'blocking').map((q) => q.id),
        summary: summarize(request, []),
        proposal: null,
        taskYaml: null,
        validationErrors: [],
        blockedReason: null,
        prohibitedOperations: prohibited,
        verificationReadiness: {
          profile: 'node-pnpm',
          ready: project.verificationProfile?.ready ?? false,
          missingScripts: project.verificationProfile?.missingScripts ?? [],
          detail: 'package.json に typecheck / lint / test:run が定義されています'
        },
        approved: false,
        approvedTaskId: null,
        createdAt: now,
        updatedAt: now
      };
      this.drafts.set(id, draft);
      return draft;
    },

    'draft.answer': ({ draftId, answers, back }) => {
      const draft = this.drafts.get(draftId) ?? this.fail('NOT_FOUND', `draft が見つかりません: ${draftId}`);
      if (draft.approved) this.fail('INVALID_STATE', '承認済みの draft は変更できません。修正する場合は新しいリビジョンを作成してください');
      const now = new Date().toISOString();
      const answeredRounds = draft.answers.length === 0 ? 0 : Math.max(...draft.answers.map((a) => a.round));

      if (back) {
        if (answeredRounds === 0) this.fail('INVALID_STATE', '戻れるラウンドがありません');
        draft.answers = draft.answers.filter((a) => a.round !== answeredRounds);
        draft.round = answeredRounds;
        draft.currentQuestions = QUESTION_ROUNDS[answeredRounds - 1] ?? [];
        draft.askedQuestions = QUESTION_ROUNDS.slice(0, answeredRounds).flat();
        draft.totalQuestionsAsked = draft.askedQuestions.length;
        draft.state = 'ASKING';
        draft.proposal = null;
        draft.taskYaml = null;
        draft.blockedReason = null;
      } else {
        if (draft.state !== 'ASKING') this.fail('INVALID_STATE', '現在は質問待ちの状態ではありません');
        const current = draft.currentQuestions;
        const incoming = answers ?? [];
        const unknown = incoming.find((a) => !current.some((q) => q.id === a.questionId));
        if (unknown) this.fail('INVALID_PARAMS', `現在のラウンドにない質問です: ${unknown.questionId}`);
        const roundNo = draft.round;
        const recorded: Answer[] = current.map((q) => {
          const a = incoming.find((x) => x.questionId === q.id);
          const value = a && !a.skipped && a.value !== null && a.value.trim() !== '' ? a.value.trim() : null;
          return { questionId: q.id, round: roundNo, value, skipped: value === null, answeredAt: now };
        });
        draft.answers = [...draft.answers.filter((a) => a.round !== roundNo), ...recorded];
        const nextRound = QUESTION_ROUNDS[roundNo];
        if (nextRound) {
          draft.round = roundNo + 1;
          draft.currentQuestions = nextRound;
          draft.askedQuestions = QUESTION_ROUNDS.slice(0, roundNo + 1).flat();
          draft.totalQuestionsAsked = draft.askedQuestions.length;
          draft.state = 'ASKING';
        } else {
          draft.currentQuestions = [];
          const unanswered = blockingUnanswered(draft);
          if (unanswered.length > 0) {
            draft.state = 'BLOCKED';
            draft.blockedReason = `必須（blocking）の質問が未回答のため、要件を確定できません: ${unanswered
              .map((id) => `${id}「${draft.askedQuestions.find((q) => q.id === id)?.question ?? ''}」`)
              .join('、')}。「戻る」で該当ラウンドに戻り回答してください。自動承認は行いません。`;
            draft.proposal = null;
          } else {
            draft.state = 'AWAITING_APPROVAL';
            draft.blockedReason = null;
            draft.proposal = buildProposal(draft.request, draft.answers);
          }
        }
      }
      draft.blockingQuestions = blockingUnanswered(draft);
      draft.summary = summarize(draft.request, draft.answers);
      draft.updatedAt = now;
      this.emit({ event: 'draft.updated', payload: structuredClone(draft) as unknown as Record<string, unknown> });
      return draft;
    },

    'draft.revise': ({ draftId, edits }) => {
      const draft = this.drafts.get(draftId) ?? this.fail('NOT_FOUND', `draft が見つかりません: ${draftId}`);
      if (!draft.proposal) this.fail('INVALID_STATE', '要件サマリーが生成される前は修正できません');
      const errors: string[] = [];
      if (edits.requirements && edits.requirements.length === 0) errors.push('requirements は 1 件以上必要です');
      if (edits.acceptanceCriteria && edits.acceptanceCriteria.length === 0) errors.push('acceptanceCriteria は 1 件以上必要です');
      if (errors.length) this.fail('VALIDATION_FAILED', errors.join(' / '));
      draft.proposal = {
        ...draft.proposal,
        ...(edits.title !== undefined ? { title: edits.title } : {}),
        ...(edits.requirements !== undefined ? { requirements: edits.requirements } : {}),
        ...(edits.outOfScope !== undefined ? { outOfScope: edits.outOfScope } : {}),
        ...(edits.acceptanceCriteria !== undefined ? { acceptanceCriteria: edits.acceptanceCriteria } : {}),
        ...(edits.approach !== undefined ? { approach: edits.approach } : {})
      };
      draft.revision += 1;
      draft.approved = false;
      draft.approvedTaskId = null;
      draft.taskYaml = null;
      draft.state = 'SUMMARY_READY';
      draft.updatedAt = new Date().toISOString();
      this.emit({ event: 'draft.updated', payload: structuredClone(draft) as unknown as Record<string, unknown> });
      return draft;
    },

    'draft.approve': ({ draftId, revision, acknowledgeDataSharing }) => {
      const draft = this.drafts.get(draftId) ?? this.fail('NOT_FOUND', `draft が見つかりません: ${draftId}`);
      if (acknowledgeDataSharing !== true) this.fail('INVALID_PARAMS', 'データ送信への同意が必要です');
      if (revision !== draft.revision) this.fail('INVALID_STATE', `リビジョンが一致しません（現在: ${draft.revision}）。内容を確認して再度承認してください`);
      if (draft.blockingQuestions.length > 0 || draft.state === 'BLOCKED') this.fail('DRAFT_BLOCKED', draft.blockedReason ?? '必須質問が未回答です');
      if (!draft.proposal) this.fail('INVALID_STATE', '要件サマリーがまだ生成されていません');
      if (!draft.verificationReadiness?.ready) this.fail('VALIDATION_FAILED', '検証プロファイルの準備ができていません');
      const taskId = `TASK-LOGIN-${String(this.drafts.size).padStart(3, '0')}`;
      const approvedTaskId = `APT-${Date.now().toString(36).toUpperCase()}`;
      const taskYaml = toTaskYaml(taskId, draft.projectPath, 'develop', draft.proposal);
      draft.approved = true;
      draft.approvedTaskId = approvedTaskId;
      draft.taskYaml = taskYaml;
      draft.state = 'READY_TO_RUN';
      draft.updatedAt = new Date().toISOString();
      this.approvedTasks.set(approvedTaskId, { draftId, proposal: draft.proposal, taskId, repository: draft.projectPath, baseRef: 'develop' });
      this.emit({ event: 'draft.updated', payload: structuredClone(draft) as unknown as Record<string, unknown> });
      return {
        draft,
        approvedTaskId,
        taskYaml,
        taskYamlPath: `C:\\Users\\dev\\AppData\\Local\\agent-orchestrator\\app-data\\tasks\\${taskId}\\revisions\\${draft.revision}\\task.yaml`
      };
    },

    'run.start': ({ approvedTaskId }) => {
      const task = this.approvedTasks.get(approvedTaskId) ?? this.fail('TASK_NOT_APPROVED', `承認済みタスクが見つかりません: ${approvedTaskId}`);
      for (const entry of this.runs.values()) {
        if (!isTerminal(entry.run.state)) this.fail('RUN_IN_PROGRESS', `別の Run (${entry.run.runId}) が進行中です`);
      }
      const runId = ulidLike();
      const now = new Date().toISOString();
      const run: RunStatus = {
        runId,
        approvedTaskId,
        taskId: task.taskId,
        taskTitle: task.proposal.title,
        repository: task.repository,
        baseRef: task.baseRef,
        baseSha: 'a1b2c3d4e5f60718293a4b5c6d7e8f9012345678',
        state: 'CREATED',
        reasonCode: null,
        reasonDetail: null,
        currentRound: 0,
        maxRounds: 3,
        worktreePath: null,
        runDir: `C:\\Users\\dev\\AppData\\Local\\agent-orchestrator\\app-data\\runs\\${runId}`,
        startedAt: now,
        finishedAt: null,
        lastSequence: 0,
        openBlockingFindings: 0,
        nextActions: []
      };
      const entry = { run, events: [] as RunEvent[], report: null as RunReportResult | null, timer: null as ReturnType<typeof setTimeout> | null };
      this.runs.set(runId, entry);
      this.scheduleRun(runId);
      return run;
    },

    'run.cancel': ({ runId }) => {
      const entry = this.runs.get(runId) ?? this.fail('NOT_FOUND', `run が見つかりません: ${runId}`);
      if (isTerminal(entry.run.state)) this.fail('INVALID_STATE', 'この Run は既に終了しています');
      if (entry.timer) clearTimeout(entry.timer);
      entry.timer = null;
      const from = entry.run.state;
      this.pushEvent(runId, 'run.cancel_requested', { from, stoppedProcesses: from === 'IMPLEMENTING' ? ['claude (pid 51234)'] : from === 'REVIEWING' ? ['codex (pid 51290)'] : [] });
      this.transition(runId, 'INTERRUPTED', {
        reasonCode: 'CANCELLED',
        reasonDetail: `ユーザーの操作により ${from} の途中でキャンセルされました。子プロセスは停止済みです。ワークツリーは保持されており、元のブランチには影響しません。`,
        finishedAt: new Date().toISOString(),
        nextActions: ['ワークツリーの変更を確認し、不要であれば削除してください', '同じ要件で再実行する場合は新しい依頼として開始してください']
      });
      return entry.run;
    },

    'run.status': ({ runId, sinceSequence }) => {
      const entry = this.runs.get(runId) ?? this.fail('NOT_FOUND', `run が見つかりません: ${runId}`);
      const since = sinceSequence ?? 0;
      return { run: entry.run, events: entry.events.filter((e) => e.sequence > since) };
    },

    'run.list': ({ limit }) => {
      const runs = [...this.runs.values()].map((e) => e.run).sort((a, b) => (a.startedAt < b.startedAt ? 1 : -1));
      return { runs: runs.slice(0, limit ?? 50) };
    },

    'run.report': ({ runId }) => {
      const entry = this.runs.get(runId) ?? this.fail('NOT_FOUND', `run が見つかりません: ${runId}`);
      if (entry.report) return { ...entry.report, run: entry.run };
      const run = entry.run;
      const done = run.state === 'COMPLETED';
      const partial = run.state === 'INTERRUPTED' || run.state === 'NEEDS_HUMAN';
      const verificationPassed = entry.events.some((e) => e.type === 'verification.completed' && e.payload['passed'] === true);
      const report: RunReportResult = {
        run,
        reportMarkdown: reportMarkdown(run, { verificationPassed, findingsCount: done ? 1 : 0, requirementsUnverified: [] }),
        diffExcerpt: done || partial ? DIFF_EXCERPT : '',
        diffTruncated: false,
        changedFiles: done ? CHANGED_FILES : partial ? CHANGED_FILES.slice(0, 2) : [],
        openFindings: done
          ? [
              {
                id: 'F-001',
                severity: 'low',
                file: 'src/routes/login/+page.svelte',
                line: 42,
                description: 'ロック中メッセージに残り時間が表示されない。',
                recommendation: 'lockedUntil から残り分数を計算して表示すると UX が向上します（任意）。'
              }
            ]
          : [],
        requirementsUnverified: [],
        reportPath: `${run.runDir}\\report.md`,
        worktreePath: run.worktreePath
      };
      if (isTerminal(run.state)) entry.report = report;
      return report;
    }
  };

  private pushEvent(runId: string, type: string, payload: Record<string, unknown>, round: number | null = null): void {
    const entry = this.runs.get(runId);
    if (!entry) return;
    const event: RunEvent = {
      runId,
      sequence: entry.run.lastSequence + 1,
      timestamp: new Date().toISOString(),
      type,
      round,
      payload
    };
    entry.events.push(event);
    entry.run.lastSequence = event.sequence;
    this.emit({ event: 'run.event', runId, payload: event as unknown as Record<string, unknown> });
  }

  private transition(runId: string, to: RunStatus['state'], patch: Partial<RunStatus> = {}): void {
    const entry = this.runs.get(runId);
    if (!entry) return;
    const from = entry.run.state;
    Object.assign(entry.run, patch);
    entry.run.state = to;
    this.pushEvent(runId, 'run.state_changed', { from, to }, entry.run.currentRound || null);
    this.emit({ event: 'run.updated', runId, payload: structuredClone(entry.run) as unknown as Record<string, unknown> });
  }

  private scheduleRun(runId: string): void {
    const steps: Array<() => void> = [
      () => {
        this.transition(runId, 'PREFLIGHT', { worktreePath: `C:\\Users\\dev\\.agent-orchestrator\\worktrees\\${runId}` });
        this.pushEvent(runId, 'preflight.completed', {
          checks: [
            { id: 'git_clean', ok: true, detail: 'develop @ a1b2c3d4 clean' },
            { id: 'docker_isolation', ok: true, detail: 'non-root, cap-drop ALL, no-new-privileges, pids=256' },
            { id: 'egress_policy', ok: true, detail: 'allowlist proxy' },
            { id: 'cli_versions', ok: true, detail: 'claude 2.1.0 / codex 0.48.0' },
            { id: 'verification_profile', ok: true, detail: 'node-pnpm: typecheck, lint, test:run' }
          ]
        });
      },
      () => {
        this.transition(runId, 'IMPLEMENTING', { currentRound: 1 });
        this.pushEvent(runId, 'builder.started', { cli: 'claude', version: '2.1.0', attempt: 1 }, 1);
      },
      () => {
        this.pushEvent(runId, 'builder.completed', { exitCode: 0, durationMs: 412_380, resultExcerpt: 'ログイン API とページ、hooks のガード、テストを追加しました。', costUsd: 0.84 }, 1);
        this.pushEvent(runId, 'diff.collected', { files: CHANGED_FILES.length, additions: 318, deletions: 4, untracked: 3, policyViolations: [] }, 1);
        this.transition(runId, 'VERIFYING');
      },
      () => {
        this.pushEvent(
          runId,
          'verification.completed',
          {
            profile: 'node-pnpm',
            passed: true,
            commands: [
              { name: 'typecheck', exitCode: 0, durationMs: 18_210 },
              { name: 'lint', exitCode: 0, durationMs: 9_904 },
              { name: 'test:run', exitCode: 0, durationMs: 41_570 }
            ],
            missing: []
          },
          1
        );
        this.transition(runId, 'REVIEWING');
        this.pushEvent(runId, 'reviewer.started', { cli: 'codex', version: '0.48.0', readOnly: true }, 1);
      },
      () => {
        this.pushEvent(
          runId,
          'review.completed',
          { verdict: 'approved', findingsCount: 1, blockingFindings: 0, requirementsUnverified: [], workspaceHashMatches: true, summary: '要件を満たしており、blocking な指摘はありません。' },
          1
        );
        this.transition(runId, 'COMPLETED', {
          reasonCode: 'COMPLETED',
          reasonDetail: '全ての完了ゲートを通過しました（検証 3/3 成功、レビュー approved、未解決 blocking 指摘 0）。',
          finishedAt: new Date().toISOString(),
          openBlockingFindings: 0,
          nextActions: ['ワークツリーの差分を確認し、問題なければ手動でコミット / push してください（自動反映は行いません）', 'low 指摘 F-001 は任意対応です']
        });
      }
    ];
    let index = 0;
    const next = () => {
      const entry = this.runs.get(runId);
      if (!entry || isTerminal(entry.run.state)) return;
      const step = steps[index++];
      if (!step) return;
      step();
      if (index < steps.length) entry.timer = setTimeout(next, this.stepDelay);
      else entry.timer = null;
    };
    const entry = this.runs.get(runId);
    if (entry) entry.timer = setTimeout(next, Math.min(this.stepDelay, 300));
  }
}

function blockingUnanswered(draft: DraftView): string[] {
  return draft.askedQuestions
    .filter((q) => q.decisionImpact === 'blocking')
    .filter((q) => {
      const a = draft.answers.find((x) => x.questionId === q.id);
      return !a || a.skipped || a.value === null;
    })
    .map((q) => q.id);
}

function isTerminal(state: RunStatus['state']): boolean {
  return state === 'COMPLETED' || state === 'NEEDS_HUMAN' || state === 'PRECHECK_FAILED' || state === 'INTERRUPTED' || state === 'INTERNAL_ERROR';
}

function ulidLike(): string {
  const chars = '0123456789ABCDEFGHJKMNPQRSTVWXYZ';
  let out = '01';
  for (let i = 0; i < 24; i++) out += chars[Math.floor(Math.random() * chars.length)];
  return out;
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}
