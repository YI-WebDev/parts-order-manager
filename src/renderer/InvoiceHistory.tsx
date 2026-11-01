import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react';
import { INVOICE_LIST_PAGE_SIZE, QUERY_MAX_LENGTH } from '../shared/limits';
import type { KeyboardEvent, MouseEvent } from 'react';
import type { DocumentHistory, DocumentHistoryItem } from '../shared/document-api';
import { documentLabel, documentTitle, formatUpdatedAt } from './document-labels';
import type { Notify } from './InvoicePanel';
import { clipQuery } from './search-query';
import type { DeleteOutcome } from './useInvoiceWorkspace';

const BACKUP_STALE_DAYS = 7;
const DAY = 24 * 60 * 60 * 1000;
function badge(item: DocumentHistoryItem): { readonly label: string; readonly tone: '' | 'ok' | 'warn' } {
  if (item.lineCount === 0) return { label: '下書き', tone: '' };
  if (item.issueCount > 0) return { label: `確認 ${item.issueCount}件`, tone: 'warn' };
  if (item.exportedRevision === item.revision) return { label: '出力済み', tone: '' };
  return { label: '出力可', tone: 'ok' };
}

/** 最終バックアップから7日以上たっている（または記録がない）ときだけ警告する。 */
function BackupWarning({ onBackup, disabled }: { readonly onBackup: () => void; readonly disabled: boolean }) {
  const [text, setText] = useState<string | null>(null);
  useEffect(() => {
    let active = true;
    void window.appApi.backups.status().then(result => {
      if (!active || result.status !== 'ok') return;
      const last = result.data.lastCreatedAt === null ? null : new Date(result.data.lastCreatedAt).getTime();
      if (last === null || Number.isNaN(last)) setText('この端末で作成したバックアップの記録がありません。');
      else { const days = Math.floor((Date.now() - last) / DAY); if (days >= BACKUP_STALE_DAYS) setText(`最後のバックアップから${days}日たっています。`); }
    }, () => undefined);
    return () => { active = false; };
  }, []);
  if (text === null) return null;
  // 注意（エラーではない）の色で出し、設定画面へ移るだけのボタンは削除・取消の色にしない。
  return <div className="alert caution backup-warning" role="alert"><span>{text}</span><button className="btn" disabled={disabled} onClick={onBackup}>バックアップへ</button></div>;
}

export function TrashIcon() {
  return <svg className="icon" viewBox="0 0 20 20" width="18" height="18" aria-hidden="true" focusable="false"><path d="M3.5 5.5h13M8 5.5V4h4v1.5M5.5 5.5l.7 10.1c.05.8.7 1.4 1.5 1.4h4.6c.8 0 1.45-.6 1.5-1.4l.7-10.1M8.5 8.5v5.5M11.5 8.5v5.5"/></svg>;
}
function CopyIcon() {
  return <svg className="icon" viewBox="0 0 20 20" width="18" height="18" aria-hidden="true" focusable="false"><rect x="7" y="6.5" width="9.5" height="10.5" rx="1.5"/><path d="M4 13.5V4.5C4 3.7 4.7 3 5.5 3h7"/></svg>;
}
function MoreIcon() {
  return <svg viewBox="0 0 20 20" width="20" height="20" aria-hidden="true" focusable="false" fill="currentColor"><circle cx="4.5" cy="10" r="1.6"/><circle cx="10" cy="10" r="1.6"/><circle cx="15.5" cy="10" r="1.6"/></svg>;
}

/**
 * 押すと画面が変わる操作（カードを開く・メニューを開く・閉じる・メニューの項目）をマウスで押したとき、続けて押した分（ダブルクリックの2回目以降。detail が2以上）を1秒だけ捨てる。
 * 変わった後の画面（編集画面の明細・削除の確認・メニューの背後・閉じたメニューの下にあったカード）の、同じ位置にあるものを押さないように。
 * 続けて押したかどうかは OS の設定（ダブルクリックの速さ・距離）で決まる。
 */
