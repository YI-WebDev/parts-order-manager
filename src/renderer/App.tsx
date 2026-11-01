import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import type { AppInfo } from '../shared/app-api';
import { BackupPanel } from './BackupPanel';
import { ConfirmDialog } from './ConfirmDialog';
import { ImportWizard } from './ImportWizard';
import { InvoiceHistory } from './InvoiceHistory';
import { InvoicePanel } from './InvoicePanel';
import { MaterialManager } from './MaterialManager';
import type { WizardStart } from './MaterialManager';
import { MaterialPalette } from './MaterialPalette';
import type { PickedMaterials } from './MaterialPalette';
import { MAX_LINES, useInvoiceWorkspace } from './useInvoiceWorkspace';
import type { PageName } from './useInvoiceWorkspace';

type InfoState = { readonly status: 'loading' } | { readonly status: 'ready'; readonly info: AppInfo } | { readonly status: 'error' };
/**
 * 日本語の変換が続いているか（field は変換を始めた要素）。変換の開始と同時に欄が無効になる・ダイアログごと閉じると compositionend が届かないため、
 * その欄に今もフォーカスがあるときだけ変換中とみなす（画面から外れた欄のフォーカスの喪失は React に届かないため、ここでも確かめる）。
 */
const stillComposing = (field: EventTarget | null): boolean => field !== null && field === document.activeElement;
/** 請求書の編集画面の欄（明細最終行の検索欄を含む）で変換が続いているか。 */
const composingInEditor = (field: EventTarget | null): boolean => stillComposing(field) && field instanceof Element && field.closest('.editor-layout') !== null;
/**
 * Ctrl+N（新規請求書）を受け付ける場所: 入力欄の外と、請求書一覧の選択のチェック。ほかの入力欄（文字の欄や、取込の確認などのチェック）では、
 * 入力中の内容や画面だけで持つ選択を失わないよう受け付けない。
 */
const acceptsNewInvoice = (target: EventTarget | null): boolean => {
  if (target instanceof HTMLTextAreaElement) return false;
  if (!(target instanceof HTMLInputElement)) return true;
  return target.type === 'checkbox' && target.closest('.page-list') !== null;
};
type Tab = 'invoice' | 'materials' | 'settings';
const tabs: readonly (readonly [Tab, string, PageName])[] = [['invoice', '請求書', 'history'], ['materials', '材料', 'materials'], ['settings', '設定', 'settings']];
const tabOf = (page: PageName): Tab => page === 'history' || page === 'invoice' ? 'invoice' : page === 'settings' ? 'settings' : 'materials';

function AppInformation() {
  const [attempt, setAttempt] = useState(0);
  const [state, setState] = useState<InfoState>({ status: 'loading' });
  useEffect(() => {
    let active = true;
    void window.appApi.getInfo().then(
      (info) => { if (active) setState({ status: 'ready', info }); },
      () => { if (active) setState({ status: 'error' }); },
    );
    return () => { active = false; };
  }, [attempt]);

  if (state.status === 'loading') return <p role="status" className="status-line">アプリ情報を取得しています…</p>;
  if (state.status === 'error') return <div className="stack gap-8"><p role="alert">アプリ情報を取得できませんでした。</p><button className="btn medium" onClick={() => { setState({ status: 'loading' }); setAttempt((value) => value + 1); }}>再試行</button></div>;
  return <dl className="card info-list">
    <dt>バージョン</dt><dd>{state.info.version}</dd>
    <dt>データの保存場所</dt><dd className="path">{state.info.userDataPath}</dd>
    {state.info.recoveryNotice && <><dt>復元の回復結果</dt><dd role="status">{state.info.recoveryNotice}</dd></>}
  </dl>;
}

