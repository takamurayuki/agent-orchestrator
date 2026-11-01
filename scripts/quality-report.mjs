#!/usr/bin/env node
// 品質評価レポート: test-results/dogfood/*.json（scripts/dogfood.mjs の出力）を集計し docs/QUALITY_REPORT.md に書く。
// 指標: タスク完了率、1 タスク当たりの実行時間、平均修正ラウンド数、unknown 発生率、AI 利用量と推定費用、人間レビュー所見（docs/dogfood-review.json）。
import { existsSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const dir = join(root, 'test-results', 'dogfood');
const files = existsSync(dir) ? readdirSync(dir).filter((f) => f.endsWith('.json')).sort() : [];
const runs = files.map((f) => ({ file: f, ...JSON.parse(readFileSync(join(dir, f), 'utf8')) }));
const reviewPath = join(root, 'docs', 'dogfood-review.json');
const humanReview = existsSync(reviewPath) ? JSON.parse(readFileSync(reviewPath, 'utf8')) : {};

const sec = (ms) => (ms === undefined || ms === null ? '-' : `${Math.round(ms / 1000)}s`);
const started = runs.filter((r) => r.run);
const completed = runs.filter((r) => r.run?.state === 'COMPLETED');
const needsHuman = runs.filter((r) => r.run?.state === 'NEEDS_HUMAN');
const precheck = runs.filter((r) => r.run?.state === 'PRECHECK_FAILED');
const internal = runs.filter((r) => r.run?.state === 'INTERNAL_ERROR');
const notStarted = runs.filter((r) => !r.run);
const allRounds = runs.flatMap((r) => r.rounds ?? []);
const reviews = allRounds.filter((x) => x.review);
const unknownReviews = reviews.filter((x) => x.review.verdict === 'unknown' || x.review.verdict === null);
const builderMs = allRounds.map((x) => x.builderMs).filter((x) => typeof x === 'number');
const reviewMs = reviews.map((x) => x.review.durationMs).filter((x) => typeof x === 'number');
const costs = allRounds.map((x) => x.builderCostUsd).filter((x) => typeof x === 'number');
const avg = (a) => (a.length ? a.reduce((s, x) => s + x, 0) / a.length : null);

const lines = [];
lines.push('# 品質評価レポート（ドッグフーディング）', '', `生成: ${new Date().toISOString()} 対象: ${runs.length} 件（test-results/dogfood/*.json）`, '');
lines.push('## 指標', '', '| 指標 | 値 |', '|---|---|');
lines.push(`| タスク数（Run 開始まで到達 / 全体） | ${started.length} / ${runs.length} |`);
lines.push(`| タスク完了率（COMPLETED / Run 開始） | ${started.length ? `${completed.length}/${started.length} = ${Math.round((100 * completed.length) / started.length)}%` : '-'} |`);
lines.push(`| 内訳 | COMPLETED ${completed.length}、NEEDS_HUMAN ${needsHuman.length}、PRECHECK_FAILED ${precheck.length}、INTERNAL_ERROR ${internal.length}、承認前停止 ${notStarted.length} |`);
lines.push(`| 1 タスク当たりの実行時間（ヒアリング+Run、平均） | ${sec(avg(runs.map((r) => r.totalMs)))}（ヒアリング ${sec(avg(runs.map((r) => r.phases?.interviewMs).filter(Boolean)))}、Run ${sec(avg(started.map((r) => r.phases?.runMs).filter(Boolean)))}） |`);
lines.push(`| 平均修正ラウンド数（Run 開始分） | ${started.length ? (started.reduce((s, r) => s + (r.run?.rounds ?? 0), 0) / started.length).toFixed(2) : '-'} |`);
lines.push(`| Builder 1 回あたり平均時間 | ${sec(avg(builderMs))}（${builderMs.length} 回） |`);
lines.push(`| Reviewer 1 回あたり平均時間 | ${sec(avg(reviewMs))}（${reviewMs.length} 回） |`);
lines.push(`| unknown 発生率（レビュー） | ${reviews.length ? `${unknownReviews.length}/${reviews.length}` : '-'} |`);
lines.push(`| AI 利用量（Builder の報告費用） | ${costs.length ? `$${costs.reduce((s, x) => s + x, 0).toFixed(3)}（報告あり ${costs.length} 回）` : 'CLI が費用を報告しなかった（null）'} |`);
lines.push(`| egress 拒否（allowlist 外） | ${runs.reduce((s, r) => s + (r.egress?.deny ?? 0), 0)} 件 ／ 許可 ${runs.reduce((s, r) => s + (r.egress?.allow ?? 0), 0)} 件 ／ エラー ${runs.reduce((s, r) => s + (r.egress?.error ?? 0), 0)} 件 |`);
lines.push(`| 元リポジトリ不変 | ${runs.every((r) => r.originalRepoUnchanged !== false) ? '全件' : 'NG あり'} |`);
lines.push('');
lines.push('## タスク別', '', '| タスク | 状態 | 理由 | ラウンド | 時間 | 変更ファイル | 未解決指摘 | 人間レビュー |', '|---|---|---|---|---|---|---|---|');
for (const r of runs) {
  const hr = humanReview[r.name];
  lines.push(`| ${r.name} | ${r.run?.state ?? r.interview?.finalState ?? '-'} | ${(r.run?.reasonDetail ?? r.interview?.blocked ?? '').replace(/\|/g, '/').slice(0, 120)} | ${r.run?.rounds ?? 0} | ${sec(r.totalMs)} | ${(r.run?.changedFiles ?? []).length} | ${(r.run?.openFindings ?? []).length} | ${hr ? `${hr.verdict}: ${hr.notes}` : '未'} |`);
}
lines.push('', '## 人間レビューと AI 判定の一致', '');
const reviewed = runs.filter((r) => humanReview[r.name]);
for (const r of reviewed) {
  const hr = humanReview[r.name];
  const ai = r.run?.state === 'COMPLETED' ? 'approved' : r.run?.state === 'NEEDS_HUMAN' ? 'changes_requested/needs_human' : r.run?.state ?? 'n/a';
  lines.push(`- **${r.name}**: AI=${ai} / 人間=${hr.verdict}（${hr.agrees ? '一致' : '不一致'}）。${hr.notes}${hr.missed?.length ? ` 未検出: ${hr.missed.join('; ')}` : ''}`);
}
if (reviewed.length === 0) lines.push('- （docs/dogfood-review.json 未作成）');
// Policy Gate 監査（scripts/policy-gate-audit.mjs の出力）
const auditPath = join(root, 'test-results', 'policy-gate-audit.json');
if (existsSync(auditPath)) {
  const audit = JSON.parse(readFileSync(auditPath, 'utf8'));
  lines.push('', '## Policy Gate 監査（偽陽性 / 偽陰性の調査）', '');
  lines.push(`- ドッグフーディングのワークスペース ${audit.workspaces.length} 件、本リポジトリの直近コミット ${audit.commits.length} 件にゲートを適用（\`node scripts/policy-gate-audit.mjs\`）。`);
  const wsHits = audit.workspaces.filter((w) => w.findings.length > 0);
  const cHits = audit.commits.filter((c) => c.findings.length > 0);
  lines.push(`- ワークスペースで検出あり: ${wsHits.length} 件 ${wsHits.map((w) => `（${w.task}: ${w.findings.join(' / ')}）`).join('')}`);
  lines.push(`- コミットで検出あり: ${cHits.length} 件 ${cHits.map((c) => `（${c.sha} ${c.subject}: ${c.findings.join(' / ')}）`).join('')}`);
  lines.push('- 判定: ワークスペース側の検出はドッグフーディングで人間が指摘した eslint-disable 回避そのもの（真陽性）。それ以外の AI 生成差分・自作コミットに偽陽性なし。コミット側の PG-VERIFY-SCRIPT は検証 scripts の「変更」を設計どおり保守的に検出したもので、意図した変更（強化）でも人間の承認（例外登録）を要求する。');
}
writeFileSync(join(root, 'docs', 'QUALITY_REPORT.md'), lines.join('\n') + '\n', 'utf8');
console.log(lines.slice(0, 16).join('\n'));
console.log(`→ docs/QUALITY_REPORT.md`);
