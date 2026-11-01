import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { RunStatus } from '@agent-orchestrator/contracts';
import { openDatabase } from '../../src/storage/db.js';
import { FileAndDbRecorder } from '../../src/storage/recorder.js';
import { Repository } from '../../src/storage/repository.js';
import { sampleTask, snapshot } from '../helpers/mock-deps.js';

let dir: string;
let repo: Repository;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'ao-storage-'));
  repo = new Repository(openDatabase(join(dir, 'test.sqlite')));
});
afterEach(() => {
  repo.db.close();
  rmSync(dir, { recursive: true, force: true });
});

/** runs.approved_task_id は FK なので、先に project/draft/approved_task を作る */
const seedApproved = (): string => {
  const project = repo.upsertProject('/repo', null);
  const draft = repo.createDraft(project.id, 'seed', []);
  return repo.approveRevision(draft.id, 1, sampleTask, 'schemaVersion: 2\n', '/tasks/seed/task.yaml').id;
};

const baseStatus = (runId: string, approvedTaskId = seedApproved()): RunStatus => ({
  runId,
  approvedTaskId,
  taskId: sampleTask.id,
  taskTitle: sampleTask.title,
  repository: '/repo',
  baseRef: 'main',
  baseSha: null,
  state: 'CREATED',
  reasonCode: null,
  reasonDetail: null,
  currentRound: 0,
  maxRounds: 3,
  worktreePath: null,
  runDir: join(dir, 'runs', runId),
  startedAt: new Date().toISOString(),
  finishedAt: null,
  lastSequence: 0,
  openBlockingFindings: 0,
  nextActions: []
});

describe('SQLite repository', () => {
  it('creates all required tables with WAL', () => {
    const tables = (repo.db.prepare("SELECT name FROM sqlite_master WHERE type='table'").all() as Array<{ name: string }>).map((t) => t.name);
    for (const t of ['projects', 'drafts', 'draft_revisions', 'questions', 'answers', 'approved_tasks', 'runs', 'run_events', 'review_findings']) expect(tables).toContain(t);
    const mode = repo.db.prepare('PRAGMA journal_mode').get() as { journal_mode: string };
    expect(mode.journal_mode).toBe('wal');
  });

  it('AUD-01: draft revisions and approved task are stored consistently; approved revision is immutable [RA-11]', () => {
    const project = repo.upsertProject('/repo', null);
    const draft = repo.createDraft(project.id, 'ログイン機能', []);
    expect(draft.currentRevision).toBe(1);
    const rev2 = repo.createRevision(draft.id, null, 'schemaVersion: 2\n', []);
    expect(rev2.revision).toBe(2);
    const approved = repo.approveRevision(draft.id, 2, sampleTask, 'schemaVersion: 2\n', '/tasks/x/task.yaml');
    expect(approved.taskId).toBe(sampleTask.id);
    expect(repo.getRevision(draft.id, 2)?.approved).toBe(true);
    expect(repo.getDraft(draft.id)?.approvedTaskId).toBe(approved.id);
    expect(() => repo.updateRevision(draft.id, 2, { taskYaml: 'changed' })).toThrow(/immutable/);
    expect(() => repo.approveRevision(draft.id, 2, sampleTask, 'x', 'y')).toThrow(/already approved/);
    // 承認後の編集は新 revision
    const rev3 = repo.createRevision(draft.id, null, 'schemaVersion: 2\ntitle: changed\n', []);
    expect(rev3.revision).toBe(3);
    expect(rev3.approved).toBe(false);
  });

  it('records questions and answers with back (retract) support [RA-06][UI-06]', () => {
    const project = repo.upsertProject('/repo', null);
    const draft = repo.createDraft(project.id, 'x', []);
    repo.addQuestions(draft.id, [{ id: 'Q-1', round: 1, question: 'q?', decisionImpact: 'blocking', options: [], recommendation: '' }]);
    repo.addAnswers(draft.id, [{ questionId: 'Q-1', round: 1, value: 'a', skipped: false, answeredAt: '2026-01-01T00:00:00Z' }]);
    expect(repo.listAnswers(draft.id)).toHaveLength(1);
    expect(repo.retractAnswersForRound(draft.id, 1)).toBe(1);
    expect(repo.listAnswers(draft.id)).toHaveLength(0);
    // 履歴は残っている
    const all = repo.db.prepare('SELECT COUNT(*) AS n FROM answers WHERE draft_id = ?').get(draft.id) as { n: number };
    expect(Number(all.n)).toBe(1);
  });

  it('AUD-02: events get strictly increasing sequence numbers and can be fetched since a sequence', () => {
    repo.insertRun(baseStatus('RUN-A'));
    const e1 = repo.appendEvent({ runId: 'RUN-A', type: 'a', round: null, payload: {} });
    const e2 = repo.appendEvent({ runId: 'RUN-A', type: 'b', round: 1, payload: { x: 1 } });
    expect([e1.sequence, e2.sequence]).toEqual([1, 2]);
    expect(repo.listEvents('RUN-A', 1).map((e) => e.type)).toEqual(['b']);
    expect(repo.countEvents('RUN-A')).toBe(2);
    // run ごとに独立した連番
    repo.insertRun(baseStatus('RUN-B'));
    expect(repo.appendEvent({ runId: 'RUN-B', type: 'a', round: null, payload: {} }).sequence).toBe(1);
  });

  it('lists active runs for restart recovery [AUD-03]', () => {
    repo.insertRun({ ...baseStatus('RUN-1'), state: 'IMPLEMENTING' });
    repo.insertRun({ ...baseStatus('RUN-2'), state: 'COMPLETED' });
    expect(repo.listActiveRuns().map((r) => r.runId)).toEqual(['RUN-1']);
  });
});

