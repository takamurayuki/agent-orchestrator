#!/usr/bin/env node
// Policy Gate の偽陽性・偽陰性調査。
//  (a) ドッグフーディング Run のワークスペース（.tmp/dogfood-app-data/*/worktrees/<runId>）に対して、ベースコミットと作業ツリーを比較して検出を列挙する
//  (b) 本リポジトリの Git 履歴（直近 N コミット）の各コミット差分に対してゲートを適用し、検出を列挙する（既存プロジェクトでの偽陽性の目安）
// 使い方: node scripts/policy-gate-audit.mjs [--commits 20]
import { execFileSync } from 'node:child_process';
import { existsSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const { evaluatePolicyGate, parsePolicyExceptions } = await import(pathToFileURL(join(root, 'apps', 'runner', 'dist', 'policy-gate.js')).href);
const git = (cwd, args) => execFileSync('git', args, { cwd, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
const show = (cwd, rev, path) => {
  try {
    return git(cwd, ['show', `${rev}:${path}`]);
  } catch {
    return null;
  }
};
const status = (code) => (code === 'A' ? 'added' : code === 'D' ? 'deleted' : code.startsWith('R') ? 'renamed' : 'modified');
const results = { workspaces: [], commits: [] };

// (a) dogfood workspaces
const dataRoot = join(root, '.tmp', 'dogfood-app-data');
if (existsSync(dataRoot)) {
  for (const task of readdirSync(dataRoot)) {
    const wt = join(dataRoot, task, 'worktrees');
    if (!existsSync(wt)) continue;
    for (const runId of readdirSync(wt)) {
      const ws = join(wt, runId);
      let baseSha;
      try {
        baseSha = git(ws, ['rev-parse', 'HEAD']).trim();
      } catch {
        continue;
      }
      const nameStatus = git(ws, ['status', '--porcelain', '--untracked-files=all']).split('\n').filter(Boolean);
      const files = nameStatus
        .map((l) => ({ code: l.slice(0, 2).trim(), path: l.slice(3).trim() }))
        .filter((f) => !/^(node_modules|\.pnpm-store|dist|coverage)\//.test(f.path))
        .map((f) => ({ path: f.path, status: f.code === '??' ? 'untracked' : status(f.code), additions: 0, deletions: 0 }));
      const baseContents = {};
      const currentContents = {};
      for (const f of files) {
        baseContents[f.path] = f.status === 'untracked' || f.status === 'added' ? null : show(ws, baseSha, f.path);
        currentContents[f.path] = f.status === 'deleted' ? null : existsSync(join(ws, f.path)) ? readFileSync(join(ws, f.path), 'utf8') : null;
      }
      const r = evaluatePolicyGate({ files, baseContents, currentContents, exceptions: parsePolicyExceptions(show(ws, baseSha, '.agent-orchestrator/policy.json')) });
      results.workspaces.push({ task, runId, files: files.map((f) => f.path), findings: r.findings.map((x) => `${x.ruleId} ${x.file}:${x.line} ${x.evidence}`) });
    }
  }
}

// (b) own history
const n = Number(process.argv[process.argv.indexOf('--commits') + 1] || 20) || 20;
const commits = git(root, ['log', `-${n}`, '--format=%H %s']).split('\n').filter(Boolean);
for (const line of commits) {
  const [sha, ...rest] = line.split(' ');
  const subject = rest.join(' ');
  let parent;
  try {
    parent = git(root, ['rev-parse', `${sha}^`]).trim();
  } catch {
    continue;
  }
  const entries = git(root, ['diff', '--name-status', parent, sha]).split('\n').filter(Boolean);
  const files = entries.map((l) => {
    const parts = l.split('\t');
    const code = parts[0];
    const path = parts[parts.length - 1];
    return { path, status: status(code), additions: 0, deletions: 0 };
  });
  const baseContents = {};
  const currentContents = {};
  for (const f of files) {
    baseContents[f.path] = f.status === 'added' ? null : show(root, parent, f.path);
    currentContents[f.path] = f.status === 'deleted' ? null : show(root, sha, f.path);
  }
  const r = evaluatePolicyGate({ files, baseContents, currentContents, exceptions: [] });
  results.commits.push({ sha: sha.slice(0, 7), subject: subject.slice(0, 70), files: files.length, findings: r.findings.map((x) => `${x.ruleId} ${x.file}:${x.line} ${x.evidence}`) });
}

writeFileSync(join(root, 'test-results', 'policy-gate-audit.json'), JSON.stringify(results, null, 2));
console.log('## dogfood workspaces');
for (const w of results.workspaces) console.log(`- ${w.task}/${w.runId}: ${w.files.length} files → ${w.findings.length ? w.findings.join(' | ') : 'no findings'}`);
console.log('## own commits');
for (const c of results.commits) console.log(`- ${c.sha} ${c.subject}: ${c.files} files → ${c.findings.length ? c.findings.join(' | ') : 'no findings'}`);
