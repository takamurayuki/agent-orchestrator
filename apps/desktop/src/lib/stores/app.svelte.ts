import type {
  DraftApproveResult,
  DraftView,
  EnvironmentReport,
  ProjectInfo,
  RunEvent,
  RunReportResult,
  RunStatus,
  SandboxSetupState
} from '@agent-orchestrator/contracts';

export type Screen = 'home' | 'interview' | 'running' | 'result';

export const SCREENS: ReadonlyArray<{ id: Screen; label: string; description: string }> = [
  { id: 'home', label: 'ホーム', description: 'プロジェクト選択と依頼入力' },
  { id: 'interview', label: 'ヒアリング', description: '質問への回答と要件の承認' },
  { id: 'running', label: '実行中', description: '実行状態とログ' },
  { id: 'result', label: '結果・履歴', description: '結果レポートと実行履歴' }
];

export interface UiError {
  code: string;
  message: string;
}

/** Svelte 5 runes-based application state. Business logic lives in the runner; this is view state only. */
class AppStore {
  screen = $state<Screen>('home');

  environment = $state<EnvironmentReport | null>(null);
  environmentError = $state<UiError | null>(null);
  /** サンドボックス準備（GUI からのイメージ取得・ビルド）の進捗 */
  sandboxSetup = $state<SandboxSetupState | null>(null);

  projectPath = $state('');
  project = $state<ProjectInfo | null>(null);
  projectError = $state<UiError | null>(null);

  request = $state('');

  draft = $state<DraftView | null>(null);
  approval = $state<DraftApproveResult | null>(null);

  run = $state<RunStatus | null>(null);
  events = $state<RunEvent[]>([]);

  history = $state<RunStatus[]>([]);
  report = $state<RunReportResult | null>(null);
  reportRunId = $state<string | null>(null);

  busy = $state<string | null>(null);
  error = $state<UiError | null>(null);

  /** Text for the aria-live region. */
  live = $state('');

  runnerAlive = $state<boolean | null>(null);
  transportKind = $state<'tauri' | 'mock'>('mock');

  readonly canRun = $derived(this.environment?.canRun === true);
  readonly projectOk = $derived(this.project?.status === 'ok');
  readonly canStart = $derived(this.canRun && this.projectOk && this.request.trim().length > 0 && this.busy === null);
  readonly lastSequence = $derived(this.events.length ? this.events[this.events.length - 1]!.sequence : (this.run?.lastSequence ?? 0));

  announce(message: string): void {
    // Re-assign even for identical text so screen readers re-read it.
    this.live = '';
    queueMicrotask(() => {
      this.live = message;
    });
  }

  navigate(screen: Screen): void {
    this.screen = screen;
    this.error = null;
    const meta = SCREENS.find((s) => s.id === screen);
    if (meta) this.announce(`${meta.label}画面に移動しました`);
  }

  setError(err: UiError | null): void {
    this.error = err;
    if (err) this.announce(`エラー: ${err.message}`);
  }

  resetRun(): void {
    this.run = null;
    this.events = [];
  }

  /** Append events preserving order; ignores duplicates by sequence. */
  mergeEvents(incoming: RunEvent[]): void {
    if (!incoming.length) return;
    const known = new Set(this.events.map((e) => e.sequence));
    const added = incoming.filter((e) => !known.has(e.sequence));
    if (!added.length) return;
    this.events = [...this.events, ...added].sort((a, b) => a.sequence - b.sequence);
  }

  upsertHistory(run: RunStatus): void {
    const idx = this.history.findIndex((r) => r.runId === run.runId);
    if (idx === -1) this.history = [run, ...this.history];
    else this.history = this.history.map((r) => (r.runId === run.runId ? run : r));
  }
}

export const app = new AppStore();
