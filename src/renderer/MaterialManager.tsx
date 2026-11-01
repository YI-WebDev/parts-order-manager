import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { CATEGORY_NAME_MAX_LENGTH, QUERY_MAX_LENGTH, TEXT_MAX_LENGTH } from '../shared/limits';
import type { ImportSummary } from '../shared/import-api';
import type { MaterialForm, MaterialSave } from '../shared/master-api';
import { MATERIAL_FIELDS } from '../shared/master-api';
import type { CategoryOption, SearchInput, SearchRow } from '../shared/material-search-api';
import { SEARCH_PAGE_SIZE } from '../shared/material-search-api';
import { CategoryPager } from './CategoryPager';
import { ConfirmDialog } from './ConfirmDialog';
import type { Confirmation, ConfirmChoice } from './ConfirmDialog';
import { filtered, noMaterialsMessage } from './empty-messages';
import { TrashIcon } from './InvoiceHistory';
import { findCategory, useCategoryPage, visibleCategories } from './useCategoryPage';
import type { DeleteOutcome } from './useInvoiceWorkspace';
import { useMaterialSearch } from './useMaterialSearch';
import type { SearchState } from './useMaterialSearch';
import type { Notify } from './InvoicePanel';

export const fieldLabels = { name: '品名', model: '型式', manufacturer: 'メーカー', quantity: '数量', remarks: '備考', unitPrice: '単価' } as const;
const empty = { name: '', model: '', manufacturer: '', quantity: '', remarks: '', unitPrice: '' };
export type WizardStart = { readonly kind: 'first' | 're'; readonly batchId: string } | null;

type CategoryChoice = { readonly id: string; readonly name: string };

