import { expect, test } from '@playwright/test';
import { VALID_PROJECT, gotoHome, reachApproval, selectProject } from './helpers';

/** v0.2.0: プロジェクト事前診断（ヒアリング前の実行可能 / 要確認 / 実行不可）と、素案の最小実装情報（予想変更範囲・衝突リスク）。 */
test.describe('UI-16 事前診断と最小実装の素案', () => {
  test('UI-16a: 選択直後に事前診断が表示され、要確認は「未確認」項目と対処を示しつつ開始は可能', async ({ page }) => {
    await gotoHome(page);
    await selectProject(page, 'C:\\Users\\dev\\projects\\policy-app');
    const diag = page.getByTestId('project-diagnosis');
    await expect(diag).toBeVisible();
    await expect(diag).toHaveAttribute('data-verdict', 'issues');
    await expect(page.getByTestId('diagnosis-verdict')).toContainText('問題あり');
    await expect(diag).toContainText('事前診断（ヒアリング前の確認）');
    await expect(diag).toContainText('自動変更は行いません');
    // 実行に影響する事項（問題あり）だけが目立つ位置に出る。未確認は折りたたみで理由と確認方法を示す
    await expect(page.locator('[data-testid="diagnosis-check"][data-status="warn"]')).toContainText('binaries.prisma.sh');
    const unverifiedBox = page.getByTestId('diagnosis-unverified');
    await expect(unverifiedBox).toContainText('未確認 2 件');
    await expect(unverifiedBox).toContainText('問題とは限りません');
    await unverifiedBox.locator('summary').click();
    const unverified = page.locator('[data-testid="diagnosis-check"][data-status="unverified"]');
    await expect(unverified).toHaveCount(2);
    await expect(unverified.first()).toContainText('minimumReleaseAge');
    await expect(unverified.first()).toContainText('理由:');
    await expect(unverified.first()).toContainText('確認方法:');
    await expect(unverified.first()).toContainText('pnpm install --frozen-lockfile');
    // 要確認でも開始はできる（判断は利用者）
    await page.getByTestId('request').fill('ログを追加したい');
    await expect(page.getByTestId('start')).toBeEnabled();
  });

  test('UI-16b: 実行可能なプロジェクトは全項目が正常、実行不可なプロジェクトは問題と対処が出て開始できない', async ({ page }) => {
    await gotoHome(page);
    await selectProject(page, VALID_PROJECT);
    await expect(page.getByTestId('project-diagnosis')).toHaveAttribute('data-verdict', 'ready');
    await expect(page.getByTestId('diagnosis-verdict')).toContainText('実行可能');
    await expect(page.getByTestId('diagnosis-ok')).toContainText('正常 7 件');
    await expect(page.getByTestId('diagnosis-unverified')).toHaveCount(0);
    await selectProject(page, 'C:\\Users\\dev\\projects\\dirty-app');
    await expect(page.getByTestId('project-diagnosis')).toHaveAttribute('data-verdict', 'blocked');
    await expect(page.getByTestId('diagnosis-verdict')).toContainText('実行不可');
    await expect(page.locator('[data-testid="diagnosis-check"][data-status="fail"]')).toHaveCount(2);
    await page.getByTestId('request').fill('x');
    await expect(page.getByTestId('start')).toBeDisabled();
  });

  test('UI-16c: 要件サマリーに「変更が予想されるファイル・領域」と「既存機能との衝突の可能性」が表示される', async ({ page }) => {
    await reachApproval(page);
    const overview = page.getByTestId('approval-overview');
    await expect(overview).toContainText('変更が予想されるファイル・領域');
    await expect(page.getByTestId('overview-expected-changes').locator('li')).toHaveCount(6);
    await expect(page.getByTestId('overview-expected-changes')).toContainText('src/server/auth/login.ts');
    await expect(overview).toContainText('人の判断を求めます');
    await expect(page.getByTestId('overview-conflict-risks').locator('li')).toHaveCount(2);
    await expect(page.getByTestId('overview-conflict-risks')).toContainText('express-session');
    await expect(overview).toContainText('生成物の更新');
    await expect(page.getByTestId('overview-generated-artifacts')).toContainText('なし');
  });
});
