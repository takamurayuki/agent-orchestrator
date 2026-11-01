import type { DatabaseSync } from 'node:sqlite';
import { ulid } from 'ulid';
import type { Answer, AskedQuestion, DraftState, Fact, ProjectInfo, ReviewFinding, RoundRecord, RunEvent, RunStatus, Task, TaskProposal } from '@agent-orchestrator/contracts';
import { transaction } from './db.js';
import { nowIso } from '../config.js';

/** SQLite への型付きアクセス。IPC 層やサービス層は SQL を直接書かない。 */

export interface ProjectRow {
  id: string;
  path: string;
  gitRoot: string | null;
  defaultBaseRef: string | null;
  packageManager: string | null;
  inspected: ProjectInfo | null;
}

export interface DraftRow {
  id: string;
  projectId: string;
  request: string;
  state: DraftState;
  currentRevision: number;
  round: number;
  blockedReason: string | null;
  prohibited: string[];
  facts: Fact[];
  summary: string;
  approvedTaskId: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface DraftRevisionRow {
  id: string;
  draftId: string;
  revision: number;
  proposal: TaskProposal | null;
  taskYaml: string | null;
  validationErrors: string[];
  approved: boolean;
  approvedAt: string | null;
  createdAt: string;
}

export interface ApprovedTaskRow {
  id: string;
  draftId: string;
  revision: number;
  taskId: string;
  taskYaml: string;
  task: Task;
  yamlPath: string;
  approvedAt: string;
  dataSharingAcknowledged: boolean;
}

export class Repository {
  constructor(readonly db: DatabaseSync) {}

  // ---- projects ----
  upsertProject(path: string, info: ProjectInfo | null): ProjectRow {
    const existing = this.db.prepare('SELECT * FROM projects WHERE path = ?').get(path) as Record<string, unknown> | undefined;
    const now = nowIso();
    if (existing) {
      this.db
        .prepare('UPDATE projects SET git_root = ?, default_base_ref = ?, package_manager = ?, inspected_json = ?, updated_at = ? WHERE id = ?')
        .run(info?.gitRoot ?? null, info?.defaultBaseRef ?? null, info?.packageManager ?? null, info ? JSON.stringify(info) : null, now, existing.id as string);
      return this.getProject(existing.id as string)!;
    }
    const id = ulid();
    this.db
      .prepare('INSERT INTO projects (id, path, git_root, default_base_ref, package_manager, inspected_json, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)')
      .run(id, path, info?.gitRoot ?? null, info?.defaultBaseRef ?? null, info?.packageManager ?? null, info ? JSON.stringify(info) : null, now, now);
    return this.getProject(id)!;
  }

  getProject(id: string): ProjectRow | null {
    const r = this.db.prepare('SELECT * FROM projects WHERE id = ?').get(id) as Record<string, unknown> | undefined;
    return r ? mapProject(r) : null;
  }

  // ---- drafts ----
  createDraft(projectId: string, request: string, prohibited: string[]): DraftRow {
    const id = ulid();
    const now = nowIso();
    transaction(this.db, () => {
      this.db
        .prepare('INSERT INTO drafts (id, project_id, request, state, current_revision, round, prohibited_json, created_at, updated_at) VALUES (?, ?, ?, ?, 1, 0, ?, ?, ?)')
        .run(id, projectId, request, 'DRAFT_CREATED', JSON.stringify(prohibited), now, now);
      this.db.prepare('INSERT INTO draft_revisions (id, draft_id, revision, created_at) VALUES (?, ?, 1, ?)').run(ulid(), id, now);
    });
    return this.getDraft(id)!;
  }

  getDraft(id: string): DraftRow | null {
    const r = this.db.prepare('SELECT * FROM drafts WHERE id = ?').get(id) as Record<string, unknown> | undefined;
    return r ? mapDraft(r) : null;
  }

  listDrafts(limit = 50): DraftRow[] {
    return (this.db.prepare('SELECT * FROM drafts ORDER BY updated_at DESC LIMIT ?').all(limit) as Record<string, unknown>[]).map(mapDraft);
  }

  updateDraft(id: string, patch: Partial<Pick<DraftRow, 'state' | 'round' | 'blockedReason' | 'facts' | 'summary' | 'approvedTaskId' | 'currentRevision'>>): DraftRow {
    const cur = this.getDraft(id);
    if (!cur) throw new Error(`draft not found: ${id}`);
    const next = { ...cur, ...patch };
    this.db
      .prepare('UPDATE drafts SET state = ?, round = ?, blocked_reason = ?, facts_json = ?, summary = ?, approved_task_id = ?, current_revision = ?, updated_at = ? WHERE id = ?')
      .run(next.state, next.round, next.blockedReason, JSON.stringify(next.facts), next.summary, next.approvedTaskId, next.currentRevision, nowIso(), id);
    return this.getDraft(id)!;
  }

