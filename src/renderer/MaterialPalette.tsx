import { useEffect, useRef, useState } from 'react';
import { MAX_LINES, QUERY_MAX_LENGTH } from '../shared/limits';
import type { KeyboardEvent } from 'react';
import type { CategoryOption, SearchRow } from '../shared/material-search-api';
import { SEARCH_PAGE_SIZE } from '../shared/material-search-api';
import { CategoryPager } from './CategoryPager';
import { noMaterialsMessage } from './empty-messages';
import { findCategory, useCategoryPage, visibleCategories } from './useCategoryPage';
import { isComposingKey, useMaterialSearch } from './useMaterialSearch';

/** 選んだ材料（選んだ順）。パレットを閉じても残し、追加できた分だけ外す。 */
export type PickedMaterials = ReadonlyMap<string, SearchRow>;

/**
 * 材料検索パレット（Ctrl+F / ヘッダーの検索ボタン / 明細の「材料をまとめて追加」）。
 * 検索・カテゴリ・ページを切り替えながら材料を選び（Enter・クリックで選択／解除）、選んだ分をまとめて作業中の請求書へ追加する。
 */
export function MaterialPalette({ focusRequest, picked, room, existing, onPick, onAdd, onClose, disabled }: {
  readonly focusRequest: number; readonly picked: PickedMaterials; readonly room: number; readonly existing: ReadonlySet<string>;
  readonly onPick: (picked: PickedMaterials) => void; readonly onAdd: (ids: readonly string[]) => void; readonly onClose: () => void; readonly disabled: boolean;
}) {
  const ref = useRef<HTMLDialogElement>(null), field = useRef<HTMLInputElement>(null), results = useRef<HTMLDivElement>(null);
  const search = useMaterialSearch();
  const { input } = search;
  const categories = useCategoryPage({ includeInactive: input.includeInactive });
  const [chosenCategory, setChosenCategory] = useState<CategoryOption | null>(null);
  const categoryRows = categories.page?.rows ?? [];
  const { pinned } = visibleCategories(categoryRows, input.categoryId ? chosenCategory : null);
  const [active, setActive] = useState(0);
  useEffect(() => {
    const dialog = ref.current; const previous = document.activeElement;
    dialog?.showModal();
    return () => { dialog?.close(); if (previous instanceof HTMLElement && previous.isConnected) previous.focus(); };
  }, []);
  useEffect(() => { field.current?.focus(); field.current?.select(); }, [focusRequest]);
  const rows = search.state.status === 'ready' ? search.state.data.rows : [];
  const total = search.state.status === 'ready' ? search.state.data.total : 0;
  const index = Math.min(active, Math.max(0, rows.length - 1));
  useEffect(() => { document.getElementById(`palette-option-${index}`)?.scrollIntoView({ block: 'nearest' }); }, [index]);
  const full = picked.size >= room, over = picked.size > room;

  /** 条件を変えたら先頭の行から選び直す。 */
  function reset(): void { setActive(0); if (results.current) results.current.scrollTop = 0; }
  /** 変換中でも選べる（結果は変換中の文字で検索したもの。フォーカスは入力欄に残り、変換は続く）。 */
  function toggle(row: SearchRow): void {
    const next = new Map(picked);
    if (next.has(row.id)) next.delete(row.id); else if (!full) next.set(row.id, row); else return;
    onPick(next);
  }
  function remove(id: string): void { const next = new Map(picked); next.delete(id); onPick(next); field.current?.focus(); }
  /** マウスで押してもフォーカスを入力欄に残す（↑↓・Enter をそのまま続けられる）。 */
  const keepFocus = (event: { preventDefault: () => void }): void => { event.preventDefault(); };
  function add(): void { if (!disabled && picked.size > 0 && !over) onAdd([...picked.keys()]); }
  function key(event: KeyboardEvent<HTMLInputElement>): void {
    if (isComposingKey(event, search.composing.current)) { if (event.key === 'Enter') event.preventDefault(); return; }
    if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
      event.preventDefault();
      if (rows.length) setActive(Math.max(0, Math.min(rows.length - 1, index + (event.key === 'ArrowDown' ? 1 : -1))));
    } else if (event.key === 'Enter') {
      event.preventDefault();
      if (event.ctrlKey) { add(); return; }
      const row = rows[index]; if (row) toggle(row);
    }
  }
  let status: string;
  if (search.state.status === 'loading') status = '検索しています…';
  else if (search.state.status === 'error') status = '';
  else status = total === 0 ? noMaterialsMessage(input, 'palette') : `${total}件中 ${input.offset + 1}～${Math.min(input.offset + SEARCH_PAGE_SIZE, total)}件`;
  // Escを繰り返すと Chromium は cancel を出さずに閉じることがあるため、close でも状態を合わせる。
  // close は次のフレームで届くため、開き直した後に届いた古い close（開発ビルドの StrictMode が effect を再実行したときなど）は無視する。
  return <dialog ref={ref} className="palette" aria-label="材料検索" onCancel={event => { event.preventDefault(); onClose(); }}
    onClose={() => { if (!ref.current?.open) onClose(); }}
    onMouseDown={event => { if (event.target === event.currentTarget) onClose(); }}>
    <input ref={field} className="palette-input" type="text" aria-label="キーワード" placeholder="品名・型式・メーカー・備考" maxLength={QUERY_MAX_LENGTH} value={input.query}
      role="combobox" aria-expanded={rows.length > 0} aria-controls="palette-results" aria-activedescendant={rows.length ? `palette-option-${index}` : undefined} autoComplete="off"
      onChange={event => { reset(); search.setQuery(event.target.value); }}
      onCompositionStart={search.compositionStart} onCompositionEnd={event => { if (search.compositionEnd(event.currentTarget.value)) reset(); }}
      onKeyDown={key}/>
    <div className="palette-filter">
      <select className="field" aria-label="カテゴリ" value={input.categoryId ?? ''} onChange={event => { reset(); const id = event.target.value || null; setChosenCategory(findCategory(id, categoryRows, chosenCategory)); search.change({ ...input, categoryId: id, offset: 0 }, true); }}>
        <option value="">{categories.page ? `すべてのカテゴリ（${categories.page.materialCount}）` : 'すべてのカテゴリ'}</option>
        {/* 候補のページ・検索結果にない選択中のカテゴリは先頭に残す。 */}
        {pinned && <option value={pinned.id}>{pinned.name}（{pinned.count}）</option>}
        {categoryRows.map(category => <option key={category.id} value={category.id}>{category.name}（{category.count}）</option>)}
      </select>
      {status && <p className="palette-status" role="status">{status}</p>}
      <CategoryPager categories={categories}/>
    </div>
    <div className="palette-results" ref={results}>
      {search.state.status === 'error' && <div className="palette-message stack gap-8"><p role="alert">{search.state.message}</p><button className="btn medium" onClick={search.retry}>再試行</button></div>}
      {rows.length > 0 && <ul id="palette-results" role="listbox" aria-multiselectable="true" aria-label="検索結果">{rows.map((row, i) => <li key={row.id} id={`palette-option-${i}`} role="option" aria-selected={picked.has(row.id)}
        className={`search-result${i === index ? ' active' : ''}`}
        onMouseMove={() => { if (i !== index) setActive(i); }} onMouseDown={event => event.preventDefault()} onClick={() => toggle(row)}>
        <span className="pick-box" aria-hidden="true">✓</span>
        {/* 備考は空欄なら出さない（型式・メーカーの空欄は材料を見分ける手がかりのため「なし」と示す）。 */}
        <span className="result-main"><span className="result-title original-text">{row.name || '（品名なし）'}</span><span className="note original-text">{[row.model || '型式なし', row.manufacturer || 'メーカーなし', row.remarks].filter(Boolean).join(' ・ ')}</span></span>
        <span className="result-tags">{existing.has(row.id) && <span className="badge">明細にあり</span>}<span className="chip">{row.categoryName}</span></span>
      </li>)}</ul>}
      {total > SEARCH_PAGE_SIZE && <div className="pager palette-pager">
        <button className="btn small" disabled={input.offset === 0} onMouseDown={keepFocus} onClick={() => { reset(); search.change({ ...input, offset: Math.max(0, input.offset - SEARCH_PAGE_SIZE) }, true); }}>前の{SEARCH_PAGE_SIZE}件</button>
        <button className="btn small" disabled={input.offset + SEARCH_PAGE_SIZE >= total} onMouseDown={keepFocus} onClick={() => { reset(); search.change({ ...input, offset: input.offset + SEARCH_PAGE_SIZE }, true); }}>次の{SEARCH_PAGE_SIZE}件</button>
      </div>}
    </div>
    <section className="palette-tray" aria-label="選んだ材料">
      {picked.size === 0 ? <p className="note">追加する材料をクリックまたは Enter で選んでください。検索やカテゴリを変えても選択は残り、まとめて明細に追加できます。</p>
        : <ul className="picked-list" aria-label="選んだ材料の一覧">{[...picked.values()].map(row => { const label = [row.name || '（品名なし）', row.model].filter(Boolean).join(' '); return <li key={row.id} className="picked-chip">
          <span className="original-text" title={label}>{label}</span><button type="button" aria-label={`${label}の選択を外す`} onMouseDown={keepFocus} onClick={() => remove(row.id)}>×</button>
        </li>; })}</ul>}
      {over ? <p role="alert">明細は{MAX_LINES}行までです。選んだ材料を{picked.size - room}件減らしてください。</p>
        : room <= 0 ? <p className="note">明細が{MAX_LINES}行に達しているため、これ以上追加できません。</p>
        : full && <p className="note">明細は{MAX_LINES}行までのため、これ以上は選べません。</p>}
      <div className="palette-tray-actions">
        <span className="strong">{picked.size}件を選択中</span>
        {picked.size > 0 && <button type="button" className="btn text" onMouseDown={keepFocus} onClick={() => { onPick(new Map()); field.current?.focus(); }}>選択をすべて外す</button>}
        <button type="button" className="btn primary push-end" disabled={disabled || picked.size === 0 || over} aria-keyshortcuts="Control+Enter" onClick={add}>{picked.size > 0 ? `${picked.size}件を明細に追加` : '明細に追加'}<span className="kbd-hint" aria-hidden="true">Ctrl+Enter</span></button>
      </div>
    </section>
    <div className="palette-hints"><span>↑↓ 移動</span><span>Enter 選択／解除</span><span>Ctrl+Enter 選んだ材料を明細に追加</span><span>Esc 閉じる</span></div>
  </dialog>;
}