function ignoreRepeatedClicks(event: MouseEvent): void {
  if (event.detail !== 1) return;
  const types = ['mousedown', 'mouseup', 'click', 'dblclick'] as const;
  const swallow = (next: globalThis.MouseEvent): void => { if (next.detail >= 2) { next.preventDefault(); next.stopPropagation(); } };
  for (const type of types) window.addEventListener(type, swallow, true);
  window.setTimeout(() => { for (const type of types) window.removeEventListener(type, swallow, true); }, 1000);
}

/** メニューをボタンの右端にそろえて下に出す（下に入らなければ上に出す）。 */
function place(element: HTMLElement, anchor: HTMLElement): void {
  const box = anchor.getBoundingClientRect(), size = element.getBoundingClientRect(), view = document.documentElement;
  const below = box.bottom + 4, above = box.top - 4 - size.height;
  element.style.top = `${below + size.height <= view.clientHeight - 8 || above < 8 ? below : above}px`;
  element.style.left = `${Math.max(8, Math.min(box.right - size.width, view.clientWidth - size.width - 8))}px`;
}

/**
 * カードの「その他の操作」（…）のメニュー。複製して編集・削除を同じ入口から選ぶ。
 * 開くと最初の項目（↑で開いたときは最後の項目）へフォーカスを移す。↑↓・Home・End で項目を移り、Esc でボタンへ戻って閉じる。
 * Tab・Shift+Tab は、ボタンの位置から次・前の欄へ進んで閉じる。メニューの外を押すと、下にあるものは押さずに閉じる（別のカードを開かない。ダブルクリックの2回目も）。
 * 一覧のスクロール・ウィンドウの大きさの変更ではボタンに付いて動き、ボタンが一覧の見える範囲から外れたら閉じる（押した直後に続くスクロールで閉じないように）。
 * フォーカスがほかの欄へ移る・操作できなくなったときも閉じる。
 * 項目を選ぶと、閉じてボタンへフォーカスを戻してから実行する（削除の確認を戻したとき・失敗したときに、フォーカスがボタンへ戻るように）。
 */
