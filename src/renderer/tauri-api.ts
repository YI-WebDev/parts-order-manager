// 画面からアプリ本体（Rust）への窓口。旧 Electron 版の preload（contextBridge）と同じ形の window.appApi を用意する。
// チャネル名・引数の数・応答の形は旧版と同じ。業務処理と入力の検査は本体側で行う。
import { invoke } from '@tauri-apps/api/core';
import { listen } from '@tauri-apps/api/event';
import { BACKUP_CHANNELS } from '../shared/backup-api';
import { MASTER_CHANNELS } from '../shared/master-api';
import { PRINT_CHANNEL } from '../shared/print-api';
import { APP_INFO_CHANNEL } from '../shared/app-api';
import type { AppApi, AppInfo } from '../shared/app-api';
import { IMPORT_CHANNELS } from '../shared/import-api';
import { MATERIAL_CATEGORY_CHANNEL, MATERIAL_SEARCH_CHANNEL } from '../shared/material-search-api';
import { EXPORT_CHANNEL } from '../shared/export-api';
import { DOCUMENT_CHANNELS } from '../shared/document-api';

const call = <T>(channel: string, ...args: unknown[]): Promise<T> => invoke<T>('ipc', { channel, args });

interface WebView2Bridge { postMessageWithAdditionalObjects?: (message: string, objects: readonly unknown[]) => void }

// ドロップしたファイルの場所は画面へ渡さない。WebView2 にファイルそのものを渡して本体側で場所を取り出し、受付番号だけで指定する。
// 取り出せない場合（WebView2 以外など）は空の番号になり、本体が「ファイルの場所を確認できません」を返す。
const droppedFile = (file: File): string => {
  try {
    const bridge = (window as unknown as { chrome?: { webview?: WebView2Bridge } }).chrome?.webview;
    if (typeof bridge?.postMessageWithAdditionalObjects !== 'function') return '';
    const token = crypto.randomUUID();
    bridge.postMessageWithAdditionalObjects(`pom-drop:${token}`, [file]);
    return token;
  } catch { return ''; }
};

const deepFreeze = <T extends object>(value: T): T => {
  for (const item of Object.values(value)) if (item && typeof item === 'object') deepFreeze(item as object);
  return Object.freeze(value);
};

export function createAppApi(): AppApi {
  return deepFreeze<AppApi>({
    backups: { create: () => call(BACKUP_CHANNELS.create), inspect: () => call(BACKUP_CHANNELS.inspect), restore: id => call(BACKUP_CHANNELS.restore, id), status: () => call(BACKUP_CHANNELS.status) },
    getInfo: (): Promise<AppInfo> => call(APP_INFO_CHANNEL),
    printing: { preview: request => call(PRINT_CHANNEL, request) },
    exports: { excel: request => call(EXPORT_CHANNEL, request) },
    materials: { search: input => call(MATERIAL_SEARCH_CHANNEL, input), categories: input => call(MATERIAL_CATEGORY_CHANNEL, input) },
    documents: {
      open: id => call(DOCUMENT_CHANNELS.open, id),
      duplicate: id => call(DOCUMENT_CHANNELS.duplicate, id),
      list: (page, query) => query === undefined ? call(DOCUMENT_CHANNELS.list, page) : call(DOCUMENT_CHANNELS.list, page, query),
      delete: ids => call(DOCUMENT_CHANNELS.delete, ids),
      addLine: input => call(DOCUMENT_CHANNELS.addLine, input),
      save: input => call(DOCUMENT_CHANNELS.save, input),
      close: token => call(DOCUMENT_CHANNELS.close, token),
      onCloseRequested: callback => {
        let active = true, stop: (() => void) | null = null;
        void listen<unknown>(DOCUMENT_CHANNELS.closeRequested, event => { if (active && typeof event.payload === 'string') callback(event.payload); })
          .then(unlisten => { if (active) stop = unlisten; else unlisten(); }, () => undefined);
        return () => { active = false; stop?.(); };
      },
    },
    master: {
      get: id => call(MASTER_CHANNELS.get, id), save: input => call(MASTER_CHANNELS.save, input), delete: ids => call(MASTER_CHANNELS.delete, ids),
      series: () => call(MASTER_CHANNELS.series), choose: id => call(MASTER_CHANNELS.choose, id),
      chooseFile: (id, file) => call(MASTER_CHANNELS.chooseFromPath, id, droppedFile(file)),
      list: () => call(MASTER_CHANNELS.list), review: id => call(MASTER_CHANNELS.review, id),
      apply: input => call(MASTER_CHANNELS.apply, input), cancel: id => call(MASTER_CHANNELS.cancel, id), resume: id => call(MASTER_CHANNELS.resume, id),
    },
    imports: {
      choose: () => call(IMPORT_CHANNELS.choose),
      chooseFile: file => call(IMPORT_CHANNELS.chooseFromPath, droppedFile(file)),
      list: () => call(IMPORT_CHANNELS.list),
      review: id => call(IMPORT_CHANNELS.review, id),
      apply: input => call(IMPORT_CHANNELS.apply, input),
      cancel: id => call(IMPORT_CHANNELS.cancel, id),
      resume: id => call(IMPORT_CHANNELS.resume, id),
    },
  });
}

/** window.appApi を用意する（書き換え不可。旧版の contextBridge.exposeInMainWorld に当たる）。 */
export function installAppApi(): void {
  if (Reflect.has(window, 'appApi')) return;
  Object.defineProperty(window, 'appApi', { value: createAppApi(), writable: false, configurable: false, enumerable: true });
  // 旧版と同じく、画面からの window.close() はウィンドウの「閉じる」と同じ扱い（終了確認を経て閉じる）にする。
  window.close = () => { void call<null>('window:close').catch(() => undefined); };
}
