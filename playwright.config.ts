import { defineConfig } from '@playwright/test';

// E2E テスト（tests/e2e）。対象は tests/e2e/app.ts を参照（Windows は実際のアプリを WebView2 の DevTools 接続で、それ以外は中継で操作する）。
export default defineConfig({
  testDir: './tests/e2e',
  outputDir: process.env['POM_E2E_OUTPUT'] ?? './test-results/e2e',
  workers: 1,
  timeout: 30_000,
  reporter: 'list',
  use: { trace: 'off' },
});
