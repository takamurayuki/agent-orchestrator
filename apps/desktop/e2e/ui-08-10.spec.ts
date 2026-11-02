import { expect, test } from '@playwright/test';
import { REQUEST, VALID_PROJECT, approve, expectFocusRing, gotoHome, reachApproval, tabTo } from './helpers';

test.describe('UI-08 承認後', () => {
  test('UI-08: 承認すると task.yaml が固定され Run 画面へ遷移し、実行が COMPLETED まで進む', async ({ page }) => {
    await reachApproval(page, { mockDelay: '700' });
    await approve(page);

    await expect(page.getByTestId('nav-running')).toHaveAttribute('aria-current', 'page');
    await expect(page.getByTestId('run-id')).not.toBeEmpty();

    // v2.3: task.yaml は「技術情報」の折りたたみの中
    await page.getByTestId('run-technical').locator('summary').first().click();
    const yaml = page.getByTestId('fixed-yaml');
    await expect(yaml).toBeVisible();
    await yaml.locator('summary').click();
    await expect(yaml).toContainText('schemaVersion: 2');
    await expect(yaml).toContainText('verificationProfile: node-pnpm');
    await expect(yaml).toContainText('acceptanceCriteria:');
    await expect(yaml).toContainText('承認済み task.yaml（固定、変更不可）');

    // State machine progresses with sequence-numbered events, then the result screen opens.
    await expect(page.getByTestId('run-round')).toContainText('1/3', { timeout: 10_000 });
    await expect(page.getByTestId('screen-result')).toBeVisible({ timeout: 15_000 });
    await expect(page.getByTestId('result-state')).toContainText('COMPLETED');
    await expect(page.getByTestId('result-status-text')).toContainText('完了');
    await expect(page.getByTestId('changed-files').locator('li')).toHaveCount(6);
    await expect(page.getByTestId('next-actions')).toContainText('手動でコミット');
    await expect(page.getByTestId('report-markdown')).toContainText('実行レポート');
    // ネットワーク（egress）: 許可 / 拒否 / エラーが区別して表示される
    const egress = page.getByTestId('egress-summary');
    await expect(egress).toContainText('api.anthropic.com');
    await expect(page.getByTestId('egress-allowed')).toHaveText('14');
    await expect(page.getByTestId('egress-denied')).toHaveText('2');
    await expect(page.getByTestId('egress-denied-hosts')).toContainText('ab.chatgpt.com');
  });
});

test.describe('UI-09 実行キャンセル', () => {
  test('UI-09: 実行中にキャンセルすると INTERRUPTED となり詳細が表示される', async ({ page }) => {
    await reachApproval(page, { mockDelay: '3000' });
    await approve(page);

    await expect(page.getByTestId('run-state')).toContainText('PREFLIGHT', { timeout: 5_000 });
    await expect(page.getByTestId('verification-results')).toContainText('まだ検証は実行されていません');
    await expect(page.getByTestId('elapsed')).toBeVisible();

    await page.getByTestId('cancel-run').click();

    await expect(page.getByTestId('screen-result')).toBeVisible({ timeout: 10_000 });
    await expect(page.getByTestId('result-state')).toContainText('INTERRUPTED');
    await expect(page.getByTestId('result-status-text')).toContainText('中断');
    await expect(page.getByTestId('result-status-text')).toContainText('CANCELLED');
    const detail = page.getByTestId('result-reason-detail');
    await expect(detail).toContainText('キャンセル');
    await expect(detail).toContainText('ワークツリーは保持');
    await expect(page.getByTestId('next-actions').locator('li')).toHaveCount(2);
    await expect(page.getByTestId('history-item').first()).toContainText('INTERRUPTED');

    // Event log is still inspectable from the running screen (reconnect via run.status).
    await page.getByTestId('nav-running').click();
    await expect(page.getByTestId('run-state')).toContainText('INTERRUPTED');
    await expect(page.getByTestId('cancel-run')).toBeDisabled();
    await page.getByTestId('log-panel').locator('summary').click();
    const rows = page.getByTestId('log-row');
    await expect(rows.first()).toBeVisible();
    await expect(page.getByTestId('log-panel')).toContainText('run.cancel_requested');
    const sequences = await rows.locator('td:first-child').allTextContents();
    expect(sequences.map(Number)).toEqual([...sequences.map(Number)].sort((a, b) => a - b));

    // v2.1 Policy Gate: 未完了 Run では静的チェックの検出がファイル・行・ルール ID・証拠付きで表示される
    await page.getByTestId('nav-result').click();
    const policy = page.getByTestId('policy-findings');
    await expect(policy).toContainText('PG-ESLINT-DISABLE');
    await expect(policy).toContainText('src/auth/login.ts:12');
    await expect(policy).toContainText('eslint-disable-next-line');
    await expect(policy).toContainText('未承認');
  });
});

test.describe('UI-10 キーボード操作', () => {
  test('UI-10: マウスなしで主要操作（選択→依頼→回答→承認→キャンセル）ができ、フォーカスが見える', async ({ page }) => {
    await gotoHome(page, { mockDelay: '3000' });

    // Home: project path → 選択 → request → 開始
    await tabTo(page, '[data-testid="project-path"]');
    await expectFocusRing(page);
    await page.keyboard.type(VALID_PROJECT);
    await tabTo(page, '[data-testid="inspect-project"]');
    await page.keyboard.press('Enter');
    await expect(page.getByTestId('project-status')).toContainText('利用可能');

    await tabTo(page, '[data-testid="request"]');
    await page.keyboard.type(REQUEST);
    await tabTo(page, '[data-testid="start"]');
    await expectFocusRing(page);
    await page.keyboard.press('Enter');
    await expect(page.getByTestId('screen-interview')).toBeVisible();

    // Round 1: radio groups via Tab + Space, then 回答して次へ via Enter
    await tabTo(page, '#q-Q-001-login_only');
    await page.keyboard.press('Space');
    await tabTo(page, '#q-Q-002-cookie');
    await page.keyboard.press('Space');
    await tabTo(page, '#q-Q-003-generic');
    await page.keyboard.press('Space');
    await tabTo(page, '[data-testid="answer-round"]');
    await page.keyboard.press('Enter');
    await expect(page.getByTestId('question-card')).toHaveCount(2);

    // Round 2
    await tabTo(page, '#q-Q-004-lock_5_15');
    await page.keyboard.press('Space');
    await tabTo(page, '#q-Q-005-route');
    await page.keyboard.press('Space');
    await tabTo(page, '[data-testid="answer-round"]');
    await page.keyboard.press('Enter');
    await expect(page.getByTestId('approval-overview')).toBeVisible();

    // Consent + approve
    await tabTo(page, '[data-testid="consent"]');
    await page.keyboard.press('Space');
    await tabTo(page, '[data-testid="approve"]');
    await expect(page.getByTestId('approve')).toBeEnabled();
    await expectFocusRing(page);
    await page.keyboard.press('Enter');
    await expect(page.getByTestId('screen-running')).toBeVisible();

    // Cancel from the keyboard
    await tabTo(page, '[data-testid="cancel-run"]');
    await page.keyboard.press('Enter');
    await expect(page.getByTestId('screen-result')).toBeVisible({ timeout: 10_000 });
    await expect(page.getByTestId('result-state')).toContainText('INTERRUPTED');

    // Live region announced the state change (text, not colour).
    await expect(page.getByTestId('live-region')).toContainText('INTERRUPTED');
  });
});
