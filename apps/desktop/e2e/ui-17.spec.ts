import { expect, test } from '@playwright/test';
import { approve, reachApproval } from './helpers';

/** v0.2.2: 停止理由の診断（記録からの自動分類）が結果画面に、何が起きたか / 影響 / 自動修復 / 次の操作 の順で表示される。 */
test.describe('UI-17 停止理由の診断', () => {
  test('UI-17a: NEEDS_HUMAN の結果に診断カードが出る。完了した Run には出ない', async ({ page }) => {
    await reachApproval(page, { mockDelay: '100', mockRun: 'needs_human' });
    await approve(page);
    await expect(page.getByTestId('screen-result')).toBeVisible({ timeout: 30_000 });
    const diag = page.getByTestId('failure-diagnosis');
    await expect(diag).toBeVisible();
    await expect(diag).toHaveAttribute('data-category', 'limit_reached');
    await expect(diag).toContainText('停止理由の診断: 修正回数・時間の上限');
    await expect(diag).toContainText('確度: 確定');
    await expect(diag).toContainText('何が起きたか');
    await expect(diag).toContainText('開発結果への影響');
    await expect(diag).toContainText('自動では直りません（人の判断が必要）');
    await expect(diag).toContainText('次に取る操作');
    await expect(diag.locator('ol li')).toHaveCount(2);
    // 根拠は折りたたみ
    await expect(diag.locator('details')).not.toHaveAttribute('open', '');
    await diag.locator('summary').click();
    await expect(diag).toContainText('csv.ts:2');
  });

  test('UI-17b: 完了した Run には診断カードが無い', async ({ page }) => {
    await reachApproval(page, { mockDelay: '100' });
    await approve(page);
    await expect(page.getByTestId('screen-result')).toBeVisible({ timeout: 30_000 });
    await expect(page.getByTestId('outcome-headline')).toContainText('完了しました');
    await expect(page.getByTestId('failure-diagnosis')).toHaveCount(0);
  });
});