function CardMenu({ id, label, describedBy, disabled, onDuplicate, onDelete }: {
  readonly id: string; readonly label: string; readonly describedBy: string; readonly disabled: boolean; readonly onDuplicate: () => void; readonly onDelete: () => void;
}) {
  const [open, setOpen] = useState<'first' | 'last' | null>(null);
  const root = useRef<HTMLDivElement>(null), button = useRef<HTMLButtonElement>(null), menu = useRef<HTMLDivElement>(null);
  if (disabled && open !== null) setOpen(null);
  const shown = open !== null;
  // 閉じるとき、メニューにあったフォーカスはボタンへ戻す（消えた項目と一緒に失われないように）。
  const dismiss = useCallback((): void => { if (root.current?.contains(document.activeElement)) button.current?.focus({ preventScroll: true }); setOpen(null); }, []);
  useEffect(() => {
    if (!shown) return;
    const follow = (): void => {
      const element = menu.current, anchor = button.current, area = anchor?.closest('.app-main')?.getBoundingClientRect();
      if (!element || !anchor) return;
      const box = anchor.getBoundingClientRect();
      if (area && (box.bottom <= area.top || box.top >= area.bottom)) dismiss(); else place(element, anchor);
    };
    window.addEventListener('resize', follow); window.addEventListener('scroll', follow, true);
    return () => { window.removeEventListener('resize', follow); window.removeEventListener('scroll', follow, true); };
  }, [shown, dismiss]);
  // 出したら項目へフォーカスを移す。
  useLayoutEffect(() => {
    const element = menu.current, anchor = button.current;
    if (open === null || !element || !anchor) return;
    place(element, anchor);
    const items = element.querySelectorAll<HTMLElement>('[role="menuitem"]');
    items[open === 'last' ? items.length - 1 : 0]?.focus({ preventScroll: true });
  }, [open]);
  function choose(event: MouseEvent, action: () => void): void { ignoreRepeatedClicks(event); button.current?.focus({ preventScroll: true }); setOpen(null); action(); }
  function key(event: KeyboardEvent<HTMLDivElement>): void {
    const items = [...(menu.current?.querySelectorAll<HTMLElement>('[role="menuitem"]') ?? [])], index = items.findIndex(item => item === document.activeElement);
    switch (event.key) {
      case 'ArrowDown': event.preventDefault(); items[(index + 1) % items.length]?.focus({ preventScroll: true }); break;
      case 'ArrowUp': event.preventDefault(); items[(index - 1 + items.length) % items.length]?.focus({ preventScroll: true }); break;
      case 'Home': event.preventDefault(); items[0]?.focus({ preventScroll: true }); break;
      case 'End': event.preventDefault(); items[items.length - 1]?.focus({ preventScroll: true }); break;
      case 'Escape': event.preventDefault(); event.stopPropagation(); dismiss(); break;
      // 既定の動き（次・前の欄へ進む）は、ボタンの位置から始める。
      case 'Tab': button.current?.focus({ preventScroll: true }); setOpen(null); break;
    }
  }
  return <div className="card-menu-anchor" ref={root} onBlur={event => { if (event.relatedTarget instanceof Node && !root.current?.contains(event.relatedTarget)) setOpen(null); }}>
    <button ref={button} type="button" id={`${id}-button`} className="card-menu-button" aria-label={`${label}のその他の操作`} aria-describedby={describedBy} title="その他の操作（複製して編集・削除）"
      aria-haspopup="menu" aria-expanded={shown} aria-controls={shown ? id : undefined} disabled={disabled}
      onClick={event => { ignoreRepeatedClicks(event); setOpen(current => current === null ? 'first' : null); }}
      onKeyDown={event => { if (event.key === 'ArrowDown' || event.key === 'ArrowUp') { event.preventDefault(); setOpen(event.key === 'ArrowUp' ? 'last' : 'first'); } }}><MoreIcon/></button>
    {shown && <>
      {/* メニューの外を押したときは、閉じるだけにする。外やメニューの余白・区切りを押しても、フォーカスはメニューから外さない。 */}
      <div className="menu-backdrop" onMouseDown={event => event.preventDefault()} onClick={event => { ignoreRepeatedClicks(event); dismiss(); }} onContextMenu={event => { event.preventDefault(); dismiss(); }}/>
      <div ref={menu} id={id} className="card-menu" role="menu" aria-labelledby={`${id}-button`} onKeyDown={key} onMouseDown={event => event.preventDefault()}>
        <button type="button" role="menuitem" tabIndex={-1} className="menu-item" onClick={event => choose(event, onDuplicate)}><CopyIcon/>複製して編集</button>
        <div role="separator" className="menu-separator"/>
        <button type="button" role="menuitem" tabIndex={-1} className="menu-item danger" onClick={event => choose(event, onDelete)}><TrashIcon/>削除</button>
      </div>
    </>}
  </div>;
}

type ListState = { readonly status: 'loading' } | { readonly status: 'error'; readonly message: string } | { readonly status: 'ready'; readonly data: DocumentHistory };
const NONE: ReadonlySet<string> = new Set();

/**
 * 保存済みの請求書の一覧。選択は表示中のページの中だけで持ち（ページ・絞り込みを変えると解除）、選んだ請求書をまとめて削除できる。
 * 選んでいる間は、カードをマウスで押すとそのカードの選択を切り替える（開かない。チェックを押し損ねて開き、選択を失わないように）。キーボード（開くボタンの Enter）では開く。
 * 削除の後は、一覧を読み直してから、消えた位置に来たカードのチェックへフォーカスを移す（カードがなければ「新規請求書」）。
 * 移すのはフォーカスが失われているときだけで、読み直しの間にページ送り・絞り込みをしたら取り消す。
 */
