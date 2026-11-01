// E2Eテストの起動と操作。対象は2通り（環境変数 POM_E2E_TARGET、既定は Windows なら webview2、それ以外は bridge）。
// - webview2: 実際のアプリ（e2e 機能付きでビルドした exe）を起動し、WebView2 の DevTools 接続（CDP）で操作する。
//   E2E 用の exe はウィンドウを画面の外に置き、フォーカスも取らない（作業の邪魔をしない）。POM_E2E_SHOW=1 で通常どおり表示する。
// - bridge: WebView2 のない環境用。同じ画面（dist）とアプリ本体を中継（pom-bridge）で動かし、Chromium で操作する。
// 旧 Electron 版のテストが Main プロセスへ直接差し込んでいた操作（ダイアログの差し替え・ipcMain の保留・fs の失敗）は、
// アプリの e2e 操作口（src-tauri/src/e2e.rs）で同じことを行う。
import { chromium, expect } from '@playwright/test';
import type { Browser, BrowserContext, Page } from '@playwright/test';
import { spawn } from 'node:child_process';
import type { ChildProcess } from 'node:child_process';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { createServer } from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import type { SQLInputValue } from 'node:sqlite';
import { evidencePath } from './evidence';

export type Target = 'webview2' | 'bridge';
export const target: Target = (process.env['POM_E2E_TARGET'] as Target | undefined) ?? (process.platform === 'win32' ? 'webview2' : 'bridge');
// 既定は `pnpm build:e2e` の出力先（E2E 用の操作口を入れたビルド。配布物とは別のフォルダー）。
const binary = (name: string): string => path.resolve('src-tauri/target/e2e', process.platform === 'win32' ? `${name}.exe` : name);
const executable = process.env['POM_E2E_EXE'] ?? binary('parts-order-manager');
const bridgeExecutable = process.env['POM_E2E_BRIDGE'] ?? binary('pom-bridge');

/** チャネルへの差し込み（src-tauri/src/e2e.rs の Rule）。 */
export interface InterceptRule {
  readonly hold?: string; readonly holdBefore?: boolean; readonly holdFirstOnly?: boolean; readonly dropFirst?: boolean;
  readonly replace?: unknown; readonly replaceByQuery?: Readonly<Record<string, unknown>>; readonly reject?: boolean; readonly delayMs?: number; readonly record?: readonly string[];
}
export interface WindowInfo { readonly label: string; readonly url: string; readonly enabled: boolean; readonly visible: boolean; readonly focused?: boolean; readonly onScreen?: boolean }
export interface TestEvent { readonly type: string; readonly [key: string]: unknown }

const freePort = (): Promise<number> => new Promise((resolve, reject) => {
  const server = createServer();
  server.once('error', reject);
  server.listen(0, '127.0.0.1', () => { const address = server.address(); server.close(() => resolve(typeof address === 'object' && address ? address.port : 0)); });
});

export class TestApp {
  private exitCode: number | null = null;
  private readonly exited: Promise<number | null>;
  private previewContext: BrowserContext | null = null;

  constructor(private readonly child: ChildProcess, private readonly browser: Browser, private readonly mainPage: Page, private readonly base: string | null) {
    this.exited = new Promise(resolve => {
      if (child.exitCode !== null) { this.exitCode = child.exitCode; resolve(child.exitCode); return; }
      child.once('exit', code => { this.exitCode = code; resolve(code); });
    });
  }

  /** メイン画面（旧版の application.firstWindow）。 */
  firstWindow(): Promise<Page> { return Promise.resolve(this.mainPage); }
  /** 終了していれば終了コード（旧版の application.process().exitCode）。 */
  get processExitCode(): number | null { return this.exitCode; }
  get running(): boolean { return this.exitCode === null && this.child.exitCode === null; }
  /** 終了を待つ（旧版の application.waitForEvent('close')）。 */
  waitForExit(): Promise<number | null> { return this.exited; }

