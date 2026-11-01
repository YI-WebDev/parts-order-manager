//! 上限値・ページ件数の定義（本体の検査に使う「正」）。画面側の写しは `src/shared/limits.ts`。
//! 値を変えるときは両方と `spec/06-limits.md` を合わせる。

/// 材料・明細・帳票上部の欄の文字数（コードポイント）。
pub const TEXT_MAX: usize = 10_000;
/// 一度に削除できる請求書・材料の数。
pub const DELETE_MAX: usize = 100;
/// 検索語の文字数。
pub const QUERY_MAX: usize = 256;
/// 帳票に置く明細の行数。
pub const LINE_ROWS: usize = 47;
/// 1つの請求書の明細の上限（編集画面）。
pub const MAX_LINES: usize = 500;
/// 請求書一覧の1ページの件数。
pub const LIST_PAGE_SIZE: usize = 20;
/// 材料検索の1ページの件数。
pub const SEARCH_PAGE_SIZE: i64 = 25;
/// カテゴリ候補を1回に返す件数（表示の都合。保存できるカテゴリ数の上限ではない）。
pub const CATEGORY_PAGE_SIZE: i64 = 100;
/// 上書きする既存 xlsx・生成した xlsx の検証上限（バイト）。
pub const XLSX_VERIFY_MAX: u64 = 8_388_608;
/// 保存する PDF の上限（バイト）。
pub const PDF_MAX: usize = 8_000_000;
