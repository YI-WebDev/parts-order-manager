export const MATERIAL_SEARCH_CHANNEL = 'materials:search';
export { SEARCH_PAGE_SIZE, CATEGORY_PAGE_SIZE } from './limits';
export interface SearchInput {
  readonly query: string;
  readonly categoryId: string | null;
  readonly includeInactive: boolean;
  readonly offset: number;
}
export interface SearchRow {
  readonly id: string;
  readonly categoryId: string;
  readonly categoryName: string;
  readonly name: string;
  readonly model: string;
  readonly manufacturer: string;
  readonly quantity: string;
  readonly remarks: string;
  readonly unitPrice: string;
  readonly active: boolean;
  readonly source: { readonly sheetName: string; readonly rowIndex: number; readonly block: string } | null;
}
export interface CategoryOption { readonly id: string; readonly name: string; readonly count: number }
export interface SearchData {
  readonly rows: readonly SearchRow[];
  readonly total: number;
  /** 並び順の先頭から1000件まで（旧版の表示上限）。画面の候補は categories で検索・ページ取得する。 */
  readonly categories: readonly CategoryOption[];
  /** カテゴリの総数（categories が全件でないことを示す）。 */
  readonly categoryTotal: number;
}
export type SearchResult = { readonly status: 'ok'; readonly data: SearchData }
  | { readonly status: 'error'; readonly code: 'VALIDATION' | 'DB'; readonly message: string; readonly correlationId: string };
/** カテゴリ候補（検索語は材料検索と同じ正規化の部分一致。並び順は固定）。1回に CATEGORY_PAGE_SIZE 件まで。 */
export const MATERIAL_CATEGORY_CHANNEL = 'materials:categories';
export interface CategoryInput {
  readonly query: string;
  /** 件数に無効の材料も数えるか */
  readonly includeInactive: boolean;
  readonly offset: number;
}
export interface CategoryPage {
  readonly rows: readonly CategoryOption[];
  /** 検索語に一致するカテゴリの総数 */
  readonly total: number;
  /** 検索語で絞り込む前のカテゴリの総数（検索欄・ページ送りを出すかはこちらで決める） */
  readonly categoryTotal: number;
  /** 材料の総数（「すべてのカテゴリ」の件数。削除した材料は数えない） */
  readonly materialCount: number;
}
export type CategoryResult = { readonly status: 'ok'; readonly data: CategoryPage }
  | { readonly status: 'error'; readonly code: 'VALIDATION' | 'DB'; readonly message: string; readonly correlationId: string };
export interface MaterialSearchApi {
  readonly search: (input: SearchInput) => Promise<SearchResult>;
  readonly categories: (input: CategoryInput) => Promise<CategoryResult>;
}