  /** e2e 操作口を呼ぶ。 */
  async e2e<T = unknown>(request: Readonly<Record<string, unknown>>): Promise<T> {
    if (this.base) {
      const response = await fetch(`${this.base}/invoke/e2e`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ request }) });
      const body = await response.json() as { ok?: T; err?: string };
      if (body.err !== undefined) throw new Error(body.err);
      return body.ok as T;
    }
    return await this.mainPage.evaluate(value => (window as unknown as { __TAURI_INTERNALS__: { invoke: (cmd: string, args: unknown) => Promise<unknown> } }).__TAURI_INTERNALS__.invoke('e2e', { request: value }), request as Record<string, unknown>) as T;
  }

  /** ダイアログの答え（種類ごとに、次に変えるまで同じ答え）。null は取消。hold を付けると release まで閉じない。 */
  dialog(kind: 'open' | 'save', value: string | null, hold?: string): Promise<void>;
  dialog(kind: 'message', value: number, hold?: string): Promise<void>;
  async dialog(kind: 'open' | 'save' | 'message', value: string | number | null, hold?: string): Promise<void> { await this.e2e({ op: 'dialog', kind, value, ...(hold ? { hold } : {}) }); }
  /** ダイアログの答えを外す（呼ばれたら取消）。 */
  async clearDialog(kind: 'open' | 'save' | 'message'): Promise<void> { await this.e2e({ op: 'dialog', kind }); }
  /** 旧版テストの dialogs(app, file, response) と同じ: 保存・開く・確認の答えをまとめて決める。 */
  async dialogs(file: string | null, response = 0): Promise<void> { await this.dialog('save', file); await this.dialog('open', file); await this.dialog('message', response); }
  async release(name: string): Promise<number> { return await this.e2e<number>({ op: 'release', name }); }
  /** 保留中・記録の数（旧版の ipcMain.listenerCount）。 */
  async count(name: string): Promise<number> { return await this.e2e<number>({ op: 'count', name }); }
  async intercept(channel: string, rule: InterceptRule | null): Promise<void> { await this.e2e({ op: 'intercept', channel, rule }); }
  /** 障害の注入（write・publish・rename・unlink・restore:<段階>）。exit を指定するとその場でプロセスを終える。 */
  async fault(point: string, options: { readonly times?: number; readonly exit?: number } = {}): Promise<void> { await this.e2e({ op: 'fault', point, ...options }); }
  async printOutcome(outcome: 'success' | 'cancel' | 'failure' | null): Promise<void> { await this.e2e({ op: 'print', outcome }); }
  async events(): Promise<TestEvent[]> { return await this.e2e<TestEvent[]>({ op: 'events' }); }
  async clearEvents(): Promise<void> { await this.e2e({ op: 'clear-events' }); }
  async windows(): Promise<WindowInfo[]> { return await this.e2e<WindowInfo[]>({ op: 'windows' }); }
  async info(): Promise<{ pid: number; appUrl: string }> { return await this.e2e({ op: 'info' }); }
  /** ウィンドウの「閉じる」（旧版の BrowserWindow.close）。 */
  // 終了確認が速く済むと応答より先にアプリが終わるため、その場合の失敗は無視する（終了は waitForExit で確かめる）。
  async requestClose(): Promise<void> { await this.e2e({ op: 'close' }).catch(() => undefined); }
  /** 画面の応答なし（旧版の 'unresponsive'）・回復（'responsive'）。 */
  async setUnresponsive(value: boolean): Promise<void> { await this.e2e({ op: 'unresponsive', value }); }
  /** 画面プロセスの異常終了（旧版の forcefullyCrashRenderer）。 */
  async crashRenderer(): Promise<void> { await this.e2e({ op: 'crash' }).catch(() => undefined); }
  /** 要求を1つ、信頼できない送信元（旧版の別ウィンドウ）から送ったものとして処理させる。 */
  async untrustedInvoke(channel: string, ...args: unknown[]): Promise<{ value?: unknown; rejected?: string }> { return await this.e2e({ op: 'untrusted-ipc', channel, args }); }
  /** ドロップの受付番号と場所を登録する（WebView2 のファイル通知の代役）。 */
  async registerDrop(token: string, file: string): Promise<void> { await this.e2e({ op: 'drop', token, path: file }); }

  /** 印刷プレビューが開くのを待ち、そのページを返す（旧版の app.waitForEvent('window')）。 */
  async waitForPreview(): Promise<Page> {
    let url = '';
    await expect.poll(async () => { url = (await this.windows()).find(w => w.label === 'preview')?.url ?? ''; return url; }, { timeout: 15_000 }).not.toBe('');
    if (this.base) {
      this.previewContext ??= await this.browser.newContext({ javaScriptEnabled: false, viewport: { width: 960, height: 800 } });
      const page = await this.previewContext.newPage();
      await page.goto(url);
      return page;
    }
    let found: Page | undefined;
    await expect.poll(() => { found = this.browser.contexts().flatMap(context => context.pages()).find(page => page.url().startsWith(url)); return found !== undefined; }, { timeout: 15_000 }).toBe(true);
    if (!found) throw new Error('Missing preview page');
    await found.waitForLoadState('domcontentloaded');
    return found;
  }

  /** 後片付け: まだ動いていればウィンドウを破棄して終了させる（旧版の destroy + application.close）。 */
  async close(): Promise<void> {
    if (this.running) { await this.e2e({ op: 'destroy' }).catch(() => undefined); }
    const timeout = new Promise<void>(resolve => setTimeout(resolve, 10_000));
    await Promise.race([this.exited, timeout]);
    if (this.running) this.child.kill();
    await this.exited;
    await this.browser.close().catch(() => undefined);
  }
}

