import { chromium, expect, test } from '@playwright/test';
import type { Page } from '@playwright/test';
import { execFile, spawn } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { promisify } from 'node:util';
import { evidencePath } from './evidence';
import { target } from './app';

const appVersion = (JSON.parse(readFileSync('package.json', 'utf8')) as { version: string }).version;

// 開発起動（tauri dev: Vite の開発サーバー + デバッグビルドのアプリ）。WebView2 の DevTools 接続（CDP）で画面を確かめる。
// 旧版は electron-forge start に --remote-debugging-port を渡していた。アプリ版は WebView2 の追加引数（環境変数）で同じポートを開く。
// 中継（bridge）は配布用の画面（dist）を使うため、開発起動は確かめられない。
test('Tauri development launch and app information IPC', async () => {
  test.skip(target !== 'webview2', 'tauri dev は WebView2（Windows）でだけ確かめる');
  // 初回はアプリのデバッグビルド（cargo）を含むため長めに待つ。
  test.setTimeout(600_000);
  const endpoint = 'http://127.0.0.1:9333';
  const occupied = await fetch(`${endpoint}/json/version`).then(() => true, () => false);
  if (occupied) throw new Error('QA port 9333 is already in use');
  const temporaryProfile = await mkdtemp(path.join(os.tmpdir(), 'pom-e2e-dev-'));
  if (path.dirname(temporaryProfile) !== path.resolve(os.tmpdir()) || !path.basename(temporaryProfile).startsWith('pom-e2e-dev-')) throw new Error('Unexpected fixture root');
  // tauri dev -- [cargo run の引数] -- [アプリの引数]。--no-watch: 変更の監視による再ビルド・再起動をしない（アプリが終わると tauri dev もその終了コードで終わる）。
  const launcher = spawn(process.execPath, ['node_modules/@tauri-apps/cli/tauri.js', 'dev', '--no-watch', '--', '--', `--user-data-dir=${temporaryProfile}`], {
    windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'],
    env: { ...process.env, WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS: '--remote-debugging-port=9333' },
  });
  let output = '';
  launcher.stdout.on('data', (chunk: Buffer) => { output += chunk.toString(); });
  launcher.stderr.on('data', (chunk: Buffer) => { output += chunk.toString(); });
  try {
    for (const deadline = Date.now() + 540_000; !await fetch(`${endpoint}/json/version`).then((response) => response.ok, () => false);) {
      if (launcher.exitCode !== null) throw new Error(`tauri dev exited ${String(launcher.exitCode)}: ${output.slice(-2000)}`);
      if (Date.now() > deadline) throw new Error('WebView2 DevTools endpoint did not open');
      await new Promise(resolve => setTimeout(resolve, 1000));
    }
    const browser = await chromium.connectOverCDP(endpoint);
    try {
      let found: Page | undefined;
      await expect.poll(() => { found = browser.contexts().flatMap(context => context.pages()).find(p => p.url().startsWith('http://127.0.0.1:5173')); return found !== undefined; }, { timeout: 30_000 }).toBe(true);
      const page = found;
      if (!page) throw new Error('Missing development window');
      await expect(page.getByRole('heading', { name: '請求書', exact: true, level: 1 })).toBeVisible();
      expect(page.url()).toBe('http://127.0.0.1:5173/');
      // 開発ビルドは StrictMode で effect を再実行する。閉じる処理の close が開き直した後に届いても、材料検索が開いたまま残ることを確かめる。
      const palette = page.getByRole('dialog', { name: '材料検索' });
      const frames = (): Promise<void> => page.evaluate(() => new Promise<void>(resolve => { requestAnimationFrame(() => { requestAnimationFrame(() => { resolve(); }); }); }));
      for (const open of [() => page.keyboard.press('Control+f'), () => page.getByRole('button', { name: /材料を検索/ }).click()]) {
        await open();
        await expect(palette.getByRole('combobox', { name: 'キーワード', exact: true })).toBeFocused();
        await frames();
        await expect(palette).toBeVisible();
        await page.keyboard.press('Escape');
        await expect(palette).toHaveCount(0);
      }
      await page.getByRole('button', { name: '設定', exact: true }).click();
      await expect(page.getByText(appVersion, { exact: true })).toBeVisible();
      expect(await page.evaluate(async () => ({ version: (await window.appApi.getInfo()).version, node: 'require' in window }))).toEqual({ version: appVersion, node: false });
      expect(await page.evaluate(async () => (await window.appApi.getInfo()).userDataPath)).toBe(temporaryProfile);
      const database = new DatabaseSync(path.join(temporaryProfile, 'database/app.sqlite'), { readOnly: true });
      try {
        expect(database.prepare('PRAGMA user_version').get()).toEqual({ user_version: 4 });
        expect(database.prepare('SELECT count(*) AS n FROM schema_migrations').get()).toEqual({ n: 4 });
        expect(database.prepare('SELECT count(*) AS n FROM materials').get()).toEqual({ n: 0 });
      } finally { database.close(); }
      await page.screenshot({ path: evidencePath('dev-settings.png'), mask: [page.locator('.path')] });
      // 開発サーバーが拒否対象（*.pdf）を返さないことを、テスト中だけ作る架空ファイルで確認する。
      const probe = path.resolve('test-results', 'dev-deny-probe.pdf');
      await mkdir(path.dirname(probe), { recursive: true });
      await writeFile(probe, '架空');
      try { expect((await fetch('http://127.0.0.1:5173/test-results/dev-deny-probe.pdf')).status).toBe(403); }
      finally { await rm(probe, { force: true }); }
      // 画面の window.close() はウィンドウの「閉じる」と同じ扱い（終了確認を経て閉じる）。
      await page.evaluate(() => window.close());
    } finally { await browser.close(); }
    await expect.poll(() => launcher.exitCode, { timeout: 30_000 }).toBe(0);
  } finally {
    if (launcher.exitCode === null && launcher.pid !== undefined) {
      if (process.platform === 'win32') await promisify(execFile)('taskkill.exe', ['/PID', String(launcher.pid), '/T', '/F'], { windowsHide: true }).catch(() => undefined);
      else launcher.kill();
    }
    await mkdir(path.dirname(evidencePath('dev.log')), { recursive: true });
    await writeFile(evidencePath('dev.log'), output);
    await rm(temporaryProfile, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });
  }
});
