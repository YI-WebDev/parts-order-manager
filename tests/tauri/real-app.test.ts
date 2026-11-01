// 実際のアプリ（Tauri 本体 + WebKitGTK）を WebDriver（WebKitWebDriver）で操作する確認（Linux 用）。
// 中継（pom-bridge）では確かめられない Tauri 本体の働き（権限設定・移動の制限・終了確認のイベント・印刷プレビューのウィンドウと
// リンクの横取り・PDF化・ドロップの受付番号・二重起動の防止）を、e2e 機能付きの実行ファイルで確かめる。
// 実行: pnpm build:e2e の後、X サーバー（Xvfb など）の DISPLAY を設定して pnpm test:tauri
// Windows（WebView2）では tests/e2e が実際のアプリを操作するため、ここは Linux だけで動かす。
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { spawn, spawnSync } from 'node:child_process';
import type { ChildProcess } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { syntheticWorkbook } from '../fixtures/xlsx';

const appVersion = (JSON.parse(readFileSync('package.json', 'utf8')) as { version: string }).version;
const binary = process.env['POM_E2E_EXE'] ?? path.resolve('src-tauri/target/e2e/parts-order-manager');
const driverBinary = process.env['POM_WEBDRIVER'] ?? '/usr/bin/WebKitWebDriver';
const port = Number(process.env['POM_WEBDRIVER_PORT'] ?? 4445);
const available = process.platform === 'linux' && Boolean(process.env['DISPLAY']) && existsSync(binary) && existsSync(driverBinary);
const base = `http://127.0.0.1:${port}`;

