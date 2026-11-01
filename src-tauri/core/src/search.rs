//! 材料検索（src/main/db/material-search.ts）。

use rusqlite::functions::FunctionFlags;
use rusqlite::types::ValueRef;
use serde::Serialize;
use serde_json::Value;

use crate::db::{flag, Store, Tx};
use crate::documents::escape_like;
use crate::error::Result;
use crate::js;
use crate::validate;

pub use crate::limits::{CATEGORY_PAGE_SIZE, SEARCH_PAGE_SIZE};
use crate::limits::QUERY_MAX;
/// 材料検索の応答に含めるカテゴリの上限（旧版の表示上限）。超えた分は件数（category_total）で知らせ、候補は `categories` で選ぶ。
pub const SEARCH_CATEGORY_LIMIT: i64 = 1000;

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SearchSource { pub sheet_name: String, pub row_index: i64, pub block: String }

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SearchRow {
    pub id: String, pub category_id: String, pub category_name: String, pub name: String, pub model: String, pub manufacturer: String,
    pub quantity: String, pub remarks: String, pub unit_price: String, pub active: bool, pub source: Option<SearchSource>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct CategoryOption { pub id: String, pub name: String, pub count: i64 }

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SearchData {
    pub rows: Vec<SearchRow>, pub total: i64,
    /// 並び順の先頭から SEARCH_CATEGORY_LIMIT 件まで。
    pub categories: Vec<CategoryOption>,
    /// カテゴリの総数（categories が全件でないことを示す）。
    pub category_total: i64,
}

/// カテゴリ候補の1ページ（並び順は sort_order・id）。
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CategoryPage {
    pub rows: Vec<CategoryOption>,
    /// 検索語に一致するカテゴリの総数。
    pub total: i64,
    /// 検索語で絞り込む前のカテゴリの総数（画面は検索欄を出すかをこちらで決める）。
    pub category_total: i64,
    /// 材料の総数（includeInactive の条件で数える。削除した材料は数えない。「すべてのカテゴリ」の件数）。
    pub material_count: i64,
}

/// 検索語と列の値の正規化（NFKC → 小文字 → 連続空白を1つ → 前後の空白を除く）。
pub fn normalize(value: &str) -> String {
    js::trim(&js::collapse_spaces(&js::lower(&js::nfkc(value)))).to_string()
}

/// 接続ごとの関数 material_search_text（元の値・search_text 列・移行は変えない）。
pub fn register(store: &Store) -> Result<()> {
    store.conn().create_scalar_function("material_search_text", 1, FunctionFlags::SQLITE_UTF8 | FunctionFlags::SQLITE_DETERMINISTIC, |ctx| {
        Ok(match ctx.get_raw(0) { ValueRef::Text(bytes) => normalize(&String::from_utf8_lossy(bytes)), _ => String::new() })
    })?;
    Ok(())
}

pub fn search(store: &Store, input: &Value) -> Result<SearchData> {
    let o = validate::strict(input, &["query", "categoryId", "includeInactive", "offset"])?;
    let query = validate::no_nul(o.string("query", 0, QUERY_MAX)?)?;
    let category_id = o.nullable_uuid("categoryId")?;
    let include_inactive = o.boolean("includeInactive")?;
    let offset = validate::int_range(o.req("offset")?, 0, 1_000_000)?;
    let pattern = format!("%{}%", escape_like(&normalize(&query)));
    // 削除した材料は出さない。
    let mut conditions = vec!["materials.deleted_at IS NULL".to_string()];
    if !include_inactive { conditions.push("materials.active = 1".to_string()); }
    if category_id.is_some() { conditions.push("materials.category_id = :category".to_string()); }
    conditions.push(["name", "model", "manufacturer", "remarks"].map(|c| format!("material_search_text(materials.{c}) LIKE :pattern ESCAPE '\\'")).join(" OR "));
    let filter = conditions.iter().map(|c| format!("({c})")).collect::<Vec<_>>().join(" AND ");
    store.transaction(Tx::Deferred, || {
        let conn = store.conn();
        // カテゴリの総数では検索を止めない（候補の全件は categories のページ取得で選ぶ）。
        let (categories, category_total) = category_page(store, "", include_inactive, SEARCH_CATEGORY_LIMIT, 0)?;
        let bind = |statement: &mut rusqlite::Statement| -> rusqlite::Result<()> {
            statement.raw_bind_parameter(":pattern", &pattern)?;
            if let Some(category) = &category_id { statement.raw_bind_parameter(":category", category)?; }
            Ok(())
        };
        let mut statement = conn.prepare(&format!("SELECT count(*) FROM materials WHERE {filter}"))?;
        bind(&mut statement)?;
        let total: i64 = statement.raw_query().next()?.map(|row| row.get(0)).transpose()?.unwrap_or(0);
        let mut statement = conn.prepare(&format!(
            "SELECT materials.id, materials.category_id, categories.name, materials.name, materials.model, materials.manufacturer, materials.quantity, materials.remarks, materials.unit_price, materials.active, import_items.sheet_name, import_items.row_index, import_items.block \
             FROM materials INNER JOIN categories ON materials.category_id = categories.id LEFT JOIN import_items ON materials.last_source_item_id = import_items.id \
             WHERE {filter} ORDER BY categories.sort_order ASC, categories.id ASC, materials.name ASC, materials.id ASC LIMIT {SEARCH_PAGE_SIZE} OFFSET :offset"))?;
        bind(&mut statement)?;
        statement.raw_bind_parameter(":offset", offset)?;
        let mut rows = Vec::new();
        let mut cursor = statement.raw_query();
        while let Some(row) = cursor.next()? {
            let sheet_name: Option<String> = row.get(10)?;
            let row_index: Option<i64> = row.get(11)?;
            let block: Option<String> = row.get(12)?;
            // drizzle の入れ子の結果は、左結合した列がすべて NULL のとき null になる。
            let source = match (sheet_name, row_index, block) {
                (None, None, None) => None,
                (s, r, b) => Some(SearchSource { sheet_name: s.unwrap_or_default(), row_index: r.unwrap_or_default(), block: b.unwrap_or_default() }),
            };
            rows.push(SearchRow {
                id: row.get(0)?, category_id: row.get(1)?, category_name: row.get(2)?, name: row.get(3)?, model: row.get(4)?, manufacturer: row.get(5)?,
                quantity: row.get(6)?, remarks: row.get(7)?, unit_price: row.get(8)?, active: flag(row.get(9)?), source,
            });
        }
        Ok(SearchData { rows, total, categories, category_total })
    })
}

/// カテゴリ候補の取得（`categories`）。検索語は材料検索と同じ正規化の部分一致、1回に CATEGORY_PAGE_SIZE 件まで。
pub fn categories(store: &Store, input: &Value) -> Result<CategoryPage> {
    let o = validate::strict(input, &["query", "includeInactive", "offset"])?;
    let query = validate::no_nul(o.string("query", 0, QUERY_MAX)?)?;
    let include_inactive = o.boolean("includeInactive")?;
    let offset = validate::int_range(o.req("offset")?, 0, 1_000_000)?;
    let query = normalize(&query);
    store.transaction(Tx::Deferred, || {
        let (rows, total) = category_page(store, &query, include_inactive, CATEGORY_PAGE_SIZE, offset)?;
        let category_total = if query.is_empty() { total } else { store.conn().query_row("SELECT count(*) FROM categories", [], |row| row.get(0))? };
        let material_count = store.conn().query_row(&format!("SELECT count(*) FROM materials WHERE materials.deleted_at IS NULL{}", if include_inactive { "" } else { " AND materials.active = 1" }), [], |row| row.get(0))?;
        Ok(CategoryPage { rows, total, category_total, material_count })
    })
}

/// 並び順（sort_order・id）で offset から limit 件のカテゴリと、条件に合うカテゴリの総数。
/// query は正規化済みの検索語（空なら全件）。件数は includeInactive の条件で数えた、そのカテゴリの材料数（削除した材料は数えない）。
pub fn category_page(store: &Store, query: &str, include_inactive: bool, limit: i64, offset: i64) -> Result<(Vec<CategoryOption>, i64)> {
    let conn = store.conn();
    let filter = if query.is_empty() { "" } else { " WHERE material_search_text(categories.name) LIKE :pattern ESCAPE '\\'" };
    let pattern = format!("%{}%", escape_like(query));
    let bind = |statement: &mut rusqlite::Statement| -> rusqlite::Result<()> { if !query.is_empty() { statement.raw_bind_parameter(":pattern", &pattern)?; } Ok(()) };
    let mut statement = conn.prepare(&format!("SELECT count(*) FROM categories{filter}"))?;
    bind(&mut statement)?;
    let total: i64 = statement.raw_query().next()?.map(|row| row.get(0)).transpose()?.unwrap_or(0);
    let active = if include_inactive { "" } else { " AND materials.active = 1" };
    // 件数はページの行だけ数える（materials_category の索引を使う）。
    let mut statement = conn.prepare(&format!(
        "WITH page AS (SELECT id, name, sort_order FROM categories{filter} ORDER BY sort_order ASC, id ASC LIMIT :limit OFFSET :offset) \
         SELECT page.id, page.name, (SELECT count(*) FROM materials WHERE materials.category_id = page.id{active} AND materials.deleted_at IS NULL) FROM page ORDER BY page.sort_order ASC, page.id ASC"))?;
    bind(&mut statement)?;
    statement.raw_bind_parameter(":limit", limit)?;
    statement.raw_bind_parameter(":offset", offset)?;
    let mut rows = Vec::new();
    let mut cursor = statement.raw_query();
    while let Some(row) = cursor.next()? { rows.push(CategoryOption { id: row.get(0)?, name: row.get(1)?, count: row.get(2)? }); }
    Ok((rows, total))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn normalization_matches_the_search_contract() {
        assert_eq!(normalize("  ＡＢ\u{3000}\tｶﾀ  "), "ab カタ");
        assert_eq!(normalize("Σ"), "σ");
    }
}