export function App() {
  const workspace = useInvoiceWorkspace();
  const [importBusy, setImportBusy] = useState(false);
  const [palette, setPalette] = useState(false), [paletteFocus, setPaletteFocus] = useState(0), [picked, setPicked] = useState<PickedMaterials>(new Map());
  const [wizardStart, setWizardStart] = useState<WizardStart>(null), [materialsView, setMaterialsView] = useState<{ readonly view: 'ledger' | 'history'; readonly key: number }>({ view: 'ledger', key: 0 });
  const [toast, setToast] = useState<{ readonly text: string; readonly label: string | undefined; readonly id: number } | null>(null);
  const composing = useRef<EventTarget | null>(null);
  // 空文字は同じ label のトーストを消す（出力の「準備しています…」を結果に合わせて片付ける）。
  const notify = useCallback((text: string, label?: string) => { if (text === '') setToast(current => current && current.label === label ? null : current); else setToast({ text, label, id: Date.now() }); }, []);
  useEffect(() => {
    if (!toast || toast.text.endsWith('…')) return;
    const timer = window.setTimeout(() => setToast(current => current?.id === toast.id ? null : current), 8000);
    return () => { window.clearTimeout(timer); };
  }, [toast]);
  const disabled = workspace.busy || importBusy;
  // ショートカットは描画直後の状態で判定する（ドロワーを閉じた直後の Ctrl+F などを取りこぼさない）。
  const blocked = useRef(disabled);
  useLayoutEffect(() => { blocked.current = disabled; });
  const openPalette = useCallback(() => { setPalette(true); setPaletteFocus(n => n + 1); }, []);
  useEffect(() => {
    const key = (event: globalThis.KeyboardEvent): void => {
      if (!event.ctrlKey || event.altKey || event.metaKey || event.isComposing || event.keyCode === 229 || stillComposing(composing.current) || blocked.current) return;
      switch (event.key.toLowerCase()) {
        case 'f': event.preventDefault(); openPalette(); break;
        case 's': if (workspace.state.session) { event.preventDefault(); void workspace.store.flush(); } break;
        case 'n': if (!palette && acceptsNewInvoice(event.target)) { event.preventDefault(); void workspace.open(null); } break;
      }
    };
    window.addEventListener('keydown', key);
    const unsubscribe = window.appApi.documents.onCloseRequested(token => {
      if (importBusy) return;
      // 請求書の編集画面の欄で変換中に閉じると、確定していない文字が変換前のまま保存されるか失われるため、黙って無視せず確定を求める（確定してもう一度閉じれば、同じ終了確認へ進む）。
      // 明細最終行の検索欄も編集画面の「変換中」を立てるため、同じく確定を求める。
      // 材料パレットなど編集画面の外の変換（検索語など）は、そのまま終了確認へ進む（モーダルの裏の通知は見えにくく、失うのは検索語だけのため）。
      if (composingInEditor(composing.current)) { notify('日本語の変換を確定してから、もう一度閉じてください。'); return; }
      void workspace.close(token);
    });
    return () => { window.removeEventListener('keydown', key); unsubscribe(); };
  }, [workspace, importBusy, palette, openPalette, notify]);

  const lines = workspace.state.session?.draft.lines;
  const existing = useMemo(() => new Set((lines ?? []).flatMap(line => line.materialId ? [line.materialId] : [])), [lines]);
  async function addFromPalette(ids: readonly string[]): Promise<void> {
    setPalette(false);
    const added = await workspace.add(ids);
    if (!added) return;
    // 追加できた材料だけ選択から外す（追加できなかった分は選んだまま残す）。
    setPicked(current => { const next = new Map(current); for (const line of added.lines) if (line.materialId) next.delete(line.materialId); return next; });
    const [first] = added.lines, last = added.position + added.lines.length - 1;
    if (added.lines.length === 1 && first) notify(`「${[first.name, first.model].filter(Boolean).join(' ') || '（品名なし）'}」を明細${added.position}に追加しました`);
    else notify(`${added.lines.length}件の材料を明細${added.position}～${last}に追加しました`);
  }
  /** 削除した材料を、材料パレットで選んだ材料から外す（削除した材料は検索に出ず、追加もできないため）。 */
  function forgetPicked(ids: readonly string[]): void {
    setPicked(current => { if (!ids.some(id => current.has(id))) return current; const next = new Map(current); for (const id of ids) next.delete(id); return next; });
  }
  function openWizard(start: WizardStart): void { setWizardStart(start); void workspace.navigate('wizard'); }
  function exitWizard(view: 'ledger' | 'history'): void { setMaterialsView(current => ({ view, key: current.key + 1 })); void workspace.navigate('materials'); }
  const tab = tabOf(workspace.page);
  const editing = workspace.page === 'invoice';

  // 確定しないまま変換中の欄からフォーカスが外れたら、変換は終わっている（後で同じ欄へ戻っても変換中とみなさない）。ウィンドウの切り替えではフォーカスのある欄は変わらない。
  return <div className="shell" onCompositionStartCapture={event => { composing.current = event.target; }} onCompositionEndCapture={() => { composing.current = null; }}
    onBlurCapture={event => { if (event.target === composing.current && document.activeElement !== event.target) composing.current = null; }}>
    <header className="app-header">
      <span className="app-name">発注書管理</span>
      <nav className="app-tabs" aria-label="メインナビゲーション">
        {tabs.map(([key, label, page]) => <button key={key} className="app-tab" disabled={disabled} aria-current={tab === key ? 'page' : undefined} onClick={() => { void workspace.navigate(page); }}>{label}</button>)}
      </nav>
      <button className="search-launcher" disabled={disabled} aria-keyshortcuts="Control+F" onClick={openPalette}>材料を検索…<span className="kbd" aria-hidden="true">Ctrl+F</span></button>
    </header>
    <main className="app-main">
      {workspace.message && <p role="alert" className="app-message">{workspace.message}</p>}
      {workspace.page === 'history' && <InvoiceHistory disabled={disabled} currentId={workspace.state.session?.documentId ?? null} open={id => { void workspace.open(id); }} duplicate={id => { void workspace.open(id, true); }} create={() => { void workspace.open(null); }}
        remove={targets => workspace.deleteDocuments(targets)} notify={notify} onBackup={() => { void workspace.navigate('settings'); }}/>}
      {editing && <InvoicePanel key={workspace.state.session?.sessionId ?? 'none'} notify={notify} printPreview={() => { void workspace.printPreview(); }} printBlocked={workspace.printBlocked} exportState={workspace.exportState} exportExcel={() => { void workspace.exportExcel(); }} state={workspace.state} disabled={disabled}
        edit={draft => workspace.store.edit(draft)} save={() => { void workspace.store.flush(); }} add={id => { void workspace.add([id]); }} pickMaterials={openPalette} remove={id => { void workspace.remove(id); }} compose={value => workspace.store.compose(value)} back={() => { void workspace.navigate('history'); }}/>}
      {workspace.page === 'materials' && <MaterialManager key={materialsView.key} initialView={materialsView.view} onBusyChange={setImportBusy} onImport={openWizard} onDeleted={forgetPicked} notify={notify} disabled={disabled}/>}
      {workspace.page === 'wizard' && <ImportWizard key={wizardStart ? `${wizardStart.kind}-${wizardStart.batchId}` : 'new'} start={wizardStart} onBusyChange={setImportBusy} onExit={exitWizard} notify={notify}/>}
      {workspace.page === 'settings' && <div className="page page-settings">
        <h1>設定</h1>
        <BackupPanel disabled={disabled} run={workspace.backupOperation}/>
        <section className="stack" aria-labelledby="app-info-heading"><h2 id="app-info-heading">アプリ情報</h2><AppInformation/>
          <p className="note">保存場所が同期フォルダーやネットワーク上にないことを、利用開始前に確認してください。</p></section>
      </div>}
    </main>
    {palette && <MaterialPalette focusRequest={paletteFocus} disabled={disabled} picked={picked} room={MAX_LINES - (lines?.length ?? 0)} existing={existing} onPick={setPicked} onClose={() => setPalette(false)} onAdd={ids => { void addFromPalette(ids); }}/>}
    {toast && <div className={`toast${editing ? ' above-footer' : ''}`} role="status" aria-label={toast.label}><span>{toast.text}</span><button onClick={() => setToast(null)}>閉じる</button></div>}
    {workspace.confirmation && <ConfirmDialog confirmation={workspace.confirmation}/>}
  </div>;
}
