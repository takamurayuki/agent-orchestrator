import { chromium, expect, test, type Page } from '@playwright/test';

/**
 * LIVE GUI: 実 Tauri アプリ（WebView2）に CDP で接続し、GUI → Rust → Node サイドカー → 実 CLI の一連を検証する。
 * 前提: Tauri アプリが WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS=--remote-debugging-port=9222 で起動済み。
 * 環境変数:
 *   LIVE_SAMPLE_REPO  専用サンプルリポジトリの絶対パス（必須）
 *   LIVE_EXPECT_ENV_FAIL=1 のとき「環境不足で利用不可が明示される」ことだけを確認する（LIVE-03 後半）
 */
const CDP = process.env.LIVE_CDP_URL ?? 'http://127.0.0.1:9222';
const sampleRepo = process.env.LIVE_SAMPLE_REPO ?? '';
const expectEnvFail = process.env.LIVE_EXPECT_ENV_FAIL === '1';

async function connect(): Promise<Page> {
  const browser = await chromium.connectOverCDP(CDP, { timeout: 30_000 });
  const context = browser.contexts()[0] ?? (await browser.newContext());
  const page = context.pages().find((p) => !p.url().startsWith('devtools')) ?? (await context.waitForEvent('page'));
  await page.bringToFront();
  return page;
}

/** 現在ラウンドの質問カードに機械的に回答する（選択肢の先頭、無ければ自由入力）。 */
async function answerCurrentRound(page: Page): Promise<void> {
  const cards = page.getByTestId('question-card');
  const n = await cards.count();
  for (let i = 0; i < n; i++) {
    const card = cards.nth(i);
    const radios = card.locator('input[type="radio"]');
    if ((await radios.count()) > 0) {
      await radios.first().check();
    } else {
      const text = card.locator('textarea, input[type="text"]').first();
      await text.fill('既存の規約に合わせて最小限で実装してください');
    }
  }
  await page.getByTestId('answer-round').click();
  // 回答送信後の再評価（モデル呼び出し）は 1〜2 分かかり、その間は前ラウンドの質問が無効化されたまま表示される。
  // トップバーの「回答送信中…」が消えるまで待ってから次のラウンド判定へ進む（v0.2.2 配布版検証で判明）
  // click 直後は busy 表示が描画前のことがあるので、まず少し待ってから「消える」のを待ち、さらに draft の状態が GAP_ANALYZING でなくなるまで待つ
  // （二重送信すると Runner が INVALID_STATE「状態 GAP_ANALYZING では回答できません」を返す）
  await page.waitForTimeout(1500);
  await expect(page.getByText(/回答送信中/)).toBeHidden({ timeout: 300_000 });
  await expect(page.getByTestId('draft-state')).not.toContainText('GAP_ANALYZING', { timeout: 300_000 });
  await expect(page.getByTestId('answer-round').or(page.getByTestId('approve-section')).first()).toBeVisible({ timeout: 300_000 });
}

