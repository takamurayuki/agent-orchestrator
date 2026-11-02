import { mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { expect, test, type Page } from '@playwright/test';
import { INVALID_PROJECT, VALID_PROJECT, answerRoundOne, answerRoundTwo, approve, gotoHome, reachApproval, selectProject, startDraft } from './helpers';

/**
 * v2.3 UI 回帰テスト（非 CLI 利用者向けの結果・承認・進捗画面）。旧 ux-walkthrough（スキップ運用）を
 * 常時実行の検証に置き換えた。各テストはスクリーンショットも .tmp/ux/ に保存する（docs/UX_REVIEW.md の根拠）。
 */
const shotDir = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..', '.tmp', 'ux');
const shot = async (page: Page, name: string) => {
  mkdirSync(shotDir, { recursive: true });
  await page.screenshot({ path: join(shotDir, `${name}.png`), fullPage: true });
};

test.describe('UI-11 結果画面（COMPLETED / NEEDS_HUMAN / PRECHECK_FAILED）', () => {
  test('UI-11a: COMPLETED は平易な見出しで表示され、未解決の指摘がある場合は注意が出る。反映ボタンは無く、安全な操作だけを案内する', async ({ page }) => {
    await reachApproval(page, { mockDelay: '150' });
    await approve(page);
    await expect(page.getByTestId('screen-result')).toBeVisible({ timeout: 15_000 });

    await expect(page.getByTestId('outcome-headline')).toContainText('開発が完了しました');
    await expect(page.getByTestId('outcome-headline')).toContainText('取り込みはまだ');
    await expect(page.getByTestId('outcome-summary')).toContainText('作業用コピー');
    // 内部ステータスは折りたたみの中（既定で閉じている）
    const internal = page.getByTestId('result-internal');
    await expect(internal).not.toHaveAttribute('open', '');
    await expect(page.getByTestId('result-status-text')).toContainText('COMPLETED');
    await internal.locator('summary').first().click();
    await expect(page.getByTestId('result-status-text')).toBeVisible();
    await expect(page.getByTestId('result-status-text')).toContainText('理由コード');

    // low 指摘 1 件 → 「完了」を保証しない旨の注意
    await expect(page.getByTestId('outcome-caution')).toContainText('未解決の指摘が 1 件');
    await expect(page.getByTestId('outcome-caution')).toContainText('保証しません');
    const finding = page.getByTestId('open-finding').first();
    await expect(finding).toContainText('原因');
    await expect(finding).toContainText('影響');
    await expect(finding).toContainText('任意対応');
    await expect(finding).toContainText('次の操作');

    // 次にできること（原因・状態・操作）
    const guidance = page.getByTestId('outcome-guidance');
    await expect(guidance).toContainText('何が起きたか');
    await expect(guidance).toContainText('元のプロジェクトはまだ変わっていません');
    await expect(guidance.locator('li')).toHaveCount(2);

    // 反映（push / merge）ボタンは存在しない。案内と安全な操作だけ
    await expect(page.getByRole('button', { name: /反映|push|merge|マージ/ })).toHaveCount(0);
    await expect(page.getByTestId('apply-note')).toContainText('このアプリでは行いません');
    await expect(page.getByTestId('copy-worktree')).toBeVisible();
    await expect(page.getByTestId('new-request')).toBeVisible();

    // 変更内容と差分
    await expect(page.getByTestId('changed-files').locator('li')).toHaveCount(6);
    await expect(page.getByTestId('diff')).not.toHaveAttribute('open', '');
    await page.getByTestId('show-diff').click();
    await expect(page.getByTestId('diff')).toHaveAttribute('open', '');
    await expect(page.getByTestId('diff')).toContainText('diff --git');
    await shot(page, 'v23-result-completed');

    // 新しい依頼 → ホームへ
    await page.getByTestId('new-request').click();
    await expect(page.getByTestId('screen-home')).toBeVisible();
  });

  test('UI-11b: NEEDS_HUMAN は「完了」と誤認させず、原因・影響・次の操作と未解決指摘を表示する', async ({ page }) => {
    await reachApproval(page, { mockDelay: '100', mockRun: 'needs_human' });
    await approve(page);
    await expect(page.getByTestId('screen-result')).toBeVisible({ timeout: 30_000 });

    await expect(page.getByTestId('outcome-headline')).toContainText('人の判断が必要です');
    await expect(page.getByTestId('outcome-headline')).not.toContainText('完了しました');
    await expect(page.getByTestId('result-state')).toContainText('NEEDS_HUMAN');
    await expect(page.getByTestId('outcome-caution')).toContainText('「完了」ではありません');
    const guidance = page.getByTestId('outcome-guidance');
    await expect(guidance).toContainText('上限回数まで試みても');
    await expect(guidance).toContainText('そのまま使わないでください');
    await expect(guidance).toContainText('新しい依頼を作る');

    const findings = page.getByTestId('open-finding');
    await expect(findings).toHaveCount(2);
    await expect(findings.first()).toContainText('重要度: 高');
    await expect(findings.first()).toContainText('完了になりません');
    await expect(findings.first()).toContainText('次の操作');
    await expect(page.getByTestId('requirements-unverified')).toContainText('BOM');
    await expect(page.getByText('途中の変更です')).toBeVisible();
    // 技術的な手順は折りたたみの中
    await expect(page.getByTestId('next-actions')).toContainText('修正上限');
    await expect(page.getByTestId('result-internal')).not.toHaveAttribute('open', '');
    await shot(page, 'v23-result-needs-human');
  });

  test('UI-11c: PRECHECK_FAILED は AI が実行されていないことと問題の内容・対処を表示する', async ({ page }) => {
    await reachApproval(page, { mockDelay: '100', mockRun: 'precheck_failed' });
    await approve(page);
    await expect(page.getByTestId('screen-result')).toBeVisible({ timeout: 15_000 });

    await expect(page.getByTestId('outcome-headline')).toContainText('AI は実行していません');
    await expect(page.getByTestId('result-state')).toContainText('PRECHECK_FAILED');
    await expect(page.getByTestId('outcome-guidance')).toContainText('料金も発生していません');
    await expect(page.getByTestId('outcome-guidance')).toContainText('セットアップチェック');
    await expect(page.getByTestId('result-reason-detail')).toContainText('問題の内容');
    await expect(page.getByTestId('result-reason-detail')).toContainText('lint');
    await expect(page.getByTestId('changed-files')).toHaveCount(0);
    await expect(page.getByTestId('show-diff')).toHaveCount(0);
    await shot(page, 'v23-result-precheck-failed');
  });
});

test.describe('UI-12 承認画面', () => {
  test('UI-12a: 質問中は承認セクションが無く、回答が終わると要件サマリー → 承認 → 修正（折りたたみ）の順に表示される。YAML を見ずに承認できる', async ({ page }) => {
    await gotoHome(page);
    await selectProject(page, VALID_PROJECT);
    await startDraft(page);
    await expect(page.getByTestId('approve-section')).toHaveCount(0);
    await expect(page.getByTestId('approve-pending-note')).toBeVisible();
    await shot(page, 'v23-interview-asking');

    await answerRoundOne(page);
    await answerRoundTwo(page);
    const overview = page.getByTestId('approval-overview');
    await expect(overview).toBeVisible();
    await expect(overview).toContainText('機能要件');
    await expect(overview).toContainText('受入条件');
    await expect(overview).toContainText('制約・やらないこと');
    await expect(overview).toContainText('push / merge / deploy は行いません');
    await expect(overview).toContainText('推奨事項・未確定の点');
    // 概要 → 承認 → 修正 の順
    const order = await page.evaluate(() => {
      const ids = ['approval-overview', 'approve-section', 'summary-editor-details'];
      return ids.map((id) => document.querySelector(`[data-testid="${id}"]`)?.getBoundingClientRect().top ?? -1);
    });
    expect(order[0]).toBeLessThan(order[1]!);
    expect(order[1]).toBeLessThan(order[2]!);
    // 修正フォームと YAML は折りたたみ
    await expect(page.getByTestId('summary-editor-details')).not.toHaveAttribute('open', '');
    await expect(page.getByTestId('summary-editor')).toBeHidden();
    await expect(page.getByText('task.yaml（固定')).toHaveCount(0);
    await expect(page.getByTestId('approve-section')).toContainText('AI の利用料金が発生');

    await page.getByTestId('consent').check();
    await expect(page.getByTestId('approve')).toBeEnabled();
    await shot(page, 'v23-interview-approval');
    await page.getByTestId('approve').click();
    await expect(page.getByTestId('screen-running')).toBeVisible();
  });

  test('UI-12b: 承認前に要件を修正すると再承認が必要になり、同意も取り直しになる', async ({ page }) => {
    await reachApproval(page);
    await page.getByTestId('consent').check();
    await expect(page.getByTestId('approve')).toBeEnabled();

    await page.getByTestId('edit-summary').click();
    await expect(page.getByTestId('summary-editor')).toBeVisible();
    await page.getByTestId('add-requirement').click();
    await page.getByTestId('requirement-input').last().fill('ログイン失敗を監査ログに記録する');
    await expect(page.getByTestId('approve')).toBeDisabled();
    await page.getByTestId('save-revision').click();

    await expect(page.getByTestId('approval-overview')).toContainText('リビジョン 2');
    await expect(page.getByTestId('approval-overview')).toContainText('監査ログ');
    await expect(page.getByTestId('reapproval-note')).toContainText('再承認が必要');
    await expect(page.getByTestId('consent')).not.toBeChecked();
    await expect(page.getByTestId('approve')).toBeDisabled();
    await expect(page.getByTestId('approve-reasons')).toContainText('同意');
    await page.getByTestId('consent').check();
    await expect(page.getByTestId('approve')).toBeEnabled();
  });
});

test.describe('UI-13 進捗画面', () => {
  test('UI-13a: 現在の処理が日本語で表示され、要件分析・実装・修正・検証・レビューが区別される。終了時刻の予測は出さず、停止できる', async ({ page }) => {
    await reachApproval(page, { mockDelay: '700', mockRun: 'needs_human' });
    await approve(page);

    const activity = page.getByTestId('current-activity');
    await expect(activity).toContainText('現在の処理');
    await expect(page.getByTestId('run-steps')).toContainText('要件分析（承認済み）');
    await expect(page.getByTestId('run-steps').locator('[data-step="ANALYSIS"]')).toHaveClass(/done/);
    await expect(activity).toContainText('実装中（ラウンド 1）', { timeout: 10_000 });
    await expect(activity).toContainText('Claude Code');
    await expect(activity).toContainText('検証中', { timeout: 10_000 });
    await expect(activity).toContainText('レビュー中', { timeout: 10_000 });
    // ラウンド 2 はフィードバック付き → 「修正」と表示
    await expect(activity).toContainText('修正中（ラウンド 2）', { timeout: 10_000 });
    await expect(page.getByTestId('run-steps')).toContainText('修正（ラウンド 2）');
    await expect(page.getByTestId('run-round')).toContainText('2/3');
    await expect(page.getByTestId('elapsed')).toBeVisible();
    await expect(page.getByTestId('no-eta-note')).toContainText('終了時刻の予測は表示しません');
    await expect(page.getByTestId('screen-running')).not.toContainText(/予定終了|残り時間|ETA/);
    await shot(page, 'v23-running-fixing');

    // 生ログは表示しない（詳細ログは要約のみで折りたたみ）
    await expect(page.getByTestId('raw-log-note')).toContainText('生ログはこの画面には表示しません');
    await expect(page.getByTestId('log-panel')).not.toHaveAttribute('open', '');
    await expect(page.getByTestId('screen-running')).not.toContainText('BOM の付与を修正しました');

    // 停止
    await expect(page.getByTestId('cancel-run')).toHaveText('実行を停止する');
    await page.getByTestId('cancel-run').click();
    await expect(page.getByTestId('screen-result')).toBeVisible({ timeout: 10_000 });
    await expect(page.getByTestId('outcome-headline')).toContainText('途中で止まりました');
  });

  test('UI-13b: 失敗で終わった場合は実行画面に原因と対応が表示される', async ({ page }) => {
    await reachApproval(page, { mockDelay: '100', mockRun: 'precheck_failed' });
    await approve(page);
    await expect(page.getByTestId('screen-result')).toBeVisible({ timeout: 15_000 });
    await page.getByTestId('nav-running').click();
    const finished = page.getByTestId('run-finished');
    await expect(finished).toContainText('AI は実行していません');
    await expect(finished).toContainText('原因:');
    await expect(finished).toContainText('対応:');
    await expect(page.getByTestId('current-activity')).toContainText('結果');
    await expect(page.getByTestId('cancel-run')).toBeDisabled();
    await expect(page.getByTestId('view-result')).toBeVisible();
  });
});

test.describe('UI-14 承認前後の状態遷移と再起動後の履歴', () => {
  test('UI-14a: ホーム → 質問 → 承認待ち → 承認 → 実行 → 結果 の順に画面が切り替わり、承認前は実行画面へ行けない', async ({ page }) => {
    await gotoHome(page, { mockDelay: '150' });
    await expect(page.getByTestId('nav-interview')).toBeDisabled();
    await expect(page.getByTestId('nav-running')).toBeDisabled();
    await selectProject(page, VALID_PROJECT);
    await startDraft(page);
    await expect(page.getByTestId('draft-state')).toContainText('ASKING');
    await expect(page.getByTestId('nav-running')).toBeDisabled();
    await answerRoundOne(page);
    await answerRoundTwo(page);
    await expect(page.getByTestId('draft-state')).toContainText('AWAITING_APPROVAL');
    await expect(page.getByTestId('nav-running')).toBeDisabled();
    await approve(page);
    await expect(page.getByTestId('nav-running')).toBeEnabled();
    await page.getByTestId('nav-interview').click();
    await expect(page.getByTestId('draft-state')).toContainText('READY_TO_RUN');
    await expect(page.getByTestId('approve')).toBeDisabled();
    await expect(page.getByTestId('approve-reasons')).toContainText('既に承認済み');
    await page.getByTestId('nav-running').click();
    await expect(page.getByTestId('screen-result')).toBeVisible({ timeout: 30_000 });
  });

  test('UI-14b: 再起動（リロード）後も履歴に残り、選択すると結果が表示される', async ({ page }) => {
    await reachApproval(page, { mockDelay: '100' });
    await approve(page);
    await expect(page.getByTestId('screen-result')).toBeVisible({ timeout: 15_000 });
    await expect(page.getByTestId('history-item')).toHaveCount(3);

    await page.reload();
    await expect(page.getByTestId('screen-home')).toBeVisible();
    // 再起動後はヒアリング・実行中画面は無い（Run は終了済み）が、結果・履歴は残る
    await expect(page.getByTestId('nav-interview')).toBeDisabled();
    await expect(page.getByTestId('nav-running')).toBeDisabled();
    await expect(page.getByTestId('history-item')).toHaveCount(3);
    await page.getByTestId('nav-result').click();
    await expect(page.getByTestId('history-item')).toHaveCount(3);
    await page.getByTestId('history-item').first().click();
    await expect(page.getByTestId('outcome-headline')).toContainText('開発が完了しました');
    await expect(page.getByTestId('changed-files').locator('li')).toHaveCount(6);
    await shot(page, 'v23-result-after-reload');
  });
});