  // ---- revisions ----
  getRevision(draftId: string, revision: number): DraftRevisionRow | null {
    const r = this.db.prepare('SELECT * FROM draft_revisions WHERE draft_id = ? AND revision = ?').get(draftId, revision) as Record<string, unknown> | undefined;
    return r ? mapRevision(r) : null;
  }

  listRevisions(draftId: string): DraftRevisionRow[] {
    return (this.db.prepare('SELECT * FROM draft_revisions WHERE draft_id = ? ORDER BY revision').all(draftId) as Record<string, unknown>[]).map(mapRevision);
  }

  /** 新しいリビジョンを作る（承認フラグはリセット）。 */
  createRevision(draftId: string, proposal: TaskProposal | null, taskYaml: string | null, validationErrors: string[]): DraftRevisionRow {
    return transaction(this.db, () => {
      const draft = this.getDraft(draftId);
      if (!draft) throw new Error(`draft not found: ${draftId}`);
      const revision = draft.currentRevision + 1;
      this.db
        .prepare('INSERT INTO draft_revisions (id, draft_id, revision, proposal_json, task_yaml, validation_errors_json, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)')
        .run(ulid(), draftId, revision, proposal ? JSON.stringify(proposal) : null, taskYaml, JSON.stringify(validationErrors), nowIso());
      this.db.prepare('UPDATE drafts SET current_revision = ?, updated_at = ? WHERE id = ?').run(revision, nowIso(), draftId);
      return this.getRevision(draftId, revision)!;
    });
  }

  updateRevision(draftId: string, revision: number, patch: { proposal?: TaskProposal | null; taskYaml?: string | null; validationErrors?: string[] }): DraftRevisionRow {
    const cur = this.getRevision(draftId, revision);
    if (!cur) throw new Error(`revision not found: ${draftId}@${revision}`);
    if (cur.approved) throw new Error('approved revision is immutable');
    const next = { ...cur, ...patch };
    this.db
      .prepare('UPDATE draft_revisions SET proposal_json = ?, task_yaml = ?, validation_errors_json = ? WHERE draft_id = ? AND revision = ?')
      .run(next.proposal ? JSON.stringify(next.proposal) : null, next.taskYaml ?? null, JSON.stringify(next.validationErrors), draftId, revision);
    return this.getRevision(draftId, revision)!;
  }

  // ---- questions / answers ----
  addQuestions(draftId: string, questions: AskedQuestion[]): void {
    const stmt = this.db.prepare('INSERT OR REPLACE INTO questions (id, draft_id, question_id, round, question_json, created_at) VALUES (?, ?, ?, ?, ?, ?)');
    transaction(this.db, () => {
      for (const q of questions) stmt.run(ulid(), draftId, q.id, q.round, JSON.stringify(q), nowIso());
    });
  }

  listQuestions(draftId: string): AskedQuestion[] {
    return (this.db.prepare('SELECT question_json FROM questions WHERE draft_id = ? ORDER BY round, created_at').all(draftId) as Array<{ question_json: string }>).map(
      (r) => JSON.parse(r.question_json) as AskedQuestion
    );
  }

  addAnswers(draftId: string, answers: Answer[]): void {
    const stmt = this.db.prepare('INSERT INTO answers (id, draft_id, question_id, round, value, skipped, answered_at) VALUES (?, ?, ?, ?, ?, ?, ?)');
    transaction(this.db, () => {
      for (const a of answers) stmt.run(ulid(), draftId, a.questionId, a.round, a.value, a.skipped ? 1 : 0, a.answeredAt);
    });
  }

  /** 有効な（取り消されていない）回答。同じ質問への複数回答は最新を採用。 */
  listAnswers(draftId: string): Answer[] {
    const rows = this.db.prepare('SELECT * FROM answers WHERE draft_id = ? AND retracted = 0 ORDER BY answered_at').all(draftId) as Record<string, unknown>[];
    const latest = new Map<string, Answer>();
    for (const r of rows) {
      latest.set(r.question_id as string, { questionId: r.question_id as string, round: r.round as number, value: (r.value as string | null) ?? null, skipped: (r.skipped as number) === 1, answeredAt: r.answered_at as string });
    }
    return [...latest.values()];
  }

