import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { LINE_ROWS, MAX_LINES, QUERY_MAX_LENGTH, TEXT_MAX_LENGTH } from '../shared/limits';
import type { CompositionEvent, CSSProperties, DragEvent, FocusEvent, KeyboardEvent, PointerEvent } from 'react';
import type { ExportCleanup, ExportIssue, ExportIssueField, ExportResult } from '../shared/export-api';
import type { InvoiceDraft, InvoiceLine } from '../shared/document-api';
import { exportIssues, issueMessage, markIndex } from '../shared/export-issues';
import { BOTH_MARK, CHECK_STATES, lineMark } from '../shared/invoice-sheet';
import type { CellSource, HeaderKey, LineField } from '../shared/invoice-sheet';
import type { EditorState } from './editor-store';
import type { FormatChange } from './format-history';
import { SheetPreview } from './SheetPreview';
import type { FormatUpdate, SheetFocus } from './SheetPreview';
import { useFormatHistory } from './useFormatHistory';
import { isComposingKey, useMaterialSearch } from './useMaterialSearch';

/** チェックの3択。状態と記号の対応は shared の CHECK_STATES（未選択は含まない）。 */
const CHECK_NAMES = { material_only: '材料のみ（●）', slip_only: '伝票のみ（○）', both: `材料・伝票とも納品（${BOTH_MARK}）` } as const;
const checks = CHECK_STATES.flatMap(entry => entry.deliveryState === 'unknown' ? [] : [{ value: entry.deliveryState, mark: entry.markOutput, label: entry.mark, name: CHECK_NAMES[entry.deliveryState] }]);
const UNSELECTED = CHECK_STATES[0];
const SHEET_LINES = LINE_ROWS, SUGGEST_LIMIT = 8;
type Target = { readonly kind: 'line'; readonly id: string } | { readonly kind: 'header' } | null;
interface Issue { readonly key: string; readonly text: string; readonly target: Target }
/** 確認事項の一覧を開いた出力の操作と、本体が止めた理由（Excel出力の事前判定で開いたときは空）。 */
interface Stopped { readonly action: 'excel' | 'print'; readonly issues: readonly ExportIssue[]; readonly draft: InvoiceDraft | undefined }
export type Notify = (text: string, label?: string) => void;

/** チェックは任意の項目のため、未選択（空欄で出力）も出力できる。止めるのは記号未確定と状態・記号の不一致だけ。 */
const markValid = (line: InvoiceLine): boolean => lineMark(line) !== null;
const LINE_FIELDS = new Set<string>(['mark', 'name', 'model', 'manufacturer', 'quantity', 'remarks']), HEADER_KEYS = new Set<string>(['C2', 'A4', 'B4', 'C4', 'E4']);
type Focused = { readonly kind: 'line'; readonly id: string; readonly field: LineField } | { readonly kind: 'header'; readonly key: HeaderKey };
/** 出力前の確認の1項目。欄（field）から一覧の識別子とジャンプ先を決める。 */
function toIssue(field: ExportIssueField, text: string, draft: InvoiceDraft): Issue {
  const index = markIndex(field), id = index === null ? undefined : draft.lines[index]?.id;
  if (id) return { key: `line:${id}`, target: { kind: 'line', id }, text };
  if (field === 'E4') return { key: 'header:E4', target: { kind: 'header' }, text };
  return { key: field === 'lines' ? 'lines' : field === 'templateVersion' ? 'template' : `main:${field}`, target: null, text };
}
/** Excel出力の事前表示。規則と文言は shared/export-issues.ts（本体と同じ）で、最終判定は本体の結果を正とする。 */
const draftIssues = (draft: InvoiceDraft): Issue[] => exportIssues(draft).map(issue => toIssue(issue.field, issueMessage(issue, draft), draft));

