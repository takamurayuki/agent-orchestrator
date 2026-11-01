#!/usr/bin/env node
// スコープ判定（D-39）を過去のドッグフーディング Run の差分に適用し、検出・誤検出を人間の判断と比べる。
// 期待変更範囲は当時の task.yaml には無いため、依頼文に書かれたファイル / 領域から人手で与える（docs/scope-replay.json）。
// 使い方: node scripts/scope-replay.mjs   → test-results/scope-replay.json
import { existsSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const { evaluateScope } = await import(pathToFileURL(join(root, 'apps', 'runner', 'dist', 'scope.js')).href);
const cases = JSON.parse(readFileSync(join(root, 'docs', 'scope-replay.json'), 'utf8'));
const out = [];
for (const c of cases) {
  const appData = join(root, '.tmp', 'dogfood-app-data', c.name, 'runs');
  if (!existsSync(appData)) {
    out.push({ ...c, result: 'no local run data' });
    continue;
  }
  const runId = readdirSync(appData)[0];
  const roundsDir = join(appData, runId, 'rounds');
  const rounds = existsSync(roundsDir) ? readdirSync(roundsDir).filter((r) => r !== '0').sort() : [];
  const perRound = [];
  for (const r of rounds) {
    const p = join(roundsDir, r, 'round.json');
    if (!existsSync(p)) continue;
    const rec = JSON.parse(readFileSync(p, 'utf8'));
    if (!rec.diff) continue;
    const sc = evaluateScope(rec.diff.files, c.expectedChanges, rec.builder?.resultExcerpt ?? null);
    perRound.push({ round: Number(r), files: rec.diff.files.map((f) => f.path), severity: sc.severity, unexpected: sc.unexpected });
  }
  const firstMajor = perRound.find((x) => x.severity === 'major');
  const detected = firstMajor ? 'major' : perRound.some((x) => x.severity === 'minor') ? 'minor' : 'none';
  out.push({ ...c, rounds: perRound, detected, agreesWithHuman: detected === c.humanJudgement });
  console.log(`${c.name}: detected=${detected} human=${c.humanJudgement} ${detected === c.humanJudgement ? 'OK' : 'MISMATCH'}`);
}
writeFileSync(join(root, 'test-results', 'scope-replay.json'), JSON.stringify(out, null, 2));
console.log('→ test-results/scope-replay.json');
