//! tests/unit/reimport.test.ts の移植（変更Excelでの更新取込）。

mod import_support;

use import_support::{assert_throws, count, open, reopen, seed_categories, temp_root, text_cell, thrown, workbook_parts, zip_parts};
use pom_core::db::Store;
use pom_core::imports::repository;
use pom_core::imports::workbook::parse_workbook;
use pom_core::imports::{OriginalCell, ParsedItem, ParsedWorkbook};
use pom_core::js;
use pom_core::materials::MATERIAL_FIELDS;
use pom_core::reimport::{self, MasterService, ReimportReview};
use pom_core::search;
use serde_json::{json, Value};
use tempfile::TempDir;

const TABLES: [&str; 7] = ["materials", "categories", "import_batches", "import_items", "import_decisions", "documents", "document_lines"];

struct Context { root: TempDir, store: Store, series: String, initial: String }

fn book(rows: &[(i64, &str, &str)]) -> Vec<u8> {
    let rows: String = rows.iter().map(|(n, name, model)| format!(r#"<row r="{n}">{}{}{}</row>"#, text_cell(&format!("A{n}"), name), text_cell(&format!("B{n}"), model), text_cell(&format!("D{n}"), "02 本"))).collect();
    zip_parts(&workbook_parts(&rows, &[]), false)
}

fn source(rows: &[(i64, &str, &str)]) -> (ParsedWorkbook, String) {
    let bytes = book(rows);
    (parse_workbook(&bytes).unwrap(), js::sha256_hex(&bytes))
}

fn candidate_ids(items: &[repository::ImportRow]) -> Vec<String> { items.iter().filter(|i| i.classification == "candidate").map(|i| i.id.clone()).collect() }

/// beforeEach（初回取込を確定し、その系列を更新元にする）。
fn setup() -> Context {
    let root = temp_root("step10-reimport-");
    let store = open(root.path());
    let (parsed, hash) = source(&[(2, "架空部品", "001-A"), (3, "消失候補", "002-B")]);
    let r = repository::stage(&store, &parsed, "架空初回.xlsx", &hash).unwrap();
    let initial = r.batch.id.clone();
    repository::apply(&store, &json!({ "batchId": initial, "acceptedIds": candidate_ids(&r.items) })).unwrap();
    let series = reimport::series(&store).unwrap().into_iter().next().expect("series").id;
    Context { root, store, series, initial }
}

impl Context {
    fn stage(&self, rows: &[(i64, &str, &str)]) -> pom_core::Result<ReimportReview> {
        let (parsed, hash) = source(rows);
        reimport::stage(&self.store, &self.series, &parsed, "架空更新.xlsx", &hash)
    }
    fn apply(&self, r: &ReimportReview, choices: &[Value], inactive_ids: &[String]) -> pom_core::Result<ReimportReview> {
        reimport::apply(&self.store, &json!({ "batchId": r.batch.id, "choices": choices, "inactiveIds": inactive_ids, "confirmed": true }))
    }
    fn snapshot(&self) -> Vec<Vec<Vec<rusqlite::types::Value>>> { import_support::snapshot(&self.store, &TABLES) }
    fn reopen(self) -> Context { let Context { root, store, series, initial } = self; let store = reopen(store, root.path()); Context { root, store, series, initial } }
}

/// 材料候補の行は change の選択、それ以外は保留。
fn choices(r: &ReimportReview, change: impl Fn(&str) -> Value) -> Vec<Value> {
    r.rows.iter().map(|row| if row.source.classification == "candidate" { change(&row.source.id) } else { json!({ "itemId": row.source.id, "action": "hold" }) }).collect()
}

fn new(id: &str) -> Value { json!({ "itemId": id, "action": "new" }) }

fn map(id: &str, material_id: &str, fields: &[&str]) -> Value { json!({ "itemId": id, "action": "map", "materialId": material_id, "fields": fields }) }

/// 提案された最初の材料へ全項目を対応させる。
fn map_to_proposal(r: &ReimportReview) -> impl Fn(&str) -> Value + '_ {
    move |id| {
        let target = r.rows.iter().find(|x| x.source.id == id).and_then(|x| x.suggested_ids.first()).expect("proposal");
        map(id, target, &MATERIAL_FIELDS)
    }
}

fn save_json(id: &str, revision: i64, category_id: &str, active: bool, values: &pom_core::materials::MaterialValues) -> Value {
    json!({ "id": id, "expectedRevision": revision, "categoryId": category_id, "newCategoryName": "", "active": active, "values": values })
}

#[test]
fn same_file_is_read_only_moved_rows_require_explicit_identity_and_repeat_apply_creates_no_duplicates() {
    let ctx = setup();
    let same = ctx.stage(&[(2, "架空部品", "001-A"), (3, "消失候補", "002-B")]).unwrap();
    assert_eq!(same.batch.id, ctx.initial);
    let r = ctx.stage(&[(9, "架空部品", "001-A"), (12, "消失候補", "002-B")]).unwrap();
    let before: Vec<String> = r.materials.iter().map(|m| m.id.clone()).collect();
    assert!(r.rows.iter().filter(|x| x.source.classification == "candidate").all(|x| x.comparison == "same"));
    let c = choices(&r, map_to_proposal(&r));
    let done = ctx.apply(&r, &c, &[]).unwrap();
    assert_eq!(done.materials.iter().map(|m| m.id.clone()).collect::<Vec<_>>(), before);
    let snap = ctx.snapshot();
    ctx.apply(&r, &c, &[]).unwrap();
    assert_eq!(ctx.snapshot(), snap);
    assert_throws(repository::resume(&ctx.store, &ctx.initial), "更新取込");
}

#[test]
fn retains_manual_edits_and_missing_manual_materials_records_new_excel_baseline_for_subsequent_conflict_comparison() {
    let ctx = setup();
    let mut master = MasterService::default();
    let m = reimport::current_materials(&ctx.store, &ctx.series).unwrap().into_iter().find(|x| x.values.name == "架空部品").expect("material");
    let mut edited = m.values.clone();
    edited.model = "手動-009".into();
    master.save(&ctx.store, &save_json(&m.id, m.revision, &m.category_id, true, &edited)).unwrap();
    let token = master.get(&ctx.store, None).unwrap().create_request_id.expect("token");
    let mut manual_values = m.values.clone();
    manual_values.name = "手動材料".into();
    let manual = master.save(&ctx.store, &json!({ "createRequestId": token, "id": null, "expectedRevision": 0, "categoryId": m.category_id, "newCategoryName": "", "active": true, "values": manual_values })).unwrap();
    let r = ctx.stage(&[(8, "架空部品", "001-Z")]).unwrap();
    ctx.apply(&r, &choices(&r, |id| map(id, &m.id, &[])), &[]).unwrap();
    let saved = master.get(&ctx.store, Some(&m.id)).unwrap().material.expect("saved");
    assert_eq!(saved.values.model, "手動-009");
    assert_eq!(saved.source.expect("source").values[1], "001-Z");
    assert_eq!(master.get(&ctx.store, Some(&manual.id)).unwrap().material, Some(manual));
    assert_eq!(reimport::current_materials(&ctx.store, &ctx.series).unwrap().len(), 2);
    let ctx = ctx.reopen();
    assert_eq!(MasterService::default().get(&ctx.store, Some(&m.id)).unwrap().material.expect("material").values.model, "手動-009");
}

#[test]
fn duplicate_content_stays_ambiguous_and_explicit_new_records_get_separate_uuids() {
    let ctx = setup();
    let r = ctx.stage(&[(2, "架空部品", "001-A"), (4, "架空部品", "001-A")]).unwrap();
    ctx.apply(&r, &choices(&r, new), &[]).unwrap();
    let next = ctx.stage(&[(7, "架空部品", "001-A")]).unwrap();
    assert_eq!(next.rows.iter().find(|x| x.source.classification == "candidate").expect("candidate").comparison, "ambiguous");
    assert_eq!(next.materials.iter().filter(|m| m.values.name == "架空部品").count(), 3);
}

#[test]
fn stale_confirmation_rejects_before_writes_and_refresh_preserves_original_staging_records() {
    let ctx = setup();
    let r = ctx.stage(&[(4, "架空部品", "NEW")]).unwrap();
    let m = r.materials.first().expect("material");
    MasterService::default().save(&ctx.store, &save_json(&m.id, m.revision, &m.category_id, false, &m.values)).unwrap();
    let before = ctx.snapshot();
    assert_throws(ctx.apply(&r, &choices(&r, new), &[]), "変更");
    assert_eq!(ctx.snapshot(), before);
    let refreshed = reimport::resume(&ctx.store, &r.batch.id).unwrap();
    assert_ne!(refreshed.batch.id, r.batch.id);
    assert_eq!(
        refreshed.rows.iter().map(|x| x.source.id.clone()).collect::<Vec<_>>(),
        r.rows.iter().filter(|x| x.source.classification != "header").map(|x| x.source.id.clone()).collect::<Vec<_>>(),
    );
    assert!(!refreshed.stale);
}

#[test]
fn cancellation_is_non_destructive_and_transaction_failure_can_retry_once_without_duplicate_records() {
    let ctx = setup();
    let r = ctx.stage(&[(5, "追加", "003")]).unwrap();
    let before = r.materials.clone();
    reimport::cancel(&ctx.store, &r.batch.id).unwrap();
    assert_eq!(reimport::current_materials(&ctx.store, &ctx.series).unwrap(), before);
    let resumed = reimport::resume(&ctx.store, &r.batch.id).unwrap();
    let c = choices(&resumed, new);
    ctx.store.conn().execute_batch("CREATE TRIGGER step10_failure BEFORE INSERT ON import_decisions BEGIN SELECT RAISE(ABORT,'synthetic failure'); END;").unwrap();
    let snap = ctx.snapshot();
    thrown(ctx.apply(&resumed, &c, &[]));
    assert_eq!(ctx.snapshot(), snap);
    ctx.store.conn().execute_batch("DROP TRIGGER step10_failure").unwrap();
    let done = ctx.apply(&resumed, &c, &[]).unwrap();
    assert_eq!(done.batch.status, "applied");
    assert_eq!(done.materials.len(), 3);
}

#[test]
fn rejects_old_reimport_resumption_after_later_source_commits_and_does_not_substitute_another_preview() {
    let ctx = setup();
    let a = ctx.stage(&[(2, "A", "A")]).unwrap();
    reimport::cancel(&ctx.store, &a.batch.id).unwrap();
    let b = ctx.stage(&[(2, "B", "B")]).unwrap();
    assert_throws(reimport::resume(&ctx.store, &a.batch.id), "別の取込");
    ctx.apply(&b, &choices(&b, new), &[]).unwrap();
    let before = ctx.snapshot();
    assert_throws(reimport::resume(&ctx.store, &a.batch.id), "後続");
    assert_eq!(ctx.snapshot(), before);
}

#[test]
fn explicit_inactivation_preserves_data_and_duplicate_target_manual_target_choices_are_rejected() {
    let ctx = setup();
    let r = ctx.stage(&[(6, "新規A", "01"), (7, "新規B", "02")]).unwrap();
    let target = r.materials.first().expect("target");
    let before = ctx.snapshot();
    assert_throws(ctx.apply(&r, &choices(&r, |id| map(id, &target.id, &[])), &[]), "対応");
    assert_eq!(ctx.snapshot(), before);
    let mut manual_api = MasterService::default();
    let token = manual_api.get(&ctx.store, None).unwrap().create_request_id.expect("token");
    let manual = manual_api.save(&ctx.store, &json!({ "createRequestId": token, "id": null, "expectedRevision": 0, "categoryId": target.category_id, "newCategoryName": "", "active": true, "values": target.values })).unwrap();
    assert_throws(ctx.apply(&r, &choices(&r, |id| json!({ "itemId": id, "action": "hold" })), std::slice::from_ref(&manual.id)), "系列");
    let done = ctx.apply(&r, &choices(&r, new), std::slice::from_ref(&target.id)).unwrap();
    let saved = done.materials.iter().find(|m| m.id == target.id).expect("saved");
    assert_eq!(saved.values, target.values);
    assert!(!saved.active);
}

#[test]
fn held_candidate_resumption_consumes_only_selected_items_never_duplicates_confirmed_mappings() {
    let ctx = setup();
    let r = ctx.stage(&[(4, "追加1", "001"), (5, "追加2", "002")]).unwrap();
    let selected = r.rows.iter().find(|x| x.source.classification == "candidate").expect("candidate");
    ctx.apply(&r, &choices(&r, |id| { let action = if id == selected.source.id { "new" } else { "hold" }; json!({ "itemId": id, "action": action }) }), &[]).unwrap();
    let resumed = reimport::resume(&ctx.store, &r.batch.id).unwrap();
    assert_eq!(resumed.rows.iter().filter(|x| x.source.classification == "candidate").count(), 1);
    ctx.apply(&resumed, &choices(&resumed, new), &[]).unwrap();
    assert_eq!(reimport::current_materials(&ctx.store, &ctx.series).unwrap().len(), 4);
}

#[test]
fn staging_refuses_expanded_response_limits_atomically_and_leaves_original_raw_history_intact() {
    let ctx = setup();
    let (parsed, _) = source(&[(4, "追加", "001")]);
    let item = parsed.items.iter().find(|i| i.classification == "candidate").expect("candidate");
    let long = "架".repeat(1500);
    let repeated: Vec<ParsedItem> = (0..4000).map(|n| {
        let mut copy = ParsedItem { row_index: n + 2, ..item.clone() };
        copy.raw_cells.insert("A".into(), OriginalCell {
            presence: "present".into(), kind: "text".into(), raw_value: Some(long.clone()), display_text: long.clone(), format_code: None, display_verified: true,
            rich_text: None, phonetic: None, formula: None, formula_cached_type: None,
        });
        copy
    }).collect();
    let before = ctx.snapshot();
    assert_throws(reimport::stage(&ctx.store, &ctx.series, &ParsedWorkbook { items: repeated, counts: parsed.counts.clone() }, "架空過大.xlsx", &"c".repeat(64)), "上限");
    assert_eq!(ctx.snapshot(), before);
}

#[test]
fn bounds_and_measures_review_apply_for_531_fictional_long_text_candidates() {
    let ctx = setup();
    let names: Vec<(i64, String, String)> = (0..531).map(|n| (n + 2, format!("架空性能部品{n} {}", "長文".repeat(50)), format!("00-{n}"))).collect();
    let rows: Vec<(i64, &str, &str)> = names.iter().map(|(n, name, model)| (*n, name.as_str(), model.as_str())).collect();
    let started = std::time::Instant::now();
    let r = ctx.stage(&rows).unwrap();
    let review_ms = started.elapsed().as_secs_f64() * 1000.0;
    let applied_at = std::time::Instant::now();
    let done = ctx.apply(&r, &choices(&r, new), &[]).unwrap();
    let apply_ms = applied_at.elapsed().as_secs_f64() * 1000.0;
    assert_eq!(done.batch.counts.applied, 531);
    assert_eq!(done.materials.len(), 533);
    println!("{}", json!({ "fictionalCandidates": 531, "reviewMs": review_ms, "applyMs": apply_ms, "responseBytes": js::json_bytes(&done) }));
}

fn rejects_a_second_source_row_across_resume_restart_but_permits_a_later_workbook(action: &str) {
    let ctx = setup();
    let r = ctx.stage(&[(4, "同一元ブックA", "ROW-A"), (5, "同一元ブックB", "ROW-B")]).unwrap();
    let first = r.rows.iter().find(|x| x.source.classification == "candidate").expect("fixture");
    let existing = r.materials.first().expect("fixture");
    ctx.apply(&r, &choices(&r, |id| if id != first.source.id { json!({ "itemId": id, "action": "hold" }) } else if action == "new" { new(id) } else { map(id, &existing.id, &MATERIAL_FIELDS) }), &[]).unwrap();
    let assigned = reimport::current_materials(&ctx.store, &ctx.series).unwrap().into_iter().find(|m| m.source.as_ref().is_some_and(|s| s.id == first.source.id)).expect("assigned");
    let ctx = ctx.reopen();
    let resumed = reimport::resume(&ctx.store, &r.batch.id).unwrap();
    let before = ctx.snapshot();
    assert_throws(ctx.apply(&resumed, &choices(&resumed, |id| map(id, &assigned.id, &MATERIAL_FIELDS)), &[]), "対応");
    assert_eq!(ctx.snapshot(), before);
    let other = resumed.materials.iter().find(|m| m.id != assigned.id).expect("other");
    ctx.apply(&resumed, &choices(&resumed, |id| map(id, &other.id, &MATERIAL_FIELDS)), &[]).unwrap();
    let next = ctx.stage(&[(12, "後続の別ブック", "NEXT")]).unwrap();
    ctx.apply(&next, &choices(&next, |id| map(id, &assigned.id, &MATERIAL_FIELDS)), &[]).unwrap();
    assert_eq!(MasterService::default().get(&ctx.store, Some(&assigned.id)).unwrap().material.expect("material").values.model, "NEXT");
}

#[test]
fn rejects_a_second_source_row_after_map_across_resume_restart_but_permits_a_later_workbook() { rejects_a_second_source_row_across_resume_restart_but_permits_a_later_workbook("map"); }

#[test]
fn rejects_a_second_source_row_after_new_across_resume_restart_but_permits_a_later_workbook() { rejects_a_second_source_row_across_resume_restart_but_permits_a_later_workbook("new"); }

#[test]
fn initial_import_committed_only_through_a_resumed_resolution_still_allows_reimport() {
    let ctx = setup();
    let Context { root, store, .. } = ctx;
    store.close();
    drop(root);
    let root = temp_root("step10-reimport-");
    let store = open(root.path());
    let (parsed, hash) = source(&[(2, "架空部品", "001-A"), (3, "架空継続", "002-B")]);
    let first = repository::stage(&store, &parsed, "架空初回.xlsx", &hash).unwrap();
    repository::cancel(&store, &first.batch.id).unwrap();
    let resumed = repository::resume(&store, &first.batch.id).unwrap();
    repository::apply(&store, &json!({ "batchId": resumed.batch.id, "acceptedIds": candidate_ids(&resumed.items) })).unwrap();
    let found = reimport::series(&store).unwrap();
    assert_eq!(found.len(), 1);
    let series = found.first().map(|s| s.id.clone()).unwrap_or_default();
    assert_eq!(reimport::head(&store, &series).unwrap().id, first.batch.id);
    let ctx = Context { root, store, series, initial: first.batch.id.clone() };
    let r = ctx.stage(&[(2, "架空部品", "001-A"), (3, "架空継続", "002-C")]).unwrap();
    assert_eq!(r.batch.status, "preview");
    assert!(!r.stale);
    assert_eq!(r.materials.len(), 2);
    let done = ctx.apply(&r, &choices(&r, map_to_proposal(&r)), &[]).unwrap();
    assert_eq!(done.batch.status, "applied");
    let mut models: Vec<String> = done.materials.iter().map(|m| m.values.model.clone()).collect();
    models.sort();
    assert_eq!(models, ["001-A", "002-C"]);
}

#[test]
fn held_rows_with_a_name_can_be_added_after_review_but_headers_and_nameless_rows_stay_held() {
    let c = setup();
    // 3行目は型式が空欄（品名あり）の要確認、4行目は品名が空欄の要確認。
    let r = c.stage(&[(2, "架空部品", "001-A"), (3, "架空型式なし", ""), (4, "", "003-C")]).unwrap();
    let held = |name: &str| r.rows.iter().find(|row| row.source.classification == "held" && row.source.values[0] == name).map(|row| row.source.id.clone()).expect(name);
    let (named, nameless) = (held("架空型式なし"), held(""));
    let header = r.rows.iter().find(|row| row.source.classification == "header").map(|row| row.source.id.clone()).expect("header");
    let only = |target: &str| -> Vec<Value> { r.rows.iter().map(|row| if row.source.id == target { json!({ "itemId": target, "action": "new" }) } else { json!({ "itemId": row.source.id, "action": "hold" }) }).collect() };
    let before = c.snapshot();
    for rejected in [&nameless, &header] { assert_throws(c.apply(&r, &only(rejected), &[]), "要確認の原記録は保留してください"); }
    assert_eq!(c.snapshot(), before);
    let applied = c.apply(&r, &only(&named), &[]).unwrap();
    assert_eq!(applied.batch.counts.applied, 1);
    let name: String = c.store.conn().query_row("SELECT name FROM materials WHERE last_source_item_id = ?", [&named], |row| row.get(0)).unwrap();
    assert_eq!(name, "架空型式なし");
}

#[test]
fn missing_lists_only_active_materials_no_row_points_to_even_after_resume_hides_applied_rows() {
    let c = setup();
    let same = c.stage(&[(9, "架空部品", "001-A"), (12, "消失候補", "002-B")]).unwrap();
    assert!(same.missing_ids.is_empty());
    c.apply(&same, &choices(&same, |id| json!({ "itemId": id, "action": "hold" })), &[]).unwrap();
    // 型式だけ変えた行は品名とメーカーで候補になる。行のない材料だけが見当たらない。
    let r = c.stage(&[(2, "架空部品", "001-Z"), (4, "架空追加", "003-C")]).unwrap();
    let id = |name: &str| r.materials.iter().find(|m| m.values.name == name).map(|m| m.id.clone()).expect(name);
    let (kept, gone) = (id("架空部品"), id("消失候補"));
    assert_eq!(r.missing_ids, vec![gone.clone()]);
    let changed = r.rows.iter().find(|row| row.source.values[0] == "架空部品").map(|row| row.source.id.clone()).expect("changed");
    let hold_all = |rows: &[reimport::ReimportRow]| -> Vec<Value> { rows.iter().map(|row| json!({ "itemId": row.source.id, "action": "hold" })).collect() };
    let mut first = hold_all(&r.rows);
    for choice in &mut first { if choice["itemId"] == changed.as_str() { *choice = map(&changed, &kept, &["model"]); } }
    let done = c.apply(&r, &first, &[]).unwrap();
    // 再確認では反映済みの行が一覧から外れるが、その行に対応した材料は見当たらない扱いにしない。
    let resumed = reimport::resume(&c.store, &done.batch.id).unwrap();
    assert!(resumed.rows.iter().all(|row| row.source.id != changed));
    assert_eq!(resumed.missing_ids, vec![gone.clone()]);
    // 無効にした材料は対象外。
    let done = c.apply(&resumed, &hold_all(&resumed.rows), std::slice::from_ref(&gone)).unwrap();
    assert!(reimport::resume(&c.store, &done.batch.id).unwrap().missing_ids.is_empty());
}

#[test]
fn resume_blocked_tells_why_a_closed_record_cannot_be_reviewed_again() {
    let c = setup();
    let r = c.stage(&[(2, "架空部品", "001-Z")]).unwrap();
    assert_eq!(r.resume_blocked, None);
    assert_eq!(reimport::cancel(&c.store, &r.batch.id).unwrap().resume_blocked, None);
    // 同じファイルを選び直すと取消の記録が開き、最初から確認し直せる。
    let again = c.stage(&[(2, "架空部品", "001-Z")]).unwrap();
    assert_eq!((again.batch.id.as_str(), again.batch.status.as_str(), again.resume_blocked.as_deref()), (r.batch.id.as_str(), "cancelled", None));
    // 後から別のExcelを確定すると、取消の記録からは再確認できない（resume と同じ理由）。
    let later = c.stage(&[(2, "架空部品", "001-Y")]).unwrap();
    c.apply(&later, &choices(&later, |id| json!({ "itemId": id, "action": "hold" })), &[]).unwrap();
    assert_eq!(reimport::review(&c.store, &later.batch.id).unwrap().resume_blocked, None);
    let blocked = reimport::review(&c.store, &r.batch.id).unwrap().resume_blocked.expect("blocked");
    assert!(blocked.contains("後続のExcelが確定済み"));
    assert_throws(reimport::resume(&c.store, &r.batch.id), &blocked);
}

#[test]
fn reimport_creating_a_category_beyond_256_keeps_material_forms_and_search_working() {
    let c = setup();
    seed_categories(&c.store, 256);
    assert_eq!(count(&c.store, "categories"), 257);
    // シート名を変えたExcelの行を新規材料として反映すると、シート名のカテゴリが258件目として作られる。
    let mut parts = workbook_parts(&format!(r#"<row r="2">{}{}{}</row>"#, text_cell("A2", "架空追加部品"), text_cell("B2", "009-Z"), text_cell("D2", "02 本")), &[]);
    let renamed = parts["xl/workbook.xml"].replace("架空材料", "架空追加シート");
    parts.insert("xl/workbook.xml".into(), renamed);
    let bytes = zip_parts(&parts, false);
    let r = reimport::stage(&c.store, &c.series, &parse_workbook(&bytes).unwrap(), "架空追加.xlsx", &js::sha256_hex(&bytes)).unwrap();
    c.apply(&r, &choices(&r, new), &[]).unwrap();
    assert_eq!(count(&c.store, "categories"), 258);
    let found = search::search(&c.store, &json!({ "query": "架空追加部品", "categoryId": null, "includeInactive": false, "offset": 0 })).unwrap();
    assert_eq!((found.total, found.rows[0].category_name.as_str()), (1, "架空追加シート"));
    let mut api = MasterService::default();
    assert!(api.get(&c.store, None).unwrap().create_request_id.is_some());
    assert_eq!(api.get(&c.store, Some(&found.rows[0].id)).unwrap().material.expect("material").category_name, "架空追加シート");
}

// ---- 材料の削除との組合せ（旧実装にはない機能） ----

#[test]
fn deleted_materials_leave_the_review_and_rows_added_again_reuse_their_category() {
    let c = setup();
    let old = reimport::current_materials(&c.store, &c.series).unwrap();
    let category = old[0].category_id.clone();
    assert!(old.iter().all(|m| m.category_id == category));
    let decisions = count(&c.store, "import_decisions");
    // シートの材料をすべて削除する（取込の判断履歴はそのまま）。
    assert_eq!(pom_core::materials::delete(&c.store, &old.iter().map(|m| m.id.clone()).collect::<Vec<_>>()).unwrap(), 2);
    assert_eq!(count(&c.store, "import_decisions"), decisions);
    assert!(reimport::current_materials(&c.store, &c.series).unwrap().is_empty());
    // 同じ内容の行でも（初回取込と同じファイルにならないよう行の位置だけ変える）、削除した材料は候補・Excelに見当たらない材料に出ず、行は対応なし（既定は保留）。
    let r = c.stage(&[(9, "架空部品", "001-A"), (12, "消失候補", "002-B")]).unwrap();
    assert!(r.materials.is_empty());
    assert!(r.missing_ids.is_empty());
    let candidates: Vec<_> = r.rows.iter().filter(|row| row.source.classification == "candidate").collect();
    assert_eq!(candidates.len(), 2);
    assert!(candidates.iter().all(|row| row.comparison == "unmatched" && row.suggested_ids.is_empty()));
    // 削除した材料へは対応させられず、無効化の対象にもならない。
    let first = candidates[0].source.id.clone();
    assert_throws(c.apply(&r, &choices(&r, |id| if id == first { map(id, &old[0].id, &MATERIAL_FIELDS) } else { json!({ "itemId": id, "action": "hold" }) }), &[]), "対応する材料");
    assert_throws(c.apply(&r, &choices(&r, |id| json!({ "itemId": id, "action": "hold" })), std::slice::from_ref(&old[0].id)), "無効化対象");
    // 新規材料として追加し直すと、同じシートの削除した材料のカテゴリへ入る（同じ名前のカテゴリを増やさない）。
    let categories = count(&c.store, "categories");
    let done = c.apply(&r, &choices(&r, new), &[]).unwrap();
    assert_eq!(count(&c.store, "categories"), categories);
    assert_eq!(done.materials.len(), 2);
    assert!(done.materials.iter().all(|m| m.category_id == category && !old.iter().any(|o| o.id == m.id)));
    let found = search::search(&c.store, &json!({ "query": "", "categoryId": category, "includeInactive": true, "offset": 0 })).unwrap();
    assert_eq!(found.total, 2);
}

#[test]
fn deleting_a_material_makes_a_pending_review_stale_and_the_refreshed_review_leaves_it_out() {
    let c = setup();
    let r = c.stage(&[(2, "架空部品", "001-B"), (3, "消失候補", "002-B")]).unwrap();
    assert!(!r.stale);
    let gone = r.materials.iter().find(|m| m.values.name == "架空部品").expect("material").id.clone();
    pom_core::materials::delete(&c.store, std::slice::from_ref(&gone)).unwrap();
    assert!(reimport::review(&c.store, &r.batch.id).unwrap().stale);
    let before = c.snapshot();
    assert_throws(c.apply(&r, &choices(&r, |id| json!({ "itemId": id, "action": "hold" })), &[]), "変更");
    assert_eq!(c.snapshot(), before);
    let refreshed = reimport::resume(&c.store, &r.batch.id).unwrap();
    assert!(!refreshed.stale);
    assert!(refreshed.materials.iter().all(|m| m.id != gone));
    assert!(refreshed.rows.iter().all(|row| !row.suggested_ids.contains(&gone)));
}
