import type { Answer, DraftView, IpcEvent, RunEvent, RunReportResult, RunStatus, SandboxSetupState, TaskProposal } from '@agent-orchestrator/contracts';
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
 * - `mockRun=needs_human|precheck_failed|completed` which run scenario `run.start` plays (default completed)
 * - `mockFresh=1`   ignore runs persisted in sessionStorage (terminal runs are persisted so a reload keeps history)
 * - `env=noimages`   environment.check reports the sandbox images as missing until the GUI setup succeeds
 * - `setup=ok|fail|fail-once|slow|build-fail` how the simulated sandbox setup behaves (default ok)
 */
const SANDBOX_MANIFEST_MOCK: SandboxSetupState['manifest'] = {
  version: '0.1.0',
  baseImage: 'node:22.23.4-bookworm-slim',
  baseDigest: 'sha256:4b150b48b4116e2a22f2c39cc27025fbf4f153e2078fd3b14d159fdb5c7279da',
  images: [
    { id: 'proxy', tag: 'agent-orchestrator-egress-proxy:0.1.0', label: 'egress プロキシイメージ' },
    { id: 'sandbox', tag: 'agent-orchestrator-sandbox:0.1.0', label: 'サンドボックスイメージ' }
  ]
};
const SETUP_STEPS: Array<{ id: string; label: string }> = [
  { id: 'docker', label: 'Docker デーモンの確認' },
  { id: 'base.pull', label: 'ベースイメージの取得（Docker Hub、ピン留め）' },
  { id: 'base.verify', label: 'ベースイメージのダイジェスト検証' },
  { id: 'build.proxy', label: 'egress プロキシイメージのビルド' },
  { id: 'build.sandbox', label: 'サンドボックスイメージのビルド' },
  { id: 'verify', label: 'ビルド結果の整合性検証' }
];
const STORAGE_KEY = 'agent-orchestrator-mock-runs';
type RunScenario = 'completed' | 'needs_human' | 'precheck_failed';
export class MockTransport implements Transport {
  readonly kind = 'mock' as const;
  readonly hasFolderPicker = false;
  readonly canRevealWorktree = false;

  async revealWorktree(): Promise<void> {
    this.fail('ENVIRONMENT_UNAVAILABLE', 'ブラウザ開発モードではフォルダーを開けません');
  }

  private readonly envFail: boolean;
  private readonly stepDelay: number;
  private readonly latency: number;
  private readonly scenario: RunScenario;
  private readonly persist: boolean;
  private readonly noImages: boolean;
  private readonly setupMode: string;
  private setupDone = false;
  private setupAttempts = 0;
  private setupTimer: ReturnType<typeof setTimeout> | null = null;
  private setup: SandboxSetupState = idleSetup();
  private readonly listeners = new Set<(e: IpcEvent) => void>();
  private readonly drafts = new Map<string, DraftView>();
  private readonly runs = new Map<string, { run: RunStatus; events: RunEvent[]; report: RunReportResult | null; timer: ReturnType<typeof setTimeout> | null }>();
  private readonly approvedTasks = new Map<string, { draftId: string; proposal: TaskProposal; taskId: string; repository: string; baseRef: string }>();
  private seq = 0;

