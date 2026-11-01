import { chromium, expect, test, type Page } from '@playwright/test';

/**
 * リリース候補検証（配布ビルドの実アプリに CDP 接続）。
 *   LIVE_RC_PHASE=error   : 無効フォルダーのエラー表示（原因・修正案）と開始不可
 *   LIVE_RC_PHASE=cancel  : ヒアリング → 承認 → 実行開始 → GUI から停止 → 結果画面で「途中で止まりました」
 *   LIVE_RC_PHASE=restart : アプリ再起動後（別プロセス）に履歴が復元され、停止した Run の結果を開ける
 * 環境変数: LIVE_CDP_URL, LIVE_SAMPLE_REPO
 */
const CDP = process.env.LIVE_CDP_URL ?? 'http://127.0.0.1:9333';
const sampleRepo = process.env.LIVE_SAMPLE_REPO ?? '';
const phase = process.env.LIVE_RC_PHASE ?? '';

async function connect(): Promise<Page> {
  const browser = await chromium.connectOverCDP(CDP, { timeout: 30_000 });
  const context = browser.contexts()[0] ?? (await browser.newContext());
  const page = context.pages().find((p) => !p.url().startsWith('devtools')) ?? (await context.waitForEvent('page'));
  await page.bringToFront();
  return page;
}

async function answerCurrentRound(page: Page): Promise<void> {
  const cards = page.getByTestId('question-card');
  const n = await cards.count();
  for (let i = 0; i < n; i++) {
    const card = cards.nth(i);
    const radios = card.locator('input[type="radio"]');
    if ((await radios.count()) > 0) await radios.first().check();
    else await card.locator('textarea, input[type="text"]').first().fill('既存の規約に合わせて最小限で実装してください');
  }
  await page.getByTestId('answer-round').click();
}

test.describe('RC: packaged app (GUI error / stop / restart)', () => {
  test('RC-error: an invalid folder shows cause and fix, and start stays disabled', async () => {
    test.skip(phase !== 'error', 'LIVE_RC_PHASE=error のときだけ');
    const page = await connect();
    await expect(page.getByTestId('screen-home')).toBeVisible({ timeout: 60_000 });
    await expect(page.getByTestId('env-status')).toBeVisible({ timeout: 180_000 });
    await page.getByTestId('project-path').fill('C:\\Windows\\Temp');
    await page.getByTestId('inspect-project').click();
    await expect(page.getByTestId('project-status')).toBeVisible({ timeout: 60_000 });
    const info = await page.getByTestId('project-info').innerText();
    console.log(`[rc] invalid folder: ${info.slice(0, 300).replace(/\n/g, ' ')}`);
    expect(info).toMatch(/Git リポジトリではありません|実行不可|原因/);
    await page.getByTestId('request').fill('テスト');
    await expect(page.getByTestId('start')).toBeDisabled();
    await expect(page.getByTestId('start-reason')).toContainText(/プロジェクト|環境/);
  });

  test('RC-cancel: interview → approve → run → stop from the GUI → result shows an interrupted outcome', async () => {
    test.skip(phase !== 'cancel', 'LIVE_RC_PHASE=cancel のときだけ');
    expect(sampleRepo, 'LIVE_SAMPLE_REPO を指定してください').not.toBe('');
    const page = await connect();
    // 直前のテストで結果画面にいることがあるのでホームへ戻る
    await page.getByTestId('nav-home').click();
    await expect(page.getByTestId('screen-home')).toBeVisible({ timeout: 60_000 });
    const env = page.getByTestId('env-status');
    await expect(env).toBeVisible({ timeout: 180_000 });
    await expect(env).not.toContainText(/実行不可|利用不可/, { timeout: 180_000 });
    await page.getByTestId('project-path').fill(sampleRepo);
    await page.getByTestId('inspect-project').click();
    await expect(page.getByTestId('project-status')).toContainText('利用可能', { timeout: 60_000 });
    await page.getByTestId('request').fill('README.md に「使い方」セクションを追加して、greet 関数の使用例を 1 つ書いてください。');
    await page.getByTestId('start').click();
    await expect(page.getByTestId('screen-interview')).toBeVisible({ timeout: 60_000 });
    for (let round = 0; round < 6; round++) {
      const outcome = await Promise.race([
        page.getByTestId('approve-section').waitFor({ state: 'visible', timeout: 300_000 }).then(() => 'summary' as const),
        page.getByTestId('question-round').waitFor({ state: 'visible', timeout: 300_000 }).then(() => 'questions' as const),
        page.getByText(/BLOCKED/).first().waitFor({ state: 'visible', timeout: 300_000 }).then(() => 'blocked' as const)
      ]);
      if (outcome === 'summary') break;
      if (outcome === 'blocked') throw new Error(`draft BLOCKED: ${await page.getByTestId('screen-interview').innerText()}`);
      await answerCurrentRound(page);
      await page.waitForTimeout(1000);
    }
    // 承認画面: 要件サマリーが先頭、YAML は見えない
    await expect(page.getByTestId('approval-overview')).toBeVisible();
    await expect(page.getByTestId('summary-editor')).toBeHidden();
    await page.getByTestId('consent').check();
    await expect(page.getByTestId('approve')).toBeEnabled({ timeout: 10_000 });
    await page.getByTestId('approve').click();
    await expect(page.getByTestId('screen-running')).toBeVisible({ timeout: 60_000 });
    await expect(page.getByTestId('current-activity')).toContainText('現在の処理');
    // 実装が始まったところで停止する
    await expect(page.getByTestId('current-activity')).toContainText(/実装中|実行前の確認中/, { timeout: 120_000 });
    await expect(page.getByTestId('cancel-run')).toBeEnabled();
    await page.getByTestId('cancel-run').click();
    await expect(page.getByTestId('screen-result')).toBeVisible({ timeout: 120_000 });
    await expect(page.getByTestId('outcome-headline')).toContainText('途中で止まりました');
    await expect(page.getByTestId('outcome-caution')).toContainText('「完了」ではありません');
    await expect(page.getByTestId('result-state')).toContainText('INTERRUPTED');
    await expect(page.getByRole('button', { name: /反映|push|merge/ })).toHaveCount(0);
    console.log(`[rc] cancelled run: ${await page.getByTestId('result-reason-detail').innerText()}`);
  });

  test('RC-restart: after an app restart the history is restored and the interrupted run can be opened', async () => {
    test.skip(phase !== 'restart', 'LIVE_RC_PHASE=restart のときだけ');
    const page = await connect();
    await expect(page.getByTestId('screen-home')).toBeVisible({ timeout: 60_000 });
    await expect(page.getByTestId('env-status')).toBeVisible({ timeout: 180_000 });
    const items = page.getByTestId('history-item');
    await expect(items.first()).toBeVisible({ timeout: 60_000 });
    await expect(items.first()).toContainText('INTERRUPTED');
    await page.getByTestId('nav-result').click();
    await expect(page.getByTestId('screen-result')).toBeVisible();
    await page.getByTestId('history-item').first().click();
    await expect(page.getByTestId('outcome-headline')).toContainText('途中で止まりました', { timeout: 60_000 });
    await expect(page.getByTestId('result-state')).toContainText('INTERRUPTED');
    await page.getByTestId('result-internal').locator('summary').first().click();
    await expect(page.getByTestId('report-markdown')).toContainText('実行レポート');
    console.log(`[rc] history restored: ${await items.count()} item(s)`);
  });
});