async function launchBridge(profile: string): Promise<TestApp> {
  const child = spawn(bridgeExecutable, [`--user-data-dir=${profile}`, `--dist=${path.resolve('dist')}`], { stdio: ['ignore', 'pipe', 'pipe'] });
  let stderr = '';
  child.stderr.on('data', chunk => { stderr += String(chunk); });
  const base = await new Promise<string>((resolve, reject) => {
    let buffered = '';
    child.stdout.on('data', chunk => { buffered += String(chunk); const match = /listening (\S+)/.exec(buffered); if (match?.[1]) resolve(match[1]); });
    child.once('exit', code => reject(new Error(`bridge exited ${String(code)}: ${stderr}`)));
  });
  // 決まった Chromium を使う場合は POM_E2E_CHROMIUM に実行ファイルを指定する。
  const browser = await chromium.launch(process.env['POM_E2E_CHROMIUM'] ? { executablePath: process.env['POM_E2E_CHROMIUM'] } : {});
  const context = await browser.newContext({ viewport: { width: 1120, height: 760 } });
  // アプリ版の移動制限（アプリのページ以外へは移動しない）と同じく、中継以外への通信・移動は止める。
  await context.route(url => !url.href.startsWith(`${base}/`), route => route.abort('aborted'));
  const page = await context.newPage();
  await page.goto(`${base}/index.html`);
  return new TestApp(child, browser, page, base);
}

async function launchWebView2(profile: string): Promise<TestApp> {
  const port = await freePort();
  const child = spawn(executable, [`--user-data-dir=${profile}`], { env: { ...process.env, WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS: `--remote-debugging-port=${port} --disable-features=CalculateNativeWinOcclusion` }, stdio: 'ignore' });
  let browser: Browser | undefined;
  for (let attempt = 0; attempt < 100 && !browser; attempt++) {
    if (child.exitCode !== null) throw new Error(`app exited ${String(child.exitCode)}`);
    try { browser = await chromium.connectOverCDP(`http://127.0.0.1:${port}`); } catch { await new Promise(resolve => setTimeout(resolve, 200)); }
  }
  if (!browser) throw new Error('WebView2 DevTools endpoint did not open');
  let page: Page | undefined;
  await expect.poll(() => { page = browser?.contexts().flatMap(context => context.pages()).find(p => p.url().startsWith('http://tauri.localhost')); return page !== undefined; }, { timeout: 30_000 }).toBe(true);
  if (!page) throw new Error('Missing main page');
  await page.waitForLoadState('domcontentloaded');
  await page.waitForFunction(() => 'appApi' in window);
  return new TestApp(child, browser, page, null);
}

/** 実際のアプリ（webview2）では、開いているウィンドウがすべて画面の外にあり、フォーカスを取っていない（POM_E2E_SHOW のときは確かめない）。 */
export async function expectInBackground(application: TestApp): Promise<void> {
  if (target !== 'webview2' || process.env['POM_E2E_SHOW']) return;
  const windows = await application.windows();
  expect(windows.length).toBeGreaterThan(0);
  for (const w of windows) {
    expect({ label: w.label, visible: w.visible, focused: w.focused, onScreen: w.onScreen }).toEqual({ label: w.label, visible: true, focused: false, onScreen: false });
  }
}