  constructor(query: URLSearchParams = new URLSearchParams()) {
    this.envFail = query.get('env') === 'fail';
    this.stepDelay = Number(query.get('mockDelay') ?? 700);
    this.latency = Number(query.get('mockLatency') ?? 60);
    const scenario = query.get('mockRun');
    this.scenario = scenario === 'needs_human' || scenario === 'precheck_failed' ? scenario : 'completed';
    this.persist = query.get('mockFresh') !== '1';
    this.noImages = query.get('env') === 'noimages';
    this.setupMode = query.get('setup') ?? 'ok';
    for (const { run, report } of seedHistory()) {
      this.runs.set(run.runId, { run, events: [], report, timer: null });
    }
    // 再起動（リロード）後も履歴が残ることを UI で検証できるよう、終了した Run は sessionStorage に保存する
    if (this.persist) {
      try {
        const raw = sessionStorage.getItem(STORAGE_KEY);
        const saved = raw ? (JSON.parse(raw) as Array<{ run: RunStatus; events: RunEvent[]; report: RunReportResult | null }>) : [];
        for (const e of saved) this.runs.set(e.run.runId, { run: e.run, events: e.events, report: e.report, timer: null });
      } catch {
        // storage unavailable → in-memory only
      }
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
    'environment.check': () => environmentReport(this.envFail, this.noImages && !this.setupDone),

    'sandbox.status': () => structuredClone(this.setup),

    'sandbox.setup': ({ acknowledgePull }) => {
      if (acknowledgePull !== true) this.fail('INVALID_PARAMS', 'ベースイメージの取得への同意（acknowledgePull）が必要です');
      if (this.setup.state === 'running') this.fail('INVALID_STATE', 'サンドボックスの準備は既に実行中です');
      this.setupAttempts += 1;
      this.setup = { ...idleSetup(), state: 'running', startedAt: new Date().toISOString() };
      this.emitSetup();
      const slow = this.setupMode === 'slow';
      const failAt = this.setupMode === 'fail' || (this.setupMode === 'fail-once' && this.setupAttempts === 1) ? 'verify' : this.setupMode === 'build-fail' ? 'build.sandbox' : null;
      let i = 0;
      const tick = () => {
        if (this.setup.state !== 'running') return;
        const step = SETUP_STEPS[i];
        if (!step) {
          this.setup = { ...this.setup, state: 'succeeded', finishedAt: new Date().toISOString() };
          this.setupDone = true;
          this.setupTimer = null;
          this.emitSetup();
          return;
        }
        this.setStep(step.id, 'running', step.id === 'base.pull' ? `${SANDBOX_MANIFEST_MOCK.baseImage}@${SANDBOX_MANIFEST_MOCK.baseDigest}` : '');
        this.setup.logTail = [...this.setup.logTail, `[mock] ${step.label} …`].slice(-40);
        this.emitSetup();
        this.setupTimer = setTimeout(() => {
          if (this.setup.state !== 'running') return;
          if (failAt === step.id) {
            const verifyFail = step.id === 'verify';
            this.setStep(step.id, 'fail', verifyFail ? 'agent-orchestrator-sandbox:0.1.0 の整合性検証に失敗しました（version=0.0.9）。イメージは削除しました' : 'npm ERR! network request to https://registry.npmjs.org/ failed');
            this.setup = {
              ...this.setup,
              state: 'failed',
              finishedAt: new Date().toISOString(),
              error: verifyFail
                ? { code: 'IMAGE_VERIFY_FAILED', message: 'agent-orchestrator-sandbox:0.1.0 の整合性検証に失敗しました（version=0.0.9）。イメージは削除しました', fix: '「再試行」で作り直してください。繰り返す場合は開発者に連絡してください' }
                : { code: 'BUILD_FAILED', message: 'agent-orchestrator-sandbox:0.1.0 のビルドが失敗しました: npm ERR! network request to https://registry.npmjs.org/ failed', fix: 'ネットワーク（npm レジストリへの到達）とディスク空き容量を確認し、「再試行」を押してください。繰り返す場合はログを添えて開発者に連絡してください' }
            };
            this.setupTimer = null;
            this.emitSetup();
            return;
          }
          this.setStep(step.id, 'ok', step.id === 'verify' ? 'version 0.1.0 / base sha256:4b150b48b4116e2' : '');
          i += 1;
          tick();
        }, slow ? 1500 : Math.max(60, Math.floor(this.stepDelay / 4)));
      };
      tick();
      return structuredClone(this.setup);
    },

    'sandbox.cancel': () => {
      if (this.setup.state !== 'running') this.fail('INVALID_STATE', '実行中のサンドボックス準備はありません');
      if (this.setupTimer) clearTimeout(this.setupTimer);
      this.setupTimer = null;
      this.setup = { ...this.setup, state: 'cancelled', finishedAt: new Date().toISOString(), steps: this.setup.steps.map((s) => (s.status === 'running' ? { ...s, status: 'skipped', detail: 'キャンセル' } : s)) };
      this.emitSetup();
      return structuredClone(this.setup);
    },

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
        contradictions: [],
        decisions: [],
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
        // v2.2: 取り消した回答の判断は retracted として履歴に残す
        const retractedIds = new Set(draft.answers.filter((a) => a.round === answeredRounds).map((a) => a.questionId));
        draft.decisions = draft.decisions.map((d) => (retractedIds.has(d.topicKey) && d.status === 'active' ? { ...d, status: 'retracted' as const } : d));
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
        // v2.2 意思決定ログ（共通モデル）: 回答を interview 判断として記録。同じ質問の再回答は履歴に積む
        for (const r of recorded) {
          if (r.value === null) continue;
          const q = current.find((x) => x.id === r.questionId)!;
          const opt = q.options.find((o) => o.value === r.value);
          const prev = draft.decisions.find((d) => d.topicKey === q.id);
          const next = {
            topicKey: q.id,
            contradictionId: q.id,
            source: 'interview' as const,
            kind: 'other' as const,
            question: q.question,
            options: q.options.map((o) => ({ value: o.value, label: o.label })),
            chosen: r.value,
            chosenLabel: opt?.label ?? r.value,
            rationale: opt ? `ユーザーが選択肢を選択（推奨: ${q.recommendation}）` : `ユーザーの自由入力（推奨: ${q.recommendation}）`,
            consequence: opt ? `${opt.label} を前提に要件を確定する` : '自由入力の内容を前提に要件を確定する',
            evidence: [],
            relatedRequirements: [],
            decidedAt: now,
            history: prev ? [...prev.history, { chosen: prev.chosen, chosenLabel: prev.chosenLabel, decidedAt: prev.decidedAt, retracted: prev.status === 'retracted', note: prev.status === 'retracted' ? '「戻る」で取り消された判断' : '再回答で置き換えられた判断' }] : [],
            supersededBy: null,
            status: 'active' as const
          };
          draft.decisions = prev ? draft.decisions.map((d) => (d.topicKey === q.id ? next : d)) : [...draft.decisions, next];
        }
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
      const needsHuman = run.state === 'NEEDS_HUMAN';
      const lastReview = [...entry.events].reverse().find((e) => e.type === 'review.completed');
      const unverified = needsHuman && Array.isArray(lastReview?.payload['requirementsUnverified']) ? (lastReview!.payload['requirementsUnverified'] as string[]) : [];
      const verificationPassed = entry.events.some((e) => e.type === 'verification.completed' && e.payload['passed'] === true);
      const report: RunReportResult = {
        run,
        reportMarkdown: reportMarkdown(run, { verificationPassed, findingsCount: done ? 1 : needsHuman ? 2 : 0, requirementsUnverified: unverified }),
        diffExcerpt: done || partial ? DIFF_EXCERPT : '',
        diffTruncated: false,
        changedFiles: done ? CHANGED_FILES : partial ? CHANGED_FILES.slice(0, 2) : [],
        egress: done || partial
          ? { available: true, allowed: 14, denied: 2, errors: 0, allowedHosts: ['api.anthropic.com', 'chatgpt.com', 'registry.npmjs.org'], deniedHosts: [{ host: 'ab.chatgpt.com', count: 2 }], errorHosts: [] }
          : { available: false, allowed: 0, denied: 0, errors: 0, allowedHosts: [], deniedHosts: [], errorHosts: [] },
        policyFindings: run.state === 'INTERRUPTED' ? [{ ruleId: 'PG-ESLINT-DISABLE', severity: 'blocking', file: 'src/auth/login.ts', line: 12, evidence: '// eslint-disable-next-line no-restricted-syntax', message: '新規の eslint-disable コメント', approved: false, approvalReason: null }] : [],
        openFindings: needsHuman
          ? [
              { id: 'F-003', severity: 'high', file: 'src/server/export/csv.ts', line: 2, description: 'BOM が文字列連結で付与されているが、ストリーミング出力経路（exportLarge）では付与されていない。', recommendation: 'Writable の先頭チャンクで BOM を書き出す共通関数に統一してください。' },
              { id: 'F-004', severity: 'low', file: 'src/server/export/csv.test.ts', line: 18, description: 'テストが BOM の存在のみを確認し、Excel 互換の改行 (CRLF) を検証していない。', recommendation: 'CRLF の検証ケースを追加してください。' }
            ]
          : done
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
        requirementsUnverified: unverified,
        scopeCheck: null,
        reportPath: `${run.runDir}\\report.md`,
        worktreePath: run.worktreePath
      };
      if (isTerminal(run.state)) entry.report = report;
      return report;
    }
  };