let driver: ChildProcess | undefined;
const wait = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));
async function webdriver<T = unknown>(method: string, url: string, body?: unknown): Promise<T> {
  const response = await fetch(`${base}${url}`, { method, headers: { 'Content-Type': 'application/json' }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
  const json = await response.json() as { value: T };
  if (!response.ok) throw new Error(JSON.stringify(json.value));
  return json.value;
}

class RealApp {
  private constructor(readonly session: string, readonly profile: string) {}
  static async launch(profile: string): Promise<RealApp> {
    const created = await webdriver<{ sessionId: string }>('POST', '/session', { capabilities: { alwaysMatch: { 'webkitgtk:browserOptions': { binary, args: [`--user-data-dir=${profile}`] } } } });
    const app = new RealApp(created.sessionId, profile);
    for (let i = 0; i < 80 && !await app.script<boolean>('return typeof window.appApi === "object" && document.querySelector("h1") !== null').catch(() => false); i++) await wait(250);
    return app;
  }
  /** ページで同期スクリプトを実行する。 */
  script<T>(source: string, ...args: unknown[]): Promise<T> { return webdriver<T>('POST', `/session/${this.session}/execute/sync`, { script: source, args }); }
  /** ページで Promise を待つスクリプトを実行する（本文は async 関数の中身。値を return する）。 */
  run<T>(body: string, ...args: unknown[]): Promise<T> {
    return webdriver<T>('POST', `/session/${this.session}/execute/async`, { script: `const done = arguments[arguments.length - 1]; (async (...args) => { ${body} })(...Array.from(arguments).slice(0, -1)).then(value => done({ value }), error => done({ error: String(error) }));`, args })
      .then(result => { const r = result as { value?: T; error?: string }; if (r.error !== undefined) throw new Error(r.error); return r.value as T; });
  }
  e2e<T = unknown>(request: Record<string, unknown>): Promise<T> { return this.run<T>('return await window.__TAURI_INTERNALS__.invoke("e2e", { request: args[0] });', request); }
  /** アプリが終了したか（WebDriver の要求が通らなくなる）。 */
  async exited(): Promise<boolean> { return await webdriver('GET', `/session/${this.session}/url`).then(() => false, () => true); }
  async end(): Promise<void> { await webdriver('DELETE', `/session/${this.session}`).catch(() => undefined); }
}

async function poll<T>(read: () => Promise<T>, accept: (value: T) => boolean, timeout = 15_000): Promise<T> {
  const deadline = Date.now() + timeout;
  for (;;) {
    const value = await read();
    if (accept(value)) return value;
    if (Date.now() > deadline) throw new Error(`timed out: ${JSON.stringify(value)}`);
    await wait(200);
  }
}

describe.skipIf(!available)('real Tauri app (WebKitGTK)', () => {
  let root = '';
  beforeAll(async () => {
    root = await mkdtemp(path.join(os.tmpdir(), 'pom-tauri-'));
    driver = spawn(driverBinary, [`--port=${port}`], { env: { ...process.env, TAURI_WEBVIEW_AUTOMATION: 'true', WEBKIT_DISABLE_COMPOSITING_MODE: '1' }, stdio: 'ignore' });
    await poll(() => fetch(`${base}/status`).then(r => r.ok, () => false), ok => ok);
  });
  afterAll(async () => {
    driver?.kill();
    if (root && path.basename(root).startsWith('pom-tauri-')) await rm(root, { recursive: true, force: true });
  });

  it('keeps the page inside the app and exposes only the business IPC', async () => {
    const profile = path.join(root, 'boundaries');
    const app = await RealApp.launch(profile);
    try {
      expect(await app.script('return location.href')).toBe('tauri://localhost');
      const info = await app.run<{ userDataPath: string; version: string }>('return await window.appApi.getInfo();');
      expect(info).toMatchObject({ userDataPath: profile, version: appVersion });
      // 許可していない Tauri の機能は呼べない（capabilities/main.json は ipc とイベントの受信だけ）。
      expect(await app.run<boolean[]>('const out = []; for (const cmd of ["plugin:window|close", "plugin:webview|create_webview_window", "plugin:path|resolve_directory", "plugin:app|version", "plugin:opener|open_url"]) out.push(await window.__TAURI_INTERNALS__.invoke(cmd, {}).then(() => false, () => true)); return out;')).toEqual([true, true, true, true, true]);
      expect(await app.script('return window.open("https://example.invalid/") === null')).toBe(true);
      expect(await app.run('try { await fetch("https://example.invalid/"); return false; } catch { return true; }')).toBe(true);
      await app.script('location.href = "https://example.invalid/";');
      await wait(500);
      expect(await app.script('return location.href')).toBe('tauri://localhost');
      // 旧版の「別ウィンドウからの要求」に当たる、信頼できない送信元からの要求は拒否する。
      expect(await app.e2e({ op: 'untrusted-ipc', channel: 'app:info', args: [] })).toEqual({ rejected: 'APP_INFO_REQUEST_REJECTED' });
      expect((await app.e2e<{ value: { status: string } }>({ op: 'untrusted-ipc', channel: 'documents:open', args: [null] })).value.status).toBe('error');
      expect((await app.e2e<{ label: string }[]>({ op: 'windows' })).map(w => w.label)).toEqual(['main']);
    } finally { await app.e2e({ op: 'destroy' }).catch(() => undefined); await app.end(); }
  });

  it('exports Excel, saves and prints from the preview window, then closes through the confirmation', async () => {
    const profile = path.join(root, 'output'), excel = path.join(root, 'out.xlsx'), pdf = path.join(root, 'out.pdf');
    const app = await RealApp.launch(profile);
    let closed = false;
    try {
      const saved = await app.run<{ documentId: string; revision: number }>(`
        const opened = await window.appApi.documents.open(null); if (opened.status !== 'ok') throw new Error('open');
        const result = await window.appApi.documents.save({ sessionId: opened.data.sessionId, requestNumber: 1, generation: 1, expectedRevision: 0, draft: { ...opened.data.draft, title: '架空の実アプリ確認', header: { ...opened.data.draft.header, C2: '架空宛先 御中' } } });
        if (result.status !== 'ok') throw new Error('save'); return result.data;`);
      await app.e2e({ op: 'dialog', kind: 'save', value: excel });
      await app.e2e({ op: 'dialog', kind: 'message', value: 1 });
      expect(await app.run('return await window.appApi.exports.excel(args[0]);', { documentId: saved.documentId, revision: saved.revision })).toMatchObject({ status: 'ok' });
      expect((await readFile(excel)).subarray(0, 2).toString()).toBe('PK');

      // 印刷プレビュー（スクリプト無効の別ウィンドウ）。開いている間はメインウィンドウを操作できない。
      await app.script('window.appApi.printing.preview(arguments[0]).then(r => { window.__preview = r; });', { documentId: saved.documentId, revision: saved.revision });
      const windows = await poll(() => app.e2e<{ label: string; url: string; enabled: boolean; visible: boolean }[]>({ op: 'windows' }), list => list.some(w => w.label === 'preview' && w.visible));
      expect(windows.find(w => w.label === 'preview')?.url).toMatch(/^print:\/\/localhost\/[0-9a-f-]{36}$/u);
      expect(windows.find(w => w.label === 'main')?.enabled).toBe(false);
      await app.e2e({ op: 'dialog', kind: 'save', value: pdf });
      await app.e2e({ op: 'preview-navigate', name: 'save' });
      const bytes = await poll(() => readFile(pdf).catch(() => Buffer.alloc(0)), data => data.length > 0, 60_000);
      expect(bytes.subarray(0, 5).toString()).toBe('%PDF-');
      expect(bytes.subarray(-29).toString()).toBe('\n%parts-order-manager:pdf-v1\n');
      await app.e2e({ op: 'print', outcome: 'cancel' });
      await app.e2e({ op: 'preview-navigate', name: 'print' });
      await poll(() => app.e2e<{ type: string }[]>({ op: 'events' }), events => events.some(e => e.type === 'print'));
      // 処理の済んだプレビューを、ページ内の「閉じる」と同じ移動で閉じる。
      await poll(async () => { await app.e2e({ op: 'preview-navigate', name: 'close' }).catch(() => undefined); return await app.script<unknown>('return window.__preview ?? null'); }, value => value !== null);
      expect(await app.script('return window.__preview')).toEqual({ status: 'closed' });
      const after = await app.e2e<{ label: string; enabled: boolean }[]>({ op: 'windows' });
      expect(after.map(w => [w.label, w.enabled])).toEqual([['main', true]]);

      // 「閉じる」→ 画面へ終了確認 → 画面が documents:close で応答 → アプリが終わる。
      // 終了確認が速く済むと、この要求の応答より先にアプリが終わることがある（その場合の失敗は無視して終了を確かめる）。
      await app.e2e({ op: 'close' }).catch(() => undefined);
      closed = await poll(() => app.exited(), done => done);
      expect(closed).toBe(true);
    } finally { if (!closed) await app.e2e({ op: 'destroy' }).catch(() => undefined); await app.end(); }
  });

  it('accepts dropped files only through tokens registered by the app', async () => {
    const profile = path.join(root, 'drop'), source = path.join(root, '架空材料.xlsx');
    await writeFile(source, syntheticWorkbook());
    const app = await RealApp.launch(profile);
    try {
      // 画面からは場所を直接渡せない（渡した文字列は受付番号として扱われ、該当がなければ空になる）。
      expect(await app.run('return await window.__TAURI_INTERNALS__.invoke("ipc", { channel: "imports:choose-from-path", args: [args[0]] });', source)).toMatchObject({ status: 'error', code: 'VALIDATION' });
      await app.e2e({ op: 'drop', token: 'fictional-token', path: source });
      expect(await app.run('return await window.__TAURI_INTERNALS__.invoke("ipc", { channel: "imports:choose-from-path", args: ["fictional-token"] });')).toMatchObject({ status: 'ok' });
      // 受付番号は1回だけ使える。
      expect(await app.run('return await window.__TAURI_INTERNALS__.invoke("ipc", { channel: "imports:choose-from-path", args: ["fictional-token"] });')).toMatchObject({ status: 'error', code: 'VALIDATION' });
    } finally { await app.e2e({ op: 'destroy' }).catch(() => undefined); await app.end(); }
  });

  it('refuses a second instance on the same data folder', async () => {
    const profile = path.join(root, 'single');
    const app = await RealApp.launch(profile);
    try {
      const second = spawnSync(binary, [`--user-data-dir=${profile}`], { timeout: 20_000 });
      expect(second.status).toBe(0);
      expect(await app.script('return typeof window.appApi')).toBe('object');
    } finally { await app.e2e({ op: 'destroy' }).catch(() => undefined); await app.end(); }
  });
});

// POM_REQUIRE_TAURI=1 では、環境（Linux・DISPLAY・ビルド済みの exe・WebKitWebDriver）がそろわず上の確認が飛ばされることを失敗にする。
it.runIf(process.env['POM_REQUIRE_TAURI'] === '1')('has the environment that POM_REQUIRE_TAURI demands', () => {
  expect({ linux: process.platform === 'linux', display: Boolean(process.env['DISPLAY']), app: existsSync(binary), driver: existsSync(driverBinary) }).toEqual({ linux: true, display: true, app: true, driver: true });
});
