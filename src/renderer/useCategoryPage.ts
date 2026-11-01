import { useEffect, useRef, useState } from 'react';
import { SEARCH_DEBOUNCE_MS } from '../shared/limits';
import type { CategoryPage } from '../shared/material-search-api';
import { CATEGORY_PAGE_SIZE } from '../shared/material-search-api';
import { clipQuery } from './search-query';

export type CategoryStatus = { readonly status: 'loading' } | { readonly status: 'error'; readonly message: string } | { readonly status: 'ready' };

/**
 * カテゴリ候補（材料台帳・材料検索パレット・材料の編集で共有）。カテゴリの総数によらず、一度に読むのは100件まで。
 * 検索語は180ms待ってから（IMEの変換中も確定を待たずに）検索し、古い応答は世代で捨てる。読み込み中も直前のページを表示し続けるが、
 * そのページは今の検索語・開始位置の結果ではないため、ページ送りには使わない（ready の間だけ送れる）。
 * includeInactive・refresh が変わったら、同じ検索語・ページで読み直す（件数・カテゴリの追加を反映する）。
 */
export function useCategoryPage(options: { readonly includeInactive: boolean; readonly refresh?: number }) {
  const { includeInactive, refresh = 0 } = options;
  const [query, setQuery] = useState(''), [offset, setOffset] = useState(0);
  const [request, setRequest] = useState({ query: '', offset: 0, generation: 0, immediate: true });
  const [page, setPage] = useState<CategoryPage | null>(null);
  const [status, setStatus] = useState<CategoryStatus>({ status: 'loading' });
  const generation = useRef(0);

  useEffect(() => {
    let active = true;
    const timer = window.setTimeout(() => {
      if (!active || generation.current !== request.generation) return;
      void window.appApi.materials.categories({ query: request.query, includeInactive, offset: request.offset }).then(result => {
        if (!active || generation.current !== request.generation) return;
        if (result.status === 'error') { setStatus({ status: 'error', message: result.message }); return; }
        // 範囲外のページ（応答を待つ間に候補が減った場合など）は表示せず、有効なページを読み直す。空のページに取り残さない。
        const valid = clampOffset(request.offset, result.data.total);
        if (valid !== request.offset) {
          generation.current += 1;
          setOffset(valid); setStatus({ status: 'loading' });
          setRequest({ query: request.query, offset: valid, generation: generation.current, immediate: true });
          return;
        }
        setPage(result.data); setStatus({ status: 'ready' });
      }, () => {
        if (active && generation.current === request.generation) setStatus({ status: 'error', message: 'カテゴリを読み込めませんでした。もう一度お試しください。' });
      });
    }, request.immediate ? 0 : SEARCH_DEBOUNCE_MS);
    return () => { active = false; window.clearTimeout(timer); };
  }, [request, includeInactive, refresh]);

  function change(nextQuery: string, nextOffset: number, immediate: boolean): void {
    generation.current += 1;
    setQuery(nextQuery); setOffset(nextOffset); setStatus({ status: 'loading' });
    setRequest({ query: clipQuery(nextQuery), offset: nextOffset, generation: generation.current, immediate });
  }
  return {
    query, offset, page, status,
    /**
     * 候補の検索欄・ページ送りを出すか（絞り込む前のカテゴリが1ページに収まらない、または検索中）。
     * 絞り込み後の件数では決めない。検索語を消して全件を読み直す間に検索欄ごと消え、入力中のフォーカスを失うため。
     */
    paged: query !== '' || (page !== null && page.categoryTotal > CATEGORY_PAGE_SIZE),
    /** 表示中のページが今の検索語・開始位置の結果か（ページ送りはこの間だけ）。 */
    current: status.status === 'ready',
    setQuery: (value: string) => { change(value, 0, false); },
    previous: () => { change(query, Math.max(0, offset - CATEGORY_PAGE_SIZE), true); },
    next: () => { change(query, offset + CATEGORY_PAGE_SIZE, true); },
    retry: () => { change(query, offset, true); },
  };
}

export type CategoryPageControl = ReturnType<typeof useCategoryPage>;

/** 開始位置 offset が総数 total の範囲外なら、最後のページの開始位置（0件なら先頭）。範囲内ならそのまま。 */
export function clampOffset(offset: number, total: number): number {
  if (offset === 0 || offset < total) return offset;
  return total === 0 ? 0 : Math.floor((total - 1) / CATEGORY_PAGE_SIZE) * CATEGORY_PAGE_SIZE;
}

/**
 * 表示するカテゴリ候補。選択中のカテゴリが今のページ・検索結果にない場合は、先頭に残して表示し続ける
 * （ページや検索語を変えても、選択が別のカテゴリへ勝手に変わらないようにする）。
 */
export function visibleCategories<T extends { readonly id: string }>(rows: readonly T[], selected: T | null): { readonly pinned: T | null; readonly rows: readonly T[] } {
  return { pinned: selected && !rows.some(row => row.id === selected.id) ? selected : null, rows };
}

/** 選んだ id のカテゴリ（今のページか、既に選んでいたもの）。 */
export function findCategory<T extends { readonly id: string }>(id: string | null, rows: readonly T[], selected: T | null): T | null {
  if (id === null) return null;
  return rows.find(row => row.id === id) ?? (selected?.id === id ? selected : null);
}