export function InvoicePanel({ state, disabled, edit, save, add, pickMaterials, remove, compose, exportExcel, exportState, printBlocked, printPreview, back, notify }: {
  readonly state: EditorState; readonly disabled: boolean; readonly edit: (draft: InvoiceDraft) => void; readonly save: () => void;
  readonly add: (materialId: string | null) => void; readonly pickMaterials: () => void; readonly remove: (id: string) => void; readonly compose: (active: boolean) => void;
  readonly exportExcel: () => void; readonly exportState: ExportResult | { readonly status: 'idle' | 'working' };
  readonly printBlocked: { readonly issues: readonly ExportIssue[] } | null; readonly printPreview: () => void;
  readonly back: () => void; readonly notify: Notify;
}) {
  const session = state.session;
  const [issuesOpen, setIssuesOpen] = useState(false);
  // フォーカスした入力欄。プレビューの同じセルを選択表示する（並べ替え後も同じ明細を指すよう id で持ち、同じ欄へ戻ったときも選び直せるよう回数を数える）。
  const [focused, setFocused] = useState<{ readonly target: Focused; readonly seq: number } | null>(null);
  const [previewShare, setPreviewShare] = useState(0.42);
  const split = useRef<HTMLDivElement>(null);
  const [stopped, setStopped] = useState<Stopped | null>(null), [seenExport, setSeenExport] = useState(exportState), [seenPrint, setSeenPrint] = useState(printBlocked);
  const [dragId, setDragId] = useState<string | null>(null), [overId, setOverId] = useState<string | null>(null), [flashId, setFlashId] = useState<string | null>(null);
  const scroller = useRef<HTMLDivElement>(null), flashTimer = useRef<number | undefined>(undefined), focusHandle = useRef<string | null>(null), focusHeader = useRef(false);
  // 日本語の変換を始めた欄（変換中だけ持つ）。
  const composingField = useRef<EventTarget | null>(null);
  const draft = session?.draft;
  // 書式の変更は履歴に積み、Ctrl+Z・Ctrl+Y（ツールバーのボタンでも）で元に戻す・やり直す。
  const formats = useFormatHistory(draft, edit, disabled || state.composing);

  // Main の blocked 結果（Excel出力・印刷プレビュー）は出力時点の保存版に対する判定。編集したら画面の事前判定へ戻す。
  if (seenExport !== exportState) {
    setSeenExport(exportState);
    if (exportState.status === 'blocked') { setStopped({ action: 'excel', issues: exportState.issues, draft }); setIssuesOpen(true); }
  }
  if (seenPrint !== printBlocked) {
    setSeenPrint(printBlocked);
    if (printBlocked) { setStopped({ action: 'print', issues: printBlocked.issues, draft }); setIssuesOpen(true); }
  }
  const shown = stopped && stopped.draft === draft ? stopped : null, blocked = shown?.issues ?? [];
  useEffect(() => {
    switch (exportState.status) {
      case 'working': notify('保存を確定してExcel出力を準備しています…', 'Excel出力状態'); break;
      case 'ok': notify(`保存版 ${exportState.revision} をExcelへ出力しました。`, 'Excel出力状態'); break;
      case 'cancelled': notify('Excel出力を取り消しました。請求書の保存内容は保持しています。', 'Excel出力状態'); break;
      case 'error': case 'blocked': notify('', 'Excel出力状態'); break;
      default: break;
    }
  }, [exportState, notify]);
  useEffect(() => {
    if (!issuesOpen) return;
    const key = (event: globalThis.KeyboardEvent): void => { if (event.key === 'Escape' && !event.isComposing) setIssuesOpen(false); };
    window.addEventListener('keydown', key);
    return () => { window.removeEventListener('keydown', key); };
  }, [issuesOpen]);
  useEffect(() => () => { window.clearTimeout(flashTimer.current); }, []);
  useLayoutEffect(() => {
    if (focusHandle.current) { document.getElementById(`handle-${focusHandle.current}`)?.focus(); focusHandle.current = null; }
    if (focusHeader.current) { focusHeader.current = false; document.getElementById('header-E4')?.focus({ preventScroll: true }); }
  });

  if (!session || !draft) return <div className="page page-list"><h1>請求書</h1><p>請求書一覧から開くか、新規請求書を作成してください。</p><button className="btn medium" onClick={back}>請求書一覧へ</button></div>;

  const doc: InvoiceDraft = draft;
  const local = draftIssues(draft), known = new Set(local.map(issue => issue.key));
  const issues = [...local];
  for (const issue of blocked.map(item => toIssue(item.field, item.message, draft))) if (!known.has(issue.key)) { known.add(issue.key); issues.push(issue); }
  const locked = disabled || state.composing;
  const lines = draft.lines;
  function lineEdit(id: string, value: Partial<InvoiceLine>): void { edit({ ...doc, lines: doc.lines.map(line => line.id === id ? { ...line, ...value } : line) }); }
  /** プレビューのツールバーで変えた書式を、帳票上部の欄と明細へ反映する（1回の編集・元に戻す1段として扱う）。 */
  function formatCells(updates: readonly FormatUpdate[]): void {
    formats.record(updates.flatMap(({ source, format }): FormatChange[] => {
      if (source.kind === 'header') return [{ target: { kind: 'header', key: source.key }, format }];
      const line = doc.lines[source.index];
      return line ? [{ target: { kind: 'line', id: line.id, field: source.field }, format }] : [];
    }));
  }
  function moveTo(id: string, target: number): void {
    const from = lines.findIndex(line => line.id === id), moving = lines[from];
    if (!moving || target < 0 || target >= lines.length || target === from) return;
    const next = lines.filter(line => line.id !== id); next.splice(target, 0, moving);
    edit({ ...doc, lines: next });
  }
  function jump(issue: Issue): void {
    setIssuesOpen(false);
    if (issue.target?.kind === 'header') { focusHeader.current = true; return; }
    if (issue.target?.kind !== 'line') return;
    const id = issue.target.id, row = document.getElementById(`line-row-${id}`), box = scroller.current;
    if (!row || !box) return;
    box.scrollTop += row.getBoundingClientRect().top - box.getBoundingClientRect().top - box.clientHeight / 3;
    window.clearTimeout(flashTimer.current); setFlashId(id); flashTimer.current = window.setTimeout(() => setFlashId(null), 1800);
    row.querySelector<HTMLButtonElement>('.check-toggle button[tabindex="0"]')?.focus({ preventScroll: true });
  }
  function startExport(): void {
    if (local.length > 0) { save(); setStopped({ action: 'excel', issues: [], draft }); setIssuesOpen(true); return; }
    exportExcel();
  }
  function quantityKey(event: KeyboardEvent<HTMLInputElement>, index: number): void {
    if (event.key !== 'Enter' || isComposingKey(event, state.composing)) return;
    event.preventDefault();
    const next = lines[index + 1];
    (next ? document.getElementById(`quantity-${next.id}-quantity`) : document.getElementById('add-line-input'))?.focus();
  }
  function handleKey(event: KeyboardEvent<HTMLButtonElement>, id: string, index: number): void {
    if (!event.altKey || (event.key !== 'ArrowUp' && event.key !== 'ArrowDown') || locked) return;
    event.preventDefault(); focusHandle.current = id; moveTo(id, index + (event.key === 'ArrowUp' ? -1 : 1));
  }
  function dragOver(event: DragEvent<HTMLTableRowElement>, id: string): void {
    if (!dragId || locked) return;
    event.preventDefault(); event.dataTransfer.dropEffect = 'move';
    if (overId !== id) setOverId(id);
  }
  function drop(event: DragEvent<HTMLTableRowElement>, index: number): void {
    if (!dragId || locked) return;
    event.preventDefault(); moveTo(dragId, index); setDragId(null); setOverId(null);
  }
  const dragIndex = dragId ? lines.findIndex(line => line.id === dragId) : -1;
  const status = state.composing ? '変換確定を待っています' : { idle: '未保存', waiting: '未保存（自動保存待機中）', saving: '保存中…', saved: '保存済み', error: '保存失敗' }[state.status];
  const target = focused?.target, focusIndex = target?.kind === 'line' ? lines.findIndex(line => line.id === target.id) : -1;
  const focusSource: CellSource | null = target?.kind === 'header' ? target : target && focusIndex >= 0 ? { kind: 'line', index: focusIndex, field: target.field } : null;
  const sheetFocus: SheetFocus | null = focused && focusSource ? { source: focusSource, seq: focused.seq } : null;
  function trackFocus(event: FocusEvent<HTMLDivElement>): void {
    const element = event.target instanceof HTMLElement ? event.target.closest<HTMLElement>('[data-line][data-field], [data-header]') : null;
    const id = element?.dataset['line'], field = element?.dataset['field'], header = element?.dataset['header'];
    const next: Focused | null = header && HEADER_KEYS.has(header) ? { kind: 'header', key: header as HeaderKey } : id && field && LINE_FIELDS.has(field) ? { kind: 'line', id, field: field as LineField } : null;
    if (next) setFocused(current => ({ target: next, seq: (current?.seq ?? 0) + 1 }));
  }
  /** プレビューで選んだ明細のセルに対応する明細表の欄へ移動する。 */
  function pick(source: CellSource): void {
    if (source.kind !== 'line') return;
    const line = lines[source.index];
    const field = line ? document.querySelector<HTMLElement>(`[data-line="${CSS.escape(line.id)}"][data-field="${source.field}"]`) : null;
    (field?.matches('input, textarea') ? field : field?.querySelector<HTMLElement>('button[tabindex="0"]'))?.focus();
  }
  function resize(event: PointerEvent<HTMLDivElement>): void {
    const box = split.current?.getBoundingClientRect();
    if (!box || event.buttons !== 1) return;
    setPreviewShare(Math.min(0.7, Math.max(0.25, (box.right - event.clientX) / box.width)));
  }
  function compositionStart(event: CompositionEvent<HTMLDivElement>): void { composingField.current = event.target; compose(true); }
  function compositionEnd(): void { composingField.current = null; compose(false); }
  /**
   * 変換中の欄からフォーカスが外れたら、変換は終わっている。欄が変換の開始と同時に無効になったときは
   * compositionend が届かないため、ここで変換中を解除する（ウィンドウを切り替えただけならフォーカスのある欄は変わらないので解除しない）。
   */
  function focusOut(event: FocusEvent<HTMLDivElement>): void {
    if (event.target === composingField.current && document.activeElement !== event.target) compositionEnd();
  }
  function resizeKey(event: KeyboardEvent<HTMLDivElement>): void {
    const delta = event.key === 'ArrowLeft' ? 0.05 : event.key === 'ArrowRight' ? -0.05 : 0;
    if (!delta) return;
    event.preventDefault(); setPreviewShare(share => Math.min(0.7, Math.max(0.25, share + delta)));
  }

  return <div className="editor-layout" role="region" aria-label="請求書編集" onCompositionStart={compositionStart} onCompositionEnd={compositionEnd} onBlur={focusOut} onInput={formats.typed}>
    <div className="editor-split" ref={split} style={{ '--preview-share': previewShare } as CSSProperties} onFocus={trackFocus}>
    <div className="editor-scroll" ref={scroller}>
      <div className="editor-body">
        <div className="row">
          <button className="btn text" onClick={back}>← 請求書一覧</button>
          <input className="title-input" aria-label="管理用タイトル" placeholder="（タイトルなし）" maxLength={TEXT_MAX_LENGTH} disabled={disabled} value={draft.title} onChange={event => edit({ ...draft, title: event.target.value })}/>
        </div>
        {state.message && <p role="alert">{state.message}</p>}
        <ExportFeedback exportState={exportState}/>
        <p className="note">帳票の上部（上部欄・ヘッダー欄・納期）は、Excelプレビューのセルをクリックして直接入力します。</p>
        <section className="stack gap-8 lines-section" aria-labelledby="lines-heading">
          <div className="lines-heading"><h2 id="lines-heading">明細</h2><span className={`line-cap${lines.length > SHEET_LINES ? ' over' : ''}`} aria-label={`明細 ${lines.length}行（帳票は${LINE_ROWS}行まで）`}>{lines.length} / {SHEET_LINES}行</span><span className="note">数量でEnter → 次の行の数量へ</span>
            <button type="button" className="btn medium push-end" disabled={locked || lines.length >= MAX_LINES} aria-keyshortcuts="Control+F" onClick={pickMaterials}>材料を選んでまとめて追加<span className="kbd-hint" aria-hidden="true">Ctrl+F</span></button></div>
          <fieldset className="lines-wrap plain-fieldset" disabled={disabled}>
            <table className="lines">
              <colgroup><col className="c-no"/><col className="c-name"/><col className="c-model"/><col className="c-maker"/><col className="c-qty"/><col className="c-remarks"/><col className="c-check"/><col className="c-del"/></colgroup>
              <thead><tr><th scope="col">#</th><th scope="col">品名</th><th scope="col">型式</th><th scope="col">メーカー</th><th scope="col">数量</th><th scope="col">備考</th><th scope="col">チェック</th><th scope="col"><span className="sr-only">削除</span></th></tr></thead>
              <tbody>
                {lines.map((line, index) => {
                  const n = index + 1, unset = !markValid(line);
                  const dropClass = overId === line.id && dragId && dragId !== line.id ? (dragIndex < index ? ' drop-below' : ' drop-above') : '';
                  return <tr key={line.id} id={`line-row-${line.id}`} className={`${unset ? 'warn' : ''}${flashId === line.id ? ' flash' : ''}${dragId === line.id ? ' dragging' : ''}${dropClass}`}
                    onDragOver={event => dragOver(event, line.id)} onDrop={event => drop(event, index)}>
                    <td><button id={`handle-${line.id}`} className="drag-handle" draggable={!locked} disabled={state.composing} aria-label={`明細${n}を並べ替え（Alt+↑↓）`} title="ドラッグで並べ替え（Alt+↑↓でも移動）"
                      onKeyDown={event => handleKey(event, line.id, index)}
                      onDragStart={event => { event.dataTransfer.effectAllowed = 'move'; event.dataTransfer.setData('text/plain', line.id); setDragId(line.id); }}
                      onDragEnd={() => { setDragId(null); setOverId(null); }}><span className="drag-dots" aria-hidden="true">⋮⋮</span>{n}</button></td>
                    <td><input className="cell-input strong" data-line={line.id} data-field="name" aria-label={`明細${n} 品名`} maxLength={TEXT_MAX_LENGTH} value={line.name} onChange={event => lineEdit(line.id, { name: event.target.value })}/></td>
                    <td><input className="cell-input" data-line={line.id} data-field="model" aria-label={`明細${n} 型式`} maxLength={TEXT_MAX_LENGTH} value={line.model} onChange={event => lineEdit(line.id, { model: event.target.value })}/></td>
                    <td><input className="cell-input" data-line={line.id} data-field="manufacturer" aria-label={`明細${n} メーカー`} maxLength={TEXT_MAX_LENGTH} value={line.manufacturer} onChange={event => lineEdit(line.id, { manufacturer: event.target.value })}/></td>
                    <td><input id={`quantity-${line.id}-quantity`} data-line={line.id} data-field="quantity" className={`cell-input number${line.quantity === '' ? ' empty' : ''}`} aria-label={`明細${n} 数量`} maxLength={TEXT_MAX_LENGTH} value={line.quantity} onKeyDown={event => quantityKey(event, index)} onChange={event => lineEdit(line.id, { quantity: event.target.value })}/></td>
                    <td><textarea className="cell-input" rows={1} data-line={line.id} data-field="remarks" aria-label={`明細${n} 備考`} maxLength={TEXT_MAX_LENGTH} value={line.remarks} onChange={event => lineEdit(line.id, { remarks: event.target.value })}/></td>
                    <td className="check-cell" data-line={line.id} data-field="mark"><CheckToggle line={line} n={n} disabled={locked} onChange={(deliveryState, markOutput) => lineEdit(line.id, { deliveryState, markOutput })}/></td>
                    <td className="delete-cell"><button className="delete-line" aria-label={`明細${n}を削除`} title="明細を削除" disabled={state.composing} onClick={() => remove(line.id)}>×</button></td>
                  </tr>;
                })}
                {/* 変換中を理由に無効にすると、この欄で変換を始めた瞬間に欄が無効になって変換が失われる（変換中に候補を押したときは AddLineRow の add が先に変換を確定させ、編集画面が変換中のままなら workspace の add が止める）。 */}
                <AddLineRow disabled={disabled || lines.length >= MAX_LINES} full={lines.length >= MAX_LINES} onAdd={add}/>
              </tbody>
            </table>
          </fieldset>
        </section>
      </div>
    </div>
    <div className="split-handle" role="separator" aria-orientation="vertical" aria-label="プレビューの幅" aria-valuemin={25} aria-valuemax={70} aria-valuenow={Math.round(previewShare * 100)} tabIndex={0}
      onPointerDown={event => event.currentTarget.setPointerCapture(event.pointerId)} onPointerMove={resize} onKeyDown={resizeKey}/>
    <SheetPreview draft={draft} disabled={disabled} focus={sheetFocus} onPick={pick} onFormat={formatCells} history={formats.controls} onHeaderChange={(key, value) => edit({ ...doc, header: { ...doc.header, [key]: value } })}/>
    </div>
    <footer className="editor-footer" aria-label="保存と出力">
      <span className="save-state" data-state={state.composing ? 'waiting' : state.status} role="status" aria-label="保存状態">{status}</span>
      <span className="note">保存版 {session.revision}<span className="footer-hint"> ・ Ctrl+Sで今すぐ保存</span></span>
      {state.status === 'error' && <button className="btn danger small" disabled={locked} onClick={save}>保存を再試行</button>}
      <button className={`issues-pill${issues.length ? ' has-issues' : ''}`} aria-expanded={issues.length ? issuesOpen : undefined} aria-controls="export-issues" disabled={issues.length === 0} onClick={() => setIssuesOpen(open => !open)}>{issues.length ? `出力前の確認 ${issues.length}件` : '出力の準備ができています'}</button>
      <div className="editor-footer-end">
        <button className="btn" disabled={locked} onClick={printPreview}>印刷プレビュー・PDF</button>
        <button className="btn primary" disabled={locked} onClick={startExport}>Excelへ出力</button>
      </div>
    </footer>
    {issuesOpen && issues.length > 0 && <div id="export-issues" className="issues-popover" role="alert" aria-label="出力前の確認事項">
      <span className="issues-popover-title">{blocked.length ? `確認が必要なため${shown?.action === 'print' ? '印刷プレビュー' : 'Excel出力'}を止めました` : shown?.action === 'excel' ? 'Excel出力の前に確認してください' : '出力の前に確認してください'}</span>
      <ul>{issues.map(issue => <li key={issue.key}>{issue.target ? <button onClick={() => jump(issue)}>{issue.text}</button> : <span>{issue.text}</span>}</li>)}</ul>
      <span className="note">下書きは保存されています。印刷表示の完全一致は未確認です。</span>
    </div>}
  </div>;
}

