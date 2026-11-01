//! tests/unit/material-search.test.ts の移植（材料検索の正規化・絞り込み・ページ・入力検証）。

mod import_support;

use std::collections::HashSet;

use pom_core::db::Store;
use pom_core::materials::{self, MaterialUpdate, MaterialValues};
use pom_core::search::{self, CategoryPage, SearchData, SearchRow};
use serde_json::{json, Value};
use tempfile::TempDir;

struct Context { store: Store, category: String, values: MaterialValues, first: String, _root: TempDir }

fn fixture() -> Context {
    let root = tempfile::Builder::new().prefix("step06-search-").tempdir().unwrap();
    let store = Store::open_default(root.path()).unwrap();
    let category = materials::create_category(&store, "架空配管", 0).unwrap();
    let other = materials::create_category(&store, "架空電材", 1).unwrap();
    let values = MaterialValues { name: " Ａ部品 ".into(), model: "００１－Ａ/Ｂ".into(), manufacturer: "架空 ＭＥＫＡ".into(), quantity: "数量専用".into(), remarks: "備考\n  特記 100%_\\".into(), unit_price: "単価専用".into() };
    let first = materials::create(&store, &category, &values).unwrap();
    materials::create(&store, &other, &values).unwrap();
    // 登録した値は前後の空白を除いた形（文中の空白・改行・全角はそのまま）。
    Context { store, category, values: values.trimmed(), first, _root: root }
}

impl Context {
    fn search(&self, input: Value) -> pom_core::Result<SearchData> { search::search(&self.store, &input) }
}

fn input(query: &str, category_id: Option<&str>, include_inactive: bool, offset: i64) -> Value {
    json!({ "query": query, "categoryId": category_id, "includeInactive": include_inactive, "offset": offset })
}

/// `toMatchObject(values)`（検索結果の行が材料の6項目を登録した形のまま持つ。全角・半角・大小・文中の空白は正規化しない）。
fn assert_matches_values(row: &SearchRow, values: &MaterialValues) {
    let actual = MaterialValues { name: row.name.clone(), model: row.model.clone(), manufacturer: row.manufacturer.clone(), quantity: row.quantity.clone(), remarks: row.remarks.clone(), unit_price: row.unit_price.clone() };
    assert_eq!(&actual, values);
}

/// `it.each([...])('matches normalized literal substring %s while retaining originals')`
fn matches_normalized_literal_substring(query: &str) {
    let context = fixture();
    let before = materials::get(&context.store, &context.first).unwrap();
    let result = context.search(input(query, None, false, 0)).unwrap();
    assert_eq!(result.total, 2);
    let row = result.rows.iter().find(|row| row.id == context.first).expect("first material in result");
    assert_matches_values(row, &context.values);
    assert_eq!(materials::get(&context.store, &context.first).unwrap(), before);
}

/// `it.each([...])('does not search unrelated fields or remove punctuation: %s')`
fn does_not_search_unrelated_fields_or_remove_punctuation(query: &str) {
    let context = fixture();
    assert_eq!(context.search(input(query, None, false, 0)).unwrap().total, 0);
}

/// `it.each([...])('rejects invalid boundary input %j')`（既定の入力に invalid を重ねる）。
fn rejects_invalid_boundary_input(invalid: Value) {
    let context = fixture();
    let mut request = input("", None, false, 0);
    for (key, value) in invalid.as_object().unwrap() { request.as_object_mut().unwrap().insert(key.clone(), value.clone()); }
    assert!(context.search(request).is_err());
}

