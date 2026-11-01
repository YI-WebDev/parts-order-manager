//! tests/unit/import-repository.test.ts の移植（初回取込の原記録保存と確定）。

mod import_support;

use std::collections::HashSet;

use import_support::{assert_throws, count, open, reopen, seed_categories, synthetic_workbook, temp_root, text_cell, thrown, workbook_parts, zip_parts};
use pom_core::db::Store;
use pom_core::documents;
use pom_core::imports::repository::{self, ImportReview};
use pom_core::imports::workbook::parse_workbook;
use pom_core::imports::ParsedWorkbook;
use pom_core::js;
use pom_core::materials::{self, MaterialValues};
use pom_core::reimport::MasterService;
use pom_core::search;
use serde_json::{json, Value};

fn hash() -> String { js::sha256_hex(synthetic_workbook()) }

fn stage(store: &Store) -> ImportReview { repository::stage(store, &parse_workbook(&synthetic_workbook()).unwrap(), "架空.xlsx", &hash()).unwrap() }

fn ids(review: &ImportReview, classification: &str) -> Vec<String> {
    review.items.iter().filter(|item| item.classification == classification).map(|item| item.id.clone()).collect()
}

fn apply_input(batch_id: &str, accepted_ids: &[String]) -> Value { json!({ "batchId": batch_id, "acceptedIds": accepted_ids }) }

#[test]
fn stores_a_durable_preview_without_touching_materials_and_returns_the_same_initial_batch() {
    let directory = temp_root("step05-db-");
    let store = open(directory.path());
    let first = stage(&store);
    let again = stage(&store);
    assert_eq!(first.batch.id, again.batch.id);
    assert_eq!(count(&store, "materials"), 0);
    let store = reopen(store, directory.path());
    assert_eq!(repository::review(&store, &first.batch.id).unwrap(), first);
}

#[test]
fn atomically_creates_distinct_uuid_materials_and_retains_raw_sources_on_replay() {
    let directory = temp_root("step05-db-");
    let store = open(directory.path());
    let first = stage(&store);
    let input = apply_input(&first.batch.id, &ids(&first, "candidate"));
    let result = repository::apply(&store, &input).unwrap();
    let replay = repository::apply(&store, &input).unwrap();
    assert_eq!((result.batch.counts.applied, result.batch.counts.held, result.batch.counts.supplements), (4, 1, 1));
    assert_eq!(replay, result);
    let mut statement = store.conn().prepare("SELECT id, name, quantity, unit_price, last_source_item_id FROM materials").unwrap();
    let rows: Vec<(String, String, String, String, Option<String>)> = statement.query_map([], |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?, row.get(3)?, row.get(4)?))).unwrap().collect::<Result<_, _>>().unwrap();
    assert_eq!(rows.len(), 4);
    assert_eq!(rows.iter().collect::<HashSet<_>>().len(), 4);
    // 登録する値は前後の空白を除く（原セル「 架空材料 」→「架空材料」）。原記録は元のまま。
    assert!(rows.iter().all(|row| row.1 == row.1.trim()), "{rows:?}");
    assert_eq!(rows.iter().filter(|row| row.1 == "架空材料").count(), 2);
    assert_eq!(store.conn().query_row("SELECT count(*) FROM import_items WHERE raw_cells LIKE '%\" 架空材料 \"%'", [], |row| row.get::<_, i64>(0)).unwrap(), 2);
    assert_eq!(store.conn().query_row("SELECT count(DISTINCT last_source_item_id) FROM materials", [], |row| row.get::<_, i64>(0)).unwrap(), 4);
    assert_eq!(count(&store, "import_items"), 8);
    assert!(store.conn().execute("UPDATE import_items SET classification='candidate'", []).is_err());
}

#[test]
fn retains_cancelled_previews_and_resumes_only_unreflected_original_items() {
    let directory = temp_root("step05-db-");
    let store = open(directory.path());
    let first = stage(&store);
    let cancelled = repository::cancel(&store, &first.batch.id).unwrap();
    assert_eq!(cancelled.batch.status, "cancelled");
    thrown(repository::apply(&store, &apply_input(&first.batch.id, &[])));
    let resumed = repository::resume(&store, &first.batch.id).unwrap();
    let candidate = resumed.items.iter().find(|item| item.classification == "candidate").expect("Missing candidate");
    repository::apply(&store, &apply_input(&resumed.batch.id, std::slice::from_ref(&candidate.id))).unwrap();
    let remaining = repository::resume(&store, &resumed.batch.id).unwrap();
    assert!(!remaining.items.iter().any(|item| item.id == candidate.id));
    assert_eq!(count(&store, "import_items"), 8);
}

