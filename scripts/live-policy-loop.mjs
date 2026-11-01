#!/usr/bin/env node
// v2.2 Phase 2: 人間が書いた task.yaml を直接承認して Run を実行し、Policy Gate の差し戻しループ
// （IMPLEMENTING → POLICY_BLOCKED → IMPLEMENTING → VERIFYING → REVIEWING → COMPLETED）の証跡を記録する。
// ヒアリングを経由しないのは、Requirements Agent が Policy Gate を知っていて違反を生まない依頼に整形してしまうため
// （docs/FINAL_REPORT.md 0‴ 参照）。実 CLI（Claude Code / Codex）を呼ぶ。
// 使い方: node scripts/live-policy-loop.mjs --name <id> --repo <path> --task <task.yaml> [--app-data <dir>]
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { execFileSync } from 'node:child_process';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const arg = (k, d) => {
  const i = process.argv.indexOf(k);
  return i >= 0 ? process.argv[i + 1] : d;
};
const name = arg('--name');
const repo = resolve(arg('--repo'));
const taskPath = resolve(arg('--task'));
if (!name || !repo || !taskPath) throw new Error('usage: --name --repo --task');
const appData = resolve(arg('--app-data', join(root, '.tmp', 'dogfood-app-data', name)));
mkdirSync(appData, { recursive: true });
const outDir = join(root, 'test-results', 'dogfood');
mkdirSync(outDir, { recursive: true });

const { createRuntime } = await import(pathToFileURL(join(root, 'apps', 'runner', 'dist', 'main.js')).href);
const { parseAndValidateTaskYaml } = await import(pathToFileURL(join(root, 'apps', 'runner', 'dist', 'requirements', 'task-generator.js')).href);
const rt = createRuntime({ ...process.env, AGENT_ORCHESTRATOR_APP_DATA: appData });
const t0 = Date.now();
const metrics = { name, repo, taskPath, mode: 'engine-only (hand-written task.yaml, no interview)', startedAt: new Date().toISOString(), headBefore: execFileSync('git', ['rev-parse', 'HEAD'], { cwd: repo, encoding: 'utf8' }).trim(), run: null, rounds: [], transitions: [], builderStarts: [], policyGateEvents: [], egress: null, originalRepoUnchanged: null };
const save = () => writeFileSync(join(outDir, `${name}.json`), JSON.stringify(metrics, null, 2));
try {
  const yaml = readFileSync(taskPath, 'utf8').replaceAll('__REPO__', repo); // YAML の plain scalar なのでエスケープ不要
  const parsed = parseAndValidateTaskYaml(yaml);
  if (!parsed.ok) throw new Error(`task.yaml invalid: ${parsed.errors.join('; ')}`);
  metrics.taskYaml = yaml;
  const inspection = await rt.inspector.inspect(repo);
  const project = rt.repo.upsertProject(repo, inspection.ok ? inspection.info : null);
  const draft = rt.repo.createDraft(project.id, `（engine-only）${parsed.task.title}`, []);
  const rev = rt.repo.createRevision(draft.id, null, yaml, []);
  const approved = rt.repo.approveRevision(draft.id, rev.revision, parsed.task, yaml, taskPath);
  const tRun = Date.now();
  const started = await rt.runs.start(approved.id);
  const final = await rt.runs.waitForActive();
  metrics.runMs = Date.now() - tRun;
  const report = rt.runs.report(started.runId);
  metrics.run = { runId: started.runId, state: final.state, reasonCode: final.reasonCode, reasonDetail: final.reasonDetail, rounds: final.currentRound, worktreePath: final.worktreePath, runDir: final.runDir, changedFiles: report.changedFiles, openFindings: report.openFindings, requirementsUnverified: report.requirementsUnverified };
  for (const r of rt.repo.listRounds(started.runId)) {
    const fb = join(final.runDir, 'rounds', String(r.round), 'feedback.json');
    metrics.rounds.push({
      round: r.round,
      builderMs: r.builder?.durationMs ?? null,
      builderCostUsd: r.builder?.costUsd ?? null,
      builderExit: r.builder?.exitCode ?? null,
      diffFiles: r.diff?.files.map((f) => `${f.status} ${f.path} +${f.additions} -${f.deletions}`) ?? [],
      policyFindings: (r.policyFindings ?? []).map((p) => `[${p.severity}${p.approved ? '/approved' : ''}] ${p.ruleId} ${p.file}:${p.line} ${p.evidence}`),
      feedbackArtifact: existsSync(fb) ? JSON.parse(readFileSync(fb, 'utf8')) : null,
      verification: r.verification ? { passed: r.verification.passed, commands: r.verification.commands.map((c) => `${c.name}:${c.exitCode}${c.timedOut ? ':timeout' : ''}:${c.durationMs}ms`) } : null,
      review: r.review ? { verdict: r.review.parsed?.verdict ?? null, parseError: r.review.parseError, durationMs: r.review.durationMs, findings: r.review.parsed?.findings.map((f) => `[${f.severity}] ${f.id} ${f.file}:${f.line} ${f.description}`) ?? [], unverified: r.review.parsed?.requirementsUnverified ?? [], summary: r.review.parsed?.summary ?? null } : null,
      hashMatch: r.workspaceHashBeforeReview !== null && r.workspaceHashBeforeReview === r.workspaceHashAfterReview
    });
  }
  const events = rt.repo.listEvents(started.runId);
  metrics.transitions = events.filter((e) => e.type === 'run.state_changed').map((e) => e.payload.to);
  metrics.builderStarts = events.filter((e) => e.type === 'builder.started').map((e) => ({ round: e.round, payload: e.payload }));
  metrics.policyGateEvents = events.filter((e) => e.type === 'policy.gate').map((e) => ({ round: e.round, payload: e.payload }));
  const egressPath = join(final.runDir, 'egress.jsonl');
  if (existsSync(egressPath)) {
    const lines = readFileSync(egressPath, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l));
    const count = (action) => lines.filter((l) => l.action === action).length;
    metrics.egress = { allow: count('allow'), deny: count('deny'), error: count('error'), deniedHosts: [...new Set(lines.filter((l) => l.action === 'deny').map((l) => l.host))] };
  }
  metrics.originalRepoUnchanged = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: repo, encoding: 'utf8' }).trim() === metrics.headBefore && execFileSync('git', ['status', '--porcelain'], { cwd: repo, encoding: 'utf8' }).trim() === '';
} catch (err) {
  metrics.error = String(err?.stack ?? err);
  console.error(err);
} finally {
  metrics.totalMs = Date.now() - t0;
  metrics.finishedAt = new Date().toISOString();
  save();
  rt.db.close();
  console.log(`[live-policy-loop] ${name}: ${metrics.run?.state ?? 'n/a'} rounds=${metrics.run?.rounds ?? 0} transitions=${metrics.transitions.join('>')} total=${Math.round(metrics.totalMs / 1000)}s → test-results/dogfood/${name}.json`);
}
