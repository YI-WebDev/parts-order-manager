//! tests/unit/database-repositories.test.ts の移植（材料・帳票の保存と、保存データの不変条件）。
//! 旧実装の repository は unknown を zod で検証してから保存する。帳票はここでも JSON を
//! `documents::parse_draft`（documentDraft）で検証してから `create_document` / `save_document` に渡す。

use pom_core::db::Store;
use pom_core::documents::{self, StoredLine};
use pom_core::js::random_uuid;
use pom_core::materials::{self, MaterialUpdate, MaterialValues};
use pom_core::Error;
use serde_json::{json, Value};
use tempfile::TempDir;

struct Context { store: Store, _root: TempDir }

fn fixture() -> Context {
    let root = tempfile::Builder::new().prefix("step04-repository-").tempdir().unwrap();
    let store = Store::open_default(root.path()).unwrap();
    Context { store, _root: root }
}

fn values() -> MaterialValues {
    MaterialValues { name: " Ａ部品 ".into(), model: "001".into(), manufacturer: "架空メーカー".into(), quantity: "02 本".into(), remarks: "備考\n２行".into(), unit_price: "001.00".into() }
}

fn header() -> Value { json!({ "C2": "", "A4": "", "B4": "", "C4": "", "E4": "未定" }) }

fn line(name: &str) -> Value {
    json!({ "name": name, "model": "001", "manufacturer": "架空", "quantity": "02 本", "remarks": "", "materialId": null, "sourceItemId": null, "deliveryState": "unknown", "markOutput": "unresolved", "observedMark": null, "ruleVersion": "unconfirmed" })
}

/// `{ ...line(), key: value }`
fn with(mut value: Value, key: &str, field: Value) -> Value {
    value.as_object_mut().unwrap().insert(key.into(), field);
    value
}

/// `editableLine(stored)`（documentId・position を除いた明細）。
fn editable_line(stored: &StoredLine) -> Value { serde_json::to_value(&stored.line).unwrap() }

fn draft(title: &str, header: Value, lines: Vec<Value>) -> Value {
    json!({ "title": title, "header": header, "templateVersion": "1", "lines": lines })
}

/// `documents.create(input)`
fn create_document(store: &Store, input: &Value) -> pom_core::Result<String> {
    let draft = documents::parse_draft(input, false, 10_000)?;
    documents::create_document(store, &draft, None)
}

/// `documents.save({ id, expectedRevision, draft })`
fn save_document(store: &Store, id: &str, expected_revision: i64, input: &Value) -> pom_core::Result<i64> {
    let draft = documents::parse_draft(input, false, 10_000)?;
    documents::save_document(store, id, expected_revision, &draft, &[])
}

fn assert_database_error<T: std::fmt::Debug>(result: pom_core::Result<T>) {
    match result {
        Err(Error::Db(..)) => {}
        other => panic!("expected DatabaseError, got {other:?}"),
    }
}

#[test]
fn keeps_duplicate_materials_distinct_original_text_intact_and_normalization_separate() {
    let context = fixture();
    let store = &context.store;
    let category_id = materials::create_category(store, "架空カテゴリ", 0).unwrap();
    let first = materials::create(store, &category_id, &values()).unwrap();
    let second = materials::create(store, &category_id, &values()).unwrap();
    assert_ne!(first, second);
    // 前後の空白は除いて登録し、文中の空白・改行・全角はそのまま。検索用の正規化（全角・半角・大小）は別。
    assert_eq!(materials::get(store, &first).unwrap().values, values().trimmed());
    assert_eq!(materials::get(store, &first).unwrap().values.name, "Ａ部品");
    assert!(materials::get(store, &first).unwrap().search_text.contains("a部品"));
    assert_eq!(materials::get(store, &first).unwrap().values.unit_price, "001.00");
    assert!(materials::create(store, &random_uuid(), &values()).is_err());
}

#[test]
fn checks_material_revisions_and_preserves_document_snapshots_after_material_edits() {
    let context = fixture();
    let store = &context.store;
    let category_id = materials::create_category(store, "架空カテゴリ", 0).unwrap();
    let material_id = materials::create(store, &category_id, &values()).unwrap();
    let id = create_document(store, &draft("架空帳票", header(), vec![with(line(&values().name), "materialId", json!(material_id))])).unwrap();
    let edited = MaterialValues { name: " 編集後\u{3000}".into(), ..values() };
    assert_eq!(materials::update(store, MaterialUpdate { id: &material_id, category_id: &category_id, expected_revision: 1, values: &edited, active: false }).unwrap(), 2);
    // 更新でも前後の空白を除いて書く。
    assert_eq!(materials::get(store, &material_id).unwrap().values.name, "編集後");
    assert_database_error(materials::update(store, MaterialUpdate { id: &material_id, category_id: &category_id, expected_revision: 1, values: &values(), active: true }));
    let document = documents::get_document(store, &id).unwrap();
    // 明細は前後の空白を除いて保存する（材料の編集では変わらない）。
    assert_eq!(document.lines[0].line.name, "Ａ部品");
    // 明細は単価を持たない（取得結果にも、document_lines の列にもない）。
    assert!(editable_line(&document.lines[0]).get("unitPrice").is_none());
    let columns: Vec<String> = store.conn().prepare("SELECT * FROM document_lines").unwrap().column_names().iter().map(|c| c.to_string()).collect();
    assert!(!columns.iter().any(|c| c == "unit_price"));
    assert!(store.conn().execute("DELETE FROM materials WHERE id=?", [&material_id]).is_err());
}

