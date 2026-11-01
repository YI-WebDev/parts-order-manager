import { expect, test } from '@playwright/test';
import { readFileSync } from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { evidencePath } from './evidence';
import { expectInBackground, launch, target } from './app';

const appVersion = (JSON.parse(readFileSync('package.json', 'utf8')) as { version: string }).version;

test('shell, narrow IPC and offline boundaries', async () => {
  const temporaryProfile = await mkdtemp(path.join(os.tmpdir(), 'pom-e2e-shell-'));
  if (path.dirname(temporaryProfile) !== path.resolve(os.tmpdir()) || !path.basename(temporaryProfile).startsWith('pom-e2e-shell-')) throw new Error('Unexpected cleanup path');
  const application = await launch(temporaryProfile);
  try {
    const page = await application.firstWindow();
    const errors: string[] = [];
    page.on('pageerror', (error) => errors.push(error.message));
    await expect(page.getByRole('heading', { name: '請求書', exact: true, level: 1 })).toBeVisible();
    await expectInBackground(application);
    const appUrl = (await application.info()).appUrl;
    expect(page.url()).toBe(appUrl);
    // 画面には Node.js の機能も、Tauri の汎用 API（ウィンドウ・ファイル操作など）もない。業務の窓口は appApi だけ。
    expect(await page.evaluate(() => ({ node: 'require' in window || 'process' in window, keys: Object.keys(window.appApi), imports: Object.keys(window.appApi.imports), master: Object.keys(window.appApi.master), backups: Object.keys(window.appApi.backups), documents: Object.keys(window.appApi.documents), frozen: Object.isFrozen(window.appApi) && Object.isFrozen(window.appApi.documents) }))).toEqual({ node: false, keys: ['backups','getInfo','printing','exports','materials','documents','master','imports'], imports: ['choose','chooseFile','list','review','apply','cancel','resume'], master: ['get','save','delete','series','choose','chooseFile','list','review','apply','cancel','resume'], backups: ['create','inspect','restore','status'], documents: ['open','duplicate','list','delete','addLine','save','close','onCloseRequested'], frozen: true });
    if (target === 'webview2') {
      // 許可していない Tauri のコマンドは呼べない（capabilities/main.json は ipc とイベントの受信だけ）。
      expect(await page.evaluate(async () => {
        const internals = (window as unknown as { __TAURI_INTERNALS__: { invoke: (cmd: string, args?: unknown) => Promise<unknown> } }).__TAURI_INTERNALS__;
        const results: boolean[] = [];
        for (const command of ['plugin:window|close', 'plugin:webview|create_webview_window', 'plugin:path|resolve_directory', 'plugin:app|version']) results.push(await internals.invoke(command, {}).then(() => false, () => true));
        return results;
      })).toEqual([true, true, true, true]);
    }
    const info = await page.evaluate(() => window.appApi.getInfo());
    expect(info.version).toBe(appVersion);
    expect(info.availableFeatures).toEqual(['app-info','initial-import','material-search','invoice-editor','excel-export','print-pdf','material-management','backup-restore']);
    expect(info.userDataPath).toBe(temporaryProfile);

    for (const width of [1120, 720, 375]) {
      await page.setViewportSize({ width, height: 720 });
      await page.getByRole('button', { name: '請求書', exact: true }).click();
      await expect(page.getByRole('heading', { name: '請求書', exact: true, level: 1 })).toBeVisible();
      await page.screenshot({ path: evidencePath(`invoices-${width}.png`) });
      await page.getByRole('button', { name: '設定', exact: true }).click();
      await expect(page.getByText(appVersion, { exact: true })).toBeVisible();
      expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
      await page.screenshot({ path: evidencePath(`settings-${width}.png`), mask: [page.locator('.path')] });
    }
    const navigation = page.getByRole('navigation', { name: 'メインナビゲーション', exact: true });
    await navigation.getByRole('button', { name: '請求書', exact: true }).focus();
    await page.keyboard.press('Enter');
    await expect(page.getByRole('heading', { name: '請求書', exact: true, level: 1 })).toBeVisible();
    await expect(navigation.getByRole('button', { name: '請求書', exact: true })).toHaveAttribute('aria-current', 'page');
    await page.keyboard.press('Tab');
    await expect(navigation.getByRole('button', { name: '材料', exact: true })).toBeFocused();
    await page.keyboard.press('Tab');
    await expect(navigation.getByRole('button', { name: '設定', exact: true })).toBeFocused();
    await page.keyboard.press('Tab');
    await expect(page.getByRole('button', { name: '材料を検索…', exact: true })).toBeFocused();
    await page.keyboard.press('Shift+Tab');
    await expect(navigation.getByRole('button', { name: '設定', exact: true })).toBeFocused();
    await page.keyboard.press('Enter');
    await expect(page.getByRole('heading', { name: '設定', exact: true })).toBeVisible();
    await expect(navigation.getByRole('button', { name: '設定', exact: true })).toHaveAttribute('aria-current', 'page');
    await expect(navigation.getByRole('button', { name: '設定', exact: true })).toBeFocused();
    await page.screenshot({ path: evidencePath('settings-focus.png'), mask: [page.locator('.path')] });

    // 新しいウィンドウ・外部への通信・位置情報は使えない。
    // 新しいウィンドウの拒否はアプリ（Tauri の on_new_window）の働きなので、中継では確かめない。
    if (target === 'webview2') expect(await page.evaluate(() => window.open('https://example.invalid/') === null)).toBe(true);
    expect(await application.windows()).toHaveLength(1);
    expect(await page.evaluate(async () => {
      try { await fetch('https://example.invalid/'); return false; } catch { return true; }
    })).toBe(true);
    // 位置情報などの権限の拒否もアプリ（Tauri の on_permission_request）の働きなので、中継では確かめない。
    if (target === 'webview2') expect(await page.evaluate(() => new Promise<boolean>((resolve) => navigator.geolocation.getCurrentPosition(() => resolve(false), () => resolve(true), { timeout: 2000 })))).toBe(true);
    expect(errors).toEqual([]);

    await page.getByRole('button', { name: '請求書', exact: true }).click();
    await expect(page.getByRole('heading', { name: '請求書', exact: true, level: 1 })).toBeVisible();
    // アプリ情報の要求が拒否された場合（旧版でハンドラーを外した状態）
    await application.intercept('app:info', { reject: true });
    await page.getByRole('button', { name: '設定', exact: true }).click();
    await expect(page.getByRole('alert')).toHaveText('アプリ情報を取得できませんでした。');
    await page.screenshot({ path: evidencePath('settings-error.png') });
    await application.intercept('app:info', { replace: { version: appVersion, userDataPath: temporaryProfile, availableFeatures: ['app-info'] }, delayMs: 700 });
    await page.getByRole('button', { name: '再試行', exact: true }).click();
    await expect(page.getByRole('status')).toHaveText('アプリ情報を取得しています…');
    await page.screenshot({ path: evidencePath('settings-loading.png') });
    await expect(page.getByText(appVersion, { exact: true })).toBeVisible();
    await page.screenshot({ path: evidencePath('settings-retried.png'), mask: [page.locator('.path')] });
    await page.evaluate(() => { const link = document.createElement('a'); link.href = 'https://example.invalid/'; link.textContent = 'test'; document.body.append(link); link.click(); link.remove(); });
    await page.waitForTimeout(300);
    expect(page.url()).toBe(appUrl);
    expect(await application.windows()).toHaveLength(1);
  } finally {
    await application.close();
    await rm(temporaryProfile, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });
  }
});
