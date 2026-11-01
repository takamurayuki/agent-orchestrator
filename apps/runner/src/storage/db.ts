import { DatabaseSync } from 'node:sqlite';

/**
 * SQLite（node:sqlite、WAL）。スキーマは migrations 配列で前方のみ適用する。
 * 主キーは ULID、タイムスタンプは UTC ISO8601、JSON 列は version 列を持つ。
 */
const MIGRATIONS: Array<{ version: number; sql: string }> = [
  {
    version: 1,
    sql: `
      CREATE TABLE IF NOT EXISTS schema_migrations (version INTEGER PRIMARY KEY, applied_at TEXT NOT NULL);

      CREATE TABLE IF NOT EXISTS projects (
        id TEXT PRIMARY KEY,
        path TEXT NOT NULL UNIQUE,
        git_root TEXT,
        default_base_ref TEXT,
        package_manager TEXT,
        inspected_json TEXT,
        inspected_version INTEGER NOT NULL DEFAULT 1,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS drafts (
        id TEXT PRIMARY KEY,
        project_id TEXT NOT NULL REFERENCES projects(id),
        request TEXT NOT NULL,
        state TEXT NOT NULL,
        current_revision INTEGER NOT NULL DEFAULT 1,
        round INTEGER NOT NULL DEFAULT 0,
        blocked_reason TEXT,
        prohibited_json TEXT NOT NULL DEFAULT '[]',
        facts_json TEXT NOT NULL DEFAULT '[]',
        summary TEXT NOT NULL DEFAULT '',
        approved_task_id TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS draft_revisions (
        id TEXT PRIMARY KEY,
        draft_id TEXT NOT NULL REFERENCES drafts(id),
        revision INTEGER NOT NULL,
        proposal_json TEXT,
        task_yaml TEXT,
        validation_errors_json TEXT NOT NULL DEFAULT '[]',
        task_version INTEGER NOT NULL DEFAULT 2,
        approved INTEGER NOT NULL DEFAULT 0,
        approved_at TEXT,
        created_at TEXT NOT NULL,
        UNIQUE(draft_id, revision)
      );

      CREATE TABLE IF NOT EXISTS questions (
        id TEXT PRIMARY KEY,
        draft_id TEXT NOT NULL REFERENCES drafts(id),
        question_id TEXT NOT NULL,
        round INTEGER NOT NULL,
        question_json TEXT NOT NULL,
        question_version INTEGER NOT NULL DEFAULT 1,
        created_at TEXT NOT NULL,
        UNIQUE(draft_id, question_id)
      );

      CREATE TABLE IF NOT EXISTS answers (
        id TEXT PRIMARY KEY,
        draft_id TEXT NOT NULL REFERENCES drafts(id),
        question_id TEXT NOT NULL,
        round INTEGER NOT NULL,
        value TEXT,
        skipped INTEGER NOT NULL DEFAULT 0,
        retracted INTEGER NOT NULL DEFAULT 0,
        answered_at TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS approved_tasks (
        id TEXT PRIMARY KEY,
        draft_id TEXT NOT NULL REFERENCES drafts(id),
        revision INTEGER NOT NULL,
        task_id TEXT NOT NULL,
        task_yaml TEXT NOT NULL,
        task_json TEXT NOT NULL,
        task_version INTEGER NOT NULL DEFAULT 2,
        yaml_path TEXT NOT NULL,
        approved_at TEXT NOT NULL,
        data_sharing_acknowledged INTEGER NOT NULL DEFAULT 0
      );

      CREATE TABLE IF NOT EXISTS runs (
        id TEXT PRIMARY KEY,
        approved_task_id TEXT NOT NULL REFERENCES approved_tasks(id),
        state TEXT NOT NULL,
        reason_code TEXT,
        reason_detail TEXT,
        status_json TEXT NOT NULL,
        status_version INTEGER NOT NULL DEFAULT 1,
        run_dir TEXT NOT NULL,
        worktree_path TEXT,
        started_at TEXT NOT NULL,
        finished_at TEXT,
        last_sequence INTEGER NOT NULL DEFAULT 0
      );

      CREATE TABLE IF NOT EXISTS run_events (
        run_id TEXT NOT NULL REFERENCES runs(id),
        sequence INTEGER NOT NULL,
        type TEXT NOT NULL,
        round INTEGER,
        payload_json TEXT NOT NULL,
        created_at TEXT NOT NULL,
        PRIMARY KEY (run_id, sequence)
      );

      CREATE TABLE IF NOT EXISTS review_findings (
        id TEXT PRIMARY KEY,
        run_id TEXT NOT NULL REFERENCES runs(id),
        round INTEGER NOT NULL,
        finding_id TEXT NOT NULL,
        severity TEXT NOT NULL,
        file TEXT NOT NULL,
        line INTEGER NOT NULL,
        description TEXT NOT NULL,
        recommendation TEXT NOT NULL,
        finding_json TEXT NOT NULL,
        review_version INTEGER NOT NULL DEFAULT 1,
        resolved INTEGER NOT NULL DEFAULT 0,
        created_at TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS run_rounds (
        run_id TEXT NOT NULL REFERENCES runs(id),
        round INTEGER NOT NULL,
        round_json TEXT NOT NULL,
        round_version INTEGER NOT NULL DEFAULT 1,
        updated_at TEXT NOT NULL,
        PRIMARY KEY (run_id, round)
      );

      CREATE INDEX IF NOT EXISTS idx_runs_started ON runs(started_at DESC);
      CREATE INDEX IF NOT EXISTS idx_drafts_project ON drafts(project_id);
    `
  },
  {
    version: 2,
    sql: `
      ALTER TABLE drafts ADD COLUMN contradictions_json TEXT NOT NULL DEFAULT '[]';
      CREATE TABLE IF NOT EXISTS decisions (
        id TEXT PRIMARY KEY,
        draft_id TEXT NOT NULL REFERENCES drafts(id),
        contradiction_id TEXT NOT NULL,
        decision_json TEXT NOT NULL,
        decision_version INTEGER NOT NULL DEFAULT 1,
        decided_at TEXT NOT NULL,
        UNIQUE(draft_id, contradiction_id)
      );
    `
  }
];

export function openDatabase(path: string): DatabaseSync {
  const db = new DatabaseSync(path);
  db.exec('PRAGMA journal_mode = WAL;');
  db.exec('PRAGMA foreign_keys = ON;');
  db.exec('PRAGMA busy_timeout = 5000;');
  migrate(db);
  return db;
}

export function migrate(db: DatabaseSync): void {
  db.exec('CREATE TABLE IF NOT EXISTS schema_migrations (version INTEGER PRIMARY KEY, applied_at TEXT NOT NULL);');
  const applied = new Set((db.prepare('SELECT version FROM schema_migrations').all() as Array<{ version: number }>).map((r) => r.version));
  for (const m of MIGRATIONS) {
    if (applied.has(m.version)) continue;
    db.exec('BEGIN');
    try {
      db.exec(m.sql);
      db.prepare('INSERT INTO schema_migrations (version, applied_at) VALUES (?, ?)').run(m.version, new Date().toISOString());
      db.exec('COMMIT');
    } catch (err) {
      db.exec('ROLLBACK');
      throw err;
    }
  }
}

export function transaction<T>(db: DatabaseSync, fn: () => T): T {
  db.exec('BEGIN IMMEDIATE');
  try {
    const result = fn();
    db.exec('COMMIT');
    return result;
  } catch (err) {
    db.exec('ROLLBACK');
    throw err;
  }
}