/** チェック状態の3択（任意の項目）。選択中を再度押すと未選択（空欄で出力）へ戻る。矢印キーでフォーカスを移し、Space/Enterで選ぶ。 */
function CheckToggle({ line, n, disabled, onChange }: { readonly line: InvoiceLine; readonly n: number; readonly disabled: boolean; readonly onChange: (state: InvoiceLine['deliveryState'], mark: InvoiceLine['markOutput']) => void }) {
  const current = checks.findIndex(option => option.value === line.deliveryState);
  const focusable = current < 0 ? 0 : current;
  function key(event: KeyboardEvent<HTMLButtonElement>, index: number): void {
    const step = event.key === 'ArrowRight' || event.key === 'ArrowDown' ? 1 : event.key === 'ArrowLeft' || event.key === 'ArrowUp' ? -1 : 0;
    if (!step || event.altKey) return;
    event.preventDefault();
    const buttons = event.currentTarget.parentElement?.querySelectorAll('button');
    buttons?.[(index + step + checks.length) % checks.length]?.focus();
  }
  // 状態と記号がそろったものだけを選択中とする（「共に納品」の記号を決める前の明細は未選択に見え、記号を押すとそろう）。
  return <div role="radiogroup" aria-label={`明細${n} チェック状態`} className={`check-toggle${markValid(line) ? '' : ' unset'}`}>
    {checks.map((option, index) => { const on = line.deliveryState === option.value && line.markOutput === option.mark; return <button key={option.value} type="button" role="radio" aria-checked={on} aria-label={option.name} title={option.name} tabIndex={index === focusable ? 0 : -1} disabled={disabled}
      onKeyDown={event => key(event, index)} onClick={() => { if (on) onChange(UNSELECTED.deliveryState, UNSELECTED.markOutput); else onChange(option.value, option.mark); }}>{option.label}</button>; })}
  </div>;
}