#[test]
fn persists_more_than_47_lines_and_reorders_stable_line_ids_atomically() {
    let context = fixture();
    let store = &context.store;
    let id = create_document(store, &draft("架空48行", header(), (0..48).map(|i| line(&format!("架空{i}"))).collect())).unwrap();
    let before = documents::get_document(store, &id).unwrap();
    let reversed: Vec<&StoredLine> = before.lines.iter().rev().collect();
    assert_eq!(save_document(store, &id, 1, &draft("並替後", header(), reversed.iter().map(|row| editable_line(row)).collect())).unwrap(), 2);
    let after = documents::get_document(store, &id).unwrap();
    assert_eq!(after.lines.iter().map(|row| row.line.id.clone()).collect::<Vec<_>>(), reversed.iter().map(|row| row.line.id.clone()).collect::<Vec<_>>());
    assert_eq!(after.lines.iter().map(|row| row.position).collect::<Vec<_>>(), (0..48).collect::<Vec<i64>>());
    assert_database_error(save_document(store, &id, 1, &draft("古い要求", header(), vec![])));
    assert_eq!(documents::get_document(store, &id).unwrap().title, "並替後");
}

#[test]
fn rolls_back_header_revision_and_line_replacement_on_a_foreign_key_failure() {
    let context = fixture();
    let store = &context.store;
    let id = create_document(store, &draft("保持する帳票", header(), vec![line("スナップショット")])).unwrap();
    let before = documents::get_document(store, &id).unwrap();
    assert!(save_document(store, &id, 1, &draft("失敗変更", header(), vec![with(line("スナップショット"), "materialId", json!(random_uuid()))])).is_err());
    assert_eq!(documents::get_document(store, &id).unwrap(), before);
    let other = create_document(store, &draft("別帳票", header(), vec![line("スナップショット")])).unwrap();
    assert_database_error(save_document(store, &other, 1, &draft("", header(), before.lines.iter().map(editable_line).collect())));
}

#[test]
fn rejects_unknown_header_keys_and_prices_in_lines_and_does_not_infer_blank_as_both() {
    let context = fixture();
    let store = &context.store;
    assert!(create_document(store, &draft("", with(header(), "arbitrary", json!("x")), vec![])).is_err());
    assert!(create_document(store, &draft("", header(), vec![with(line("スナップショット"), "unitPrice", json!("99"))])).is_err());
    let id = create_document(store, &draft("", header(), vec![with(line("スナップショット"), "observedMark", json!(""))])).unwrap();
    let stored = documents::get_document(store, &id).unwrap();
    let first = &stored.lines[0].line;
    assert_eq!((first.delivery_state.as_str(), first.mark_output.as_str(), first.observed_mark.as_deref()), ("unknown", "unresolved", Some("")));
}

#[test]
fn keeps_raw_import_rows_and_decisions_immutable_without_inferring_or_merging() {
    let context = fixture();
    let db = context.store.conn();
    let batch = random_uuid();
    let first = random_uuid();
    let second = random_uuid();
    db.execute("INSERT INTO import_batches VALUES (?,?,?,?,?,?,?,?,?,?,?,?)", rusqlite::params![batch, random_uuid(), None::<String>, "initial", "a".repeat(64), "synthetic.xlsx", "1", "preview", "[]", "{}", "{}", "now"]).unwrap();
    let insert = "INSERT INTO import_items VALUES (?,?,?,?,?,?,?,?,?,?,?)";
    db.execute(insert, rusqlite::params![first, batch, "row", "架空シート", 0, 10, "left", None::<String>, r#"{"A":{"displayText":"001"}}"#, "review", "same"]).unwrap();
    db.execute(insert, rusqlite::params![second, batch, "supplement", "架空シート", 0, 10, "G", "G10", r#"{"G":{"displayText":"未確定"}}"#, "review", "same"]).unwrap();
    db.execute("INSERT INTO import_decisions VALUES (?,?,?,?,?,?,?,?)", rusqlite::params![random_uuid(), first, None::<String>, "hold", "[]", "要確認", "now", None::<String>]).unwrap();
    assert!(db.execute("UPDATE import_items SET classification=? WHERE id=?", ["discard", first.as_str()]).is_err());
    assert!(db.execute("DELETE FROM import_decisions WHERE item_id=?", [&first]).is_err());
    assert_eq!(db.query_row("SELECT count(*) AS n FROM import_items", [], |row| row.get::<_, i64>(0)).unwrap(), 2);
}
