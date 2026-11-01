// 差分テストの実行器。旧実装（TypeScript）と新実装（Rust の harness）に同じ要求を送る。
import { spawn } from 'node:child_process';
import type { ChildProcessWithoutNullStreams } from 'node:child_process';
import { mkdir } from 'node:fs/promises';
import path from 'node:path';
import { vi } from 'vitest';
import * as mock from './electron-mock';

export type Request = { readonly op: string } & Readonly<Record<string, unknown>>;
export interface Runner { send(request: Request): Promise<Record<string, unknown>>; close(): Promise<void> }
export const APP_URL = 'app://desktop/index.html';

/** 旧実装を同じプロセス内で動かす。init のたびにモジュールを読み直し、アプリの再起動と同じ状態にする。 */
export function tsRunner(baseline: string): Runner {
  let store: { close(): void } | undefined;
  let window: ReturnType<typeof mock.fakeWindow> | undefined;
  let trusted = true;
  const running = new Map<string, Promise<Record<string, unknown>>>();
  (globalThis as typeof globalThis & { __pomUuid?: number }).__pomUuid = 0;
  type Module = Record<string, (...args: unknown[]) => unknown>;
  const load = async (file: string): Promise<Module> => await import(/* @vite-ignore */ path.join(baseline, 'src/main', file)) as Module;
  const call = async (file: string, name: string, ...args: unknown[]): Promise<unknown> => { const fn = (await load(file))[name]; if (!fn) throw new Error(`${file}#${name}`); return fn(...args); };
  async function invoke(request: Request): Promise<Record<string, unknown>> {
    const handler = mock.state.handlers.get(String(request['channel']));
    if (!handler || !window) return { ok: false, error: `No handler registered for '${String(request['channel'])}'` };
    try {
      const value: unknown = await handler(window.event(trusted), ...(request['args'] as unknown[] ?? []));
      return { ok: true, value: value === undefined ? null : JSON.parse(JSON.stringify(value)) as unknown };
    } catch (error) { return { ok: false, error: error instanceof Error ? error.message : String(error) }; }
  }
  return {
    async send(request) {
      switch (request.op) {
        case 'init': {
          vi.resetModules(); mock.reset();
          const userData = String(request['userData']);
          mock.state.paths = { userData, documents: String(request['documents']), appPath: String(request['appPath']), exe: path.join(String(request['exeDir']), 'parts-order-manager.exe') };
          mock.state.version = String(request['version'] ?? '0.1.0');
          let notice: unknown;
          // Electron は起動時に userData を作る。
          await mkdir(userData, { recursive: true });
          try { notice = await call('backups/recovery.ts', 'recoverRestore', userData); store = await call('db/database.ts', 'openDatabase', path.join(userData, 'database')) as { close(): void }; }
          catch (error) { return { ok: false, error: error instanceof Error ? error.message : String(error) }; }
          window = mock.fakeWindow(APP_URL);
          const win = window.window;
          const meta = await call('ui-meta.ts', 'uiMetaStore', userData);
          await call('backups/ipc.ts', 'registerBackups', win, APP_URL, store, meta);
          await call('imports/ipc.ts', 'registerImports', win, APP_URL, store);
          await call('reimport/ipc.ts', 'registerMaster', win, APP_URL, store);
          await call('material-search-ipc.ts', 'registerMaterialSearch', win, APP_URL, store);
          await call('documents/ipc.ts', 'registerDocuments', win, APP_URL, store, meta);
          await call('exports/ipc.ts', 'registerExcelExport', win, APP_URL, store, meta);
          // 印刷プレビューのウィンドウは作れない（新実装の harness も開けない）ので、作成に進んだ要求は同じく失敗する。
          await call('printing/ipc.ts', 'registerPrinting', win, APP_URL, store);
          const assertInfoRequest = (await load('security.ts'))['assertInfoRequest'];
          const features = ['app-info', 'initial-import', 'material-search', 'invoice-editor', 'excel-export', 'print-pdf', 'material-management', 'backup-restore'];
          const current = window;
          mock.state.handlers.set('app:info', (event, ...args) => {
            const sender = event as ReturnType<typeof current.event>;
            assertInfoRequest?.(sender.senderFrame === current.window.webContents.mainFrame, sender.senderFrame.url, APP_URL, args);
            return { recoveryNotice: notice, version: mock.state.version, userDataPath: userData, availableFeatures: features };
          });
          return { ok: true, recoveryNotice: notice };
        }
        case 'dialog': mock.state.answers.push(request['value'] ?? null); return { ok: true };
        case 'release': mock.release(String(request['name'])); return { ok: true };
        case 'trusted': trusted = request['value'] !== false; return { ok: true };
        case 'events': { await new Promise(resolve => setImmediate(resolve)); const events = mock.state.events.splice(0); return { ok: true, events: JSON.parse(JSON.stringify(events)) as unknown }; }
        case 'invoke': return invoke(request);
        case 'start': running.set(String(request['id']), invoke(request)); await new Promise(resolve => setTimeout(resolve, 100)); return { ok: true };
        case 'await': { const pending = running.get(String(request['id'])); running.delete(String(request['id'])); return pending ? await pending : { ok: false, error: 'unknown id' }; }
        case 'close': return { ok: true, allowed: window?.window.requestClose() ?? false };
        case 'shutdown': store?.close(); store = undefined; return { ok: true };
        default: return { ok: false, error: `unknown op ${request.op}` };
      }
    },
    async close() { store?.close(); },
  };
}

/** 新実装（Rust）の harness を子プロセスで動かす。 */
export function rustRunner(binary: string): Runner {
  const child: ChildProcessWithoutNullStreams = spawn(binary, [], { stdio: ['pipe', 'pipe', 'pipe'] });
  const pending: ((value: Record<string, unknown>) => void)[] = [];
  let stderr = '', exited: string | null = null, buffered = '';
  child.stderr.on('data', chunk => { stderr += String(chunk); });
  // readline は U+2028・U+2029 でも行を区切るため、改行（\n）だけで区切る。
  child.stdout.setEncoding('utf8');
  child.stdout.on('data', (chunk: string) => {
    buffered += chunk;
    for (let end = buffered.indexOf('\n'); end >= 0; end = buffered.indexOf('\n')) {
      const line = buffered.slice(0, end);
      buffered = buffered.slice(end + 1);
      pending.shift()?.(JSON.parse(line) as Record<string, unknown>);
    }
  });
  child.on('exit', code => { exited = `harness exited ${String(code)}: ${stderr}`; for (const resolve of pending.splice(0)) resolve({ ok: false, error: exited }); });
  return {
    send(request) {
      if (exited !== null) return Promise.resolve({ ok: false, error: exited });
      return new Promise(resolve => { pending.push(resolve); child.stdin.write(`${JSON.stringify(request)}\n`); });
    },
    async close() { child.stdin.end(); await new Promise(resolve => child.on('close', resolve)); },
  };
}
