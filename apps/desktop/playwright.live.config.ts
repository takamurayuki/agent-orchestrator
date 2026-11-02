import { defineConfig } from '@playwright/test';

/**
 * LIVE GUI 検証用（UI ⇔ 実 Runner）。Tauri アプリを WebView2 のリモートデバッグ付きで起動しておき、CDP で接続する。
 *   set WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS=--remote-debugging-port=9222
 *   pnpm --filter @agent-orchestrator/desktop run tauri:dev   （または配布ビルドの exe）
 *   pnpm --filter @agent-orchestrator/desktop exec playwright test -c playwright.live.config.ts
 * 実 CLI を呼ぶため費用と時間がかかる。LIVE_SAMPLE_REPO に専用の一時リポジトリを指定する。
 */
export default defineConfig({
  testDir: './e2e-live',
  fullyParallel: false,
  workers: 1,
  retries: 0,
  timeout: 60 * 60 * 1000,
  reporter: [['list'], ['json', { outputFile: 'test-results/playwright-live.json' }]],
  // actionTimeout を設定しないと click/check/innerText が無期限に待ち、原因が分からないまま 1 時間のテストタイムアウトになる（v0.2.2 検証で発生）
  use: { trace: 'retain-on-failure', screenshot: 'only-on-failure', actionTimeout: 60_000, navigationTimeout: 60_000 }
});
