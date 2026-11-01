#!/usr/bin/env node
import { createRequire } from 'node:module';
import type { DraftView, RunEvent, RunStatus, SandboxSetupState } from '@agent-orchestrator/contracts';
import { ClaudeBuilder } from './agents/claude.js';
import { CodexReviewer } from './agents/codex.js';
import { ClaudeInterviewModel } from './agents/requirements.js';
import { ensureAppDataLayout, loadConfig } from './config.js';
import { loadClaudeCredentials, loadCodexCredentials } from './credentials.js';
import { LocalEnvironmentAdapter } from './environment.js';
import { IpcServer } from './ipc.js';
import { DockerSandbox } from './isolation/docker.js';
import { createPreflight } from './preflight.js';
import { SandboxSetupService } from './sandbox/setup.js';
import { RepoInspector } from './requirements/repo-inspector.js';
import { DraftService } from './requirements/service.js';
import { RunService } from './run-service.js';
import { openDatabase } from './storage/db.js';
import { FileAndDbRecorder } from './storage/recorder.js';
import { Repository } from './storage/repository.js';
import { SandboxVerifier } from './verification/runner.js';
import { WorkspaceManager } from './workspace.js';

/**
 * Node サイドカーのエントリ。`--ipc stdio` で stdin/stdout の行単位 JSON を処理する。
 * ネットワーク待受は行わない。ログは stderr。
 */
/** SEA（単一実行ファイル）では import.meta.url が使えないので、バンドル時に埋め込まれた値を優先する。 */
declare const __RUNNER_VERSION__: string | undefined;
function resolveVersion(): string {
  if (typeof __RUNNER_VERSION__ === 'string') return __RUNNER_VERSION__;
  try {
    const require = createRequire(import.meta.url);
    return (require('../package.json') as { version: string }).version;
  } catch {
    return '0.0.0-unknown';
  }
}
const VERSION = resolveVersion();

function isSingleExecutable(): boolean {
  try {
    // node:sea は SEA 以外でも読み込めるが isSea() が false を返す
    return (process.getBuiltinModule?.('node:sea') as { isSea?: () => boolean } | undefined)?.isSea?.() ?? false;
  } catch {
    return false;
  }
}

export function createRuntime(env: NodeJS.ProcessEnv = process.env) {
  const config = loadConfig(env);
  const layout = ensureAppDataLayout(config);
  const db = openDatabase(layout.dbPath);
  const repo = new Repository(db);
  const workspace = new WorkspaceManager({ worktreesDir: config.worktreesDir, maxDiffBytes: config.maxDiffBytes });
  const environment = new LocalEnvironmentAdapter({ config, env });
  const sandbox = new DockerSandbox({ config });
  const recorder = new FileAndDbRecorder(repo, layout.runsDir, config.maxLogBytes);
  const inspector = new RepoInspector(config, workspace);
  const claudeCreds = () => loadClaudeCredentials(env);
  const codexCreds = () => loadCodexCredentials(env);

  const listeners = { draft: new Set<(v: DraftView) => void>(), run: new Set<(s: RunStatus) => void>(), event: new Set<(e: RunEvent) => void>(), sandbox: new Set<(s: SandboxSetupState) => void>() };
  const sandboxSetup = new SandboxSetupService({ config, onProgress: (s) => listeners.sandbox.forEach((l) => l(s)) });

  const drafts = new DraftService({
    repo,
    inspector,
    model: new ClaudeInterviewModel(sandbox, claudeCreds),
    tasksDir: layout.tasksDir,
    onDraftUpdated: (v) => listeners.draft.forEach((l) => l(v))
  });
  const runs = new RunService({
    repo,
    recorder,
    runsDir: layout.runsDir,
    sandbox,
    engineDeps: {
      preflight: createPreflight({ config, environment, workspace, env }),
      workspace,
      transport: {
        push: (runId, ws) => sandbox.pushWorkspace(runId, ws.path),
        pull: (runId, ws) => sandbox.pullWorkspace(runId, ws.path)
      },
      builder: new ClaudeBuilder(sandbox, claudeCreds, 10, config.sandboxEnv),
      verifier: new SandboxVerifier(sandbox, config.sandboxEnv),
      reviewer: new CodexReviewer(sandbox, codexCreds)
    },
    onRunUpdated: (s) => listeners.run.forEach((l) => l(s)),
    onRunEvent: (e) => listeners.event.forEach((l) => l(e))
  });
  return { config, layout, db, repo, workspace, environment, sandbox, recorder, inspector, drafts, runs, listeners, sandboxSetup };
}