  /** 戻る: 指定ラウンドの回答を取り消す（履歴は残す）。 */
  retractAnswersForRound(draftId: string, round: number): number {
    const result = this.db.prepare('UPDATE answers SET retracted = 1 WHERE draft_id = ? AND round = ? AND retracted = 0').run(draftId, round);
    return Number(result.changes);
  }

  removeQuestionsForRound(draftId: string, round: number): void {
    this.db.prepare('DELETE FROM questions WHERE draft_id = ? AND round = ?').run(draftId, round);
  }

  // ---- approved tasks ----
  approveRevision(draftId: string, revision: number, task: Task, taskYaml: string, yamlPath: string): ApprovedTaskRow {
    return transaction(this.db, () => {
      const rev = this.getRevision(draftId, revision);
      if (!rev) throw new Error(`revision not found: ${draftId}@${revision}`);
      if (rev.approved) throw new Error('revision already approved');
      const now = nowIso();
      const id = ulid();
      this.db.prepare('UPDATE draft_revisions SET approved = 1, approved_at = ? WHERE draft_id = ? AND revision = ?').run(now, draftId, revision);
      this.db
        .prepare('INSERT INTO approved_tasks (id, draft_id, revision, task_id, task_yaml, task_json, yaml_path, approved_at, data_sharing_acknowledged) VALUES (?, ?, ?, ?, ?, ?, ?, ?, 1)')
        .run(id, draftId, revision, task.id, taskYaml, JSON.stringify(task), yamlPath, now);
      this.db.prepare("UPDATE drafts SET approved_task_id = ?, state = 'READY_TO_RUN', updated_at = ? WHERE id = ?").run(id, now, draftId);
      return this.getApprovedTask(id)!;
    });
  }

  getApprovedTask(id: string): ApprovedTaskRow | null {
    const r = this.db.prepare('SELECT * FROM approved_tasks WHERE id = ?').get(id) as Record<string, unknown> | undefined;
    if (!r) return null;
    return {
      id: r.id as string,
      draftId: r.draft_id as string,
      revision: r.revision as number,
      taskId: r.task_id as string,
      taskYaml: r.task_yaml as string,
      task: JSON.parse(r.task_json as string) as Task,
      yamlPath: r.yaml_path as string,
      approvedAt: r.approved_at as string,
      dataSharingAcknowledged: (r.data_sharing_acknowledged as number) === 1
    };
  }

  // ---- runs ----
  insertRun(status: RunStatus): void {
    this.db
      .prepare('INSERT INTO runs (id, approved_task_id, state, reason_code, reason_detail, status_json, run_dir, worktree_path, started_at, finished_at, last_sequence) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)')
      .run(status.runId, status.approvedTaskId, status.state, status.reasonCode, status.reasonDetail, JSON.stringify(status), status.runDir, status.worktreePath, status.startedAt, status.finishedAt, status.lastSequence);
  }

  updateRun(status: RunStatus): void {
    this.db
      .prepare('UPDATE runs SET state = ?, reason_code = ?, reason_detail = ?, status_json = ?, worktree_path = ?, finished_at = ?, last_sequence = ? WHERE id = ?')
      .run(status.state, status.reasonCode, status.reasonDetail, JSON.stringify(status), status.worktreePath, status.finishedAt, status.lastSequence, status.runId);
  }

  getRun(runId: string): RunStatus | null {
    const r = this.db.prepare('SELECT status_json FROM runs WHERE id = ?').get(runId) as { status_json: string } | undefined;
    return r ? (JSON.parse(r.status_json) as RunStatus) : null;
  }

  listRuns(limit = 50): RunStatus[] {
    return (this.db.prepare('SELECT status_json FROM runs ORDER BY started_at DESC LIMIT ?').all(limit) as Array<{ status_json: string }>).map((r) => JSON.parse(r.status_json) as RunStatus);
  }

  listActiveRuns(): RunStatus[] {
    return (
      this.db
        .prepare("SELECT status_json FROM runs WHERE state IN ('CREATED','PREFLIGHT','IMPLEMENTING','VERIFYING','REVIEWING')")
        .all() as Array<{ status_json: string }>
    ).map((r) => JSON.parse(r.status_json) as RunStatus);
  }

  /** イベントを連番付きで追加（トランザクション内で連番を決めるので順序が保たれる）。 */
  appendEvent(event: Omit<RunEvent, 'sequence' | 'timestamp'>): RunEvent {
    return transaction(this.db, () => {
      const row = this.db.prepare('SELECT COALESCE(MAX(sequence), 0) AS seq FROM run_events WHERE run_id = ?').get(event.runId) as { seq: number };
      const sequence = Number(row.seq) + 1;
      const timestamp = nowIso();
      this.db
        .prepare('INSERT INTO run_events (run_id, sequence, type, round, payload_json, created_at) VALUES (?, ?, ?, ?, ?, ?)')
        .run(event.runId, sequence, event.type, event.round, JSON.stringify(event.payload), timestamp);
      this.db.prepare('UPDATE runs SET last_sequence = ? WHERE id = ?').run(sequence, event.runId);
      return { ...event, sequence, timestamp };
    });
  }

