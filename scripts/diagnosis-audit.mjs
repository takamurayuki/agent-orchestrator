#!/usr/bin/env node
// 事前診断（D-38）の偽陽性・偽陰性を実プロジェクトのコピーで確認する。
// 使い方: node scripts/diagnosis-audit.mjs <repoPath> [<repoPath> ...]   → test-results/diagnosis-audit.json
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const { loadConfig } = await import(pathToFileURL(join(root, 'apps', 'runner', 'dist', 'config.js')).href);
const { RepoInspector } = await import(pathToFileURL(join(root, 'apps', 'runner', 'dist', 'requirements', 'repo-inspector.js')).href);
const { WorkspaceManager } = await import(pathToFileURL(join(root, 'apps', 'runner', 'dist', 'workspace.js')).href);

const targets = process.argv.slice(2).map((p) => resolve(p));
if (targets.length === 0) throw new Error('usage: node scripts/diagnosis-audit.mjs <repo> [...]');
const config = loadConfig({});
const inspector = new RepoInspector(config, new WorkspaceManager({ worktreesDir: join(root, '.tmp', 'diag-wt') }));
const results = [];
for (const repo of targets) {
  const t0 = Date.now();
  const r = await inspector.inspect(repo);
  const ms = Date.now() - t0;
  if (!r.ok) {
    results.push({ repo, ok: false, code: r.code, message: r.message, ms });
    console.log(`${repo}: NOT OK ${r.code} ${r.message}`);
    continue;
  }
  results.push({ repo, ok: true, status: r.info.status, verdict: r.info.diagnosis.verdict, problems: r.info.problems.map((p) => p.code), checks: r.info.diagnosis.checks.map((c) => ({ id: c.id, status: c.status, detail: c.detail.slice(0, 160) })), ms });
  console.log(`${repo}: status=${r.info.status} verdict=${r.info.diagnosis.verdict} (${ms} ms)`);
  for (const c of r.info.diagnosis.checks) if (c.status !== 'ok') console.log(`  [${c.status}] ${c.id}: ${c.detail.slice(0, 140)}`);
}
mkdirSync(join(root, 'test-results'), { recursive: true });
writeFileSync(join(root, 'test-results', 'diagnosis-audit.json'), JSON.stringify(results, null, 2));
console.log(`→ test-results/diagnosis-audit.json`);
