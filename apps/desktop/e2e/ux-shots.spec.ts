import { mkdirSync } from 'node:fs';
import { expect, test } from '@playwright/test';
import { VALID_PROJECT, answerRoundOne, approve, gotoHome, reachApproval, selectProject, startDraft } from './helpers';

/**
 * UX 磨き込み用のスクリーンショット採取（UX_SHOTS=1 のときだけ）。モック UI の主要画面を 1200×820 で保存する。
 *   UX_SHOTS=1 UX_SHOTS_DIR=.tmp/ux-before npx playwright test e2e/ux-shots.spec.ts
 */
const enabled = process.env.UX_SHOTS === '1';
const dir = process.env.UX_SHOTS_DIR ?? '.tmp/ux-shots';

test.describe('UX screenshots', () => {
  test.skip(!enabled, 'UX_SHOTS=1 のときだけ');
  test.use({ viewport: { width: 1200, height: 820 } });
  test.beforeAll(() => mkdirSync(dir, { recursive: true }));

  const shot = async (page: import('@playwright/test').Page, name: string) => {
    await page.screenshot({ path: `${dir}/${name}.png`, fullPage: true });
  };

  test('capture main screens', async ({ page }) => {
    await gotoHome(page);
    await shot(page, '01-home-empty');
    await selectProject(page, VALID_PROJECT);
    await expect(page.getByTestId('project-diagnosis')).toBeVisible();
    await shot(page, '02-home-ready');
    await selectProject(page, 'C:\\Users\\dev\\projects\\policy-app');
    await expect(page.getByTestId('project-diagnosis')).toBeVisible();
    await shot(page, '03-home-issues');
    await selectProject(page, VALID_PROJECT);
    await startDraft(page);
    await expect(page.getByTestId('question-round')).toBeVisible();
    await shot(page, '04-interview-round1');
    await answerRoundOne(page);
    await expect(page.getByTestId('question-round')).toBeVisible();
    await shot(page, '05-interview-round2');
  });

  test('capture approval, running and results', async ({ page }) => {
    await reachApproval(page, { mockDelay: '2500' });
    await expect(page.getByTestId('approve-section')).toBeVisible();
    await shot(page, '06-interview-approval');
    await approve(page);
    await expect(page.getByTestId('screen-running')).toBeVisible();
    await page.waitForTimeout(6000);
    await shot(page, '07-running');
    await expect(page.getByTestId('screen-result')).toBeVisible({ timeout: 60_000 });
    await expect(page.getByTestId('outcome-headline')).toBeVisible();
    await shot(page, '08-result-completed');
  });

  test('capture needs-human result', async ({ page }) => {
    await reachApproval(page, { mockDelay: '100', mockRun: 'needs_human' });
    await approve(page);
    await expect(page.getByTestId('screen-result')).toBeVisible({ timeout: 30_000 });
    await expect(page.getByTestId('failure-diagnosis')).toBeVisible();
    await shot(page, '09-result-needs-human');
  });
});