  listEvents(runId: string, sinceSequence = 0, limit = 5000): RunEvent[] {
    return (
      this.db.prepare('SELECT * FROM run_events WHERE run_id = ? AND sequence > ? ORDER BY sequence LIMIT ?').all(runId, sinceSequence, limit) as Record<string, unknown>[]
    ).map((r) => ({
      runId: r.run_id as string,
      sequence: r.sequence as number,
      timestamp: r.created_at as string,
      type: r.type as string,
      round: (r.round as number | null) ?? null,
      payload: JSON.parse(r.payload_json as string) as Record<string, unknown>
    }));
  }

  countEvents(runId: string): number {
    const r = this.db.prepare('SELECT COUNT(*) AS n FROM run_events WHERE run_id = ?').get(runId) as { n: number };
    return Number(r.n);
  }

  saveRound(runId: string, round: RoundRecord): void {
    transaction(this.db, () => {
      this.db
        .prepare('INSERT OR REPLACE INTO run_rounds (run_id, round, round_json, updated_at) VALUES (?, ?, ?, ?)')
        .run(runId, round.round, JSON.stringify(round), nowIso());
      if (round.review?.parsed) {
        this.db.prepare('DELETE FROM review_findings WHERE run_id = ? AND round = ?').run(runId, round.round);
        const stmt = this.db.prepare(
          'INSERT INTO review_findings (id, run_id, round, finding_id, severity, file, line, description, recommendation, finding_json, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)'
        );
        for (const f of round.review.parsed.findings) {
          stmt.run(ulid(), runId, round.round, f.id, f.severity, f.file, f.line, f.description, f.recommendation, JSON.stringify(f), nowIso());
        }
      }
    });
  }

  listRounds(runId: string): RoundRecord[] {
    return (this.db.prepare('SELECT round_json FROM run_rounds WHERE run_id = ? ORDER BY round').all(runId) as Array<{ round_json: string }>).map((r) => JSON.parse(r.round_json) as RoundRecord);
  }

  listFindings(runId: string, round?: number): ReviewFinding[] {
    const rows = (
      round === undefined
        ? this.db.prepare('SELECT finding_json FROM review_findings WHERE run_id = ? ORDER BY round, created_at').all(runId)
        : this.db.prepare('SELECT finding_json FROM review_findings WHERE run_id = ? AND round = ? ORDER BY created_at').all(runId, round)
    ) as Array<{ finding_json: string }>;
    return rows.map((r) => JSON.parse(r.finding_json) as ReviewFinding);
  }
}

function mapProject(r: Record<string, unknown>): ProjectRow {
  return {
    id: r.id as string,
    path: r.path as string,
    gitRoot: (r.git_root as string | null) ?? null,
    defaultBaseRef: (r.default_base_ref as string | null) ?? null,
    packageManager: (r.package_manager as string | null) ?? null,
    inspected: r.inspected_json ? (JSON.parse(r.inspected_json as string) as ProjectInfo) : null
  };
}

function mapDraft(r: Record<string, unknown>): DraftRow {
  return {
    id: r.id as string,
    projectId: r.project_id as string,
    request: r.request as string,
    state: r.state as DraftState,
    currentRevision: r.current_revision as number,
    round: r.round as number,
    blockedReason: (r.blocked_reason as string | null) ?? null,
    prohibited: JSON.parse(r.prohibited_json as string) as string[],
    facts: JSON.parse(r.facts_json as string) as Fact[],
    summary: r.summary as string,
    approvedTaskId: (r.approved_task_id as string | null) ?? null,
    createdAt: r.created_at as string,
    updatedAt: r.updated_at as string
  };
}

function mapRevision(r: Record<string, unknown>): DraftRevisionRow {
  return {
    id: r.id as string,
    draftId: r.draft_id as string,
    revision: r.revision as number,
    proposal: r.proposal_json ? (JSON.parse(r.proposal_json as string) as TaskProposal) : null,
    taskYaml: (r.task_yaml as string | null) ?? null,
    validationErrors: JSON.parse(r.validation_errors_json as string) as string[],
    approved: (r.approved as number) === 1,
    approvedAt: (r.approved_at as string | null) ?? null,
    createdAt: r.created_at as string
  };
}
