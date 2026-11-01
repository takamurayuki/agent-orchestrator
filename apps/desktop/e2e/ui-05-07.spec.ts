import { expect, test } from '@playwright/test';
import { VALID_PROJECT, answerRoundOne, answerRoundTwo, gotoHome, option, reachApproval, selectProject, startDraft } from './helpers';

test.describe('UI-05 質問の表示', () => {
  test('UI-05: 4問以上の質問が最大3問ずつ複数ラウンドで表示される', async ({ page }) => {
    await gotoHome(page);
    await selectProject(page, VALID_PROJECT);
    await startDraft(page);

    const cards = page.getByTestId('question-card');
    await expect(cards).toHaveCount(3);
    const round1Ids = await cards.evaluateAll((els) => els.map((e) => e.getAttribute('data-question-id')));
    await expect(page.getByTestId('progress')).toContainText('ラウンド 1/5');

    await answerRoundOne(page);
    const round2Ids = await cards.evaluateAll((els) => els.map((e) => e.getAttribute('data-question-id')));
    expect(round2Ids.length).toBeLessThanOrEqual(3);
    await expect(page.getByTestId('progress')).toContainText('ラウンド 2/5');
    await expect(page.getByTestId('progress')).toContainText('質問数 5/15');

    const all = new Set([...round1Ids, ...round2Ids]);
    expect(all.size).toBeGreaterThanOrEqual(4);
    for (const id of round2Ids) expect(round1Ids).not.toContain(id);
  });
});

test.describe('UI-06 戻って修正', () => {
  test('UI-06: 戻るで前のラウンドに戻り回答を変えるとサマリーが再評価される', async ({ page }) => {
    await gotoHome(page);
    await selectProject(page, VALID_PROJECT);
    await startDraft(page);

    await answerRoundOne(page, { 'Q-001': 'login_only' });
    await expect(page.getByTestId('draft-summary')).toContainText('スコープ: ログインのみ');
    await expect(page.getByTestId('answer-history')).toContainText('Q-001');

    await page.getByTestId('back-round').click();
    await expect(page.getByTestId('question-card')).toHaveCount(3);
    await expect(page.getByTestId('progress')).toContainText('ラウンド 1/5');
    // Previous answer is prefilled for editing.
    await expect(option(page, 'Q-001', 'login_only')).toBeChecked();
    // Summary no longer claims the cancelled answer.
    await expect(page.getByTestId('draft-summary')).toContainText('スコープ: 未確定');

    await option(page, 'Q-001', 'with_signup').check();
    await page.getByTestId('answer-round').click();
    await expect(page.getByTestId('question-card')).toHaveCount(2);
    await expect(page.getByTestId('draft-summary')).toContainText('スコープ: 新規登録も含める');

    await answerRoundTwo(page);
    await expect(page.getByTestId('approval-overview')).toContainText('新規登録');
    await page.getByTestId('edit-summary').click();
    const editor = page.getByTestId('summary-editor');
    await expect(editor.getByTestId('summary-title')).toContainText('新規登録');
    const requirements = await editor.getByTestId('requirement-input').evaluateAll((els) => els.map((e) => (e as HTMLInputElement).value));
    expect(requirements.some((r) => r.includes('新規ユーザー登録'))).toBe(true);
  });

  test('UI-06: 要件サマリーを修正すると新しいリビジョンになり承認がリセットされる', async ({ page }) => {
    await reachApproval(page);
    await expect(page.getByTestId('approval-overview')).toContainText('リビジョン 1');
    await page.getByTestId('consent').check();
    await expect(page.getByTestId('approve')).toBeEnabled();

    await page.getByTestId('edit-summary').click();
    await expect(page.getByTestId('summary-editor')).toContainText('リビジョン 1');
    await page.getByTestId('add-requirement').click();
    await page.getByTestId('requirement-input').last().fill('ログイン成功時に監査ログを記録する');
    await expect(page.getByTestId('summary-dirty')).toBeVisible();
    // Unsaved edits block approval with an explicit reason.
    await expect(page.getByTestId('approve')).toBeDisabled();
    await expect(page.getByTestId('approve-reasons')).toContainText('未保存の修正');

    await page.getByTestId('save-revision').click();
    await expect(page.getByTestId('summary-editor')).toContainText('リビジョン 2');
    await expect(page.getByTestId('summary-dirty')).toHaveCount(0);
    // v2.3: 要件を変更したので再承認（同意の取り直し）が必要
    await expect(page.getByTestId('reapproval-note')).toBeVisible();
    await expect(page.getByTestId('approve')).toBeDisabled();
    await page.getByTestId('consent').check();
    await expect(page.getByTestId('approve')).toBeEnabled();
  });
});

test.describe('UI-07 承認前', () => {
  test('UI-07: 同意前は承認ボタンが無効で、Run は開始されない', async ({ page }) => {
    await reachApproval(page);
    const approveBtn = page.getByTestId('approve');
    await expect(approveBtn).toHaveText('この内容で開発を開始');
    await expect(approveBtn).toBeDisabled();
    await expect(page.getByTestId('approve-reasons')).toContainText('リポジトリの内容がモデルに送信されることに同意');
    await expect(page.getByTestId('nav-running')).toBeDisabled();

    await page.getByTestId('consent').check();
    await expect(approveBtn).toBeEnabled();
    await page.getByTestId('consent').uncheck();
    await expect(approveBtn).toBeDisabled();
    // Still no run.
    await expect(page.getByTestId('nav-running')).toBeDisabled();
  });

  test('UI-07: blocking 質問をスキップすると BLOCKED になり承認できない（理由をテキスト表示）', async ({ page }) => {
    await gotoHome(page);
    await selectProject(page, VALID_PROJECT);
    await startDraft(page);

    // Skip the blocking Q-001, answer the rest.
    await page.locator('[data-question-id="Q-001"]').getByTestId('skip-question').click();
    await option(page, 'Q-002', 'cookie').check();
    await option(page, 'Q-003', 'generic').check();
    await page.getByTestId('answer-round').click();
    await expect(page.getByTestId('question-card')).toHaveCount(2);
    // Q-001 (skipped) and Q-004 (just asked, not yet answered) are both outstanding.
    await expect(page.getByTestId('progress')).toContainText('未回答の必須質問 2 件');

    await option(page, 'Q-004', 'lock_5_15').check();
    await page.getByTestId('answer-round').click();

    await expect(page.getByTestId('draft-state')).toContainText('BLOCKED');
    const blocked = page.getByTestId('blocked-reason');
    await expect(blocked).toBeVisible();
    await expect(blocked).toContainText('Q-001');
    await expect(blocked).toContainText('自動承認は行いません');
    await expect(page.getByTestId('summary-editor')).toHaveCount(0);

    await page.getByTestId('consent').check();
    await expect(page.getByTestId('approve')).toBeDisabled();
    await expect(page.getByTestId('approve-reasons')).toContainText('未回答の必須質問があります');
    await expect(page.getByTestId('nav-running')).toBeDisabled();

    // Going back twice lets the user answer Q-001 and recover.
    await page.getByTestId('back-round').click();
    await expect(page.getByTestId('question-card')).toHaveCount(2);
    await page.getByTestId('back-round').click();
    await expect(page.getByTestId('question-card')).toHaveCount(3);
    await option(page, 'Q-001', 'login_only').check();
    await page.getByTestId('answer-round').click();
    await answerRoundTwo(page);
    await expect(page.getByTestId('draft-state')).toContainText('AWAITING_APPROVAL');
    await expect(page.getByTestId('approve')).toBeEnabled();
  });
});
