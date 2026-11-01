// 本体（src-tauri/core/src/limits.rs）との約束事の値。本体の検査が「正」で、ここは画面の事前表示・入力欄の制限のための写し。
// 値を変えるときは limits.rs と spec/06-limits.md も合わせる。

/** 材料・明細・帳票上部の欄・管理用タイトルの文字数（コードポイント）。 */
export const TEXT_MAX_LENGTH = 10000;
/** カテゴリ名の文字数。 */
export const CATEGORY_NAME_MAX_LENGTH = 1000;
/** 検索語の文字数（コードポイントで数える）。 */
export const QUERY_MAX_LENGTH = 256;
/** 帳票に置く明細の行数。 */
export const LINE_ROWS = 47;
/** 1つの請求書の明細の上限（編集画面）。 */
export const MAX_LINES = 500;
/** 材料検索の1ページの件数。 */
export const SEARCH_PAGE_SIZE = 25;
/** カテゴリ候補を1回に取得する件数（表示の都合で、保存できるカテゴリ数の上限ではない）。 */
export const CATEGORY_PAGE_SIZE = 100;
/** 請求書一覧の1ページの件数。 */
export const INVOICE_LIST_PAGE_SIZE = 20;
/** 材料・カテゴリの検索を始めるまでの待ち（ミリ秒）。 */
export const SEARCH_DEBOUNCE_MS = 180;
