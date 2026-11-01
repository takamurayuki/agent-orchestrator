import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { RunEvent, RunStatus } from '@agent-orchestrator/contracts';
import { RunService, RunServiceError } from '../../src/run-service.js';
import { openDatabase } from '../../src/storage/db.js';
import { FileAndDbRecorder } from '../../src/storage/recorder.js';
import { Repository } from '../../src/storage/repository.js';
import { FakeSandbox } from '../helpers/fake-sandbox.js';
import { createMockDeps, highReview, okBuilder, reviewOutcome, sampleTask, type MockOptions } from '../helpers/mock-deps.js';
import { stringify } from 'yaml';

let dir: string;
let repo: Repository;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'ao-runsvc-'));
  repo = new Repository(openDatabase(join(dir, 'db.sqlite')));
});
afterEach(() => {
  repo.db.close();
  rmSync(dir, { recursive: true, force: true });
});

const approveTask = () => {
  const project = repo.upsertProject('/repo', null);
  const draft = repo.createDraft(project.id, 'x', []);
  const { limits: _l, review: _r, ...task } = sampleTask;
  const yaml = stringify({ ...task, limits: sampleTask.limits, review: sampleTask.review });
  return repo.approveRevision(draft.id, 1, { ...task, limits: sampleTask.limits, review: sampleTask.review }, yaml, join(dir, 'task.yaml'));
};

const build = (options: MockOptions = {}) => {
  const mock = createMockDeps(options);
  const recorder = new FileAndDbRecorder(repo, join(dir, 'runs'));
  const sandbox = new FakeSandbox();
  const updates: RunStatus[] = [];
  const events: RunEvent[] = [];
  const { recorder: _rec, hasActiveRun: _h, now: _n, ...engineDeps } = mock.deps;
  const service = new RunService({ repo, recorder, runsDir: join(dir, 'runs'), sandbox, engineDeps, onRunUpdated: (s) => updates.push(s), onRunEvent: (e) => events.push(e) });
  return { service, mock, sandbox, updates, events };
};

describe('RunService', () => {
  it('runs an approved task to COMPLETED, writes report.md, and exposes status/events/report [EX-01][AUD-04][AUD-05]', async () => {
    const approved = approveTask();
    const { service, sandbox, events } = build();
    const started = await service.start(approved.id);
    expect(['CREATED', 'PREFLIGHT', 'IMPLEMENTING', 'VERIFYING', 'REVIEWING', 'COMPLETED']).toContain(started.state);
    const final = await service.waitForActive();
    expect(final?.state).toBe('COMPLETED');
    const status = service.status(final!.runId);
    expect(status.run.state).toBe('COMPLETED');
    expect(status.events.map((e) => e.sequence)).toEqual(status.events.map((_, i) => i + 1));
    // sinceSequence で差分取得（UI 再接続 AUD-05）
    const tail = service.status(final!.runId, status.events.length - 2);
    expect(tail.events).toHaveLength(2);
    expect(events.length).toBe(status.events.length);
    const report = service.report(final!.runId);
    expect(report.reportMarkdown).toContain('完了（ゲート通過）');
    expect(report.reportMarkdown).toContain('次の手動操作');
    expect(report.changedFiles).toEqual(['modified src/auth/login.ts']);
    expect(existsSync(report.reportPath)).toBe(true);
    expect(sandbox.cleaned).toEqual([final!.runId]);
    expect(service.list().map((r) => r.runId)).toEqual([final!.runId]);
  });

  it('EX-13: a second run while one is active is refused', async () => {
    const approved = approveTask();
    let release: () => void = () => undefined;
    const gate = new Promise<void>((r) => (release = r));
    const { service } = build({ builders: [async () => { await gate; return okBuilder(); }] });
    await service.start(approved.id);
    await expect(service.start(approved.id)).rejects.toMatchObject({ code: 'RUN_IN_PROGRESS' });
    release();
    await service.waitForActive();
    // 完了後は再度開始できる
    const second = await service.start(approved.id);
    expect(second.runId).toBeTruthy();
    await service.waitForActive();
  });

  it('refuses unknown / unapproved task ids [RA-12]', async () => {
    const { service } = build();
    await expect(service.start('nope')).rejects.toBeInstanceOf(RunServiceError);
  });

  it('EX-12 / UI-09: cancel aborts the run → INTERRUPTED with details persisted', async () => {
    const approved = approveTask();
    let release: () => void = () => undefined;
    const gate = new Promise<void>((r) => (release = r));
    const { service } = build({ builders: [async (input) => { await Promise.race([gate, new Promise((r) => input.signal.addEventListener('abort', r))]); return okBuilder(); }] });
    const started = await service.start(approved.id);
    const cancelled = await service.cancel(started.runId);
    release();
    expect(cancelled.state).toBe('INTERRUPTED');
    expect(cancelled.reasonCode).toBe('CANCELLED');
    const status = service.status(started.runId);
    expect(status.run.state).toBe('INTERRUPTED');
    expect(status.events.some((e) => e.type === 'run.finished')).toBe(true);
    expect(JSON.parse(readFileSync(join(status.run.runDir, 'status.json'), 'utf8')).state).toBe('INTERRUPTED');
    await expect(service.cancel(started.runId)).rejects.toMatchObject({ code: 'INVALID_STATE' });
  });

  it('AUD-03: runs left in progress are marked INTERRUPTED on restart, never auto-resumed', async () => {
    const approved = approveTask();
    const { service } = build();
    const started = await service.start(approved.id);
    await service.waitForActive();
    // 異常終了を模倣: 状態を IMPLEMENTING に戻す
    repo.updateRun({ ...repo.getRun(started.runId)!, state: 'IMPLEMENTING', finishedAt: null });
    const { service: restarted, mock } = build();
    const recovered = restarted.recoverInterruptedRuns();
    expect(recovered.map((r) => r.runId)).toEqual([started.runId]);
    expect(repo.getRun(started.runId)?.state).toBe('INTERRUPTED');
    expect(repo.getRun(started.runId)?.reasonCode).toBe('RECOVERED_AFTER_RESTART');
    expect(mock.calls.builder).toBe(0);
    const events = repo.listEvents(started.runId);
    expect(events[events.length - 1]?.type).toBe('run.recovered');
  });

  it('AUD-04: a failed run has a report with reason and next actions, and open findings in the report result', async () => {
    const approved = approveTask();
    const { service } = build({ reviews: [reviewOutcome(highReview())] });
    await service.start(approved.id);
    const final = await service.waitForActive();
    expect(final?.state).toBe('NEEDS_HUMAN');
    expect(final?.reasonCode).toBe('MAX_ROUNDS');
    const report = service.report(final!.runId);
    expect(report.reportMarkdown).toContain('要確認');
    expect(report.reportMarkdown).toContain('MAX_ROUNDS');
    expect(report.openFindings[0]?.id).toBe('REV-001');
    expect(report.run.nextActions.length).toBeGreaterThan(0);
    expect(repo.listFindings(final!.runId).length).toBe(3);
  });
});
