import { useState, useRef, useSyncExternalStore, useLayoutEffect } from 'react';
import { MAX_LINES } from '../shared/limits';
import type { ExportIssue, ExportResult } from '../shared/export-api';
import type { DocumentHistoryItem, InvoiceLine } from '../shared/document-api';
import { EditorStore } from './editor-store';
import type { Confirmation, ConfirmChoice, ConfirmRequest } from './ConfirmDialog';
// 3タブ（請求書 / 材料 / 設定）の画面。history＝請求書一覧、invoice＝請求書編集、materials＝材料台帳・取込履歴、wizard＝Excelから取込。
export type PageName = 'history' | 'invoice' | 'materials' | 'wizard' | 'settings';
/** 追加した明細と、その先頭の行番号（1から）。 */
export interface AddedLines { readonly lines: readonly InvoiceLine[]; readonly position: number }
/** 削除（請求書・材料）の結果。unknown は応答が届かず、削除されたかを確認できなかったとき。 */
export type DeleteOutcome = 'cancelled' | 'deleted' | 'failed' | 'unknown';
export { MAX_LINES };
export function useInvoiceWorkspace() {
  const [store] = useState(() => new EditorStore(request => window.appApi.documents.save(request)));
  const state = useSyncExternalStore(store.subscribe, store.getSnapshot);
  const [page, setPage] = useState<PageName>('history'), [busy, setBusy] = useState(false), [message, setMessage] = useState('');
  const [confirmation, setConfirmation] = useState<Confirmation | null>(null);
  const [exportState, setExportState] = useState<ExportResult | { readonly status: 'idle' | 'working' }>({ status: 'idle' });
  // 印刷プレビューを本体が止めたときの確認事項（止めるたびに新しいオブジェクトにして、編集画面の確認事項の一覧を開き直す）。
  const [printBlocked, setPrintBlocked] = useState<{ readonly issues: readonly ExportIssue[] } | null>(null);
  const lock = useRef(false);
  const focusAfterCommit = useRef<HTMLElement | string | null>(null);
  useLayoutEffect(() => {
    if (busy || confirmation) return;
    const target = focusAfterCommit.current;
    focusAfterCommit.current = null;
    const element = typeof target === 'string' ? document.getElementById(target) : target;
    if (element?.isConnected) element.focus();
  }, [busy, confirmation, page, state.session]);
  function ask(request: ConfirmRequest): Promise<ConfirmChoice> { return new Promise(resolve => setConfirmation({ ...request, resolve: choice => { setConfirmation(null); resolve(choice); } })); }
  async function guard(): Promise<boolean> {
    if (store.getSnapshot().composing) { setMessage('日本語の変換を確定してから操作してください。'); return false; }
    if (!store.getSnapshot().dirty) return true;
    const choice = await ask({ kind: 'leave' });
    switch (choice) {
      case 'cancel': return false;
      case 'discard': return store.discard();
      case 'save': return store.flush();
    }
  }
  async function run(action: () => Promise<void>): Promise<void> {
    if (lock.current) return;
    focusAfterCommit.current = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    lock.current = true; setBusy(true); setMessage(''); store.pause(true);
    try { await action(); } catch { setMessage('操作を完了できませんでした。編集中の内容は保持しています。'); }
    finally { lock.current = false; setBusy(false); store.pause(false); }
  }
  async function navigate(next: PageName): Promise<void> { await run(async () => { if (next === page || await guard()) setPage(next); }); }
  async function open(id: string | null, duplicate = false): Promise<void> {
    await run(async () => { if (!await guard()) return; const result = duplicate && id ? await window.appApi.documents.duplicate(id) : await window.appApi.documents.open(id); switch (result.status) { case 'error': setMessage(result.message); break; case 'ok': store.load(result.data); setExportState({ status: 'idle' }); setPrintBlocked(null); setPage('invoice'); break; } });
  }
  /** 材料（null は空の明細）を選んだ順に明細の末尾へ追加する。途中で失敗したら、そこまでの分だけ追加して止める。 */
  async function add(materialIds: readonly (string | null)[]): Promise<AddedLines | null> {
    let added: AddedLines | null = null;
    await run(async () => {
      if (store.getSnapshot().composing || materialIds.length === 0) return;
      if (!store.getSnapshot().session) { const result = await window.appApi.documents.open(null); switch (result.status) { case 'error': setMessage(result.message); return; case 'ok': store.load(result.data); } }
      const session = store.getSnapshot().session; if (!session) return;
      const room = MAX_LINES - session.draft.lines.length;
      if (materialIds.length > room) { setMessage(room > 0 ? `明細は${MAX_LINES}行以内にしてください。あと${room}行まで追加できます。` : `明細は${MAX_LINES}行以内にしてください。`); return; }
      const lines: InvoiceLine[] = [];
      try {
        for (const materialId of materialIds) {
          const result = await window.appApi.documents.addLine({ sessionId: session.sessionId, materialId });
          if (result.status === 'error') { setMessage(lines.length ? `${result.message}（選んだ${materialIds.length}件のうち${lines.length}件を追加しました。残りは追加せず、選んだまま残しています）` : result.message); break; }
          lines.push(result.data);
        }
      } finally {
        // 応答が途絶えても、追加できた分は明細に入れる。
        const current = store.getSnapshot().session, first = lines[0];
        if (first && current && current.sessionId === session.sessionId) {
          store.edit({ ...current.draft, lines: [...current.draft.lines, ...lines] }); setPage('invoice');
          added = { lines, position: current.draft.lines.length + 1 };
          focusAfterCommit.current = `quantity-${first.id}-quantity`;
        }
      }
    });
    return added;
  }
  async function remove(id: string): Promise<void> {
    await run(async () => { if (await ask({ kind: 'delete' }) !== 'discard') return; const session = store.getSnapshot().session; if (session) store.edit({ ...session.draft, lines: session.draft.lines.filter(line => line.id !== id) }); });
  }
  /**
   * 請求書を削除する（確認してから。すべて削除するか、何も削除しない）。開いている請求書を削除したとき（結果を確認できなかったときを含む）は、
   * 編集中の状態も閉じる（本体も編集セッションを閉じるため。一覧にいる間は未保存の変更はない）。
   */
  async function deleteDocuments(targets: readonly DocumentHistoryItem[]): Promise<DeleteOutcome> {
    let outcome: DeleteOutcome = 'cancelled';
    await run(async () => {
      if (targets.length === 0 || await ask({ kind: 'delete-documents', documents: targets }) !== 'discard') return;
      const ids = targets.map(item => item.id);
      const closeIfDeleted = (): void => { const documentId = store.getSnapshot().session?.documentId; if (documentId && ids.includes(documentId)) store.unload(); };
      try {
        const result = await window.appApi.documents.delete(ids);
        if (result.status === 'error') { outcome = 'failed'; setMessage(result.message); return; }
        outcome = 'deleted';
      } catch {
        outcome = 'unknown';
        setMessage('削除の結果を確認できませんでした。一覧を読み直したので、請求書が残っているかを確認してください。');
      }
      closeIfDeleted();
    });
    return outcome;
  }
  async function exportExcel(): Promise<void> {
    await run(async () => {
      if (store.getSnapshot().composing) { setMessage('日本語の変換を確定してから出力してください。'); return; }
      setExportState({ status: 'working' });
      try {
        if (!await store.flush(true)) { setExportState({ status: 'idle' }); setMessage('保存を完了できないため出力していません。内容を確認して保存を再試行してください。'); return; }
        const current = store.getSnapshot(), session = current.session;
        if (current.dirty || current.composing || !session?.documentId || session.revision < 1) { setExportState({ status: 'idle' }); setMessage('保存確定した請求書を開いてから出力してください。'); return; }
        setExportState(await window.appApi.exports.excel({ documentId: session.documentId, revision: session.revision }));
      } catch {
        setExportState({ status: 'idle' });
        setMessage('出力結果を確認できませんでした。保存先を確認してから再試行してください。請求書の保存内容は保持しています。');
      }
    });
  }
  async function printPreview(): Promise<void> {
    await run(async () => {
      if (store.getSnapshot().composing) { setMessage('日本語の変換を確定してから出力してください。'); return; }
      if (!await store.flush(true)) { setMessage('保存を完了できないため印刷プレビューを開いていません。保存を再試行してください。'); return; }
      const current = store.getSnapshot(), session = current.session;
      if (current.dirty || current.composing || !session?.documentId || session.revision < 1) { setMessage('保存確定した請求書を開いてください。'); return; }
      const result = await window.appApi.printing.preview({ documentId: session.documentId, revision: session.revision });
      if (result.status === 'error') setMessage(result.message);
      // 止めた理由は、全件をつなげた警告にせず、編集画面の確認事項の一覧（件数・該当行への移動）で示す。
      if (result.status === 'blocked') setPrintBlocked({ issues: result.issues });
    });
  }
  async function close(token: string): Promise<void> {
    await run(async () => { if (!await guard()) return; const result = await window.appApi.documents.close(token); if (result.status === 'error') setMessage(result.message); });
  }
  async function backupOperation(action: () => Promise<void>): Promise<void> {
    await run(async () => { if (await guard()) await action(); });
  }
  return { backupOperation, store, state, page, busy, message, confirmation, exportState, exportExcel, printBlocked, printPreview, navigate, open, add, remove, deleteDocuments, close };
}
