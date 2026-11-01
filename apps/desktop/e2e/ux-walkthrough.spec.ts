import { mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { expect, test } from '@playwright/test';
import { INVALID_PROJECT, VALID_PROJECT, answerRoundOne, answerRoundTwo, approve, gotoHome, reachApproval, selectProject, startDraft } from './helpers';

/**
 * v2.2 Phase 5: 非 CLI ユーザー視点の UI ウォークスルー。モック transport で 4 画面を順に辿り、スクリーンショットを
 * .tmp/ux/ に保存する。評価（docs/UX_REVIEW.md）の根拠。UX_WALKTHROUGH=1 のときだけ実行する。
 */
const enabled = process.env.UX_WALKTHROUGH === '1';
// Playwright は実行ごとに test-results を消すため、リポジトリ直下の .tmp/ux（gitignore 対象）に保存する
const outDir = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..', '.tmp', 'ux');

test.describe('UX walkthrough (screenshots)', () => {
  test.skip(!enabled, 'UX_WALKTHROUGH=1 のときだけ実行');
  test.beforeAll(() => mkdirSync(outDir, { recursive: true }));
  test.use({ viewport: { width: 1280, height: 900 } });

  const shot = (name: string) => join(outDir, `${name}.png`);

  test('01 初回起動（環境 NG）→ 02 プロジェクト選択（OK / NG）→ 03 依頼入力', async ({ page }) => {
    await gotoHome(page, { env: 'fail' });
    await page.screenshot({ path: shot('01-home-env-fail'), fullPage: true });
    await gotoHome(page);
    await selectProject(page, INVALID_PROJECT);
    await page.screenshot({ path: shot('02-home-invalid-folder'), fullPage: true });
    await selectProject(page, VALID_PROJECT);
    await page.getByTestId('request').fill('メールアドレスとパスワードでログインできる機能を追加したい');
    await page.screenshot({ path: shot('03-home-ready'), fullPage: true });
  });

  test('04 質問（ラウンド 1）→ 05 戻る → 06 サマリー・承認', async ({ page }) => {
    await gotoHome(page);
    await selectProject(page, VALID_PROJECT);
    await startDraft(page);
    await page.screenshot({ path: shot('04-interview-round1'), fullPage: true });
    await answerRoundOne(page);
    await page.screenshot({ path: shot('05-interview-round2'), fullPage: true });
    await answerRoundTwo(page);
    await page.screenshot({ path: shot('06-interview-summary-approval'), fullPage: true });
    // 編集 → 新 revision
    await page.getByTestId('add-requirement').click();
    await page.getByTestId('requirement-input').last().fill('ログイン失敗を監査ログに記録する');
    await page.getByTestId('save-revision').click();
    await expect(page.getByTestId('summary-dirty')).toBeHidden();
    await page.screenshot({ path: shot('07-interview-after-revise'), fullPage: true });
  });

  test('08 実行中 → 09 結果（COMPLETED）', async ({ page }) => {
    await reachApproval(page, { mockDelay: '1500' });
    await approve(page);
    await expect(page.getByTestId('run-state')).toContainText(/PREFLIGHT|IMPLEMENTING/, { timeout: 10_000 });
    await page.screenshot({ path: shot('08-running'), fullPage: true });
    await expect(page.getByTestId('screen-result')).toBeVisible({ timeout: 60_000 });
    await page.screenshot({ path: shot('09-result-completed'), fullPage: true });
  });

  test('10 キャンセル → 結果（INTERRUPTED、Policy Gate 表示）→ 11 履歴', async ({ page }) => {
    await reachApproval(page, { mockDelay: '3000' });
    await approve(page);
    await expect(page.getByTestId('run-state')).toContainText('PREFLIGHT', { timeout: 5_000 });
    await page.getByTestId('cancel-run').click();
    await expect(page.getByTestId('screen-result')).toBeVisible({ timeout: 10_000 });
    await page.screenshot({ path: shot('10-result-interrupted'), fullPage: true });
    await page.getByTestId('nav-running').click();
    await page.getByTestId('log-panel').locator('summary').click();
    await page.screenshot({ path: shot('11-running-log'), fullPage: true });
  });
});