describe('FileAndDbRecorder', () => {
  it('writes the run directory layout and masks secrets in artifacts [SEC-05][AUD-05]', async () => {
    const runsDir = join(dir, 'runs');
    const recorder = new FileAndDbRecorder(repo, runsDir);
    const seen: number[] = [];
    recorder.onEvent((e) => seen.push(e.sequence));
    const status = baseStatus('RUN-F');
    await recorder.createRun(status, snapshot({ approvedTaskId: status.approvedTaskId }));
    await recorder.appendEvent({ runId: 'RUN-F', type: 'run.created', round: null, payload: { token: 'ANTHROPIC_API_KEY=sk-ant-api03-secretsecretsecret' } });
    await recorder.saveArtifact('RUN-F', 1, 'builder.log', 'export OPENAI_API_KEY=sk-proj-abcdefghijklmnopqrstu\nok');
    await recorder.saveRound('RUN-F', { round: 1, builder: null, diff: null, policyViolations: [], policyFindings: [], verification: null, review: null, workspaceHashBeforeReview: null, workspaceHashAfterReview: null, startedAt: 't', finishedAt: null });
    await recorder.saveReport('RUN-F', '# report');
    await recorder.updateStatus({ ...status, state: 'COMPLETED' });
    const runDir = join(runsDir, 'RUN-F');
    for (const f of ['task.snapshot.yaml', 'metadata.json', 'events.jsonl', 'status.json', 'report.md', 'rounds/1/builder.log', 'rounds/1/round.json']) expect(existsSync(join(runDir, f))).toBe(true);
    const events = readFileSync(join(runDir, 'events.jsonl'), 'utf8');
    expect(events).not.toContain('sk-ant-api03-secretsecretsecret');
    expect(readFileSync(join(runDir, 'rounds/1/builder.log'), 'utf8')).not.toContain('sk-proj-abcdefghijklmnopqrstu');
    expect(JSON.parse(readFileSync(join(runDir, 'status.json'), 'utf8')).state).toBe('COMPLETED');
    expect(seen).toEqual([1]);
    expect(await recorder.persistedEventCount('RUN-F')).toBe(1);
  });
});
