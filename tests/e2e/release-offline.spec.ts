import { expect, test } from '@playwright/test';
import type { Page } from '@playwright/test';
import { createServer } from 'node:http';
import { writeFile } from 'node:fs/promises';
import { capture, fixture, subject, target } from './app';
import type { TestApp } from './app';
import { evidencePath } from './evidence';

/** ウィンドウの「閉じる」で通常どおり終了させ、終了コードを返す（旧版の BrowserWindow.close）。 */
async function shutdown(application: TestApp): Promise<number | null> {
  const exited = application.waitForExit();
  await application.requestClose();
  return exited;
}

// 旧版は Chromium の NetLog（--log-net-log）を起動時から記録していた。WebView2・中継の Chromium にはテストから同じ記録を付けられないため、
// 起動後に画面が出した要求を Playwright で記録し、外部への http(s) 要求がないことを確かめる。
// アプリの内部の通信先（中継の 127.0.0.1、アプリ版の tauri.localhost・ipc.localhost）は外部に数えない。
const internalHosts = ['127.0.0.1', 'localhost', '[::1]', 'tauri.localhost', 'ipc.localhost'];
function observe(page: Page): string[] {
  const urls: string[] = [];
  page.on('request', request => urls.push(request.url()));
  page.on('websocket', socket => urls.push(socket.url()));
  return urls;
}
function requestSummary(urls: readonly string[]) {
  const httpUrls = [...new Set(urls.filter(value => /^https?:/.test(value)))];
  const externalHttpUrls = httpUrls.filter(value => !internalHosts.includes(new URL(value).hostname));
  return { requestCount: urls.length, httpUrls, externalHttpUrls, nonHttpUrls: [...new Set(urls.filter(value => !/^https?:/.test(value)))] };
}

test('local editing and restart work while the page network is blocked', async () => {
  test.setTimeout(90_000);
  // Given: only a test-owned loopback server and an isolated profile.
  let requests = 0;
  const server = createServer((_request, response) => { requests++; response.end('fictional-local-probe'); });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('Local test listener unavailable');
  const probe = `http://127.0.0.1:${address.port}/fictional-offline-probe`;
  const f = await fixture(Buffer.alloc(0));
  let application = await f.launch();
  try {
    let page = await application.firstWindow();
    const firstRequests = observe(page);
    await expect(page.getByRole('heading', { name: '請求書', exact: true, level: 1 })).toBeVisible();
    // 旧版は Electron の session でネットワークを切り（enableNetworkEmulation）、Main プロセスから同じ session で探査していた。
    // アプリ版には session を切る口がない。画面の通信は CSP（connect-src は ipc: と ipc.localhost だけ）で止まるので、画面から探査して確かめる。
    const probeResult = await page.evaluate(async url => {
      const violations: string[] = [];
      const listener = (event: SecurityPolicyViolationEvent) => { violations.push(event.effectiveDirective); };
      document.addEventListener('securitypolicyviolation', listener);
      let result: { blocked: boolean; error: string };
      try { await fetch(url); result = { blocked: false, error: '' }; }
      catch (error) { result = { blocked: true, error: error instanceof Error ? error.message : String(error) }; }
      // 違反の通知は後から届くことがあるので少し待つ。
      for (let i = 0; i < 20 && violations.length === 0; i++) await new Promise(resolve => setTimeout(resolve, 25));
      document.removeEventListener('securitypolicyviolation', listener);
      return { ...result, violations };
    }, probe);
    expect(probeResult.blocked).toBe(true);
    expect(probeResult.violations).toContain('connect-src');
    expect(requests).toBe(0);
    // When: local search and save while the page cannot reach the network, then reopen in the same condition.
    await page.getByRole('button', { name: '材料を検索…', exact: true }).click();
    const palette = page.getByRole('dialog', { name: '材料検索', exact: true });
    await palette.getByLabel('キーワード', { exact: true }).fill('架空オフライン検索');
    await expect(palette.getByRole('status')).toContainText('該当する材料はありません');
    await expect(page.locator('.search-result')).toHaveCount(0);
    await page.keyboard.press('Escape');
    await expect(palette).toHaveCount(0);
    await page.getByRole('button', { name: '請求書', exact: true }).click();
    await page.getByRole('button', { name: '新規請求書', exact: true }).click();
    await page.getByLabel('管理用タイトル', { exact: true }).fill('架空オフライン保存');
    await page.getByLabel('材料を検索して明細に追加', { exact: true }).click();
    await page.getByRole('button', { name: '空の明細を追加', exact: true }).click();
    await page.getByLabel('明細1 品名', { exact: true }).fill('架空オフライン材料');
    await page.getByLabel('明細1 数量', { exact: true }).fill('0002 本');
    await page.keyboard.press('Control+s');
    await expect(page.getByRole('status', { name: '保存状態' })).toHaveText('保存済み');
    const firstExit = await shutdown(application);
    expect(firstExit).toBe(0);
    await application.close();
    application = await f.launch(); page = await application.firstWindow();
    const secondRequests = observe(page);
    await page.getByRole('button', { name: '請求書', exact: true }).click();
    await expect(page.getByRole('heading', { name: '架空オフライン保存', exact: true })).toBeVisible();
    await page.getByRole('article', { name: '架空オフライン保存', exact: true }).getByRole('button', { name: /を開く$/ }).click();
    await expect(page.getByLabel('明細1 品名', { exact: true })).toHaveValue('架空オフライン材料');
    await expect(page.getByLabel('明細1 数量', { exact: true })).toHaveValue('0002 本');
    await capture(page, 'release-offline-reopened');
    const secondExit = await shutdown(application);
    expect(secondExit).toBe(0);
    // Then: persistence works without page networking; observation is bounded to the page's requests after launch, not all OS traffic.
    const logs = [requestSummary(firstRequests), requestSummary(secondRequests)];
    for (const log of logs) expect(log.externalHttpUrls).toEqual([]);
    expect(requests).toBe(0);
    await writeFile(evidencePath('release-offline.json'), JSON.stringify({ ...subject(), synthetic: true, firstExit, secondExit, localProbe: probeResult, localServerRequests: requests, logs, savedAndReopened: true, limits: ['OS network adapter remains enabled', 'No session-wide offline switch: the page network is blocked by the Content-Security-Policy (connect-src) and, on the bridge target, by the Playwright route that aborts requests outside the bridge', 'Requests are observed with Playwright only after the page has loaded on each launch; startup is not observed', 'Observation covers requests issued by the page, not the app process (Rust) or other-process sockets', `Target ${target}: ${target === 'webview2' ? 'the real app over a local WebView2 debugging connection' : 'the bridge (pom-bridge) driven by Chromium over a local connection'}`, 'No external host was probed'] }, null, 2));
  } finally {
    await application.close();
    await f.cleanup();
    await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
  }
});
