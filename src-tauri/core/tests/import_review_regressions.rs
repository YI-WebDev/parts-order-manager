//! tests/unit/import-review-regressions.test.ts の移植（初回取込の確認・再開・容量上限の回帰）。

mod import_support;

use import_support::{assert_throws, count, escape_xml, open, reopen, synthetic_workbook, temp_root, text_cell, thrown, workbook_parts, zip_parts, NS};
use pom_core::db::{Store, Tx};
use pom_core::error::{Error, ImportCode};
use pom_core::imports::repository::{self, ImportReview};
use pom_core::imports::workbook::parse_workbook;
use pom_core::imports::{Budget, OriginalCell, ParsedItem, ParsedWorkbook};
use pom_core::js;
use rusqlite::params;
use serde_json::{json, Value};

const TABLES: [&str; 5] = ["import_batches", "import_items", "import_decisions", "categories", "materials"];

fn snapshot(store: &Store) -> Vec<Vec<Vec<rusqlite::types::Value>>> { import_support::snapshot(store, &TABLES) }

fn styles(code: &str) -> String {
    format!(r#"<styleSheet xmlns="{NS}"><numFmts><numFmt numFmtId="164" formatCode="{}"/></numFmts><cellXfs><xf numFmtId="0"/><xf numFmtId="164"/></cellXfs></styleSheet>"#, escape_xml(code))
}

fn stage(store: &Store, hash: &str) -> ImportReview {
    repository::stage(store, &parse_workbook(&synthetic_workbook()).unwrap(), &format!("架空{hash}.xlsx"), &hash.repeat(64)).unwrap()
}

fn candidate_ids(review: &ImportReview) -> Vec<String> {
    review.items.iter().filter(|item| item.classification == "candidate").map(|item| item.id.clone()).collect()
}

fn apply_input(batch_id: &str, accepted_ids: &[String]) -> Value { json!({ "batchId": batch_id, "acceptedIds": accepted_ids }) }

/// `rejects.toMatchObject({ code })`
#[track_caller]
fn assert_code<T>(result: pom_core::Result<T>, code: ImportCode) {
    match thrown(result) { Error::Import(found, _) => assert_eq!(found, code), other => panic!("expected ImportError {code:?}, got {other}") }
}

fn row_two(rows: &str) -> String { format!(r#"<row r="2">{}{}{rows}</row>"#, text_cell("A2", "架空"), text_cell("B2", "型")) }

fn first_row(parsed: &ParsedWorkbook, row_index: i64) -> &ParsedItem { parsed.items.iter().find(|item| item.row_index == row_index).expect("row") }

fn r1_keeps_old_source_read_only_after_another_series_commits_and_restart(status: &str) {
    let directory = temp_root("step05-review-");
    let store = open(directory.path());
    let a = stage(&store, "a");
    if status == "cancelled" { repository::cancel(&store, &a.batch.id).unwrap(); } else {
        store.conn().execute_batch("CREATE TRIGGER fail_material BEFORE INSERT ON materials BEGIN SELECT RAISE(ABORT,'fixture'); END;").unwrap();
        thrown(repository::apply(&store, &apply_input(&a.batch.id, &candidate_ids(&a))));
        store.conn().execute_batch("DROP TRIGGER fail_material").unwrap();
    }
    let b = stage(&store, "b");
    repository::apply(&store, &apply_input(&b.batch.id, &candidate_ids(&b))).unwrap();
    let store = reopen(store, directory.path());
    let before = snapshot(&store);
    assert_throws(repository::resume(&store, &a.batch.id), "別の取込");
    assert_eq!(repository::review(&store, &a.batch.id).unwrap().batch.status, status);
    assert_eq!(snapshot(&store), before);
}

#[test]
fn r1_keeps_old_cancelled_source_read_only_after_another_series_commits_and_restart() { r1_keeps_old_source_read_only_after_another_series_commits_and_restart("cancelled"); }

#[test]
fn r1_keeps_old_failed_source_read_only_after_another_series_commits_and_restart() { r1_keeps_old_source_read_only_after_another_series_commits_and_restart("failed"); }

#[test]
fn r1_rejects_a_legacy_preview_at_apply_without_changing_its_status_or_raw_records() {
    let directory = temp_root("step05-review-");
    let store = open(directory.path());
    let a = stage(&store, "a");
    repository::cancel(&store, &a.batch.id).unwrap();
    let b = stage(&store, "b");
    repository::apply(&store, &apply_input(&b.batch.id, &[])).unwrap();
    store.conn().execute("UPDATE import_batches SET status='preview' WHERE id=?", [&a.batch.id]).unwrap();
    let before = snapshot(&store);
    assert_throws(repository::apply(&store, &apply_input(&a.batch.id, &candidate_ids(&a))), "別の取込");
    assert_eq!(snapshot(&store), before);
}

#[test]
fn r2_refuses_a_different_preview_instead_of_returning_its_confirmation() {
    let directory = temp_root("step05-review-");
    let store = open(directory.path());
    let a = stage(&store, "a");
    repository::cancel(&store, &a.batch.id).unwrap();
    let b = stage(&store, "b");
    let before = snapshot(&store);
    assert_throws(repository::resume(&store, &a.batch.id), "別の取込");
    assert_eq!(snapshot(&store), before);
    assert_eq!(repository::review(&store, &b.batch.id).unwrap().batch.status, "preview");
}

#[test]
fn r2_reuses_only_the_matching_same_source_pending_resolution() {
    let directory = temp_root("step05-review-");
    let store = open(directory.path());
    let a = stage(&store, "a");
    repository::cancel(&store, &a.batch.id).unwrap();
    let first = repository::resume(&store, &a.batch.id).unwrap();
    assert_eq!(repository::resume(&store, &a.batch.id).unwrap(), first);
    let candidate = first.items.iter().find(|item| item.classification == "candidate").expect("Missing candidate");
    repository::apply(&store, &apply_input(&first.batch.id, std::slice::from_ref(&candidate.id))).unwrap();
    let remaining = repository::resume(&store, &first.batch.id).unwrap();
    assert_eq!(remaining.items.iter().filter(|item| item.classification == "candidate").count(), 3);
}

#[test]
fn r3_holds_unsupported_text_format_while_retaining_originals() {
    for kind in ["s", "inlineStr", "str"] {
        let code = r#"0;0;0;"QTY "@"#;
        let value = match kind { "s" => "<v>0</v>", "inlineStr" => "<is><t>02</t></is>", _ => "<v>02</v>" };
        let shared = format!(r#"<sst xmlns="{NS}"><si><t>02</t></si></sst>"#);
        let rows = row_two(&format!(r#"<c r="D2" t="{kind}" s="1">{value}</c>"#));
        let parsed = parse_workbook(&zip_parts(&workbook_parts(&rows, &[("xl/styles.xml", &styles(code)), ("xl/sharedStrings.xml", &shared)]), false)).unwrap();
        let row = first_row(&parsed, 2);
        assert_eq!(row.classification, "held", "{kind}");
        let d = row.raw_cells.get("D").expect("D");
        assert_eq!((d.raw_value.as_deref(), d.display_text.as_str(), d.format_code.as_deref(), d.display_verified), (Some("02"), "02", Some(code), false), "{kind}");
    }
}

#[test]
fn r4_rejects_unsupported_formula_metadata_before_storing() {
    for attrs in [r#"t="shared" si="0" ref="D2:D3""#, r#"t="shared" si="0""#, r#"t="array" ref="D2:D3""#] {
        let directory = temp_root("step05-review-");
        let store = open(directory.path());
        let before = snapshot(&store);
        let bytes = zip_parts(&workbook_parts(&row_two(&format!(r#"<c r="D2"><f {attrs}>1+1</f><v>2</v></c>"#)), &[]), false);
        assert_code(parse_workbook(&bytes).and_then(|parsed| repository::stage(&store, &parsed, "架空.xlsx", &"a".repeat(64))), ImportCode::Format);
        assert_eq!(snapshot(&store), before, "{attrs}");
    }
}

#[test]
fn r4_treats_a_plain_formula_saved_with_libreoffice_recalculation_flags_as_a_held_formula() {
    for attrs in [r#"aca="false""#, r#"aca="0" ca="1""#, r#"ca="true""#] {
        let parsed = parse_workbook(&zip_parts(&workbook_parts(&row_two(&format!(r#"<c r="D2" t="n"><f {attrs}>1+1</f><v>2</v></c>"#)), &[]), false)).unwrap();
        let row = first_row(&parsed, 2);
        assert_eq!(row.classification, "held", "{attrs}");
        let d = row.raw_cells.get("D").expect("D");
        assert_eq!((d.kind.as_str(), d.formula.as_deref(), d.raw_value.as_deref(), d.display_verified), ("formula", Some("1+1"), Some("2"), false), "{attrs}");
    }
}

#[test]
fn r4_still_rejects_other_formula_metadata_next_to_recalculation_flags() {
    for attrs in [r#"aca="false" t="shared" si="0""#, r#"aca="maybe""#, r#"r1="A1""#] {
        let bytes = zip_parts(&workbook_parts(&row_two(&format!(r#"<c r="D2"><f {attrs}>1+1</f><v>2</v></c>"#)), &[]), false);
        assert_code(parse_workbook(&bytes), ImportCode::Format);
    }
}

#[test]
fn r4_retains_the_cached_source_type_on_supported_plain_formulas() {
    let parsed = parse_workbook(&zip_parts(&workbook_parts(&row_two(r#"<c r="D2" t="str"><f>"02"</f><v>02</v></c>"#), &[]), false)).unwrap();
    let d = first_row(&parsed, 2).raw_cells.get("D").expect("D");
    assert_eq!((d.formula.as_deref(), d.formula_cached_type.as_deref(), d.raw_value.as_deref(), d.display_verified), (Some(r#""02""#), Some("str"), Some("02"), false));
}

#[test]
fn r5_rejects_an_oversized_reused_format_before_any_batch_is_stored() {
    let directory = temp_root("step05-review-");
    let store = open(directory.path());
    let before = snapshot(&store);
    let big = styles(&"X".repeat(1024 * 1024));
    let bytes = zip_parts(&workbook_parts(&row_two(""), &[("xl/styles.xml", &big)]), true);
    assert_code(parse_workbook(&bytes).and_then(|parsed| repository::stage(&store, &parsed, "架空.xlsx", &"a".repeat(64))), ImportCode::Limit);
    assert_eq!(snapshot(&store), before);
}

#[test]
fn r5_bounds_expanded_repeated_shared_strings_including_escaped_utf8_content() {
    let directory = temp_root("step05-review-");
    let store = open(directory.path());
    let before = snapshot(&store);
    let value = "部\n\"".repeat(2000);
    let rows: String = (0..180).map(|i| {
        let cells: String = ["A", "B", "C", "D", "E", "F"].iter().map(|c| format!(r#"<c r="{c}{}" t="s"><v>0</v></c>"#, i + 2)).collect();
        format!(r#"<row r="{}">{cells}</row>"#, i + 2)
    }).collect();
    let shared = format!(r#"<sst xmlns="{NS}"><si><t>{}</t></si></sst>"#, escape_xml(&value));
    let bytes = zip_parts(&workbook_parts(&rows, &[("xl/sharedStrings.xml", &shared)]), true);
    assert!(bytes.len() < 20_000, "{}", bytes.len());
    assert_code(parse_workbook(&bytes).and_then(|parsed| repository::stage(&store, &parsed, "架空.xlsx", &"a".repeat(64))), ImportCode::Limit);
    assert_eq!(snapshot(&store), before);
}

#[test]
fn r5_enforces_the_storage_budget_again_before_stage_transaction() {
    let directory = temp_root("step05-review-");
    let store = open(directory.path());
    let parsed = parse_workbook(&zip_parts(&workbook_parts(&format!(r#"<row r="2">{}{}</row>"#, text_cell("A2", &"架空".repeat(4000)), text_cell("B2", "型")), &[]), false)).unwrap();
    let row = first_row(&parsed, 2);
    let before = snapshot(&store);
    let items = (0..300).map(|i| ParsedItem { row_index: i + 2, ..row.clone() }).collect();
    assert_throws(repository::stage(&store, &ParsedWorkbook { items, counts: parsed.counts.clone() }, "架空.xlsx", &"a".repeat(64)), "データ量");
    assert_eq!(snapshot(&store), before);
}

#[test]
fn r5_charges_repeated_empty_runs_rather_than_counting_only_their_joined_text() {
    let mut budget = Budget::default();
    let empty_runs = vec![""; 20_000];
    let result = (|| -> pom_core::Result<()> { for _ in 0..300 { budget.add(&json!({ "richText": empty_runs }))?; } Ok(()) })();
    assert_throws(result, "データ量");
}

#[test]
fn r5_refuses_oversized_legacy_raw_records_before_review_resume_cancel_or_apply_mutations() {
    let directory = temp_root("step05-review-");
    let store = open(directory.path());
    let initial = stage(&store, "a");
    store.conn().execute(
        "INSERT INTO import_items (id,batch_id,kind,sheet_name,sheet_order,row_index,block,cell_address,raw_cells,classification,fingerprint)
    VALUES (?,?,'row','架空',1,99,'left',NULL,?,'held','fixture')",
        params!["00000000-0000-4000-8000-000000000001", initial.batch.id, js::stringify(&json!({ "A": { "rawValue": "x".repeat(16 * 1024 * 1024) } }))],
    ).unwrap();
    let measure = || store.conn().query_row("SELECT count(*), sum(length(CAST(raw_cells AS BLOB))) FROM import_items", [], |row| Ok((row.get::<_, i64>(0)?, row.get::<_, i64>(1)?))).unwrap();
    let before = measure();
    let id = &initial.batch.id;
    assert_throws(repository::review(&store, id), "読取上限");
    assert_throws(repository::resume(&store, id), "読取上限");
    assert_throws(repository::cancel(&store, id), "読取上限");
    assert_throws(repository::apply(&store, &apply_input(id, &[])), "読取上限");
    assert_eq!(measure(), before);
    assert_eq!(store.conn().query_row("SELECT status FROM import_batches WHERE id=?", [id], |row| row.get::<_, String>(0)).unwrap(), "preview");
    assert_eq!(count(&store, "materials"), 0);
}

#[test]
fn r3_rechecks_legacy_text_candidates_on_review_same_hash_selection_and_resolution_without_rewriting_raw_records() {
    let directory = temp_root("step05-review-");
    let store = open(directory.path());
    let parsed = parse_workbook(&synthetic_workbook()).unwrap();
    let legacy_cell = OriginalCell {
        presence: "present".into(), kind: "text".into(), raw_value: Some("02".into()), display_text: "02".into(), format_code: Some(r#"0;0;0;"QTY "@"#.into()), display_verified: true,
        rich_text: None, phonetic: None, formula: None, formula_cached_type: None,
    };
    let legacy = ParsedWorkbook {
        items: parsed.items.iter().map(|item| {
            let mut item = item.clone();
            if item.row_index == 2 && item.block == "left" { item.raw_cells.insert("D".into(), legacy_cell.clone()); }
            item
        }).collect(),
        counts: parsed.counts.clone(),
    };
    let first = repository::stage(&store, &legacy, "旧確認.xlsx", &"a".repeat(64)).unwrap();
    let raw_rows = || -> Vec<(String, String, String)> {
        let mut statement = store.conn().prepare("SELECT id, raw_cells, classification FROM import_items ORDER BY id").unwrap();
        statement.query_map([], |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?))).unwrap().collect::<Result<_, _>>().unwrap()
    };
    let raw = raw_rows();
    let held = first.items.iter().find(|item| item.row_index == 2 && item.block == "left").expect("Missing row");
    assert_eq!(held.classification, "held");
    assert!(!held.cells.iter().find(|cell| cell.column == "D").expect("D").display_verified);
    assert_eq!((first.batch.counts.candidates, first.batch.counts.held), (3, 2));
    let reselected = repository::stage(&store, &parsed, "再選択.xlsx", &"a".repeat(64)).unwrap();
    assert_eq!(reselected.items.iter().find(|item| item.id == held.id).expect("held").classification, "held");
    repository::cancel(&store, &first.batch.id).unwrap();
    let resolution = repository::resume(&store, &first.batch.id).unwrap();
    assert_eq!((resolution.batch.counts.candidates, resolution.batch.counts.held), (3, 2));
    assert_eq!(resolution.items.iter().find(|item| item.id == held.id).expect("held").classification, "held");
    // 要確認の行は材料候補の一括選択に入らない（明示して選んだときだけ採用する）。
    repository::apply(&store, &apply_input(&resolution.batch.id, &candidate_ids(&resolution))).unwrap();
    assert_eq!(raw_rows(), raw);
    assert_eq!(count(&store, "materials"), 3);
    assert!(!repository::review(&store, &resolution.batch.id).unwrap().items.iter().find(|item| item.id == held.id).expect("held").applied);
}

#[test]
fn r5_stops_expanded_legacy_responses_even_when_stored_json_is_below_the_read_limit() {
    let directory = temp_root("step05-review-");
    let store = open(directory.path());
    let first = stage(&store, "a");
    let text = "x".repeat(9000);
    let mut cells = serde_json::Map::new();
    for column in ["A", "B", "C", "D", "E", "F"] {
        cells.insert(column.into(), json!({ "presence": "present", "kind": "text", "rawValue": text, "displayText": text, "formatCode": "General", "displayVerified": true }));
    }
    let raw = js::stringify(&cells);
    store.transaction(Tx::Deferred, || {
        for i in 0..110 {
            store.conn().execute(
                "INSERT INTO import_items (id,batch_id,kind,sheet_name,sheet_order,row_index,block,cell_address,raw_cells,classification,fingerprint) VALUES (?,?,'row','架空',1,?,'left',NULL,?,'held','fixture')",
                params![js::random_uuid(), first.batch.id, i + 100, raw],
            )?;
        }
        Ok(())
    }).unwrap();
    let bytes: i64 = store.conn().query_row("SELECT sum(length(CAST(raw_cells AS BLOB))) FROM import_items", [], |row| row.get(0)).unwrap();
    assert!(bytes < 16 * 1024 * 1024, "{bytes}");
    let id = &first.batch.id;
    assert_throws(repository::review(&store, id), "保存・確認データ量");
    assert_throws(repository::resume(&store, id), "保存・確認データ量");
    assert_throws(repository::cancel(&store, id), "保存・確認データ量");
    assert_throws(repository::apply(&store, &apply_input(id, &[])), "保存・確認データ量");
    assert_eq!(count(&store, "import_batches"), 1);
    assert_eq!(store.conn().query_row("SELECT status FROM import_batches WHERE id=?", [id], |row| row.get::<_, String>(0)).unwrap(), "preview");
    assert_eq!(count(&store, "materials"), 0);
}