export async function launch(profile: string): Promise<TestApp> { return target === 'bridge' ? await launchBridge(profile) : await launchWebView2(profile); }

export type Row = Record<string, unknown>;
/** DB を開く（node:sqlite。旧版テストの better-sqlite3 に当たる最小限の形）。 */
export function openDatabase(file: string) {
  const db = new DatabaseSync(file, { open: true });
  return {
    prepare(sql: string) {
      const statement = db.prepare(sql);
      return { get: (...values: SQLInputValue[]) => statement.get(...values) as Row | undefined, all: (...values: SQLInputValue[]) => statement.all(...values) as Row[], run: (...values: SQLInputValue[]) => statement.run(...values) };
    },
    exec(sql: string) { db.exec(sql); },
    integrity(): string { return String((db.prepare('PRAGMA integrity_check').get() as Row)['integrity_check']); },
    close() { db.close(); },
  };
}

export async function fixture(bytes: Buffer) {
  const root = await mkdtemp(path.join(os.tmpdir(), 'pom-e2e-'));
  const profile = path.join(root, 'profile'), source = path.join(root, '架空材料.xlsx');
  await mkdir(profile); await writeFile(source, bytes);
  const database = () => openDatabase(path.join(profile, 'database/app.sqlite'));
  const cleanup = async () => {
    if (path.dirname(root) !== path.resolve(os.tmpdir()) || !path.basename(root).startsWith('pom-e2e-')) throw new Error('Unexpected cleanup root');
    await rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });
  };
  return { root, profile, source, launch: () => launch(profile), database, cleanup };
}

/** 材料タブ →「Excelから取込」→ 種類を選んで「次へ」まで進め、ファイル選択の段階を開く。 */
export async function openImport(page: Page, kind: 'first' | 're' = 'first'): Promise<void> {
  await page.getByRole('button', { name: '材料', exact: true }).click();
  await page.getByRole('button', { name: 'Excelから取込', exact: true }).click();
  await page.getByRole('button', { name: kind === 'first' ? /^新しいExcelを初回取込/ : /^変更したExcelで更新/ }).click();
  await page.getByRole('button', { name: '次へ', exact: true }).click();
}
/** ファイル選択の段階でダイアログの答えを決め、選択領域をクリックする。成功すると内容の確認へ進む。 */
export async function pick(application: TestApp, page: Page, file: string | null): Promise<void> {
  await application.dialog('open', file);
  await page.getByRole('button', { name: /ドロップ、またはクリックして選択/ }).click();
}
export async function capture(page: Page, name: string, width = 1280): Promise<void> {
  await page.setViewportSize({ width, height: 800 });
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
  await page.screenshot({ path: evidencePath(`${name}-${width}.png`) });
  const data = await readFile(evidencePath(`${name}-${width}.png`));
  expect(data.subarray(0, 8).toString('hex')).toBe('89504e470d0a1a0a');
  expect(data.readUInt32BE(16)).toBe(width); expect(data.readUInt32BE(20)).toBe(800);
}
/** 内容確認から「次へ」で確定の段階へ進み、確認チェックを入れて確定する。 */
export async function confirm(page: Page): Promise<void> { const next = page.getByRole('button', { name: '次へ', exact: true }); if (await next.isVisible()) await next.click(); await page.getByRole('checkbox', { name: '件数と内容を確認しました' }).check(); await page.getByRole('button', { name: '選択した候補を確定', exact: true }).click(); }
export async function expectKeyboardFocus(control: ReturnType<Page['getByRole']>): Promise<void> {
  await expect(control).toBeFocused();
  expect(await control.evaluate(element => element.matches(':focus-visible'))).toBe(true);
  await expect(control).toHaveCSS('outline-style', 'solid'); await expect(control).toHaveCSS('outline-color', 'rgb(36, 95, 196)');
  const width = await control.evaluate(element => Number.parseFloat(getComputedStyle(element).outlineWidth));
  expect(width).toBeGreaterThanOrEqual(2); expect(width).toBeLessThanOrEqual(3);
}
/** 証跡に付ける、テスト対象の実行ファイルの情報。 */
export function subject(): Record<string, unknown> { return { platform: process.platform, target, executable: target === 'bridge' ? bridgeExecutable : executable }; }