export function InvoiceHistory({ open, duplicate, create, remove, onBackup, notify, currentId, disabled }: {
  readonly open: (id: string) => void; readonly duplicate: (id: string) => void; readonly create: () => void;
  readonly remove: (targets: readonly DocumentHistoryItem[]) => Promise<DeleteOutcome>; readonly onBackup: () => void; readonly notify: Notify;
  readonly currentId: string | null; readonly disabled: boolean;
}) {
  const [page, setPage] = useState(0), [retry, setRetry] = useState(0), [filter, setFilter] = useState(''), [query, setQuery] = useState('');
  const [state, setState] = useState<ListState>({ status: 'loading' });
  const [selected, setSelected] = useState(NONE);
  const list = useRef<HTMLUListElement>(null), bar = useRef<HTMLDivElement>(null), allBox = useRef<HTMLInputElement>(null), createButton = useRef<HTMLButtonElement>(null);
  // 一覧を読み終えた回数と、削除の後に移すフォーカス（index の位置のカード。after 回目より後の読み込みを待つ。次のページから繰り上がるカードがあるため）。
  const loads = useRef(0), focusAfterDelete = useRef<{ readonly index: number; readonly after: number } | null>(null);
  // 絞り込みは入力から250ms待って反映する（IMEの変換中も、確定を待たずに今の文字で絞り込む。送るのは先頭の256文字まで）。
  const wanted = clipQuery(filter);
  useEffect(() => {
    if (wanted === query) return;
    const timer = window.setTimeout(() => { setQuery(wanted); setPage(0); setSelected(NONE); focusAfterDelete.current = null; setState({ status: 'loading' }); }, 250);
    return () => { window.clearTimeout(timer); };
  }, [wanted, query]);
  useEffect(() => {
    let active = true;
    void window.appApi.documents.list(page, query || undefined).then(result => {
      if (!active) return;
      switch (result.status) {
        // 削除で先頭以外のページが空になったら、前のページへ戻る（フォーカスは、消した位置にいちばん近いそのページの最後のカードへ）。
        case 'ok':
          if (result.data.items.length === 0 && page > 0) {
            setPage(page - 1); setSelected(NONE);
            if (focusAfterDelete.current) focusAfterDelete.current = { ...focusAfterDelete.current, index: Number.MAX_SAFE_INTEGER };
          } else { loads.current += 1; setState({ status: 'ready', data: result.data }); }
          break;
        case 'error': setState({ status: 'error', message: result.message }); break;
      }
    }, () => { if (active) setState({ status: 'error', message: '請求書の一覧を読み込めませんでした。' }); });
    return () => { active = false; };
  }, [page, query, retry]);
  const items = state.status === 'ready' ? state.data.items : [];
  // 選択の数・対象は、表示中の請求書に限る（読み直しで消えたものは数えない）。
  const chosen = items.filter(item => selected.has(item.id)), all = items.length > 0 && chosen.length === items.length;
  useLayoutEffect(() => { if (allBox.current) allBox.current.indeterminate = chosen.length > 0 && !all; });
  useLayoutEffect(() => {
    const pending = focusAfterDelete.current;
    if (!pending || disabled || state.status !== 'ready' || loads.current <= pending.after) return;
    focusAfterDelete.current = null;
    // 読み直しの間に利用者がほかの欄へ移ったときは、そのままにする（消したカード・読み込み中の表示にあったフォーカスは body に落ちている）。
    if (document.activeElement !== null && document.activeElement !== document.body) return;
    const boxes = list.current?.querySelectorAll<HTMLInputElement>('.card-select input') ?? [];
    (boxes[Math.min(pending.index, boxes.length - 1)] ?? createButton.current)?.focus();
  });
  // 選択の帯（sticky）の高さだけ、スクロールする .app-main の上端に余白を取る（フォーカスした欄が帯の下に隠れないように）。
  // 帯の大きさが変わったとき（狭い幅で選ぶと2段になる・ウィンドウの幅や拡大率が変わる）は、フォーカスしている一覧の欄を見える位置へ戻す。
  // 戻すのは、見える範囲に掛かったまま帯の下に入った欄と、帯が伸びたときに見える範囲の下端に掛かっている欄・下端から伸びた分以内の下にある欄
  // （伸びた分だけ一覧が下へずれて押し出された欄を含む。一覧がずれないときも同じに扱う）だけ。
  // それ以外の、見える範囲の外にある欄（読み進めて上へ外れた・下端から伸びた分より遠い・並びが変わって外れた）へは、一覧を引き戻さない。
  const shown = state.status === 'ready' && items.length > 0;
  useLayoutEffect(() => {
    const element = bar.current, scroller = element?.closest<HTMLElement>('.app-main');
    if (!shown || !element || !scroller) return;
    let last = -1;
    const observer = new ResizeObserver(() => {
      const height = element.offsetHeight, grown = last < 0 ? 0 : Math.max(0, height - last);
      if (height !== last) { last = height; scroller.style.scrollPaddingTop = `${height + 16}px`; }
      const focused = document.activeElement;
      if (!(focused instanceof HTMLElement) || !list.current?.contains(focused)) return;
      const rect = focused.getBoundingClientRect(), view = scroller.getBoundingClientRect();
      const underBar = rect.bottom > view.top && rect.top < view.bottom && rect.top < element.getBoundingClientRect().bottom;
      const pushedDown = grown > 0 && rect.bottom > view.bottom && rect.top < view.bottom + grown;
      if (underBar || pushedDown) focused.scrollIntoView({ block: 'nearest' });
    });
    observer.observe(element);
    return () => { observer.disconnect(); scroller.style.scrollPaddingTop = ''; };
  }, [shown]);
  function move(next: number): void { setState({ status: 'loading' }); setSelected(NONE); focusAfterDelete.current = null; setPage(next); }
  function toggle(id: string): void { setSelected(current => { const next = new Set(current); if (!next.delete(id)) next.add(id); return next; }); }
  async function removeItems(targets: readonly DocumentHistoryItem[]): Promise<void> {
    const [first] = targets;
    if (!first) return;
    const index = items.findIndex(item => item.id === first.id), more = state.status === 'ready' && state.data.hasMore, outcome = await remove(targets);
    if (outcome === 'cancelled') return;
    // フォーカスは読み直した一覧で決める（失敗のときは押したボタンが残るので動かさない）。
    if (outcome !== 'failed') focusAfterDelete.current = { index: Math.max(0, index), after: loads.current };
    if (outcome === 'deleted') {
      const gone = new Set(targets.map(item => item.id));
      setSelected(current => new Set([...current].filter(id => !gone.has(id))));
      // 消したカードはすぐに一覧から外す。ページが空になり、ほかのページに請求書があるときは、空の表示を出さずに読み直す。
      if ((page > 0 || more) && items.every(item => gone.has(item.id))) setState({ status: 'loading' });
      else setState(current => current.status === 'ready' ? { status: 'ready', data: { ...current.data, items: current.data.items.filter(item => !gone.has(item.id)) } } : current);
      notify(targets.length === 1 ? `「${documentTitle(first)}」を削除しました` : `${targets.length}件の請求書を削除しました`);
    } else if (outcome === 'unknown') setState({ status: 'loading' });
    // 失敗・結果不明のときも読み直して、実際に残っている請求書を見せる。
    setRetry(n => n + 1);
  }
  return <div className="page page-list">
    <div className="list-toolbar">
      <h1>請求書</h1>
      <input className="field" type="search" aria-label="請求書を絞り込む" placeholder="タイトル・上部欄で絞り込み" maxLength={QUERY_MAX_LENGTH} value={filter} disabled={disabled}
        onChange={event => setFilter(event.target.value)}/>
      <button ref={createButton} className="btn primary push-end" disabled={disabled} onClick={create}>新規請求書<span className="kbd-hint" aria-hidden="true">Ctrl+N</span></button>
    </div>
    <BackupWarning onBackup={onBackup} disabled={disabled}/>
    {state.status === 'loading' && <p role="status" className="status-line">請求書の一覧を読み込んでいます…</p>}
    {state.status === 'error' && <div className="stack gap-8"><p role="alert">{state.message}</p><button className="btn medium" onClick={() => { setState({ status: 'loading' }); setRetry(n => n + 1); }}>一覧を再試行</button></div>}
    {state.status === 'ready' && <>
      {items.length === 0
        ? <p className="empty-state" role="status">{query ? '条件に合う請求書はありません。絞り込みを変更してください。' : '保存済みの請求書はありません。「新規請求書」から作成してください。'}</p>
        : <>
          <div ref={bar} className={`select-bar${chosen.length ? ' active' : ''}`} role="group" aria-label="請求書の選択">
            <label className="check-control compact"><input ref={allBox} type="checkbox" checked={all} disabled={disabled} onChange={() => setSelected(all ? NONE : new Set(items.map(item => item.id)))}/>このページをすべて選択</label>
            <span className="select-count" role="status">{chosen.length ? `${chosen.length}件を選択中` : ''}</span>
            {chosen.length > 0 && <>
              {/* 押すとこのボタンは消えるため、フォーカスは「このページをすべて選択」へ移す。 */}
              <button className="btn text" disabled={disabled} onClick={() => { setSelected(NONE); allBox.current?.focus(); }}>選択を解除</button>
              <button className="btn danger medium push-end" disabled={disabled} onClick={() => { void removeItems(chosen); }}><TrashIcon/>選択した{chosen.length}件を削除</button>
            </>}
          </div>
          <ul ref={list} className={`invoice-cards${chosen.length ? ' selecting' : ''}`} aria-label="保存済み請求書">{items.map(item => { const tag = badge(item), title = documentTitle(item), label = documentLabel(item), checked = selected.has(item.id); return <li key={item.id}>
            <article className={`invoice-card${item.id === currentId ? ' current' : ''}${checked ? ' selected' : ''}`} aria-label={title}>
              <div className="invoice-card-head">
                <label className="card-select" title="選択"><input type="checkbox" aria-label={`${label}を選択`} aria-describedby={`meta-${item.id}`} checked={checked} disabled={disabled} onChange={() => toggle(item.id)}/></label>
                {/* カードのどこを押しても開く（カード全体に重ねたボタン。チェックと「その他の操作」だけはその上に出す）。
                    選んでいる間のマウス（detail が1以上）は選択の切り替えにする。キーボードの Enter・Space（detail が0）では開く。 */}
                <button type="button" className="card-open" aria-label={`${label}を開く`} aria-describedby={`meta-${item.id}`} disabled={disabled}
                  onClick={event => { if (event.detail > 0 && chosen.length > 0) { toggle(item.id); return; } ignoreRepeatedClicks(event); open(item.id); }}/>
                <div className="card-title"><h2 className="original-text">{title}</h2><span className="note original-text">{item.c2 || '上部欄 未入力'}</span></div>
                <CardMenu id={`actions-${item.id}`} label={label} describedBy={`meta-${item.id}`} disabled={disabled} onDuplicate={() => duplicate(item.id)} onDelete={() => { void removeItems([item]); }}/>
              </div>
              <div className="invoice-card-foot">
                <div className="invoice-meta" id={`meta-${item.id}`}><span>明細 {item.lineCount}行</span><span>保存版 {item.revision}</span><span>{formatUpdatedAt(item.updatedAt)}</span>{item.duplicatedFromId && <span>複製</span>}</div>
                {/* 開いている請求書は枠の色だけでなく文字でも示す。 */}
                <div className="invoice-card-badges">{item.id === currentId && <span className="badge editing">編集中</span>}<span className={`badge ${tag.tone}`}>{tag.label}</span></div>
              </div>
            </article>
          </li>; })}</ul>
        </>}
      {(page > 0 || state.data.hasMore) && <div className="pager"><button className="btn medium" disabled={disabled || page === 0} onClick={() => move(page - 1)}>前の{INVOICE_LIST_PAGE_SIZE}件</button><span className="status-line" role="status">{page + 1}ページ</span><button className="btn medium" disabled={disabled || !state.data.hasMore} onClick={() => move(page + 1)}>次の{INVOICE_LIST_PAGE_SIZE}件</button></div>}
      <p className="note centered">各請求書の現在の保存内容を新しい順に表示しています。全編集版の履歴ではありません。</p>
    </>}
  </div>;
}
