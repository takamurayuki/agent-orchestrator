import { execFileSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { createRuntime } from '../../apps/runner/src/main.js';

/**
 * LIVE-01 / LIVE-02: 実 CLI（Claude Code / Codex）・実 Docker・専用サンプルリポジトリでの end-to-end。
 * RUN_LIVE_E2E=1 のときだけ実行する。モデル API を呼ぶため費用と時間がかかる（数分〜）。
 * 事前条件: pnpm sandbox:build、ホストで claude / codex にログイン済み、インターネット接続。
 */
const enabled = process.env.RUN_LIVE_E2E === '1';
const d = enabled ? describe : describe.skip;

d('LIVE pipeline (real CLIs in sandbox)', () => {
  const root = mkdtempSync(join(tmpdir(), 'ao-live-'));
  const sample = join(root, 'sample-repo');
  const appData = join(root, 'app-data');
  execFileSync('node', [join(process.cwd(), 'tests', 'fixtures', 'make-sample-repo.mjs'), sample], { stdio: 'inherit' });
  const headBefore = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: sample, encoding: 'utf8' }).trim();
  const rt = createRuntime({ ...process.env, AGENT_ORCHESTRATOR_APP_DATA: appData });

  afterAll(() => {
    rt.db.close();
    // ワークスペースは保全する（確認用）。一時リポジトリは残す
    console.log(`LIVE artifacts kept at ${root}`);
  });

  it('LIVE-01: request → interview → approve → implement → verify → review → result', async () => {
    const env = await rt.environment.check();
    expect(env.canRun, JSON.stringify(env.checks.filter((c) => c.status !== 'ok'))).toBe(true);

    let draft = await rt.drafts.create({ projectPath: sample, request: 'greet 関数に、名前が空文字のときは "Hello, stranger!" を返す仕様を追加したい。テストも追加してください。' });
    // 質問には選択肢の先頭（または固定の自由入力）で機械的に回答する
    for (let i = 0; i < 6 && draft.state === 'ASKING'; i++) {
      draft = await rt.drafts.answer({
        draftId: draft.id,
        answers: draft.currentQuestions.map((q) => ({ questionId: q.id, value: q.options[0]?.value ?? '既存の規約に合わせて最小限で実装してください', skipped: false }))
      });
    }
    expect(draft.state, draft.blockedReason ?? draft.validationErrors.join('; ')).toBe('AWAITING_APPROVAL');
    const approved = await rt.drafts.approve({ draftId: draft.id, revision: draft.revision, acknowledgeDataSharing: true });
    expect(existsSync(approved.taskYamlPath)).toBe(true);

    const started = await rt.runs.start(approved.approvedTaskId);
    const final = await rt.runs.waitForActive();
    expect(final).not.toBeNull();
    const report = rt.runs.report(started.runId);
    console.log(report.reportMarkdown);
    expect(['COMPLETED', 'NEEDS_HUMAN']).toContain(final!.state);
    expect(final!.state).not.toBe('INTERNAL_ERROR');
    expect(existsSync(report.reportPath)).toBe(true);
    if (final!.state === 'COMPLETED') {
      expect(report.changedFiles.length).toBeGreaterThan(0);
      expect(report.openFindings).toEqual([]);
    }
    // LIVE-02: 元リポジトリの HEAD / 作業ツリーは不変、remote 無し
    expect(execFileSync('git', ['rev-parse', 'HEAD'], { cwd: sample, encoding: 'utf8' }).trim()).toBe(headBefore);
    expect(execFileSync('git', ['status', '--porcelain'], { cwd: sample, encoding: 'utf8' }).trim()).toBe('');
    if (final!.worktreePath) {
      expect(execFileSync('git', ['remote'], { cwd: final!.worktreePath, encoding: 'utf8' }).trim()).toBe('');
      expect(readFileSync(join(final!.runDir, 'task.snapshot.yaml'), 'utf8')).toBe(approved.taskYaml);
    }
    rmSync(join(root, 'nothing'), { force: true });
  }, 60 * 60 * 1000);
});