  private setStep(id: string, status: SandboxSetupState['steps'][number]['status'], detail: string): void {
    this.setup = { ...this.setup, steps: this.setup.steps.map((s) => (s.id === id ? { ...s, status, detail } : s)) };
  }

  private emitSetup(): void {
    this.emit({ event: 'sandbox.progress', payload: structuredClone(this.setup) as unknown as Record<string, unknown> });
  }

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
    if (isTerminal(to)) this.saveTerminalRuns();
  }

  private saveTerminalRuns(): void {
    if (!this.persist) return;
    try {
      const seeded = new Set(seedHistory().map((s) => s.run.runId));
      const entries = [...this.runs.values()].filter((e) => isTerminal(e.run.state) && !seeded.has(e.run.runId)).map((e) => ({ run: e.run, events: e.events, report: e.report }));
      sessionStorage.setItem(STORAGE_KEY, JSON.stringify(entries));
    } catch {
      // ignore
    }
  }

  private scheduleRun(runId: string): void {
    const steps: Array<() => void> = this.scenario === 'precheck_failed' ? this.precheckFailedSteps(runId) : this.scenario === 'needs_human' ? this.needsHumanSteps(runId) : this.completedSteps(runId);
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

  /** 起動前検査で失敗（AI は呼ばれない） */
  private precheckFailedSteps(runId: string): Array<() => void> {
    return [
      () => {
        this.transition(runId, 'PREFLIGHT', { worktreePath: `C:\\Users\\dev\\.agent-orchestrator\\worktrees\\${runId}` });
        this.pushEvent(runId, 'preflight.completed', { ok: false, failed: ['verification_profile'] });
      },
      () => {
        this.transition(runId, 'PRECHECK_FAILED', {
          reasonCode: 'PRECHECK_FAILED',
          reasonDetail: 'ベースライン検証（変更前のリポジトリ）が失敗: lint（exit 1: src/legacy/report.ts に未使用変数）。プロジェクト側で typecheck / lint / test:run が通る状態にしてから再実行してください',
          finishedAt: new Date().toISOString(),
          nextActions: ['起動前検査に失敗しました。各チェックの修正方法に従って環境を整えてから再実行してください']
        });
      }
    ];
  }

  /** 3 ラウンドとも changes_requested → NEEDS_HUMAN / MAX_ROUNDS */
  private needsHumanSteps(runId: string): Array<() => void> {
    const steps: Array<() => void> = [
      () => {
        this.transition(runId, 'PREFLIGHT', { worktreePath: `C:\\Users\\dev\\.agent-orchestrator\\worktrees\\${runId}` });
        this.pushEvent(runId, 'preflight.completed', { ok: true, failed: [] });
      }
    ];
    for (let round = 1; round <= 3; round++) {
      steps.push(
        () => {
          this.transition(runId, 'IMPLEMENTING', { currentRound: round });
          this.pushEvent(runId, 'builder.started', { cli: 'claude', version: '2.1.0', attempt: round, hasFeedback: round > 1, feedbackKinds: round > 1 ? { verification: 0, review: 1, policy: 0 } : null }, round);
        },
        () => {
          this.pushEvent(runId, 'builder.completed', { exitCode: 0, durationMs: 180_000, resultExcerpt: 'BOM の付与を修正しました。', costUsd: 0.4 }, round);
          this.pushEvent(runId, 'diff.collected', { files: 2, additions: 40, deletions: 3, untracked: 0, policyViolations: [] }, round);
          this.transition(runId, 'VERIFYING');
        },
        () => {
          this.pushEvent(runId, 'verification.completed', { profile: 'node-pnpm', passed: true, commands: [{ name: 'typecheck', exitCode: 0, durationMs: 15_000 }, { name: 'lint', exitCode: 0, durationMs: 8_000 }, { name: 'test:run', exitCode: 0, durationMs: 30_000 }], missing: [] }, round);
          this.transition(runId, 'REVIEWING');
          this.pushEvent(runId, 'reviewer.started', { cli: 'codex', version: '0.48.0', readOnly: true }, round);
        },
        () => {
          this.pushEvent(runId, 'review.completed', { verdict: 'changes_requested', findingsCount: 2, blockingFindings: 1, requirementsUnverified: ['Excel で開いた際に文字化けしないこと（BOM 付き UTF-8）'], workspaceHashMatches: true, summary: 'ストリーミング出力経路で BOM が付与されていません。' }, round);
          if (round === 3) {
            this.transition(runId, 'NEEDS_HUMAN', {
              reasonCode: 'MAX_ROUNDS',
              reasonDetail: 'round 3: レビュー changes_requested（high 1 件）、修正上限に到達',
              finishedAt: new Date().toISOString(),
              openBlockingFindings: 1,
              nextActions: ['修正上限（3 回）に達しました。レポートの失敗理由と指摘を確認し、要件を見直すか手動で修正してください']
            });
          }
        }
      );
    }
    return steps;
  }

  private completedSteps(runId: string): Array<() => void> {
    return [
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
  }
}

function idleSetup(): SandboxSetupState {
  return { state: 'idle', startedAt: null, finishedAt: null, steps: SETUP_STEPS.map((s) => ({ ...s, status: 'pending', detail: '' })), logTail: [], error: null, manifest: SANDBOX_MANIFEST_MOCK };
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
