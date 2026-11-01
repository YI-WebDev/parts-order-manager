import { CATEGORY_PAGE_SIZE } from '../shared/material-search-api';
import { QUERY_MAX_LENGTH } from '../shared/limits';
import type { CategoryPageControl } from './useCategoryPage';

/**
 * カテゴリ候補の検索欄・件数・ページ送り。カテゴリ全体が1ページ（100件）に収まり、検索もしていない間は出さない。
 * ページ送りは今の検索語・開始位置の結果を表示している間だけ押せる。先頭以外のページでは「前の100件」を常に出す。
 * 読み込みに失敗した場合は、ページ送りの有無によらず再試行を出す。
 */
export function CategoryPager({ categories, disabled = false }: { readonly categories: CategoryPageControl; readonly disabled?: boolean }) {
  const { page, status, query, offset, current } = categories;
  const failure = status.status === 'error' && <div className="stack gap-8"><p role="alert">{status.message}</p><button type="button" className="btn small" disabled={disabled} onClick={categories.retry}>カテゴリを再読込</button></div>;
  if (!categories.paged) return failure || null;
  const total = page?.total ?? 0;
  const text = status.status === 'loading' ? 'カテゴリを読み込んでいます…' : status.status === 'error' ? '' : total === 0 ? '該当するカテゴリはありません。' : `${total}件中 ${offset + 1}～${Math.min(offset + CATEGORY_PAGE_SIZE, total)}件`;
  return <div className="category-pager stack gap-8">
    <input className="field" type="search" aria-label="カテゴリを検索" placeholder="カテゴリ名で絞り込み" maxLength={QUERY_MAX_LENGTH} value={query} disabled={disabled}
      onChange={event => categories.setQuery(event.target.value)}/>
    {text && <p role="status" aria-label="カテゴリの候補の件数" className="note">{text}</p>}
    {failure}
    {(total > CATEGORY_PAGE_SIZE || offset > 0) && <div className="pager">
      <button type="button" className="btn small" disabled={disabled || !current || offset === 0} onClick={categories.previous}>前の{CATEGORY_PAGE_SIZE}件</button>
      <button type="button" className="btn small" disabled={disabled || !current || offset + CATEGORY_PAGE_SIZE >= total} onClick={categories.next}>次の{CATEGORY_PAGE_SIZE}件</button>
    </div>}
  </div>;
}