/** 明細の最終行。材料を検索して追加する（↑↓で選択、Enterで追加）。 */
function AddLineRow({ disabled, full, onAdd }: { readonly disabled: boolean; readonly full: boolean; readonly onAdd: (materialId: string | null) => void }) {
  const [open, setOpen] = useState(false), [selected, setSelected] = useState(0);
  const search = useMaterialSearch({ enabled: open }), field = useRef<HTMLInputElement>(null);
  const query = search.input.query.trim();
  const rows = query && search.state.status === 'ready' ? search.state.data.rows.slice(0, SUGGEST_LIMIT) : [];
  const index = Math.min(selected, Math.max(0, rows.length - 1));
  /**
   * 選んだ材料（null は空の明細）を追加する。変換中に候補・ボタンを押したときは、先に変換を確定する（フォーカスを外すと compositionend が
   * その場で届き、編集画面の「変換中」が解ける。変換中のままでは追加できない）。フォーカスは欄へ戻し、追加できなかったときもこの欄に残す。
   */
  function add(id: string | null): void {
    if (disabled) return;
    const box = field.current;
    if (search.composing.current && box) { box.blur(); box.focus(); }
    onAdd(id); search.setQuery(''); setSelected(0); setOpen(false);
  }
  function key(event: KeyboardEvent<HTMLInputElement>): void {
    if (isComposingKey(event, search.composing.current)) { if (event.key === 'Enter') event.preventDefault(); return; }
    if (event.key === 'Escape') { if (open) { event.preventDefault(); event.stopPropagation(); setOpen(false); } return; }
    if (event.key === 'ArrowDown' || event.key === 'ArrowUp') { event.preventDefault(); setOpen(true); if (rows.length) setSelected(Math.max(0, Math.min(rows.length - 1, index + (event.key === 'ArrowDown' ? 1 : -1)))); return; }
    if (event.key === 'Enter') { event.preventDefault(); const row = rows[index]; if (row && open) add(row.id); }
  }
  let label: string;
  if (!query) label = full ? `明細は${MAX_LINES}行までです。` : 'キーワードを入力すると候補を表示します';
  else if (search.state.status === 'loading') label = '検索しています…';
  else if (search.state.status === 'error') label = search.state.message;
  else label = rows.length ? `${search.state.data.total}件の候補${search.state.data.total > SUGGEST_LIMIT ? `（上位${SUGGEST_LIMIT}件を表示）` : ''}` : '該当する材料はありません';
  return <tr className="add-row">
    <td className="add-mark" aria-hidden="true">+</td>
    <td colSpan={7} className="add-cell">
      <input ref={field} id="add-line-input" className="field" type="text" role="combobox" aria-label="材料を検索して明細に追加" aria-expanded={open} aria-controls="add-line-suggest" aria-activedescendant={open && rows.length ? `add-option-${index}` : undefined} autoComplete="off"
        placeholder="品名・型式・メーカーを入力して材料を追加（↑↓で選択、Enterで追加）" maxLength={QUERY_MAX_LENGTH} disabled={disabled} value={search.input.query}
        onFocus={() => setOpen(true)} onKeyDown={key}
        // 変換を確定しないままフォーカスが外れたとき（compositionend が届かないとき）も、変換中の扱い（Enter・↑↓を IME に任せる）を解く（ウィンドウの切り替えでは欄のフォーカスは変わらないので解かない）。
        onBlur={event => { setOpen(false); if (search.composing.current && document.activeElement !== event.currentTarget) search.compositionEnd(event.currentTarget.value); }}
        onChange={event => { setOpen(true); setSelected(0); search.setQuery(event.target.value); }}
        onCompositionStart={search.compositionStart} onCompositionEnd={event => { if (search.compositionEnd(event.currentTarget.value)) setSelected(0); }}/>
      {open && <div id="add-line-suggest" className="suggest" onMouseDown={event => event.preventDefault()}>
        {rows.length > 0 && <ul className="suggest-list" role="listbox" aria-label="追加する材料の候補">{rows.map((row, i) => <li key={row.id} id={`add-option-${i}`} role="option" aria-selected={i === index} className="suggest-item" onMouseMove={() => { if (i !== index) setSelected(i); }} onClick={() => add(row.id)}>
          <span className="original-text"><span className="strong">{row.name || '（品名なし）'}</span><span className="sub"> {row.model || '型式なし'} ・ {row.manufacturer || 'メーカーなし'}</span></span>
          <span className="chip">{row.categoryName}</span>
        </li>)}</ul>}
        <div className="suggest-foot"><span role="status">{label}</span><button type="button" disabled={disabled} onClick={() => add(null)}>空の明細を追加</button></div>
      </div>}
    </td>
  </tr>;
}