/** 材料の編集ドロワー。保存結果不明時の文言・再試行・編集中の移動停止は従来どおり。カテゴリは候補を検索・ページ送りして選び、選んだカテゴリは候補のページを変えても保持する。 */
function MaterialDrawer({ form, onDone, onBusyChange }: { readonly form: MaterialForm; readonly onDone: (saved: boolean, uncertain?: boolean) => void; readonly onBusyChange: (busy: boolean) => void }) {
  const m = form.material;
  const initialCategory: CategoryChoice | null = m ? { id: m.categoryId, name: m.categoryName } : form.categories[0] ?? null;
  const [value, setValue] = useState<MaterialSave>({ ...(!m && form.createRequestId ? { createRequestId: form.createRequestId } : {}), id: m?.id ?? null, expectedRevision: m?.revision ?? 0, categoryId: initialCategory?.id ?? null, newCategoryName: '', active: m?.active ?? true, values: m?.values ?? empty });
  const [category, setCategory] = useState(initialCategory);
  const categories = useCategoryPage({ includeInactive: true });
  // 最初の候補を読むまでは、材料の画面と一緒に届いた先頭ページを使う。
  const choices: readonly CategoryChoice[] = categories.page?.rows ?? form.categories;
  const { pinned } = visibleCategories(choices, value.categoryId ? category : null);
  const [saving, setSaving] = useState(false), [error, setError] = useState(''), [uncertain, setUncertain] = useState(false), [showEscapes, setShowEscapes] = useState(false);
  const pending = useRef<MaterialSave | null>(null), unmounting = useRef(false), lock = useRef(false), composing = useRef(false), ref = useRef<HTMLDialogElement>(null);
  useEffect(() => { onBusyChange(true); return () => onBusyChange(false); }, [onBusyChange]);
  useEffect(() => {
    const dialog = ref.current; const previous = document.activeElement;
    dialog?.showModal();
    return () => { unmounting.current = true; dialog?.close(); if (previous instanceof HTMLElement && previous.isConnected) previous.focus(); };
  }, []);
  async function save(): Promise<void> {
    if (lock.current || composing.current || (!uncertain && value.values.name.trim() === '')) return;
    lock.current = true; setSaving(true); setError('');
    try { const request = uncertain && pending.current ? pending.current : value; pending.current = request; const r = await window.appApi.master.save(request); if (r.status === 'ok') onDone(true); else if (r.status === 'error') setError(r.message); }
    catch { if (!m) setUncertain(true); setError(m ? '保存結果を確認できません。入力を保持しています。一覧の状態を確認してください。' : '保存結果を確認できません。既に保存されている可能性があります。同じ内容で再試行できます。閉じても保存の取消にはなりません。'); }
    finally { lock.current = false; setSaving(false); }
  }
  const cancel = (): void => { if (!saving) onDone(false, uncertain); };
  const heading = m ? '材料を編集' : '材料を手動追加';
  return <dialog ref={ref} className="drawer" aria-labelledby="drawer-heading" onCancel={event => { event.preventDefault(); cancel(); }}
    onClose={() => { if (unmounting.current) return; if (saving) ref.current?.showModal(); else cancel(); }}
    onMouseDown={event => { if (event.target === event.currentTarget) cancel(); }}
    onCompositionStart={() => { composing.current = true; }} onCompositionEnd={() => { composing.current = false; }}
    onKeyDown={event => { if (event.ctrlKey && event.key.toLowerCase() === 's') { event.preventDefault(); event.stopPropagation(); if (!event.nativeEvent.isComposing && event.nativeEvent.keyCode !== 229) void save(); } }}>
    <div className="drawer-head"><span className="note original-text">{m?.source ? `Excel由来 ・ ${m.source.sheetName} / ${m.source.rowIndex}行 / ${m.source.block}` : '手動作成'}</span><h2 id="drawer-heading">{heading}</h2></div>
    <div className="drawer-body">
      <fieldset disabled={saving || uncertain} className="plain-fieldset stack" aria-label="材料の値">
        <label className="labelled"><span className="label-text">カテゴリ</span><select className="field" value={value.categoryId ?? ''} onChange={e => { const id = e.target.value || null; setCategory(findCategory(id, choices, category)); setValue({ ...value, categoryId: id, newCategoryName: '' }); }}>
          <option value="">新しいカテゴリ</option>
          {pinned && <option value={pinned.id}>{pinned.name}</option>}
          {choices.map(c => <option key={c.id} value={c.id}>{c.name}</option>)}
        </select></label>
        <CategoryPager categories={categories}/>
        {!value.categoryId && <label className="labelled"><span className="label-text">新しいカテゴリ名</span><input className="field" maxLength={CATEGORY_NAME_MAX_LENGTH} value={value.newCategoryName} onChange={e => setValue({ ...value, newCategoryName: e.target.value })}/></label>}
        {MATERIAL_FIELDS.map(field => { const changed = m !== null && m.values[field] !== value.values[field]; return <label key={field} className="labelled">
          <span className="label-text">{fieldLabels[field]}{changed && <span className="changed-mark">変更あり</span>}</span>
          <textarea className={`field${changed ? ' changed' : ''}`} rows={1} aria-label={fieldLabels[field]} maxLength={TEXT_MAX_LENGTH} value={value.values[field]} onChange={e => setValue({ ...value, values: { ...value.values, [field]: e.target.value } })}/>
        </label>; })}
        <label className="check-control"><input type="checkbox" checked={value.active} onChange={e => setValue({ ...value, active: e.target.checked })}/>有効（外すと検索の既定結果から除外）</label>
      </fieldset>
      {value.values.name.trim() === '' && !uncertain && <p className="note">品名を入力すると保存できます。</p>}
      {m?.source && <details className="material-comparison"><summary>前回確認済み取込値と現在値を比較</summary>
        <div className="stack gap-8">
          <p className="note">保存された原記録と編集中の値を比較します。再取込で現在値を保持した項目も、比較の基準はその時のExcelです。</p>
          <label className="check-control compact"><input type="checkbox" checked={showEscapes} onChange={e => setShowEscapes(e.target.checked)}/>空白・改行を記号で表示（JSON）</label>
          <table className="comparison"><thead><tr><th>項目</th><th>比較</th><th>前回確認済み取込値</th><th>現在値（編集中）</th></tr></thead><tbody>{MATERIAL_FIELDS.map((field, index) => {
            const base = m.source?.values[index] ?? '', current = value.values[field];
            return <tr key={field}><th>{fieldLabels[field]}</th><td>{base === current ? '一致' : '変更あり'}</td><td className="original-text">{showEscapes ? JSON.stringify(base) : base || '（空欄）'}</td><td className="original-text">{showEscapes ? JSON.stringify(current) : current || '（空欄）'}</td></tr>;
          })}</tbody></table>
        </div></details>}
      {error && <p role="alert">{uncertain ? <>保存結果を確認できません。<br/>既に保存されている可能性があります。<br/>同じ内容で再試行できます。<br/>閉じても保存の取消にはなりません。</> : error}</p>}
      <p className="note">{uncertain ? '再試行するか、閉じて一覧で保存状態を確認してください。' : '保存しても過去の請求書は変わりません。Ctrl+Sでも保存できます。編集中は画面移動・終了を止めています。'}</p>
    </div>
    <div className="drawer-foot">
      <button className="btn" disabled={saving} onClick={cancel}>{uncertain ? '保存結果を後で確認して閉じる' : '編集を取り消す'}</button>
      <button className="btn primary" disabled={saving || (!uncertain && value.values.name.trim() === '')} onClick={() => { void save(); }}>{saving ? '保存中…' : '材料を保存'}</button>
    </div>
  </dialog>;
}

