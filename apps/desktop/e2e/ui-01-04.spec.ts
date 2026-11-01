import { expect, test } from '@playwright/test';
import { INVALID_PROJECT, REQUEST, VALID_PROJECT, gotoHome, selectProject, startDraft } from './helpers';

test.describe('UI-01 初回起動', () => {
  test('UI-01: 4画面のナビゲーションが表示され、環境NGのときはセットアップ案内と修正方法を表示し開始できない', async ({ page }) => {
    await gotoHome(page, { env: 'fail' });

    const nav = page.getByTestId('screen-nav');
    await expect(nav.getByRole('button')).toHaveCount(4);
    await expect(nav.getByTestId('nav-home')).toHaveText('ホーム');
    await expect(nav.getByTestId('nav-interview')).toHaveText('ヒアリング');
    await expect(nav.getByTestId('nav-running')).toHaveText('実行中');
    await expect(nav.getByTestId('nav-result')).toHaveText('結果・履歴');
    await expect(nav.getByTestId('nav-home')).toHaveAttribute('aria-current', 'page');

    // Setup checklist with a failing Docker check and its fix instructions (text, not colour only).
    const setup = page.getByTestId('setup-check');
    await expect(setup).toBeVisible();
    await expect(page.getByTestId('env-status')).toContainText('実行不可');
    const failing = setup.locator('[data-testid="env-check"][data-status="fail"]');
    await expect(failing).toHaveCount(1);
    await expect(failing).toContainText('Docker Desktop');
    await expect(failing).toContainText('失敗');
    await expect(failing).toContainText('修正方法');
    await expect(failing).toContainText('WSL integration');

    // Browsing is allowed, running is not.
    await selectProject(page, VALID_PROJECT);
    await expect(page.getByTestId('project-status')).toContainText('利用可能');
    await page.getByTestId('request').fill(REQUEST);
    await expect(page.getByTestId('start')).toBeDisabled();
    await expect(page.getByTestId('start-reason')).toContainText('実行環境が整っていません');

    // Result/history is reachable from navigation even before any run.
    await nav.getByTestId('nav-result').click();
    await expect(page.getByTestId('screen-result')).toBeVisible();
    await expect(page.getByTestId('history-item')).toHaveCount(2);
  });

  test('UI-01: 環境OKのとき実行可能と表示され、依頼内容が空なら開始できない', async ({ page }) => {
    await gotoHome(page);
    await expect(page.getByTestId('env-status')).toContainText('実行可能');
    await expect(page.getByTestId('start')).toBeDisabled();
    await expect(page.getByTestId('start-reason')).toContainText('プロジェクトフォルダーを選択');
  });
});

test.describe('UI-02 / UI-03 フォルダ選択', () => {
  test('UI-02: Git フォルダを選択するとプロジェクト情報が表示される', async ({ page }) => {
    await gotoHome(page);
    await selectProject(page, VALID_PROJECT);
    const info = page.getByTestId('project-info');
    await expect(page.getByTestId('project-status')).toContainText('利用可能');
    await expect(info).toContainText(VALID_PROJECT);
    await expect(info).toContainText('develop');
    await expect(info).toContainText('pnpm');
    await expect(info).toContainText('SvelteKit 2');
    await expect(page.getByTestId('verification-profile')).toContainText('node-pnpm: 準備完了');
    await expect(page.getByTestId('project-problems')).toHaveCount(0);
  });

  test('UI-03: 無効なフォルダでは原因と修正案が表示され、開始できない', async ({ page }) => {
    await gotoHome(page);
    await selectProject(page, INVALID_PROJECT);
    await expect(page.getByTestId('project-status')).toContainText('Git リポジトリではありません');
    const problems = page.getByTestId('project-problems');
    await expect(problems).toBeVisible();
    await expect(problems).toContainText('原因');
    await expect(problems).toContainText('.git ディレクトリが見つかりません');
    await expect(problems).toContainText('修正案');
    await expect(problems).toContainText('git init');
    await expect(problems).toContainText('NOT_GIT_REPOSITORY');

    await page.getByTestId('request').fill(REQUEST);
    await expect(page.getByTestId('start')).toBeDisabled();
    await expect(page.getByTestId('start-reason')).toContainText('プロジェクトに問題があるため開始できません');
  });
});

test.describe('UI-04 依頼入力', () => {
  test('UI-04: 日本語で依頼を入力して開始すると draft が作成されヒアリング画面へ遷移する', async ({ page }) => {
    await gotoHome(page);
    await selectProject(page, VALID_PROJECT);
    await startDraft(page, REQUEST);

    await expect(page.getByTestId('nav-interview')).toHaveAttribute('aria-current', 'page');
    await expect(page.getByTestId('draft-state')).toContainText('ASKING');
    await expect(page.getByTestId('screen-interview')).toContainText(REQUEST);
    await expect(page.getByTestId('progress')).toContainText('ラウンド 1/5');
    await expect(page.getByTestId('progress')).toContainText('質問数 3/15');
    // Facts separated into confirmed / inferred / unknown.
    await expect(page.getByTestId('facts-confirmed')).toContainText('SvelteKit');
    await expect(page.getByTestId('facts-inferred')).toContainText('bcrypt');
    await expect(page.getByTestId('facts-unknown')).toContainText('メール送信');
    // Recommendation is labelled as such and separated from facts.
    await expect(page.getByTestId('question-card').first()).toContainText('推奨案（AI の提案）');
  });
});
