import { expect, test, type Page } from '@playwright/test';
import { VALID_PROJECT, gotoHome, selectProject } from './helpers';

/**
 * v0.1.0 公開準備: 初回セットアップ（サンドボックスイメージの取得・ビルド・検証）を GUI から行う。
 * 成功 / 失敗（原因と復旧方法）/ キャンセル / 再試行 / 検証失敗時の停止 を検証する。
 */
async function openSetup(page: Page, query: Record<string, string>) {
  await gotoHome(page, { env: 'noimages', ...query });
  await expect(page.getByTestId('env-status')).toContainText('実行不可');
  const setup = page.getByTestId('sandbox-setup');
  await expect(setup).toBeVisible();
  return setup;
}

test.describe('UI-15 初回セットアップ（サンドボックス）', () => {
  test('UI-15a: イメージが無いとき GUI から準備でき、同意なしでは外部取得を開始できない。成功すると実行可能になる', async ({ page }) => {
    const setup = await openSetup(page, {});
    // 失敗したチェックに GUI の案内が出る
    const imageCheck = page.locator('[data-testid="env-check"][data-status="fail"]').first();
    await expect(imageCheck).toContainText('サンドボックスイメージ');
    await expect(imageCheck).toContainText('サンドボックスを準備する');
    // 取得内容（ベースイメージとダイジェスト）が表示され、同意なしでは開始不可
    await expect(setup).toContainText('node:22.23.4-bookworm-slim');
    await expect(setup).toContainText('sha256:4b150b48b411');
    await expect(page.getByTestId('sandbox-start')).toBeDisabled();
    await page.getByTestId('sandbox-consent').check();
    await expect(page.getByTestId('sandbox-start')).toBeEnabled();
    await page.getByTestId('sandbox-start').click();

    await expect(setup).toHaveAttribute('data-state', 'running');
    await expect(page.getByTestId('sandbox-cancel')).toBeVisible();
    // 成功 → 自動で再チェック → 実行可能（準備パネルは消え、完了メッセージが出る）、依頼を開始できる
    await expect(page.getByTestId('sandbox-success')).toBeVisible({ timeout: 15_000 });
    await expect(page.getByTestId('env-status')).toContainText('実行可能');
    await selectProject(page, VALID_PROJECT);
    await page.getByTestId('request').fill('ログイン機能を追加したい');
    await expect(page.getByTestId('start')).toBeEnabled();
  });

  test('UI-15b: 整合性検証に失敗すると処理が停止し、原因と復旧方法が表示され、実行可能にならない。再試行で成功する', async ({ page }) => {
    const setup = await openSetup(page, { setup: 'fail-once' });
    await page.getByTestId('sandbox-consent').check();
    await page.getByTestId('sandbox-start').click();
    await expect(setup).toHaveAttribute('data-state', 'failed', { timeout: 15_000 });
    const error = page.getByTestId('sandbox-error');
    await expect(error).toContainText('原因');
    await expect(error).toContainText('整合性検証に失敗');
    await expect(error).toContainText('イメージは削除しました');
    await expect(error).toContainText('復旧方法');
    await expect(error).toContainText('IMAGE_VERIFY_FAILED');
    await expect(page.getByTestId('sandbox-steps').locator('li[data-status="fail"]')).toHaveCount(1);
    await expect(page.getByTestId('env-status')).toContainText('実行不可');
    await expect(page.getByTestId('sandbox-log')).toBeVisible();

    // 再試行（同意は維持）
    await expect(page.getByTestId('sandbox-start')).toHaveText('再試行');
    await page.getByTestId('sandbox-start').click();
    await expect(page.getByTestId('sandbox-success')).toBeVisible({ timeout: 15_000 });
    await expect(page.getByTestId('env-status')).toContainText('実行可能', { timeout: 10_000 });
  });

  test('UI-15c: ビルド失敗は原因と復旧方法を表示し、再試行できる', async ({ page }) => {
    const setup = await openSetup(page, { setup: 'build-fail' });
    await page.getByTestId('sandbox-consent').check();
    await page.getByTestId('sandbox-start').click();
    await expect(setup).toHaveAttribute('data-state', 'failed', { timeout: 15_000 });
    await expect(page.getByTestId('sandbox-error')).toContainText('BUILD_FAILED');
    await expect(page.getByTestId('sandbox-error')).toContainText('ネットワーク');
    await expect(page.getByTestId('sandbox-start')).toBeEnabled();
  });

  test('UI-15d: 準備中にキャンセルすると中止として表示され、再試行できる', async ({ page }) => {
    const setup = await openSetup(page, { setup: 'slow' });
    await page.getByTestId('sandbox-consent').check();
    await page.getByTestId('sandbox-start').click();
    await expect(setup).toHaveAttribute('data-state', 'running');
    await expect(page.getByTestId('sandbox-steps').locator('li[data-status="running"]')).toHaveCount(1);
    await page.getByTestId('sandbox-cancel').click();
    await expect(setup).toHaveAttribute('data-state', 'cancelled');
    await expect(page.getByTestId('sandbox-cancelled')).toContainText('中止しました');
    await expect(page.getByTestId('sandbox-steps').locator('li[data-status="skipped"]')).toHaveCount(1);
    await expect(page.getByTestId('env-status')).toContainText('実行不可');
    await expect(page.getByTestId('sandbox-start')).toHaveText('再試行');
    await expect(page.getByTestId('sandbox-start')).toBeEnabled();
  });
});