function ExportFeedback({ exportState }: { readonly exportState: ExportResult | { readonly status: 'idle' | 'working' } }) {
  if (exportState.status === 'ok' && exportState.cleanup) return <div className="alert export-feedback" role="alert" aria-label="Excel出力の一時ファイル"><p>保存版 {exportState.revision} をExcelへ出力しました。出力は確定済みです。一時ファイルが残っているため、同じ名前への上書きはできません。</p><CleanupInstructions cleanup={exportState.cleanup}/></div>;
  if (exportState.status === 'error') return <div className="alert export-feedback" role="alert" aria-label="Excel出力エラー"><p>{exportState.message}</p>{exportState.cleanup && <><p>今回の出力は未確定です。既存のxlsxは変更していません。下書きの保存内容も保持しています。</p><CleanupInstructions cleanup={exportState.cleanup}/></>}</div>;
  return null;
}

function CleanupInstructions({ cleanup }: { readonly cleanup: ExportCleanup }) {
  return <><p>削除できなかった一時ファイル: <span className="path">{cleanup.temporaryName}</span></p><ol><li>選択した保存先フォルダーをエクスプローラーで開き、ファイル名拡張子を表示してください。</li><li>上の名前と完全に一致する一時ファイルだけを削除してください。完成したxlsxや他のtmpは削除しないでください。</li><li>削除後に「Excelへ出力」から再試行してください。削除できない場合は別名で出力できますが、一時ファイルには帳票情報が残るため、使用状態やアクセス権を確認して後で削除してください。</li></ol></>;
}
