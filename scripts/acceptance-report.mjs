#!/usr/bin/env node
// tests/ACCEPTANCE.md のテスト ID ごとに PASS / FAIL / NOT_RUN を集計する。
// 入力: test-results/vitest.json（vitest --reporter=json）、apps/desktop/test-results/playwright.json（存在すれば）、
//       test-results/live.json（LIVE-xx の手動/実機結果。存在すれば）
// 出力: docs/ACCEPTANCE_REPORT.md と標準出力の表
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const acceptance = readFileSync(join(root, 'docs', 'ACCEPTANCE.md'), 'utf8');
const ids = [...acceptance.matchAll(/^\|\s*((?:UI|RA|EX|SEC|AUD)-\d{2})\s*\|\s*([^|]+)\|\s*([^|]+)\|\s*([^|]+)\|/gm)].map((m) => ({ id: m[1], category: m[2].trim(), scenario: m[3].trim(), expected: m[4].trim() }));
const liveIds = [...acceptance.matchAll(/^(LIVE-\d{2}):\s*(.+)$/gm)].map((m) => ({ id: m[1], scenario: m[2].trim() }));

const ID_RE = /\b((?:UI|RA|EX|SEC|AUD|LIVE)-\d{2})\b/g;
/** id → { passed: n, failed: n, tests: [names] } */
const results = new Map();
const record = (name, status) => {
  for (const m of name.matchAll(ID_RE)) {
    const id = m[1];
    const r = results.get(id) ?? { passed: 0, failed: 0, skipped: 0, tests: [] };
    if (status === 'passed') r.passed++;
    else if (status === 'skipped') r.skipped++;
    else r.failed++;
    r.tests.push(`${status === 'passed' ? '✓' : status === 'skipped' ? '○' : '✗'} ${name.slice(0, 120)}`);
    results.set(id, r);
  }
};

const vitestPath = join(root, 'test-results', 'vitest.json');
let vitestSummary = null;
if (existsSync(vitestPath)) {
  const data = JSON.parse(readFileSync(vitestPath, 'utf8'));
  vitestSummary = { total: data.numTotalTests, passed: data.numPassedTests, failed: data.numFailedTests };
  for (const file of data.testResults ?? []) {
    for (const t of file.assertionResults ?? []) {
      const name = [...(t.ancestorTitles ?? []), t.title].join(' > ');
      record(name, t.status === 'passed' ? 'passed' : t.status === 'pending' || t.status === 'skipped' || t.status === 'todo' ? 'skipped' : 'failed');
    }
  }
}

const pwPath = join(root, 'apps', 'desktop', 'test-results', 'playwright.json');
let pwSummary = null;
if (existsSync(pwPath)) {
  const data = JSON.parse(readFileSync(pwPath, 'utf8'));
  let total = 0;
  let passed = 0;
  const walk = (suite, prefix = []) => {
    for (const spec of suite.specs ?? []) {
      for (const test of spec.tests ?? []) {
        total++;
        const status = test.status === 'expected' || test.status === 'flaky' ? 'passed' : test.status === 'skipped' ? 'skipped' : 'failed';
        if (status === 'passed') passed++;
        record([...prefix, suite.title, spec.title].filter(Boolean).join(' > '), status);
      }
    }
    for (const s of suite.suites ?? []) walk(s, [...prefix, suite.title]);
  };
  for (const s of data.suites ?? []) walk(s);
  pwSummary = { total, passed, failed: total - passed };
}

const livePath = join(root, 'test-results', 'live.json');
const live = existsSync(livePath) ? JSON.parse(readFileSync(livePath, 'utf8')) : {};

const statusOf = (id) => {
  const r = results.get(id);
  if (!r || r.tests.length === 0) return 'NOT_RUN';
  if (r.failed > 0) return 'FAIL';
  if (r.passed > 0) return 'PASS';
  return 'NOT_RUN';
};

const rows = ids.map((x) => ({ ...x, status: statusOf(x.id), tests: results.get(x.id)?.tests ?? [] }));
const liveRows = liveIds.map((x) => ({ ...x, status: live[x.id]?.status ?? 'NOT_RUN', note: live[x.id]?.note ?? '実機未実施' }));
const counts = { PASS: 0, FAIL: 0, NOT_RUN: 0 };
for (const r of [...rows, ...liveRows]) counts[r.status] = (counts[r.status] ?? 0) + 1;

const lines = [];
lines.push('# 受入テスト結果', '', `生成: ${new Date().toISOString()}`, '');
lines.push(`- Vitest: ${vitestSummary ? `${vitestSummary.passed}/${vitestSummary.total} passed` : '未実行（pnpm test:run を先に実行）'}`);
lines.push(`- Playwright: ${pwSummary ? `${pwSummary.passed}/${pwSummary.total} passed` : '未実行（pnpm test:e2e を先に実行）'}`);
lines.push(`- 集計: PASS ${counts.PASS} / FAIL ${counts.FAIL} / NOT_RUN ${counts.NOT_RUN}`, '');
lines.push('PASS = 対応する自動テストがすべて成功。FAIL = 1 件以上失敗。NOT_RUN = 対応テストの実行結果なし（LIVE は実機未実施）。', '');
lines.push('| ID | 分類 | シナリオ | 期待結果 | 結果 | 対応テスト |', '|---|---|---|---|---|---|');
for (const r of rows) lines.push(`| ${r.id} | ${r.category} | ${r.scenario} | ${r.expected} | **${r.status}** | ${r.tests.length} |`);
lines.push('', '## LIVE（実 CLI / 実機）', '', '| ID | シナリオ | 結果 | 備考 |', '|---|---|---|---|');
for (const r of liveRows) lines.push(`| ${r.id} | ${r.scenario} | **${r.status}** | ${r.note} |`);
lines.push('', '## 対応テスト詳細', '');
for (const r of rows) {
  lines.push(`### ${r.id} — ${r.status}`);
  for (const t of r.tests) lines.push(`- ${t}`);
  if (r.tests.length === 0) lines.push('- （対応テストなし）');
  lines.push('');
}
writeFileSync(join(root, 'docs', 'ACCEPTANCE_REPORT.md'), lines.join('\n'), 'utf8');

const pad = (s, n) => String(s).padEnd(n);
console.log(`${pad('ID', 8)}${pad('STATUS', 9)}SCENARIO`);
for (const r of [...rows, ...liveRows]) console.log(`${pad(r.id, 8)}${pad(r.status, 9)}${r.scenario}`);
console.log(`\nPASS ${counts.PASS} / FAIL ${counts.FAIL} / NOT_RUN ${counts.NOT_RUN}  → docs/ACCEPTANCE_REPORT.md`);
process.exitCode = counts.FAIL > 0 ? 1 : 0;
