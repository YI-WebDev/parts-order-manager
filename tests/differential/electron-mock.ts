// 差分テストで旧実装（TypeScript の Main プロセス）を Electron なしで動かすための代役。
// ダイアログは台本（queue）から答え、表示した内容は events に記録する（Rust 側の harness と同じ形）。
import path from 'node:path';

type Handler = (event: unknown, ...args: unknown[]) => unknown;
type Listener = (...args: unknown[]) => void;
interface MockState { handlers: Map<string, Handler>; answers: unknown[]; events: unknown[]; released: Set<string>; waiters: (() => void)[]; paths: Record<string, string>; version: string }
// vi.resetModules() で旧実装のモジュールを読み直しても、台本と記録は同じものを使う。
const shared = globalThis as typeof globalThis & { __pomElectronMock?: MockState };
export const state: MockState = shared.__pomElectronMock ??= { handlers: new Map(), answers: [], events: [], released: new Set(), waiters: [], paths: {}, version: '0.1.0' };
export function reset(): void {
  state.handlers.clear(); state.answers.length = 0; state.events.length = 0; state.released.clear(); state.waiters.length = 0;
}
export function release(name: string): void { state.released.add(name); for (const waiter of state.waiters.splice(0)) waiter(); }
async function answer(event: unknown): Promise<unknown> {
  state.events.push(event);
  const value = state.answers.shift() ?? null;
  if (value && typeof value === 'object' && 'hold' in value) {
    const name = String((value as { hold: unknown }).hold);
    while (!state.released.has(name)) await new Promise<void>(resolve => state.waiters.push(resolve));
    state.released.delete(name);
    return (value as { value?: unknown }).value ?? null;
  }
  return value;
}
const kind = (type: unknown): string => type === 'warning' ? 'Warning' : type === 'error' ? 'Error' : 'Info';
interface DialogOptions { title?: string; defaultPath?: string; filters?: unknown; message?: string; detail?: string; buttons?: string[]; defaultId?: number; cancelId?: number; type?: string }
export const dialog = {
  async showOpenDialog(_window: unknown, options: DialogOptions) {
    const value = await answer({ type: 'open', parent: 'Main', title: options.title, filters: options.filters });
    return typeof value === 'string' ? { canceled: false, filePaths: [value] } : { canceled: true, filePaths: [] };
  },
  async showSaveDialog(_window: unknown, options: DialogOptions) {
    const value = await answer({ type: 'save', parent: 'Main', title: options.title, defaultName: options.defaultPath ? path.basename(options.defaultPath) : null, filters: options.filters });
    return typeof value === 'string' ? { canceled: false, filePath: value } : { canceled: true, filePath: '' };
  },
  async showMessageBox(_window: unknown, options: DialogOptions) {
    const value = await answer({ type: 'message', parent: 'Main', kind: kind(options.type), title: options.title ?? null, message: options.message, detail: options.detail ?? null, buttons: options.buttons, defaultId: options.defaultId ?? 0, cancelId: options.cancelId ?? 0 });
    return { response: typeof value === 'number' ? value : options.cancelId ?? 0 };
  },
  showErrorBox(): void { /* 表示しない */ },
};
export const ipcMain = {
  handle(channel: string, handler: Handler): void { if (state.handlers.has(channel)) throw new Error(`duplicate handler ${channel}`); state.handlers.set(channel, handler); },
  removeHandler(channel: string): void { state.handlers.delete(channel); },
  on(): void { /* 未使用 */ }, once(): void { /* 未使用 */ }, emit(): void { /* 未使用 */ },
};
export const app = {
  getPath: (name: string): string => { const value = state.paths[name]; if (!value) throw new Error(`path ${name}`); return value; },
  getVersion: (): string => state.version,
  getAppPath: (): string => state.paths['appPath'] ?? '/',
  quit: (): void => { state.events.push({ type: 'quit' }); },
};
export class BrowserWindow { static getAllWindows(): unknown[] { return []; } }
export const session = { fromPartition: (): never => { throw new Error('print preview is not available in the harness'); } };
export const protocol = {}, Menu = {}, webUtils = {}, contextBridge = {}, ipcRenderer = {};
export function fakeWindow(url: string) {
  const listeners = new Map<string, Listener[]>();
  let destroyed = false;
  const mainFrame = { url };
  const webContents = {
    mainFrame,
    send: (_channel: string, token: unknown) => { state.events.push({ type: 'close-requested', token }); },
    on: (name: string, listener: Listener) => { listeners.set(`wc:${name}`, [...listeners.get(`wc:${name}`) ?? [], listener]); },
  };
  const window = {
    webContents,
    isDestroyed: () => destroyed,
    on: (name: string, listener: Listener) => { listeners.set(name, [...listeners.get(name) ?? [], listener]); return window; },
    once: (name: string, listener: Listener) => { listeners.set(name, [...listeners.get(name) ?? [], listener]); return window; },
    close: () => { state.events.push({ type: 'close-window' }); },
    destroy: () => { destroyed = true; },
    /** ウィンドウを閉じる操作（close イベント）。戻り値は閉じてよいか。 */
    requestClose: (): boolean => { let prevented = false; for (const listener of listeners.get('close') ?? []) listener({ preventDefault: () => { prevented = true; } }); return !prevented; },
  };
  return { window, event: (trusted: boolean) => ({ sender: webContents, senderFrame: trusted ? mainFrame : { url: 'app://other/' } }) };
}
export default { dialog, ipcMain, app, BrowserWindow, session, protocol, Menu };
