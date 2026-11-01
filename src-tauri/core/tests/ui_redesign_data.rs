//! 旧 tests/unit/ui-redesign-data.test.ts（請求書一覧の件数・絞り込み、台帳の件数、表示用メタデータ、ドロップしたパス）の移植。

use pom_core::db::Store;
use pom_core::documents::{DocumentEditor, EditorSession, InvoiceDraft};
use pom_core::imports::source::dropped_workbook_path;
use pom_core::materials::{self, MaterialUpdate, MaterialValues};
use pom_core::search;
use pom_core::ui_meta::UiMeta;
use serde_json::{Value, json};

struct Context { root: tempfile::TempDir, store: Store, meta: UiMeta, editor: DocumentEditor }

fn context() -> Context {
    let root = tempfile::Builder::new().prefix("ui-redesign-").tempdir().unwrap();
    let store = Store::open_default(&root.path().join("database")).unwrap();
    let meta = UiMeta::new(root.path());
    Context { root, store, meta, editor: DocumentEditor::default() }
}

fn values(name: &str) -> MaterialValues {
    MaterialValues { name: name.into(), model: "001-A".into(), manufacturer: "架空社".into(), quantity: "02 本".into(), remarks: String::new(), unit_price: String::new() }
}

fn save(context: &mut Context, session: &EditorSession, draft: Value) -> pom_core::documents::SaveReceipt {
    context.editor.save(&context.store, &json!({ "sessionId": session.session_id, "draft": draft, "requestNumber": 1, "expectedRevision": session.revision, "generation": 1 })).unwrap()
}

fn draft_json(draft: &InvoiceDraft) -> Value { serde_json::to_value(draft).unwrap() }

#[test]
fn lists_line_counts_export_blocking_issues_upper_field_and_current_revision_export() {
    let mut c = context();
    let category = materials::create_category(&c.store, "架空", 0).unwrap();
    let material = materials::create(&c.store, &category, &values("架空材料")).unwrap();
    let session = c.editor.open(&c.store, &Value::Null, false).unwrap();
    let lines: Vec<Value> = (0..3).map(|_| serde_json::to_value(c.editor.add_line(&c.store, &json!({ "sessionId": session.session_id, "materialId": material })).unwrap()).unwrap()).collect();
    let mut first = lines[0].clone(); first["deliveryState"] = json!("material_only"); first["markOutput"] = json!("filled_circle");
    let mut second = lines[1].clone(); second["deliveryState"] = json!("both"); second["markOutput"] = json!("both_mark");
    let mut draft = draft_json(&session.draft);
    draft["title"] = json!("架空請求");
    draft["header"]["C2"] = json!("架空宛先 御中");
    draft["header"]["E4"] = json!("2026-02-30");
    draft["lines"] = json!([first, second, lines[2]]);
    let receipt = save(&mut c, &session, draft);
    let item = c.editor.list(&c.store, &json!(0), None, Some(&c.meta)).unwrap().items.remove(0);
    // 実在しない納期1件。チェックが未選択の1行は任意の項目のため数えない（利用者の指示、2026年10月16日）。材料伝票共に納品の⦿は出力できる。
    assert_eq!((item.id.as_str(), item.c2.as_str(), item.line_count, item.issue_count, item.exported_revision, item.exported_at.as_deref()), (receipt.document_id.as_str(), "架空宛先 御中", 3, 1, None, None));
    // 記号を決める前に保存した「共に納品」（記号未確定）は、選び直すまで出力を止める項目に数える。
    c.store.conn().execute("UPDATE document_lines SET mark_output=? WHERE id=?", ["unresolved", lines[1]["id"].as_str().unwrap()]).unwrap();
    assert_eq!(c.editor.list(&c.store, &json!(0), None, Some(&c.meta)).unwrap().items[0].issue_count, 2);
    c.meta.record_export(&receipt.document_id, receipt.revision);
    let item = c.editor.list(&c.store, &json!(0), None, Some(&c.meta)).unwrap().items.remove(0);
    assert_eq!(item.exported_revision, Some(1));
    assert!(chrono::DateTime::parse_from_rfc3339(item.exported_at.as_deref().unwrap_or("")).is_ok());
}