macro_rules! cases {
    ($runner:ident { $($name:ident: $arg:expr,)* }) => { $( #[test] fn $name() { $runner($arg); } )* };
}

cases!(matches_normalized_literal_substring {
    matches_normalized_literal_substring_a_bu: "a部",
    matches_normalized_literal_substring_1_a_b: "1-a/b",
    matches_normalized_literal_substring_001_a_b: "001-a/b",
    matches_normalized_literal_substring_meka: "meka",
    matches_normalized_literal_substring_remarks_with_collapsed_space: "備考 特記",
    matches_normalized_literal_substring_100_percent: "100%",
    matches_normalized_literal_substring_underscore: "_",
    matches_normalized_literal_substring_backslash: "\\",
});

cases!(does_not_search_unrelated_fields_or_remove_punctuation {
    does_not_search_unrelated_fields_quantity: "数量専用",
    does_not_search_unrelated_fields_unit_price: "単価専用",
    does_not_search_unrelated_fields_sql_injection: "' OR 1=1 --",
    does_not_remove_punctuation_001ab: "001ab",
    does_not_search_unrelated_fields_missing: "存在しない",
});

cases!(rejects_invalid_boundary_input {
    rejects_invalid_boundary_input_long_query: json!({ "query": "a".repeat(257) }),
    rejects_invalid_boundary_input_nul_query: json!({ "query": "\0" }),
    rejects_invalid_boundary_input_bad_category: json!({ "categoryId": "bad" }),
    rejects_invalid_boundary_input_negative_offset: json!({ "offset": -1 }),
    rejects_invalid_boundary_input_string_include_inactive: json!({ "includeInactive": "yes" }),
    rejects_invalid_boundary_input_unknown_key: json!({ "sql": "DELETE" }),
});

#[test]
fn combines_category_and_active_filters_without_merging_duplicates() {
    let context = fixture();
    materials::update(&context.store, MaterialUpdate { id: &context.first, category_id: &context.category, expected_revision: 1, active: false, values: &context.values }).unwrap();
    assert_eq!(context.search(input("", Some(&context.category), false, 0)).unwrap().total, 0);
    assert_eq!(context.search(input("", Some(&context.category), true, 0)).unwrap().rows.iter().map(|row| row.id.clone()).collect::<Vec<_>>(), vec![context.first.clone()]);
    assert_eq!(context.search(input("", None, false, 0)).unwrap().total, 1);
}

#[test]
fn treats_percent_underscore_and_backslash_literally_rather_than_matching_plain_peers() {
    let context = fixture();
    materials::create(&context.store, &context.category, &MaterialValues { remarks: "備考 特記 100XYZ".into(), ..context.values.clone() }).unwrap();
    for query in ["%", "_", "\\", "100%_\\"] { assert_eq!(context.search(input(query, None, false, 0)).unwrap().total, 2, "query {query:?}"); }
    assert_eq!(context.search(input("100", None, false, 0)).unwrap().total, 3);
}

#[test]
fn uses_stable_bounded_pages_for_duplicate_values() {
    let context = fixture();
    for _ in 0..55 { materials::create(&context.store, &context.category, &context.values).unwrap(); }
    let first = context.search(input("", None, false, 0)).unwrap();
    let second = context.search(input("", None, false, 25)).unwrap();
    assert_eq!(first.total, 57);
    assert_eq!(first.rows.len(), 25);
    assert_eq!(second.rows.len(), 25);
    assert_eq!(first.rows.iter().chain(&second.rows).map(|row| row.id.as_str()).collect::<HashSet<_>>().len(), 50);
    assert_eq!(context.search(input("", None, false, 0)).unwrap(), first);
}

// ---- カテゴリの総数（1000件を超えても材料検索は止まらない） ----

#[test]
fn searches_materials_in_the_last_category_with_1000_and_1001_categories() {
    for total in [1000, 1001] {
        let root = import_support::temp_root("search-categories-");
        let store = Store::open_default(root.path()).unwrap();
        let last = import_support::seed_categories(&store, total).pop().expect("last category");
        let id = materials::create(&store, &last, &MaterialValues { name: "架空末尾材料".into(), ..MaterialValues::default() }).unwrap();
        let all = search::search(&store, &input("末尾", None, false, 0)).unwrap_or_else(|e| panic!("{total}: {e}"));
        assert_eq!((all.total, all.rows[0].id.as_str(), all.rows[0].category_id.as_str()), (1, id.as_str(), last.as_str()), "{total}");
        let filtered = search::search(&store, &input("", Some(&last), false, 0)).unwrap_or_else(|e| panic!("{total}: {e}"));
        assert_eq!(filtered.total, 1, "{total}");
        // 応答のカテゴリは先頭の1000件まで。総数で全件でないことを示す（1000件以下は従来どおり全件）。
        assert_eq!((all.categories.len(), all.category_total), (1000, total as i64), "{total}");
        assert_eq!(all.categories.last().map(|c| c.id == last), Some(total == 1000), "{total}");
    }
}

fn category_input(query: &str, include_inactive: bool, offset: i64) -> Value { json!({ "query": query, "includeInactive": include_inactive, "offset": offset }) }

fn category_page(store: &Store, query: &str, include_inactive: bool, offset: i64) -> CategoryPage { search::categories(store, &category_input(query, include_inactive, offset)).unwrap() }

#[test]
fn pages_category_candidates_in_a_fixed_order_without_gaps_or_duplicates() {
    let root = import_support::temp_root("category-page-");
    let store = Store::open_default(root.path()).unwrap();
    // 並び順が同じカテゴリが混ざる（並び順 → ID の順に並ぶ）。
    let mut expected: Vec<(i64, String)> = (0..257).map(|i| { let order = (i * 7) % 3; (order, materials::create_category(&store, &format!("架空分類{i:03}"), order).unwrap()) }).collect();
    expected.sort();
    let mut seen = Vec::new();
    for (offset, length) in [(0, 100), (100, 100), (200, 57), (300, 0)] {
        let page = category_page(&store, "", false, offset);
        assert_eq!((page.rows.len(), page.total, page.category_total), (length, 257, 257), "offset {offset}");
        seen.extend(page.rows.into_iter().map(|c| c.id));
    }
    assert_eq!(seen, expected.into_iter().map(|(_, id)| id).collect::<Vec<_>>());
    assert_eq!(seen.iter().collect::<HashSet<_>>().len(), 257);
    // 材料の画面は同じ順の先頭ページと総数を返す。
    let form = pom_core::reimport::MasterService::default().get(&store, None).unwrap();
    assert_eq!((form.categories.len(), form.category_total), (100, 257));
    assert_eq!(form.categories.iter().map(|c| c.id.clone()).collect::<Vec<_>>(), seen[..100]);
}

#[test]
fn searches_category_names_with_the_material_search_normalization() {
    let context = fixture();
    let long = "架空の長いカテゴリ名".repeat(100);
    for (name, order) in [("ＡＢ配管", 2), ("ｶﾀﾛｸﾞ電材", 3), ("100%_材 \\ 記号", 4), (long.as_str(), 5)] { materials::create_category(&context.store, name, order).unwrap(); }
    let names = |query: &str| -> Vec<String> { category_page(&context.store, query, true, 0).rows.into_iter().map(|c| c.name).collect() };
    assert_eq!(names("ab"), vec!["ＡＢ配管"]);
    assert_eq!(names("カタログ"), vec!["ｶﾀﾛｸﾞ電材"]);
    assert_eq!(names("  架空  "), vec!["架空配管".to_string(), "架空電材".to_string(), long.clone()]);
    assert_eq!(names("%"), vec!["100%_材 \\ 記号"]);
    assert_eq!(names("_"), vec!["100%_材 \\ 記号"]);
    assert_eq!(names("\\"), vec!["100%_材 \\ 記号"]);
    assert_eq!(names(&long.chars().take(256).collect::<String>()), vec![long.clone()]);
    let empty = category_page(&context.store, "存在しない架空", true, 0);
    assert_eq!((empty.rows.len(), empty.total), (0, 0));
    // 絞り込み後の件数とは別に、絞り込む前の総数を返す（画面は検索欄を出すかをこちらで決める）。
    assert_eq!(empty.category_total, 6);
    assert_eq!((category_page(&context.store, "ab", true, 0).total, category_page(&context.store, "ab", true, 0).category_total), (1, 6));
    assert_eq!(category_page(&context.store, "", true, 0).category_total, 6);
    // 検索語の正規化は表示名を変えない（長い日本語名も切り詰めずに返す）。
    assert_eq!(category_page(&context.store, "", true, 0).rows.iter().find(|c| c.name.starts_with("架空の長い")).map(|c| c.name.chars().count()), Some(1000));
}

#[test]
fn counts_materials_per_category_and_in_total_with_and_without_inactive() {
    let context = fixture();
    let second = materials::create(&context.store, &context.category, &context.values).unwrap();
    materials::update(&context.store, MaterialUpdate { id: &second, expected_revision: 1, category_id: &context.category, active: false, values: &context.values }).unwrap();
    let counts = |include_inactive: bool| { let page = category_page(&context.store, "", include_inactive, 0); (page.rows.into_iter().map(|c| (c.name, c.count)).collect::<Vec<_>>(), page.material_count) };
    assert_eq!(counts(false), (vec![("架空配管".to_string(), 1), ("架空電材".to_string(), 1)], 2));
    assert_eq!(counts(true), (vec![("架空配管".to_string(), 2), ("架空電材".to_string(), 1)], 3));
    // 材料検索の応答のカテゴリも同じ件数。
    let searched = context.search(input("", None, true, 0)).unwrap();
    assert_eq!(searched.categories.iter().map(|c| c.count).collect::<Vec<_>>(), vec![2, 1]);
    assert_eq!(searched.category_total, 2);
}

#[test]
fn rejects_invalid_category_requests() {
    let context = fixture();
    let mut extra = category_input("", false, 0);
    extra["sql"] = json!("DROP TABLE categories");
    for invalid in [
        extra, json!(null), json!([]), json!({ "query": "", "offset": 0 }), category_input(&"x".repeat(257), false, 0), category_input("a\u{0}", false, 0),
        json!({ "query": "", "includeInactive": "false", "offset": 0 }), json!({ "query": "", "includeInactive": false, "offset": -1 }),
        json!({ "query": "", "includeInactive": false, "offset": 1.5 }), json!({ "query": "", "includeInactive": false, "offset": 1_000_001 }),
    ] {
        assert!(search::categories(&context.store, &invalid).is_err(), "{invalid}");
    }
    assert_eq!(category_page(&context.store, &"𠮷".repeat(256), false, 0).total, 0);
    assert_eq!(category_page(&context.store, "", false, 1_000_000).rows.len(), 0);
}