const NONE: ReadonlySet<string> = new Set();
/** 材料を見分ける名前（品名と型式。材料パレットの選んだ材料と同じ）。 */
const materialLabel = (row: SearchRow): string => [row.name || '（品名なし）', row.model].filter(Boolean).join(' ');

/**
 * 材料台帳。選択は表示中のページ・検索条件の中だけで持ち（検索語・カテゴリ・無効の表示・ページを変えると解除）、選んだ材料をまとめて削除できる。
 * 削除した行はすぐに外し、表示したまま読み直してから、消えた位置に来た行のチェックへフォーカスを移す（行がなければキーワード欄）。
 * 移すのはフォーカスが失われているときだけで、読み直しの間に検索条件を変えたら取り消す。削除・編集の処理中は、検索の欄も使えない。
 */
function Ledger({ disabled, onEdit, remove, epoch }: { readonly disabled: boolean; readonly onEdit: (id: string) => void; readonly remove: (targets: readonly SearchRow[]) => Promise<DeleteOutcome>; readonly epoch: number }) {
  const search = useMaterialSearch();
  const { input } = search;
  const refreshed = useRef(epoch);
  useEffect(() => { if (refreshed.current !== epoch) { refreshed.current = epoch; search.refresh(); } }, [epoch, search]);
  // 削除の後はカテゴリの件数も読み直す（epoch・reloads はどちらも増えるだけなので、和が変われば読み直す）。
  const [reloads, setReloads] = useState(0);
  const categories = useCategoryPage({ includeInactive: input.includeInactive, refresh: epoch + reloads });
  const [picked, setPicked] = useState<CategoryOption | null>(null);
  const categoryRows = categories.page?.rows ?? [];
  const { pinned } = visibleCategories(categoryRows, input.categoryId ? picked : null);
  // 選んだ材料と、削除した材料（読み直しを待たずに一覧から外す。削除した材料は検索に出ないため、外したままでよい）。
  const [selected, setSelected] = useState(NONE), [gone, setGone] = useState(NONE);
  const allBox = useRef<HTMLInputElement>(null), keyword = useRef<HTMLInputElement>(null), body = useRef<HTMLTableSectionElement>(null);
  // 削除の後に移すフォーカス（index の位置の行。stale の検索結果より後の結果を待つ。次のページから繰り上がる行があるため）。
  const focusAfterDelete = useRef<{ readonly index: number; readonly stale: SearchState } | null>(null);
  /** 選択と、削除の後のフォーカスの予定を外す（検索条件を変えたとき）。 */
  function forget(): void { setSelected(NONE); focusAfterDelete.current = null; }
  function change(next: SearchInput, immediate = false): void { forget(); search.change(next, immediate); }
  const choose = (category: CategoryOption | null): void => { setPicked(category); change({ ...input, categoryId: category?.id ?? null, offset: 0 }, true); };
  const data = search.state.status === 'ready' ? search.state.data : null;
  const rows = data ? data.rows.filter(row => !gone.has(row.id)) : [];
  const total = data ? data.total - (data.rows.length - rows.length) : 0;
  // 選択の数・対象は、表示中の行に限る（読み直しで消えた・ほかのページへ移った行は数えない）。
  const chosen = rows.filter(row => selected.has(row.id)), all = rows.length > 0 && chosen.length === rows.length;
  useLayoutEffect(() => { if (allBox.current) allBox.current.indeterminate = chosen.length > 0 && !all; });
  useLayoutEffect(() => {
    const pending = focusAfterDelete.current;
    if (!pending || disabled || search.state.status !== 'ready' || search.state === pending.stale) return;
    focusAfterDelete.current = null;
    // 読み直しの間に利用者がほかの欄へ移ったときは、そのままにする（消した行にあったフォーカスは body に落ちている）。
    if (document.activeElement !== null && document.activeElement !== document.body) return;
    const boxes = body.current?.querySelectorAll<HTMLInputElement>('input[type="checkbox"]') ?? [];
    (boxes[Math.min(pending.index, boxes.length - 1)] ?? keyword.current)?.focus();
  });
  function toggle(id: string): void { setSelected(current => { const next = new Set(current); if (!next.delete(id)) next.add(id); return next; }); }
  async function removeRows(targets: readonly SearchRow[]): Promise<void> {
    const [first] = targets;
    if (!first) return;
    const index = Math.max(0, rows.findIndex(row => row.id === first.id)), outcome = await remove(targets);
    // 失敗したときは何も削除していないため、読み直さない（押したボタンにフォーカスを残す）。
    if (outcome === 'cancelled' || outcome === 'failed') return;
    setReloads(n => n + 1);
    if (outcome === 'unknown') {
      // 結果を確認できないときは、読み込み中の表示にして実際に残っている材料を見せる（選択は残す）。
      focusAfterDelete.current = { index, stale: search.state };
      search.refresh();
      return;
    }
    const ids = new Set(targets.map(row => row.id));
    setGone(current => new Set([...current, ...ids]));
    setSelected(current => new Set([...current].filter(id => !ids.has(id))));
    const left = rows.filter(row => !ids.has(row.id)).length, later = total - input.offset - rows.length;
    focusAfterDelete.current = { index, stale: search.state };
    // 行が残る、またはどこにも材料が残らないときは、表示したまま読み直す（後ろのページの行が繰り上がる）。
    if (left > 0 || total === rows.length) search.reload();
    // ページが空になり後ろのページに材料があるときは、空の表示を出さずに読み直す。最後のページ（先頭以外）が空になったら、前のページへ戻る。
    else if (later > 0) search.refresh();
    else { setSelected(NONE); focusAfterDelete.current = { index: Number.MAX_SAFE_INTEGER, stale: search.state }; search.change({ ...input, offset: Math.max(0, input.offset - SEARCH_PAGE_SIZE) }, true); }
  }
  return <div className="ledger">
    <div className="card category-list" role="group" aria-label="カテゴリ">
      <span className="note">カテゴリ</span>
      <CategoryPager categories={categories}/>
      <button aria-pressed={input.categoryId === null} disabled={disabled} onClick={() => choose(null)}><span className="original-text">すべて</span><span className="count">{categories.page?.materialCount}</span></button>
      {/* 候補のページ・検索結果にない選択中のカテゴリは先頭に残す（件数は無効の表示切替で変わるため出さない）。 */}
      {pinned && <button aria-pressed disabled={disabled} onClick={() => choose(pinned)}><span className="original-text">{pinned.name}</span><span className="count">選択中</span></button>}
      {categoryRows.map(category => <button key={category.id} aria-pressed={input.categoryId === category.id} disabled={disabled} onClick={() => choose(category)}><span className="original-text">{category.name}</span><span className="count">{category.count}</span></button>)}
      <label className="check-control compact"><input type="checkbox" checked={input.includeInactive} disabled={disabled} onChange={event => change({ ...input, includeInactive: event.target.checked, offset: 0 }, true)}/>無効も表示</label>
    </div>
    <div className="stack gap-8">
      <input ref={keyword} className="field" type="search" aria-label="キーワード" placeholder="品名・型式・メーカー・備考で絞り込み" maxLength={QUERY_MAX_LENGTH} value={input.query} disabled={disabled}
        onChange={event => change({ ...input, query: event.target.value, offset: 0 })} onCompositionStart={search.compositionStart} onCompositionEnd={event => { if (search.compositionEnd(event.currentTarget.value)) forget(); }}/>
      {search.state.status === 'loading' && <p role="status" className="status-line">検索しています…</p>}
      {search.state.status === 'error' && <div className="stack gap-8"><p role="alert">{search.state.message}</p><button className="btn medium" disabled={disabled} onClick={search.retry}>再試行</button></div>}
      {data && <>
        {/* 絞り込まずに0件（材料が登録されていない）ときは、登録の仕方を空の表示として目立たせる。 */}
        <p role="status" className={total === 0 && !filtered(input) ? 'empty-state' : 'note'}>{total === 0 ? noMaterialsMessage(input, 'ledger') : `${total}件中 ${input.offset + 1}～${input.offset + rows.length}件`}</p>
        {rows.length > 0 && <>
          <div className={`select-bar inline${chosen.length ? ' active' : ''}`} role="group" aria-label="材料の選択">
            <label className="check-control compact"><input ref={allBox} type="checkbox" checked={all} disabled={disabled} onChange={() => setSelected(all ? NONE : new Set(rows.map(row => row.id)))}/>このページをすべて選択</label>
            <span className="select-count" role="status">{chosen.length ? `${chosen.length}件を選択中` : ''}</span>
            {chosen.length > 0 && <>
              {/* 押すとこのボタンは消えるため、フォーカスは「このページをすべて選択」へ移す。 */}
              <button className="btn text" disabled={disabled} onClick={() => { setSelected(NONE); allBox.current?.focus(); }}>選択を解除</button>
              <button className="btn danger medium push-end" disabled={disabled} onClick={() => { void removeRows(chosen); }}><TrashIcon/>選択した{chosen.length}件を削除</button>
            </>}
          </div>
          <div className="data-table-wrap"><table className="data-table" aria-label="材料台帳">
            <colgroup><col className="m-select"/><col className="m-name"/><col className="m-model"/><col className="m-maker"/><col className="m-qty"/><col/><col className="m-state"/><col className="m-action"/></colgroup>
            <thead><tr><th scope="col"><span className="sr-only">選択</span></th><th scope="col">品名</th><th scope="col">型式</th><th scope="col">メーカー</th><th scope="col">数量</th><th scope="col">備考</th><th scope="col">状態</th><th scope="col"><span className="sr-only">操作</span></th></tr></thead>
            <tbody ref={body}>{rows.map(row => { const label = materialLabel(row), checked = selected.has(row.id); return <tr key={row.id} className={[row.active ? '' : 'inactive', checked ? 'selected' : ''].filter(Boolean).join(' ') || undefined}>
              <td className="select-cell"><input type="checkbox" aria-label={`${label}を選択`} checked={checked} disabled={disabled} onChange={() => toggle(row.id)}/></td>
              <td className="strong original-text">{row.name || '（品名なし）'}</td><td className="original-text">{row.model}</td><td className="original-text">{row.manufacturer}</td><td className="original-text qty-cell">{row.quantity}</td><td className="original-text">{row.remarks || '—'}</td><td className="note">{row.active ? '有効' : '無効'}</td>
              <td className="action-cell"><button className="btn small" disabled={disabled} aria-label={`${row.name || '（品名なし）'}を編集`} onClick={() => onEdit(row.id)}>編集</button>
                <button className="btn small icon-button" disabled={disabled} aria-label={`${label}を削除`} title="削除" onClick={() => { void removeRows([row]); }}><TrashIcon/></button></td>
            </tr>; })}</tbody>
          </table></div>
        </>}
        {total > SEARCH_PAGE_SIZE && <div className="pager"><button className="btn medium" disabled={disabled || input.offset === 0} onClick={() => change({ ...input, offset: Math.max(0, input.offset - SEARCH_PAGE_SIZE) }, true)}>前の{SEARCH_PAGE_SIZE}件</button><button className="btn medium" disabled={disabled || input.offset + SEARCH_PAGE_SIZE >= total} onClick={() => change({ ...input, offset: input.offset + SEARCH_PAGE_SIZE }, true)}>次の{SEARCH_PAGE_SIZE}件</button></div>}
      </>}
    </div>
  </div>;
}