export function registerHandlers(server: IpcServer, rt: ReturnType<typeof createRuntime>): void {
  server.register('environment.check', async () => rt.environment.check());
  server.register('project.inspect', async (p) => {
    const { path } = p as { path: string };
    const r = await rt.inspector.inspect(path);
    if (r.ok) rt.repo.upsertProject(r.info.path, r.info);
    return r.info;
  });
  server.register('draft.create', async (p) => rt.drafts.create(p as { projectPath: string; request: string }));
  server.register('draft.answer', async (p) => rt.drafts.answer(p as Parameters<DraftService['answer']>[0]));
  server.register('draft.revise', async (p) => rt.drafts.revise(p as Parameters<DraftService['revise']>[0]));
  server.register('draft.approve', async (p) => rt.drafts.approve(p as Parameters<DraftService['approve']>[0]));
  server.register('run.start', async (p) => rt.runs.start((p as { approvedTaskId: string }).approvedTaskId));
  server.register('run.cancel', async (p) => rt.runs.cancel((p as { runId: string }).runId));
  server.register('run.status', async (p) => {
    const { runId, sinceSequence } = p as { runId: string; sinceSequence?: number };
    return rt.runs.status(runId, sinceSequence ?? 0);
  });
  server.register('run.list', async (p) => ({ runs: rt.runs.list((p as { limit?: number }).limit ?? 50) }));
  server.register('run.report', async (p) => rt.runs.report((p as { runId: string }).runId));
  server.register('sandbox.setup', async (p) => rt.sandboxSetup.start(p as { acknowledgePull: true }));
  server.register('sandbox.cancel', async () => rt.sandboxSetup.cancel());
  server.register('sandbox.status', async () => rt.sandboxSetup.status());
  rt.listeners.sandbox.add((s) => server.emit({ event: 'sandbox.progress', payload: s as unknown as Record<string, unknown> }));

  rt.listeners.draft.add((v) => server.emit({ event: 'draft.updated', payload: v as unknown as Record<string, unknown> }));
  rt.listeners.run.add((s) => server.emit({ event: 'run.updated', runId: s.runId, payload: s as unknown as Record<string, unknown> }));
  rt.listeners.event.add((e) => {
    server.emit({ event: 'run.event', runId: e.runId, payload: e as unknown as Record<string, unknown> });
    const status = rt.repo.getRun(e.runId);
    if (status && e.type === 'run.state_changed') server.emit({ event: 'run.updated', runId: e.runId, payload: status as unknown as Record<string, unknown> });
  });
}

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  if (args.includes('--version')) {
    process.stdout.write(`${VERSION}\n`);
    return;
  }
  const log = (line: string) => process.stderr.write(`${new Date().toISOString()} ${line}\n`);
  const rt = createRuntime();
  const recovered = rt.runs.recoverInterruptedRuns();
  if (recovered.length > 0) log(`[recovery] ${recovered.length} run(s) marked INTERRUPTED: ${recovered.map((r) => r.runId).join(', ')}`);

  if (args.includes('--check')) {
    const report = await rt.environment.check();
    process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
    process.exitCode = report.canRun ? 0 : 1;
    rt.db.close();
    return;
  }

  const server = new IpcServer(process.stdin, process.stdout, log);
  registerHandlers(server, rt);
  server.start();
  server.emit({ event: 'runner.ready', payload: { version: VERSION, pid: process.pid, appDataDir: rt.config.appDataDir, recovered: recovered.map((r) => r.runId) } });
  log(`[runner] ready v${VERSION} app-data=${rt.config.appDataDir}`);

  const shutdown = async (signal: string) => {
    log(`[runner] ${signal} received, stopping`);
    try {
      const active = await Promise.race([rt.runs.waitForActive(), new Promise<null>((r) => setTimeout(() => r(null), 100))]);
      void active;
    } catch {
      /* ignore */
    }
    await server.flush();
    rt.db.close();
    process.exit(0);
  };
  process.on('SIGINT', () => void shutdown('SIGINT'));
  process.on('SIGTERM', () => void shutdown('SIGTERM'));
  process.stdin.on('end', () => void shutdown('stdin-end'));
}

const isEntry = isSingleExecutable() || (process.argv[1] !== undefined && /main\.(js|ts|cjs)$/.test(process.argv[1]));
if (isEntry) {
  main().catch((err) => {
    process.stderr.write(`[runner] fatal: ${(err as Error).stack ?? String(err)}\n`);
    process.exit(1);
  });
}