/// TD-45: 納期の判定は前後の空白を除いた後で行う（出力と同じ）。保存した後に空白が付いた値でも件数に数えない。
#[test]
fn counts_the_due_date_issue_after_trimming_surrounding_whitespace() {
    let mut c = context();
    let session = c.editor.open(&c.store, &Value::Null, false).unwrap();
    let mut draft = draft_json(&session.draft);
    draft["title"] = json!("架空請求");
    let receipt = save(&mut c, &session, draft);
    for (e4, expected) in [("\u{3000}2026/10/31 ", 0), ("\u{3000}2026-02-30\u{FEFF}", 1), ("\u{200B}2026-10-31", 1), ("\u{3000}", 0)] {
        let header = json!({ "C2": "", "A4": "", "B4": "", "C4": "", "E4": e4 });
        c.store.conn().execute("UPDATE documents SET header=? WHERE id=?", [&header.to_string(), &receipt.document_id]).unwrap();
        assert_eq!(c.editor.list(&c.store, &json!(0), None, Some(&c.meta)).unwrap().items[0].issue_count, expected, "{e4:?}");
    }
}

#[test]
fn filters_the_invoice_list_by_title_or_upper_field_as_literal_text() {
    let mut c = context();
    for (title, c2) in [("架空 A工事", "宛先甲"), ("架空 B工事", "100%_宛先"), ("別件", "宛先乙")] {
        let session = c.editor.open(&c.store, &Value::Null, false).unwrap();
        let mut draft = draft_json(&session.draft);
        draft["title"] = json!(title);
        draft["header"]["C2"] = json!(c2);
        save(&mut c, &session, draft);
    }
    let titles = |c: &Context, filter: &str| c.editor.list(&c.store, &json!(0), Some(&json!(filter)), None).unwrap().items.into_iter().map(|i| i.title).collect::<Vec<_>>();
    assert_eq!(titles(&c, "A工事"), ["架空 A工事"]);
    assert_eq!(titles(&c, "宛先乙"), ["別件"]);
    assert_eq!(titles(&c, "%_"), ["架空 B工事"]);
    assert_eq!(titles(&c, "架空").len(), 2);
    assert_eq!(titles(&c, "").len(), 3);
    assert!(c.editor.list(&c.store, &json!(0), Some(&json!("x".repeat(257))), None).is_err());
}

#[test]
fn counts_materials_per_category_for_the_ledger_honouring_the_inactive_filter() {
    let c = context();
    let a = materials::create_category(&c.store, "架空A", 0).unwrap();
    let b = materials::create_category(&c.store, "架空B", 1).unwrap();
    materials::create(&c.store, &a, &values("架空材料")).unwrap();
    let hidden = materials::create(&c.store, &a, &values("無効予定")).unwrap();
    materials::update(&c.store, MaterialUpdate { id: &hidden, category_id: &a, expected_revision: 1, values: &values("無効予定"), active: false }).unwrap();
    let counts = |category: Value, inactive: bool| search::search(&c.store, &json!({ "query": "", "categoryId": category, "includeInactive": inactive, "offset": 0 })).unwrap()
        .categories.into_iter().map(|o| (o.id, o.count)).collect::<Vec<_>>();
    assert_eq!(counts(Value::Null, false), [(a.clone(), 1), (b.clone(), 0)]);
    assert_eq!(counts(json!(b), true), [(a, 2), (b, 0)]);
}

#[test]
fn keeps_display_only_metadata_outside_the_database_and_survives_a_broken_file() {
    let c = context();
    assert_eq!(c.meta.last_backup_at(), None);
    c.meta.record_backup();
    let reloaded = UiMeta::new(c.root.path());
    assert!(chrono::DateTime::parse_from_rfc3339(&reloaded.last_backup_at().unwrap_or_default()).is_ok());
    let stored: Value = serde_json::from_slice(&std::fs::read(c.root.path().join("ui-meta.json")).unwrap()).unwrap();
    assert!(stored.get("exports").is_some());
    std::fs::write(c.root.path().join("ui-meta.json"), "{broken").unwrap();
    let broken = UiMeta::new(c.root.path());
    assert_eq!(broken.last_backup_at(), None);
    broken.record_export("7c0d1d4e-8a7b-4f6a-9d2c-3b1f2e4a5c6d", 2);
    assert_eq!(UiMeta::new(c.root.path()).export_of("7c0d1d4e-8a7b-4f6a-9d2c-3b1f2e4a5c6d").map(|r| r.revision), Some(2));
}

#[test]
fn accepts_only_local_absolute_xlsx_paths_from_drag_and_drop() {
    assert!(dropped_workbook_path(&json!("C:\\架空\\材料.XLSX")).unwrap().to_string_lossy().ends_with("材料.XLSX"));
    for value in [json!(""), json!("材料.xlsx"), json!("\\\\server\\share\\材料.xlsx"), json!("//server/share/材料.xlsx"), json!("C:\\架空\\材料.xls"), json!("C:\\架空\\材料.csv"), json!("C:\\架空\0\\材料.xlsx"), json!(42), Value::Null] {
        assert!(dropped_workbook_path(&value).is_err(), "{value}");
    }
}
