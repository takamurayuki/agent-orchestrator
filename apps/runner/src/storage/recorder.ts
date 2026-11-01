import { appendFileSync, chmodSync, mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { RoundRecord, RunEvent, RunStatus } from '@agent-orchestrator/contracts';
import type { ApprovedTaskSnapshot, RunRecorder } from '../engine.js';
import { maskSecrets, truncateBytes } from '../masking.js';
import type { Repository } from './repository.js';

/**
 * SQLite + ファイル（runs/<runId>/...）への永続化。
 *   task.snapshot.yaml, metadata.json, events.jsonl, status.json, report.md, rounds/<n>/{builder.log,verify.json,review.json,diff.patch}
 * イベントはまず SQLite（連番決定）、次に events.jsonl に書き、両方終わってからリスナーに配送する。
 */
export class FileAndDbRecorder implements RunRecorder {
  private readonly listeners = new Set<(event: RunEvent) => void>();

  constructor(
    private readonly repo: Repository,
    private readonly runsDir: string,
    private readonly maxArtifactBytes = 4 * 1024 * 1024
  ) {}

  onEvent(listener: (event: RunEvent) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  runDir(runId: string): string {
    return join(this.runsDir, runId);
  }

  async createRun(status: RunStatus, snapshot: ApprovedTaskSnapshot): Promise<void> {
    const dir = this.runDir(status.runId);
    mkdirSync(join(dir, 'rounds'), { recursive: true });
    restrictPermissions(dir);
    writeFileSync(join(dir, 'task.snapshot.yaml'), snapshot.taskYaml, 'utf8');
    writeFileSync(
      join(dir, 'metadata.json'),
      JSON.stringify({ runId: status.runId, approvedTaskId: snapshot.approvedTaskId, taskId: snapshot.task.id, approved: snapshot.approved, approvedAt: snapshot.approvedAt, startedAt: status.startedAt, repository: snapshot.task.repository, baseRef: snapshot.task.baseRef }, null, 2),
      'utf8'
    );
    writeFileSync(join(dir, 'events.jsonl'), '', 'utf8');
    this.repo.insertRun(status);
    writeFileSync(join(dir, 'status.json'), JSON.stringify(status, null, 2), 'utf8');
  }

  async updateStatus(status: RunStatus): Promise<void> {
    this.repo.updateRun(status);
    writeFileSync(join(this.runDir(status.runId), 'status.json'), JSON.stringify(status, null, 2), 'utf8');
  }

  async appendEvent(event: Omit<RunEvent, 'sequence' | 'timestamp'>): Promise<RunEvent> {
    const masked = { ...event, payload: JSON.parse(maskSecrets(JSON.stringify(event.payload))) as Record<string, unknown> };
    const persisted = this.repo.appendEvent(masked);
    appendFileSync(join(this.runDir(event.runId), 'events.jsonl'), `${JSON.stringify(persisted)}\n`, 'utf8');
    for (const l of this.listeners) {
      try {
        l(persisted);
      } catch {
        /* リスナーの失敗は永続化に影響させない */
      }
    }
    return persisted;
  }

  async saveRound(runId: string, round: RoundRecord): Promise<void> {
    this.repo.saveRound(runId, round);
    const dir = join(this.runDir(runId), 'rounds', String(round.round));
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, 'round.json'), JSON.stringify(round, null, 2), 'utf8');
  }

  async saveArtifact(runId: string, round: number, name: string, content: string): Promise<void> {
    const dir = join(this.runDir(runId), 'rounds', String(round));
    mkdirSync(dir, { recursive: true });
    const safeName = name.replace(/[^A-Za-z0-9._-]/g, '_');
    const { text } = truncateBytes(maskSecrets(content), this.maxArtifactBytes);
    const path = join(dir, safeName);
    writeFileSync(path, text, 'utf8');
    restrictPermissions(path);
  }

  async saveReport(runId: string, markdown: string): Promise<void> {
    writeFileSync(join(this.runDir(runId), 'report.md'), maskSecrets(markdown), 'utf8');
  }

  async persistedEventCount(runId: string): Promise<number> {
    return this.repo.countEvents(runId);
  }
}

/** diff/log は秘密情報を含み得るので所有者のみ読める権限にする（Windows では無視される）。 */
function restrictPermissions(path: string): void {
  if (process.platform === 'win32') return;
  try {
    chmodSync(path, 0o700);
  } catch {
    /* best effort */
  }
}