const statusLabels = { preview: '確認中', applied: '確定済み', cancelled: '取消', failed: '保存失敗' } as const;
const dateFormat = new Intl.DateTimeFormat('ja-JP', { year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' });
function formatDate(value: string): string { const date = new Date(value); return Number.isNaN(date.getTime()) ? value : dateFormat.format(date); }

function ImportHistory({ disabled, onOpen }: { readonly disabled: boolean; readonly onOpen: (start: WizardStart) => void }) {
  const [rows, setRows] = useState<readonly (ImportSummary & { readonly kind: 'first' | 're' })[] | null>(null), [error, setError] = useState(''), [retry, setRetry] = useState(0);
  useEffect(() => {
    let active = true;
    void Promise.all([window.appApi.imports.list(), window.appApi.master.list()]).then(([first, re]) => {
      if (!active) return;
      const messages = [first, re].flatMap(result => result.status === 'error' ? [result.message] : []);
      setError(messages.join(' '));
      const merged = [...(first.status === 'ok' ? first.data.map(row => ({ ...row, kind: 'first' as const })) : []), ...(re.status === 'ok' ? re.data.map(row => ({ ...row, kind: 're' as const })) : [])];
      setRows(merged.sort((a, b) => b.createdAt.localeCompare(a.createdAt)));
    }, () => { if (active) { setError('取込履歴を取得できませんでした。再試行してください。'); setRows([]); } });
    return () => { active = false; };
  }, [retry]);
  if (rows === null) return <p role="status" className="status-line">取込履歴を読み込んでいます…</p>;
  return <div className="stack gap-8">
    {error && <div className="stack gap-8"><p role="alert">{error}</p><button className="btn medium" onClick={() => { setRows(null); setRetry(n => n + 1); }}>再試行</button></div>}
    {rows.length === 0 ? <p className="empty-state">取込記録はまだありません。「Excelから取込」から始めてください。</p>
      : <div className="data-table-wrap"><table className="data-table history" aria-label="取込履歴"><thead><tr><th scope="col">ファイル</th><th scope="col">種類</th><th scope="col">状態</th><th scope="col">反映・保留</th><th scope="col">日時</th><th scope="col"><span className="sr-only">操作</span></th></tr></thead>
        <tbody>{rows.map(row => <tr key={`${row.kind}-${row.id}`}>
          <td className="strong original-text">{row.displayName}</td><td>{row.kind === 'first' ? '初回取込' : '更新取込'}</td>
          <td><span className={`badge medium ${row.status === 'applied' ? 'ok' : row.status === 'preview' ? '' : 'warn'}`}>{statusLabels[row.status]}</span></td>
          <td>反映 {row.counts.applied}件・保留 {row.counts.held + row.counts.supplements}件</td><td className="muted">{formatDate(row.createdAt)}</td>
          <td className="action-cell"><button className="btn small" disabled={disabled} aria-label={`${row.displayName}（${statusLabels[row.status]}）を開く`} onClick={() => onOpen({ kind: row.kind, batchId: row.id })}>開く</button></td>
        </tr>)}</tbody></table></div>}
  </div>;
}

export function MaterialManager({ initialView, onBusyChange, onImport, onDeleted, notify, disabled }: {
  readonly initialView: 'ledger' | 'history'; readonly onBusyChange: (busy: boolean) => void; readonly onImport: (start: WizardStart) => void;
  /** 材料を削除したとき（材料パレットで選んでいた分を外すため）。 */
  readonly onDeleted: (ids: readonly string[]) => void; readonly notify: Notify; readonly disabled: boolean;
}) {
  const [view, setView] = useState<'ledger' | 'history'>(initialView);
  const [form, setForm] = useState<MaterialForm | null>(null), [busy, setBusy] = useState(false), [message, setMessage] = useState(''), [epoch, setEpoch] = useState(0);
  const [confirmation, setConfirmation] = useState<Confirmation | null>(null);
  const loading = useRef(false);
  // 削除の確認・処理の間は画面を止めるため、押したボタンは無効になり、確認を閉じたときにフォーカスを戻せない。止め終わってから戻す
  // （請求書の削除と同じ。消えたボタンや、利用者がほかへ移したフォーカスには戻さない。削除した後のフォーカスは台帳が決める）。
  const returnFocus = useRef<HTMLElement | null>(null);
  useLayoutEffect(() => {
    if (disabled || confirmation) return;
    const target = returnFocus.current;
    returnFocus.current = null;
    if (target?.isConnected && (document.activeElement === null || document.activeElement === document.body)) target.focus();
  });
  async function open(id: string | null): Promise<void> {
    if (loading.current) return; loading.current = true; setBusy(true); onBusyChange(true); setMessage('');
    try { const r = await window.appApi.master.get(id); if (r.status === 'ok') setForm(r.data); else if (r.status === 'error') setMessage(r.message); }
    catch { setMessage('材料を読み込めませんでした。再試行してください。'); } finally { loading.current = false; setBusy(false); onBusyChange(false); }
  }
  /**
   * 材料を削除する（確認してから。すべて削除するか、何も削除しない）。確認から結果が届くまでは、画面全体の操作を止める
   * （確認の裏で材料パレットを開く・タブを移るなどをさせない。請求書の削除と同じ）。
   */
  async function deleteMaterials(targets: readonly SearchRow[]): Promise<DeleteOutcome> {
    if (loading.current || targets.length === 0) return 'cancelled';
    loading.current = true; onBusyChange(true); setMessage('');
    returnFocus.current = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    try {
      const choice = await new Promise<ConfirmChoice>(resolve => { setConfirmation({ kind: 'delete-materials', materials: targets, resolve: value => { setConfirmation(null); resolve(value); } }); });
      if (choice !== 'discard') return 'cancelled';
      const ids = targets.map(row => row.id);
      try {
        const result = await window.appApi.master.delete(ids);
        if (result.status !== 'ok') { setMessage(result.status === 'error' ? result.message : '材料を削除できませんでした。'); return 'failed'; }
      } catch {
        setMessage('削除の結果を確認できませんでした。一覧を読み直したので、材料が残っているかを確認してください。');
        return 'unknown';
      }
      onDeleted(ids);
      const [first] = targets;
      notify(targets.length === 1 && first ? `「${materialLabel(first)}」を削除しました` : `${targets.length}件の材料を削除しました`);
      return 'deleted';
    } finally { loading.current = false; onBusyChange(false); }
  }
  const locked = disabled || busy;
  return <div className="page page-materials" aria-label="材料" role="region">
    <div className="row gap-12">
      <h1>材料</h1>
      <div className="segmented" role="tablist" aria-label="材料の表示">
        {([['ledger', '材料台帳'], ['history', '取込履歴']] as const).map(([key, label]) => <button key={key} role="tab" aria-selected={view === key} disabled={locked} onClick={() => setView(key)}>{label}</button>)}
      </div>
      <div className="row push-end"><button className="btn primary medium" disabled={locked} onClick={() => onImport(null)}>Excelから取込</button><button className="btn medium" disabled={locked} onClick={() => { void open(null); }}>手動で追加</button></div>
    </div>
    {message && <p role="alert">{message}</p>}
    {busy && <p role="status" className="status-line">読み込み中…</p>}
    {view === 'ledger' ? <Ledger disabled={locked} epoch={epoch} onEdit={id => { void open(id); }} remove={deleteMaterials}/> : <ImportHistory disabled={locked} onOpen={onImport}/>}
    {form && <MaterialDrawer form={form} onBusyChange={onBusyChange} onDone={(saved, uncertain) => { onBusyChange(false); setForm(null); setEpoch(n => n + 1); notify(saved ? '材料を保存しました。' : uncertain ? '保存結果が未確認です。一覧で保存状態を確認してください。' : '編集を取り消しました。'); }}/>}
    {confirmation && <ConfirmDialog confirmation={confirmation}/>}
  </div>;
}