#[test]
fn rolls_back_all_material_changes_and_preserves_raw_preview_when_a_db_write_fails() {
    let directory = temp_root("step05-db-");
    let store = open(directory.path());
    let first = stage(&store);
    store.conn().execute_batch("CREATE TRIGGER simulated_failure BEFORE INSERT ON materials WHEN NEW.model='R-01' BEGIN SELECT RAISE(ABORT,'synthetic'); END;").unwrap();
    assert_throws(repository::apply(&store, &apply_input(&first.batch.id, &ids(&first, "candidate"))), "保存に失敗");
    assert_eq!(count(&store, "materials"), 0);
    assert_eq!(count(&store, "categories"), 0);
    assert_eq!(count(&store, "import_decisions"), 0);
    assert_eq!(repository::review(&store, &first.batch.id).unwrap().batch.status, "failed");
    store.conn().execute_batch("DROP TRIGGER simulated_failure").unwrap();
    assert_eq!(repository::resume(&store, &first.batch.id).unwrap().items.len(), 6);
}

#[test]
fn rejects_ambiguous_selection_forged_item_ids_duplicates_and_changed_source_updates() {
    let directory = temp_root("step05-db-");
    let store = open(directory.path());
    let first = stage(&store);
    let held = first.items.iter().find(|item| item.classification == "held").expect("Missing fixture item");
    let candidate = first.items.iter().find(|item| item.classification == "candidate").expect("Missing fixture item");
    thrown(repository::apply(&store, &apply_input(&first.batch.id, std::slice::from_ref(&held.id))));
    thrown(repository::apply(&store, &apply_input(&first.batch.id, &[candidate.id.clone(), candidate.id.clone()])));
    thrown(repository::apply(&store, &apply_input(&first.batch.id, &["123e4567-e89b-42d3-a456-426614174000".to_string()])));
    repository::apply(&store, &apply_input(&first.batch.id, std::slice::from_ref(&candidate.id))).unwrap();
    let empty = ParsedWorkbook { items: Vec::new(), counts: first.batch.counts.clone() };
    assert_throws(repository::stage(&store, &empty, "変更.xlsx", &"a".repeat(64)), "「変更したExcelで更新」");
}

#[test]
fn does_not_alter_pre_existing_app_edits_or_document_snapshots_during_initial_import() {
    let directory = temp_root("step05-db-");
    let store = open(directory.path());
    let category = materials::create_category(&store, "既存", 0).unwrap();
    let values = MaterialValues { name: "編集済み".into(), model: "001".into(), manufacturer: "".into(), quantity: "02 本".into(), remarks: "元の備考".into(), unit_price: "001.00".into() };
    let material = materials::create(&store, &category, &values).unwrap();
    let draft = documents::parse_draft(&json!({
        "title": "架空帳票", "header": { "C2": "", "A4": "", "B4": "", "C4": "", "E4": "" }, "templateVersion": "v1",
        "lines": [{ "materialId": material, "sourceItemId": null, "name": "当時の名称", "model": "001", "manufacturer": "", "quantity": "1", "remarks": "保持", "deliveryState": "unknown", "markOutput": "unresolved", "observedMark": null, "ruleVersion": "v1" }],
    }), false, 10_000).unwrap();
    let id = documents::create_document(&store, &draft, None).unwrap();
    let before = documents::get_document(&store, &id).unwrap();
    let material_before = materials::get(&store, &material).unwrap();
    let first = stage(&store);
    repository::apply(&store, &apply_input(&first.batch.id, &ids(&first, "candidate"))).unwrap();
    assert_eq!(documents::get_document(&store, &id).unwrap(), before);
    assert_eq!(materials::get(&store, &material).unwrap(), material_before);
}