test.describe('LIVE GUI (Tauri + real runner)', () => {
  test('LIVE-03b: environment problems are shown explicitly and running is not possible', async () => {
    test.skip(!expectEnvFail, 'LIVE_EXPECT_ENV_FAIL=1 のときだけ');
    const page = await connect();
    await expect(page.getByTestId('screen-home')).toBeVisible({ timeout: 60_000 });
    const env = page.getByTestId('env-status');
    await expect(env).toBeVisible({ timeout: 120_000 });
    await expect(env).toContainText(/実行不可|利用不可/, { timeout: 120_000 });
    await expect(page.getByTestId('start')).toBeDisabled();
  });

  test('LIVE-03a smoke: packaged app connects to the bundled runner (environment.check + project.inspect)', async () => {
    test.skip(process.env.LIVE_MODE !== 'smoke', 'LIVE_MODE=smoke のときだけ');
    expect(sampleRepo, 'LIVE_SAMPLE_REPO を指定してください').not.toBe('');
    const page = await connect();
    await expect(page.getByTestId('screen-home')).toBeVisible({ timeout: 60_000 });
    const env = page.getByTestId('env-status');
    await expect(env).toBeVisible({ timeout: 180_000 });
    await expect(env).not.toContainText(/実行不可|利用不可/, { timeout: 180_000 });
    await page.getByTestId('project-path').fill(sampleRepo);
    await page.getByTestId('inspect-project').click();
    await expect(page.getByTestId('project-status')).toContainText('利用可能', { timeout: 60_000 });
    console.log(`[live-gui] smoke ok: ${await env.innerText()}`);
  });

  test('LIVE-01/LIVE-03a via GUI: request → interview → approve → run → result', async () => {
    test.skip(expectEnvFail || process.env.LIVE_MODE === 'smoke', 'LIVE_EXPECT_ENV_FAIL=1 / LIVE_MODE=smoke のときはスキップ');
    expect(sampleRepo, 'LIVE_SAMPLE_REPO を指定してください').not.toBe('');
    const page = await connect();
    await page.getByTestId('nav-home').click();
    await expect(page.getByTestId('screen-home')).toBeVisible({ timeout: 60_000 });
    // 実 Runner の environment.check が返る（Rust → サイドカー接続の証明）
    const env = page.getByTestId('env-status');
    await expect(env).toBeVisible({ timeout: 180_000 });
    await expect(env).not.toContainText(/実行不可|利用不可/, { timeout: 180_000 });

    await page.getByTestId('project-path').fill(sampleRepo);
    await page.getByTestId('inspect-project').click();
    await expect(page.getByTestId('project-status')).toContainText('利用可能', { timeout: 60_000 });

    await page.getByTestId('request').fill('greet 関数に、名前が空文字のときは "Hello, stranger!" を返す仕様を追加したい。テストも追加してください。');
    await expect(page.getByTestId('start')).toBeEnabled();
    await page.getByTestId('start').click();
    await expect(page.getByTestId('screen-interview')).toBeVisible({ timeout: 180_000 }); // draft 作成（調査 + 最初の質問）は 1 分を超えることがある

    // ヒアリング: 質問があれば回答、サマリーが出るまで（最大 6 ラウンド、各ラウンド最大 5 分）
    for (let round = 0; round < 6; round++) {
      const outcome = await Promise.race([
        page.getByTestId('approve-section').waitFor({ state: 'visible', timeout: 300_000 }).then(() => 'summary' as const),
        page.getByTestId('question-round').waitFor({ state: 'visible', timeout: 300_000 }).then(() => 'questions' as const),
        page.getByText(/BLOCKED/).first().waitFor({ state: 'visible', timeout: 300_000 }).then(() => 'blocked' as const)
      ]);
      if (outcome === 'summary') break;
      if (outcome === 'blocked') throw new Error(`draft BLOCKED: ${await page.getByTestId('screen-interview').innerText()}`);
      await expect(page.getByTestId('question-card').first()).toBeVisible();
      expect(await page.getByTestId('question-card').count()).toBeLessThanOrEqual(3);
      await answerCurrentRound(page);
      await page.waitForTimeout(1000);
    }
    await expect(page.getByTestId('approve-section')).toBeVisible();
    // 同意前は承認不可
    await expect(page.getByTestId('approve')).toBeDisabled();
    await page.getByTestId('consent').check();
    await expect(page.getByTestId('approve')).toBeEnabled({ timeout: 10_000 });
    await page.getByTestId('approve').click();

    await expect(page.getByTestId('screen-running')).toBeVisible({ timeout: 60_000 });
    await expect(page.getByTestId('current-activity')).toContainText(/現在の処理|結果/);
    // v2.3: Run ID と task.yaml は「技術情報」の折りたたみ内
    await page.getByTestId('run-technical').locator('summary').first().click();
    await expect(page.getByTestId('run-id')).not.toBeEmpty();
    await expect(page.getByTestId('fixed-yaml')).toContainText('schemaVersion: 2');
    // 実行完了（最大 45 分）→ 結果画面
    await expect(page.getByTestId('screen-result')).toBeVisible({ timeout: 45 * 60 * 1000 });
    const headline = await page.getByTestId('outcome-headline').innerText();
    console.log(`[live-gui] result headline: ${headline}`);
    expect(headline).toMatch(/開発が完了しました|人の判断が必要です/);
    // v2.3: 内部ステータスと技術情報は折りたたみ内
    await page.getByTestId('result-internal').locator('summary').first().click();
    const stateText = await page.getByTestId('result-status-text').innerText();
    console.log(`[live-gui] result: ${stateText}`);
    expect(stateText).toMatch(/COMPLETED|NEEDS_HUMAN/);
    await expect(page.getByTestId('report-markdown')).toContainText('実行レポート');
    await expect(page.getByTestId('next-actions').locator('li').first()).toBeVisible();
    await expect(page.getByTestId('worktree-path')).not.toContainText('（なし）');
  });
});
