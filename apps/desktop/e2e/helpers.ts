import { expect, type Page } from '@playwright/test';

export const VALID_PROJECT = 'C:\\Users\\dev\\projects\\web-app';
export const INVALID_PROJECT = 'C:\\Users\\dev\\Downloads\\invalid-folder';
export const REQUEST = 'メールアドレスとパスワードでログインできる機能を追加したい';

/** Open the app against the in-browser MockTransport. */
export async function gotoHome(page: Page, query: Record<string, string> = {}): Promise<void> {
  const params = new URLSearchParams(query).toString();
  await page.goto(`/${params ? `?${params}` : ''}`);
  await expect(page.getByTestId('screen-home')).toBeVisible();
  // Wait for the initial environment.check to resolve.
  await expect(page.getByTestId('env-status')).toBeVisible();
}

export async function selectProject(page: Page, path: string): Promise<void> {
  await page.getByTestId('project-path').fill(path);
  await page.getByTestId('inspect-project').click();
  await expect(page.getByTestId('project-status')).toBeVisible();
}

export async function startDraft(page: Page, request = REQUEST): Promise<void> {
  await page.getByTestId('request').fill(request);
  await expect(page.getByTestId('start')).toBeEnabled();
  await page.getByTestId('start').click();
  await expect(page.getByTestId('screen-interview')).toBeVisible();
  await expect(page.getByTestId('question-card')).toHaveCount(3);
}

export function option(page: Page, questionId: string, value: string) {
  return page.locator(`#q-${questionId}-${value}`);
}

/** Answer round 1 (3 questions) with sensible defaults. */
export async function answerRoundOne(page: Page, overrides: Partial<Record<'Q-001' | 'Q-002' | 'Q-003', string>> = {}): Promise<void> {
  await option(page, 'Q-001', overrides['Q-001'] ?? 'login_only').check();
  await option(page, 'Q-002', overrides['Q-002'] ?? 'cookie').check();
  await option(page, 'Q-003', overrides['Q-003'] ?? 'generic').check();
  await page.getByTestId('answer-round').click();
  await expect(page.getByTestId('question-card')).toHaveCount(2);
}

/** Answer round 2 (2 questions). */
export async function answerRoundTwo(page: Page, overrides: Partial<Record<'Q-004' | 'Q-005', string>> = {}): Promise<void> {
  await option(page, 'Q-004', overrides['Q-004'] ?? 'lock_5_15').check();
  await option(page, 'Q-005', overrides['Q-005'] ?? 'route').check();
  await page.getByTestId('answer-round').click();
  await expect(page.getByTestId('summary-editor')).toBeVisible();
}

/** Full happy path up to (not including) the approve click. */
export async function reachApproval(page: Page, query: Record<string, string> = {}): Promise<void> {
  await gotoHome(page, query);
  await selectProject(page, VALID_PROJECT);
  await startDraft(page);
  await answerRoundOne(page);
  await answerRoundTwo(page);
}

export async function approve(page: Page): Promise<void> {
  await page.getByTestId('consent').check();
  await expect(page.getByTestId('approve')).toBeEnabled();
  await page.getByTestId('approve').click();
  await expect(page.getByTestId('screen-running')).toBeVisible();
}

/** Press Tab until the focused element matches `selector` (asserting keyboard reachability). */
export async function tabTo(page: Page, selector: string, maxPresses = 80): Promise<void> {
  for (let i = 0; i < maxPresses; i++) {
    const focused = await page.evaluate((sel) => {
      const el = document.activeElement;
      return el instanceof HTMLElement && el.matches(sel);
    }, selector);
    if (focused) return;
    await page.keyboard.press('Tab');
  }
  throw new Error(`Tab で ${selector} に到達できませんでした (${maxPresses} 回)`);
}

export async function expectFocusRing(page: Page): Promise<void> {
  const outline = await page.evaluate(() => {
    const el = document.activeElement;
    if (!(el instanceof HTMLElement)) return null;
    const style = getComputedStyle(el);
    return { style: style.outlineStyle, width: style.outlineWidth };
  });
  expect(outline).not.toBeNull();
  expect(outline!.style).toBe('solid');
  expect(parseFloat(outline!.width)).toBeGreaterThanOrEqual(2);
}