#[test]
fn adopts_reviewed_held_and_heading_rows_with_a_name_but_never_supplements_or_nameless_rows() {
    let directory = temp_root("step05-db-");
    let store = open(directory.path());
    // 2行目: 型式がないため要確認（品名あり） / 3行目: 材料候補 / 4行目: 品名がない要確認 / G4: 補足セル / 5行目: 型式がない要確認（品名あり）
    let rows = format!(
        r#"<row r="2">{}{}</row><row r="3">{}{}</row><row r="4">{}{}</row><row r="5">{}</row>"#,
        text_cell("A2", "架空型式なし"), text_cell("C2", "架空社"), text_cell("A3", "架空候補"), text_cell("B3", "C-1"), text_cell("C4", "架空品名なし"), text_cell("G4", "架空補足"), text_cell("A5", "架空あとで採用"),
    );
    let bytes = zip_parts(&workbook_parts(&rows, &[]), true);
    let first = repository::stage(&store, &parse_workbook(&bytes).unwrap(), "架空.xlsx", &js::sha256_hex(&bytes)).unwrap();
    let id = |classification: &str, row: i64| first.items.iter().find(|item| item.classification == classification && item.row_index == row && item.block != "right").map(|item| item.id.clone()).expect("fixture item");
    let (held, heading, candidate, nameless, supplement, later) = (id("held", 2), id("header", 1), id("candidate", 3), id("held", 4), id("supplement", 4), id("held", 5));
    // 補足セル・品名のない行は採用できない（何も反映しない）。
    for rejected in [&supplement, &nameless] { assert_throws(repository::apply(&store, &apply_input(&first.batch.id, &[candidate.clone(), rejected.clone()])), "分類"); }
    assert_eq!(count(&store, "materials"), 0);
    // 要確認の行・列見出しの行も、確認して選べば材料にする。
    let applied = repository::apply(&store, &apply_input(&first.batch.id, &[candidate.clone(), held.clone(), heading.clone()])).unwrap();
    assert_eq!(applied.batch.counts.applied, 3);
    assert_eq!(applied.batch.counts.excluded, first.batch.counts.excluded - 1);
    assert_eq!(applied.batch.counts.held, first.batch.counts.held + first.batch.counts.candidates - 2);
    let mut names: Vec<String> = store.conn().prepare("SELECT name FROM materials ORDER BY name").unwrap().query_map([], |row| row.get(0)).unwrap().collect::<Result<_, _>>().unwrap();
    names.sort();
    assert_eq!(names, ["品名", "架空候補", "架空型式なし"]);
    let reason: String = store.conn().query_row("SELECT reason FROM import_decisions WHERE item_id = ?", [&held], |row| row.get(0)).unwrap();
    assert_eq!(reason, "要確認の行を確認して採用");
    // 品名のある要確認行が残っていれば、後から再確認して採用できる。品名のない行と補足セルだけになったら再確認できない。
    let resumed = repository::resume(&store, &first.batch.id).unwrap();
    assert!(resumed.items.iter().any(|item| item.id == later) && !resumed.items.iter().any(|item| item.classification == "header"));
    repository::apply(&store, &apply_input(&resumed.batch.id, std::slice::from_ref(&later))).unwrap();
    assert_eq!(count(&store, "materials"), 4);
    assert_throws(repository::resume(&store, &resumed.batch.id), "未反映の材料候補はありません");
}

#[test]
fn resume_blocked_tells_why_a_closed_initial_record_cannot_be_reviewed_again() {
    let directory = temp_root("step05-db-");
    let store = open(directory.path());
    let first = stage(&store);
    assert_eq!(first.resume_blocked, None);
    let cancelled = repository::cancel(&store, &first.batch.id).unwrap();
    assert_eq!((cancelled.batch.status.as_str(), cancelled.resume_blocked.as_deref()), ("cancelled", None));
    // 同じファイルを選び直すと取消の記録が開き、最初から確認し直せる。
    let again = stage(&store);
    assert_eq!((again.batch.id.as_str(), again.resume_blocked.as_deref()), (first.batch.id.as_str(), None));
    // 別のExcelを確定すると、取消の記録からは再確認できない（resume と同じ理由）。
    let other = zip_parts(&workbook_parts(&format!(r#"<row r="2">{}{}</row>"#, text_cell("A2", "別系列の架空"), text_cell("B2", "B-01")), &[]), false);
    let staged = repository::stage(&store, &parse_workbook(&other).unwrap(), "別系列.xlsx", &js::sha256_hex(&other)).unwrap();
    repository::apply(&store, &apply_input(&staged.batch.id, &ids(&staged, "candidate"))).unwrap();
    let blocked = repository::review(&store, &first.batch.id).unwrap().resume_blocked.expect("blocked");
    assert!(blocked.contains("別の取込が確定済み"));
    assert_throws(repository::resume(&store, &first.batch.id), &blocked);
    // 候補をすべて反映した記録は、未反映の候補がないことを理由に示す。
    assert!(repository::review(&store, &staged.batch.id).unwrap().resume_blocked.expect("nothing pending").contains("未反映の材料候補はありません"));
}

#[test]
fn initial_import_beyond_256_categories_keeps_material_forms_and_search_working() {
    let directory = temp_root("step05-db-");
    let store = open(directory.path());
    seed_categories(&store, 256);
    let first = stage(&store);
    repository::apply(&store, &apply_input(&first.batch.id, &ids(&first, "candidate"))).unwrap();
    // シート「架空材料」のカテゴリが257件目として作られる。
    assert_eq!(count(&store, "categories"), 257);
    let found = search::search(&store, &json!({ "query": "架空材料", "categoryId": null, "includeInactive": false, "offset": 0 })).unwrap();
    assert_eq!(found.total, 4);
    let mut api = MasterService::default();
    assert!(api.get(&store, None).unwrap().create_request_id.is_some());
    let material = api.get(&store, Some(&found.rows[0].id)).unwrap().material.expect("material");
    assert_eq!(material.category_name, "架空材料");
}
