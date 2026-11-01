#!/usr/bin/env node
// ドッグフーディング: 実リポジトリのコピーに対して依頼 → ヒアリング（機械回答）→ 承認 → Run を実行し、指標を JSON に記録する。
// 使い方: node scripts/dogfood.mjs --name <id> --repo <path> --request "<依頼>" [--answer <value>] [--prefer v1,v2,...] [--app-data <dir>]
//   --prefer: 選択肢の value が一致（部分一致可）するものを優先して選ぶ（v2.2 Policy Gate 差し戻しループの再現用。既定は先頭の選択肢）
// 実 CLI（Claude Code / Codex）を呼ぶ。予算: Builder --max-budget-usd 10、RA 3、cliTimeoutSeconds 900、試行 3 回（task.yaml 既定）。
import { mkdirSync, writeFileSync, readFileSync, existsSync } from 'node:fs';
import { join, dirname, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { execFileSync } from 'node:child_process';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const arg = (k, d) => {
  const i = process.argv.indexOf(k);
  return i >= 0 ? process.argv[i + 1] : d;
};
const name = arg('--name');
const repo = resolve(arg('--repo'));
const request = arg('--request');
const freeAnswer = arg('--answer', '既存の規約に合わせて最小限で実装してください。判断が必要な点は推奨案に従ってください。');
const prefer = (arg('--prefer', '') || '').split(',').map((s) => s.trim().toLowerCase()).filter(Boolean);
const pick = (q) => {
  for (const p of prefer) {
    const hit = q.options.find((o) => o.value.toLowerCase() === p) ?? q.options.find((o) => o.value.toLowerCase().includes(p) || o.label.toLowerCase().includes(p));
    if (hit) return hit.value;
  }
  return q.options[0]?.value ?? freeAnswer;
};
if (!name || !repo || !request) throw new Error('usage: --name --repo --request');
const appData = resolve(arg('--app-data', join(root, '.tmp', 'dogfood-app-data', name)));
mkdirSync(appData, { recursive: true });
const outDir = join(root, 'test-results', 'dogfood');
mkdirSync(outDir, { recursive: true });

const { createRuntime } = await import(pathToFileURL(join(root, 'apps', 'runner', 'dist', 'main.js')).href);
const rt = createRuntime({ ...process.env, AGENT_ORCHESTRATOR_APP_DATA: appData });
const t0 = Date.now();
const metrics = { name, repo, request, startedAt: new Date().toISOString(), headBefore: execFileSync('git', ['rev-parse', 'HEAD'], { cwd: repo, encoding: 'utf8' }).trim(), phases: {}, interview: { rounds: 0, questions: [], blocked: null }, run: null, rounds: [], egress: null, originalRepoUnchanged: null };
const save = () => writeFileSync(join(outDir, `${name}.json`), JSON.stringify(metrics, null, 2));
try {
  const tDraft = Date.now();
  let draft = await rt.drafts.create({ projectPath: repo, request });
  for (let i = 0; i < 6 && draft.state === 'ASKING'; i++) {
    metrics.interview.rounds = draft.round;
    for (const q of draft.currentQuestions) metrics.interview.questions.push({ id: q.id, impact: q.decisionImpact, question: q.question, options: q.options.map((o) => o.value), recommendation: q.recommendation.slice(0, 200) });
    const chosen = draft.currentQuestions.map((q) => ({ questionId: q.id, value: pick(q), skipped: false }));
    for (const c of chosen) metrics.interview.questions.find((x) => x.id === c.questionId).chosen = c.value;
    draft = await rt.drafts.answer({ draftId: draft.id, answers: chosen });
  }
  metrics.phases.interviewMs = Date.now() - tDraft;
  metrics.interview.finalState = draft.state;
  metrics.interview.summary = draft.summary;
  metrics.interview.proposal = draft.proposal;
  metrics.interview.decisions = draft.decisions;
  if (draft.state !== 'AWAITING_APPROVAL') {
    metrics.interview.blocked = draft.blockedReason ?? draft.validationErrors.join('; ');
    console.log(`[dogfood] draft did not reach approval: ${draft.state} ${metrics.interview.blocked}`);
  } else {
    const approved = await rt.drafts.approve({ draftId: draft.id, revision: draft.revision, acknowledgeDataSharing: true });
    metrics.taskYaml = approved.taskYaml;
    const tRun = Date.now();
    const started = await rt.runs.start(approved.approvedTaskId);
    const final = await rt.runs.waitForActive();
    metrics.phases.runMs = Date.now() - tRun;
    const report = rt.runs.report(started.runId);
    metrics.run = { runId: started.runId, state: final.state, reasonCode: final.reasonCode, reasonDetail: final.reasonDetail, rounds: final.currentRound, worktreePath: final.worktreePath, runDir: final.runDir, changedFiles: report.changedFiles, openFindings: report.openFindings, requirementsUnverified: report.requirementsUnverified };
    for (const r of rt.repo.listRounds(started.runId)) {
      metrics.rounds.push({
        round: r.round,
        builderMs: r.builder?.durationMs ?? null,
        builderCostUsd: r.builder?.costUsd ?? null,
        builderExit: r.builder?.exitCode ?? null,
        diffFiles: r.diff?.files.map((f) => `${f.status} ${f.path} +${f.additions} -${f.deletions}`) ?? [],
        verification: r.verification ? { passed: r.verification.passed, commands: r.verification.commands.map((c) => `${c.name}:${c.exitCode}${c.timedOut ? ':timeout' : ''}:${c.durationMs}ms`) } : null,
        review: r.review ? { verdict: r.review.parsed?.verdict ?? null, parseError: r.review.parseError, durationMs: r.review.durationMs, findings: r.review.parsed?.findings.map((f) => `[${f.severity}] ${f.id} ${f.file}:${f.line} ${f.description}`) ?? [], unverified: r.review.parsed?.requirementsUnverified ?? [], summary: r.review.parsed?.summary ?? null } : null,
        hashMatch: r.workspaceHashBeforeReview !== null && r.workspaceHashBeforeReview === r.workspaceHashAfterReview,
        policyFindings: (r.policyFindings ?? []).map((p) => `[${p.severity}${p.approved ? '/approved' : ''}] ${p.ruleId} ${p.file}:${p.line} ${p.evidence}`),
        scopeCheck: r.scopeCheck ?? null,
        feedbackArtifact: existsSync(join(final.runDir, 'rounds', String(r.round), 'feedback.json')) ? JSON.parse(readFileSync(join(final.runDir, 'rounds', String(r.round), 'feedback.json'), 'utf8')) : null
      });
    }
    // 状態遷移とフィードバック受け渡しのログ証跡（v2.2 Phase 2）
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
  console.log(`[dogfood] ${name}: ${metrics.run?.state ?? metrics.interview.finalState} rounds=${metrics.run?.rounds ?? 0} total=${Math.round(metrics.totalMs / 1000)}s → test-results/dogfood/${name}.json`);
}
