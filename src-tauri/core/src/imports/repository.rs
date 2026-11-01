//! 取込記録（原記録・判断履歴）の保存と初回取込の確定（src/main/imports/repository.ts）。

use std::collections::HashSet;

use indexmap::IndexMap;
use rusqlite::{params, params_from_iter, Row};
use serde::Serialize;
use serde_json::{json, Map, Value};

use super::cells::text_format_supported;
use super::workbook::cell_value;
use super::{import_error, limits, Budget, ImportCounts, ParsedItem, ParsedWorkbook, RawCells, IMPORT_RULE};
use crate::db::{optional, Store, Tx};
use crate::error::{Error, ImportCode, Result};
use crate::js;
use crate::materials::{self, MaterialValues, MATERIAL_FIELDS};
use crate::validate;

pub const LEFT: [&str; 6] = ["A", "B", "C", "D", "E", "F"];
pub const RIGHT: [&str; 6] = ["H", "I", "J", "K", "L", "M"];

/// import_batches の行。
#[derive(Debug, Clone, PartialEq)]
pub struct Batch {
    pub id: String, pub source_series_id: String, pub previous_batch_id: Option<String>, pub kind: String, pub file_sha256: String, pub display_name: String,
    pub rule_version: String, pub status: String, pub target_item_ids: Vec<Value>, pub counts: Map<String, Value>, pub target_revisions: Map<String, Value>, pub created_at: String,
}

pub const BATCH_COLUMNS: &str = "id, source_series_id, previous_batch_id, kind, file_sha256, display_name, rule_version, status, target_item_ids, counts, target_revisions, created_at";

fn json_column<T: serde::de::DeserializeOwned>(row: &Row, index: usize) -> rusqlite::Result<T> {
    let text: String = row.get(index)?;
    serde_json::from_str(&text).map_err(|error| rusqlite::Error::FromSqlConversionFailure(index, rusqlite::types::Type::Text, Box::new(error)))
}

pub fn batch_row(row: &Row) -> rusqlite::Result<Batch> {
    Ok(Batch {
        id: row.get(0)?, source_series_id: row.get(1)?, previous_batch_id: row.get(2)?, kind: row.get(3)?, file_sha256: row.get(4)?, display_name: row.get(5)?,
        rule_version: row.get(6)?, status: row.get(7)?, target_item_ids: json_column(row, 8)?, counts: json_column(row, 9)?, target_revisions: json_column(row, 10)?, created_at: row.get(11)?,
    })
}

/// import_items の行。
#[derive(Debug, Clone, PartialEq)]
pub struct Item {
    pub id: String, pub batch_id: String, pub kind: String, pub sheet_name: String, pub sheet_order: i64, pub row_index: i64, pub block: String,
    pub cell_address: Option<String>, pub raw_cells: RawCells, pub classification: String, pub fingerprint: String,
}

pub const ITEM_COLUMNS: &str = "id, batch_id, kind, sheet_name, sheet_order, row_index, block, cell_address, raw_cells, classification, fingerprint";

pub fn item_row(row: &Row) -> rusqlite::Result<Item> {
    Ok(Item {
        id: row.get(0)?, batch_id: row.get(1)?, kind: row.get(2)?, sheet_name: row.get(3)?, sheet_order: row.get(4)?, row_index: row.get(5)?, block: row.get(6)?,
        cell_address: row.get(7)?, raw_cells: json_column(row, 8)?, classification: row.get(9)?, fingerprint: row.get(10)?,
    })
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RowCell { pub column: String, pub raw_value: Option<String>, pub display_text: String, pub format_code: Option<String>, pub kind: String, pub presence: String, pub display_verified: bool }

/// 画面に出す原記録の行（ImportRow）。
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ImportRow {
    pub id: String, pub sheet_name: String, pub sheet_order: i64, pub row_index: i64, pub block: String, pub classification: String, pub reason: String,
    pub values: Vec<String>, pub applied: bool, pub cells: Vec<RowCell>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ImportSummary { pub id: String, pub display_name: String, pub created_at: String, pub status: String, pub counts: ImportCounts }

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ImportReview {
    pub batch: ImportSummary, pub items: Vec<ImportRow>,
    /// 確認中でない記録から再確認（resume）できない理由。確認中の記録と、再確認できる記録は None。
    pub resume_blocked: Option<String>,
}

/// rowView に必要な原記録の項目。
pub struct RowSource<'a> { pub id: &'a str, pub kind: &'a str, pub sheet_name: &'a str, pub sheet_order: i64, pub row_index: i64, pub block: &'a str, pub cell_address: Option<&'a str>, pub raw_cells: &'a RawCells, pub classification: &'a str }

impl<'a> From<&'a Item> for RowSource<'a> {
    fn from(item: &'a Item) -> Self {
        RowSource { id: &item.id, kind: &item.kind, sheet_name: &item.sheet_name, sheet_order: item.sheet_order, row_index: item.row_index, block: &item.block, cell_address: item.cell_address.as_deref(), raw_cells: &item.raw_cells, classification: &item.classification }
    }
}

fn parse_classification(value: &str) -> Result<&str> {
    match value { "candidate" | "held" | "supplement" | "header" => Ok(value), _ => Err(Error::invalid("classification")) }
}

/// 表示形式を確認できない文字列セルを含む材料候補は保留にする（classificationFor）。
pub fn classification_for(classification: &str, raw_cells: &RawCells) -> Result<String> {
    let original = parse_classification(classification)?;
    Ok(if original == "candidate" && raw_cells.values().any(|cell| cell.kind == "text" && !text_format_supported(cell.format_code.as_deref())) { "held".into() } else { original.into() })
}

pub fn row_columns<'a>(kind: &str, block: &str, raw_cells: &'a RawCells) -> Vec<String> {
    if kind == "supplement" { raw_cells.keys().cloned().collect() } else if block == "left" { LEFT.map(String::from).to_vec() } else { RIGHT.map(String::from).to_vec() }
}

pub fn row_view(item: &RowSource, applied: &HashSet<String>) -> Result<ImportRow> {
    let is_applied = applied.contains(item.id);
    let classification = if is_applied { parse_classification(item.classification)?.to_string() } else { classification_for(item.classification, item.raw_cells)? };
    let columns = row_columns(item.kind, item.block, item.raw_cells);
    let reason = match classification.as_str() { "held" => "品名・形式・表示形式等を要確認。今回は保留します。", "supplement" => "関連先が未確定の補足セル", "header" => "列見出しとして除外", _ => "材料候補" };
    Ok(ImportRow {
        id: item.id.to_string(), sheet_name: item.sheet_name.to_string(), sheet_order: item.sheet_order, row_index: item.row_index,
        block: item.cell_address.unwrap_or(item.block).to_string(), classification, reason: reason.into(),
        values: columns.iter().map(|column| item.raw_cells.get(column).map(cell_value).unwrap_or_default()).collect(),
        applied: is_applied,
        cells: columns.iter().filter_map(|column| item.raw_cells.get(column).map(|cell| RowCell {
            column: column.clone(), raw_value: cell.raw_value.clone(), display_text: cell.display_text.clone(), format_code: cell.format_code.clone(), kind: cell.kind.clone(), presence: cell.presence.clone(),
            display_verified: cell.display_verified && (cell.kind != "text" || text_format_supported(cell.format_code.as_deref())),
        })).collect(),
    })
}

/// 初回取込の確認で採用できる項目か。材料候補に加え、要確認行・列見出しの行も、品名があれば確認のうえで採用できる。
/// 補足セル（材料の項目に対応しない単独のセル）と品名のない行は採用しない（手動追加と同じく品名を必須にする）。
pub fn adoptable(item: &Item) -> bool {
    if item.kind != "row" { return false; }
    let columns = if item.block == "left" { LEFT } else { RIGHT };
    !js::trim(item.raw_cells.get(columns[0]).map(|cell| cell.display_text.as_str()).unwrap_or("")).is_empty()
}

/// 原記録から読んだ材料の6項目（incomingValues）。
pub fn incoming_values(item: &Item) -> Result<MaterialValues> {
    Ok(MaterialValues::from_slice(&row_view(&item.into(), &HashSet::new())?.values))
}

fn counts_strict(counts: &Map<String, Value>) -> Result<ImportCounts> {
    const KEYS: [&str; 6] = ["candidates", "held", "supplements", "excluded", "empty", "applied"];
    if counts.keys().any(|k| !KEYS.contains(&k.as_str())) { return Err(Error::invalid("counts keys")); }
    let get = |key: &str| counts.get(key).and_then(js::safe_int).filter(|v| *v >= 0).ok_or_else(|| Error::invalid("counts value"));
    Ok(ImportCounts { candidates: get("candidates")?, held: get("held")?, supplements: get("supplements")?, excluded: get("excluded")?, empty: get("empty")?, applied: get("applied")? })
}

pub fn summary(batch: &Batch) -> Result<ImportSummary> {
    Ok(ImportSummary { id: batch.id.clone(), display_name: batch.display_name.clone(), created_at: batch.created_at.clone(), status: batch.status.clone(), counts: counts_strict(&batch.counts)? })
}

pub fn counts_json(counts: &ImportCounts) -> Map<String, Value> {
    let Value::Object(map) = json!({ "candidates": counts.candidates, "held": counts.held, "supplements": counts.supplements, "excluded": counts.excluded, "empty": counts.empty, "applied": counts.applied }) else { unreachable!() };
    map
}

pub fn select_batches(store: &Store, filter: &str, values: &[&dyn rusqlite::ToSql]) -> Result<Vec<Batch>> {
    let mut statement = store.conn().prepare(&format!("SELECT {BATCH_COLUMNS} FROM import_batches {filter}"))?;
    Ok(statement.query_map(values, batch_row)?.collect::<std::result::Result<_, _>>()?)
}

pub fn insert_batch(store: &Store, batch: &Batch) -> Result<()> {
    store.conn().execute(
        &format!("INSERT INTO import_batches ({BATCH_COLUMNS}) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)"),
        params![batch.id, batch.source_series_id, batch.previous_batch_id, batch.kind, batch.file_sha256, batch.display_name, batch.rule_version, batch.status, js::stringify(&batch.target_item_ids), js::stringify(&batch.counts), js::stringify(&batch.target_revisions), batch.created_at],
    )?;
    Ok(())
}

pub fn insert_item(store: &Store, id: &str, batch_id: &str, item: &ParsedItem) -> Result<()> {
    let raw = js::stringify(&item.raw_cells);
    store.conn().execute(
        &format!("INSERT INTO import_items ({ITEM_COLUMNS}) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)"),
        params![id, batch_id, item.kind, item.sheet_name, item.sheet_order, item.row_index, item.block, item.cell_address, raw, item.classification, js::sha256_hex(&raw)],
    )?;
    Ok(())
}

pub fn set_batch_status(store: &Store, id: &str, status: &str) -> Result<()> {
    store.conn().execute("UPDATE import_batches SET status = ? WHERE id = ?", params![status, id])?;
    Ok(())
}

pub fn insert_decision(store: &Store, item_id: &str, material_id: Option<&str>, decision: &str, selected_fields: &[&str], reason: &str, created_at: &str, applied_batch_id: &str) -> Result<()> {
    store.conn().execute(
        "INSERT INTO import_decisions (id, item_id, material_id, decision, selected_fields, reason, created_at, applied_batch_id) VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
        params![js::random_uuid(), item_id, material_id, decision, js::stringify(selected_fields), reason, created_at, applied_batch_id],
    )?;
    Ok(())
}

/// 選択条件（SQL の WHERE 句とパラメーター）で原記録を読む。件数・容量の上限を先に確かめる。
pub fn read_items(store: &Store, filter: &str, values: &[String], limit_message: &str) -> Result<Vec<Item>> {
    let size: Option<(i64, i64)> = optional(store.conn().query_row(
        &format!("SELECT count(*), coalesce(sum(length(cast(raw_cells as blob)) + length(cast(sheet_name as blob)) + 1024), 0) FROM import_items WHERE {filter}"),
        params_from_iter(values.iter()), |row| Ok((row.get(0)?, row.get(1)?)),
    ))?;
    match size {
        Some((count, bytes)) if count <= limits::ITEMS as i64 && bytes <= limits::DATA_BYTES => {}
        _ => return Err(import_error(ImportCode::Limit, limit_message)),
    }
    let mut statement = store.conn().prepare(&format!("SELECT {ITEM_COLUMNS} FROM import_items WHERE {filter} ORDER BY sheet_order ASC, row_index ASC, block ASC"))?;
    Ok(statement.query_map(params_from_iter(values.iter()), item_row)?.collect::<std::result::Result<_, _>>()?)
}

/// drizzle の inArray（空の配列は常に偽）。
pub fn in_list(column: &str, count: usize) -> String { if count == 0 { "0".into() } else { format!("{column} IN ({})", vec!["?"; count].join(",")) } }

fn get_batch(store: &Store, input: &str) -> Result<Batch> {
    if !js::is_uuid(input) { return Err(Error::invalid("batchId")); }
    select_batches(store, "WHERE id = ? AND rule_version = ?", &[&input, &IMPORT_RULE])?.into_iter().next()
        .ok_or_else(|| import_error(ImportCode::Validation, "取込記録が見つかりません。"))
}

fn get_items(store: &Store, batch: &Batch) -> Result<Vec<Item>> {
    if batch.kind != "initial" && batch.target_item_ids.is_empty() { return Ok(Vec::new()); }
    let message = "保存済み取込のデータ量が読取上限を超えています。原記録は変更していません。";
    if batch.kind == "initial" { return read_items(store, "batch_id = ?", &[batch.id.clone()], message); }
    let ids = batch.target_item_ids.iter().map(validate::uuid).collect::<Result<Vec<_>>>()?;
    read_items(store, &in_list("id", ids.len()), &ids, message)
}

const NOTHING_PENDING: &str = "未反映の材料候補はありません。要確認行・補足セルは保留のまま残っています。";

/// この初回取込の原記録から追加反映できない理由（できるなら None）。
fn series_blocked(store: &Store, batch: &Batch) -> Result<Option<&'static str>> {
    let started: Option<String> = optional(store.conn().query_row("SELECT id FROM import_batches WHERE kind = 'reimport' AND status IN ('preview', 'applied')", [], |row| row.get(0)))?;
    if started.is_some() { return Ok(Some("更新取込が開始されています。古い初回取込からは追加反映できません。原記録は保持されています。")); }
    let committed = select_batches(store, "WHERE rule_version = ? AND status = 'applied'", &[&IMPORT_RULE])?;
    if committed.iter().any(|value| value.source_series_id != batch.source_series_id || value.file_sha256 != batch.file_sha256) {
        return Ok(Some("別の取込が確定済みです。この原記録は閲覧のみ可能です。"));
    }
    Ok(None)
}

fn assert_series(store: &Store, batch: &Batch) -> Result<()> {
    match series_blocked(store, batch)? { Some(reason) => Err(import_error(ImportCode::Conflict, reason)), None => Ok(()) }
}

/// 材料へ反映済み（new・apply）の原記録。
pub fn applied_items(store: &Store) -> Result<HashSet<String>> {
    let mut statement = store.conn().prepare("SELECT item_id FROM import_decisions WHERE decision IN ('new', 'apply')")?;
    Ok(statement.query_map([], |row| row.get(0))?.collect::<std::result::Result<_, _>>()?)
}

pub fn review(store: &Store, input: &str) -> Result<ImportReview> {
    let batch = get_batch(store, input)?;
    let applied = applied_items(store)?;
    let mut budget = Budget::response()?;
    let mut items = Vec::new();
    let raw = get_items(store, &batch)?;
    for item in &raw {
        let row = row_view(&item.into(), &applied)?;
        budget.add(&row)?;
        budget.add(",")?;
        items.push(row);
    }
    let mut info = summary(&batch)?;
    if batch.status != "applied" {
        info.counts.candidates = items.iter().filter(|item| item.classification == "candidate").count() as i64;
        info.counts.held = items.iter().filter(|item| item.classification == "held").count() as i64;
    }
    // resume と同じ条件（別の取込を確認中のときは、その場の状態なので含めない）。
    let resume_blocked = if batch.status == "preview" { None }
        else if let Some(reason) = series_blocked(store, &batch)? { Some(reason.to_string()) }
        else if !raw.iter().any(|item| !applied.contains(&item.id) && item.classification != "header" && adoptable(item)) { Some(NOTHING_PENDING.to_string()) }
        else { None };
    Ok(ImportReview { batch: info, items, resume_blocked })
}

pub fn list(store: &Store) -> Result<Vec<ImportSummary>> {
    select_batches(store, "WHERE rule_version = ? ORDER BY created_at DESC LIMIT 100", &[&IMPORT_RULE])?.iter().map(summary).collect()
}

pub fn stage(store: &Store, parsed: &ParsedWorkbook, display_name: &str, hash: &str) -> Result<ImportReview> {
    if js::cp_len(display_name) < 1 || js::cp_len(display_name) > 1000 { return Err(Error::invalid("displayName")); }
    if hash.len() != 64 || !hash.bytes().all(|b| b.is_ascii_digit() || (b'a'..=b'f').contains(&b)) { return Err(Error::invalid("hash")); }
    if let Some(existing) = select_batches(store, "WHERE kind = 'initial' AND file_sha256 = ? AND rule_version = ?", &[&hash, &IMPORT_RULE])?.into_iter().next() {
        return review(store, &existing.id);
    }
    let previous = select_batches(store, "WHERE rule_version = ?", &[&IMPORT_RULE])?;
    if previous.iter().any(|batch| batch.status == "applied") { return Err(import_error(ImportCode::Conflict, "確定済みのExcelと内容が異なります。変更したExcelは、取込の種類で「変更したExcelで更新」を選んで取り込んでください。")); }
    if previous.iter().any(|batch| batch.status == "preview") { return Err(import_error(ImportCode::Conflict, "確認中の取込があります。先に確認を続けるか取り消してください。")); }
    let (mut storage_budget, mut output_budget) = (Budget::response()?, Budget::response()?);
    if parsed.items.len() > limits::ITEMS { return Err(import_error(ImportCode::Limit, "取込項目数が上限を超えています。")); }
    let placeholder = "00000000-0000-4000-8000-000000000000";
    for item in &parsed.items {
        storage_budget.add(item)?;
        storage_budget.add_spaces(1024)?;
        let source = RowSource { id: placeholder, kind: &item.kind, sheet_name: &item.sheet_name, sheet_order: item.sheet_order, row_index: item.row_index, block: &item.block, cell_address: item.cell_address.as_deref(), raw_cells: &item.raw_cells, classification: &item.classification };
        output_budget.add(&row_view(&source, &HashSet::new())?)?;
        output_budget.add(",")?;
    }
    let id = js::random_uuid();
    store.transaction(Tx::Immediate, || {
        insert_batch(store, &Batch {
            id: id.clone(), source_series_id: js::random_uuid(), previous_batch_id: None, kind: "initial".into(), file_sha256: hash.into(), display_name: display_name.into(),
            rule_version: IMPORT_RULE.into(), status: "preview".into(), target_item_ids: Vec::new(), counts: counts_json(&parsed.counts), target_revisions: Map::new(), created_at: js::iso_now(),
        })?;
        for item in &parsed.items { insert_item(store, &js::random_uuid(), &id, item)?; }
        Ok(())
    })?;
    review(store, &id)
}

pub fn cancel(store: &Store, input: &str) -> Result<ImportReview> {
    let batch = get_batch(store, input)?;
    review(store, &batch.id)?;
    if batch.status == "preview" { set_batch_status(store, &batch.id, "cancelled")?; }
    review(store, &batch.id)
}

pub fn resume(store: &Store, input: &str) -> Result<ImportReview> {
    let previous = get_batch(store, input)?;
    assert_series(store, &previous)?;
    review(store, &previous.id)?;
    if previous.status == "preview" { return review(store, &previous.id); }
    let applied = applied_items(store)?;
    let pending: Vec<Item> = get_items(store, &previous)?.into_iter().filter(|item| !applied.contains(&item.id) && item.classification != "header").collect();
    if !pending.iter().any(adoptable) { return Err(import_error(ImportCode::Conflict, NOTHING_PENDING)); }
    if let Some(ongoing) = select_batches(store, "WHERE rule_version = ? AND status = 'preview'", &[&IMPORT_RULE])?.into_iter().next() {
        if ongoing.source_series_id != previous.source_series_id || ongoing.file_sha256 != previous.file_sha256 { return Err(import_error(ImportCode::Conflict, "別の取込の確認中です。要求した原記録からは再開できません。")); }
        let target_ids: HashSet<String> = get_items(store, &ongoing)?.into_iter().filter(|item| !applied.contains(&item.id) && item.classification != "header").map(|item| item.id).collect();
        if target_ids.len() != pending.len() || pending.iter().any(|item| !target_ids.contains(&item.id)) { return Err(import_error(ImportCode::Conflict, "別の取込または異なる対象の確認中です。要求した原記録からは再開できません。")); }
        return review(store, &ongoing.id);
    }
    let id = js::random_uuid();
    let mut counts = ImportCounts::default();
    for item in &pending {
        match classification_for(&item.classification, &item.raw_cells)?.as_str() { "candidate" => counts.candidates += 1, "held" => counts.held += 1, _ => {} }
        if item.kind == "supplement" { counts.supplements += 1; }
    }
    insert_batch(store, &Batch {
        id: id.clone(), source_series_id: previous.source_series_id.clone(), previous_batch_id: Some(previous.id.clone()), kind: "resolution".into(), file_sha256: previous.file_sha256.clone(),
        display_name: previous.display_name.clone(), rule_version: IMPORT_RULE.into(), status: "preview".into(), target_item_ids: pending.iter().map(|item| Value::String(item.id.clone())).collect(),
        counts: counts_json(&counts), target_revisions: Map::new(), created_at: js::iso_now(),
    })?;
    review(store, &id)
}

pub fn apply(store: &Store, input: &Value) -> Result<ImportReview> {
    let o = validate::strict(input, &["batchId", "acceptedIds"])?;
    let batch_id = o.uuid("batchId")?;
    let accepted_ids = validate::array(o.req("acceptedIds")?, limits::ITEMS)?.iter().map(validate::uuid).collect::<Result<Vec<_>>>()?;
    let batch = get_batch(store, &batch_id)?;
    if batch.status == "applied" { return review(store, &batch.id); }
    if batch.status != "preview" { return Err(import_error(ImportCode::Conflict, "この確認は終了しています。履歴から未反映の候補を再確認してください。")); }
    review(store, &batch.id)?;
    let items = get_items(store, &batch)?;
    let accepted: HashSet<&String> = accepted_ids.iter().collect();
    let applied = applied_items(store)?;
    let mut classes = IndexMap::new();
    for item in &items { classes.insert(item.id.clone(), classification_for(&item.classification, &item.raw_cells)?); }
    if accepted.len() != accepted_ids.len() || accepted_ids.iter().any(|id| applied.contains(id) || !items.iter().any(|item| &item.id == id && adoptable(item))) {
        return Err(import_error(ImportCode::Validation, "選択した項目の所属・分類・反映状態が一致しません。"));
    }
    let result = store.transaction(Tx::Immediate, || {
        if get_batch(store, &batch.id)?.status != "preview" { return Err(import_error(ImportCode::Conflict, "取込状態が変更されています。")); }
        assert_series(store, &batch)?;
        let now = js::iso_now();
        let committed = applied_items(store)?;
        let mut categories_by_sheet: IndexMap<i64, String> = IndexMap::new();
        for item in &items {
            if committed.contains(&item.id) { return Err(import_error(ImportCode::Conflict, "既に反映済みの項目があります。")); }
            let mut material_id: Option<String> = None;
            if accepted.contains(&item.id) {
                let category = match categories_by_sheet.get(&item.sheet_order) {
                    Some(category) => category.clone(),
                    None => {
                        let old: Option<String> = optional(store.conn().query_row(
                            "SELECT materials.category_id FROM materials INNER JOIN import_items ON materials.last_source_item_id = import_items.id INNER JOIN import_batches ON import_items.batch_id = import_batches.id WHERE (import_batches.source_series_id = ? AND import_items.sheet_order = ?)",
                            params![batch.source_series_id, item.sheet_order], |row| row.get(0),
                        ))?;
                        let category = match old { Some(category) => category, None => materials::create_category(store, &item.sheet_name, item.sheet_order)? };
                        categories_by_sheet.insert(item.sheet_order, category.clone());
                        category
                    }
                };
                let columns = if item.block == "left" { LEFT } else { RIGHT };
                let values: Vec<String> = columns.iter().map(|column| item.raw_cells.get(*column).map(cell_value).unwrap_or_default()).collect();
                let created = materials::create(store, &category, &MaterialValues::from_slice(&values))?;
                materials::set_last_source(store, &created, &item.id)?;
                material_id = Some(created);
            }
            let decision = if material_id.is_some() { "new" } else if item.classification == "header" { "non_material" } else { "hold" };
            let reason = if material_id.is_some() {
                match classes.get(&item.id).map(String::as_str) { Some("held") => "要確認の行を確認して採用", Some("header") => "列見出しの行を確認して採用", _ => "初回取込の確認で採用" }
            } else if decision == "hold" { "未選択または要確認のため保留" } else { "列見出し" };
            let fields: &[&str] = if material_id.is_some() { &MATERIAL_FIELDS } else { &[] };
            insert_decision(store, &item.id, material_id.as_deref(), decision, fields, reason, &now, &batch.id)?;
        }
        let mut counts = counts_strict(&batch.counts)?;
        let current_candidates = classes.values().filter(|c| *c == "candidate").count() as i64;
        let current_held = classes.values().filter(|c| *c == "held").count() as i64;
        let accepted_as = |class: &str| items.iter().filter(|item| accepted.contains(&item.id) && classes.get(&item.id).map(String::as_str) == Some(class)).count() as i64;
        counts.candidates = current_candidates;
        counts.applied = accepted.len() as i64;
        counts.held = current_held + current_candidates - accepted_as("candidate") - accepted_as("held");
        counts.excluded -= accepted_as("header");
        store.conn().execute("UPDATE import_batches SET status = 'applied', counts = ? WHERE id = ?", params![js::stringify(&counts_json(&counts)), batch.id])?;
        Ok(())
    });
    if let Err(error) = result {
        if matches!(error, Error::Import(..)) { return Err(error); }
        store.conn().execute("UPDATE import_batches SET status = 'failed' WHERE id = ? AND status = 'preview'", params![batch.id])?;
        return Err(import_error(ImportCode::Db, "保存に失敗しました。材料への反映は取り消しました。履歴から再確認できます。"));
    }
    review(store, &batch.id)
}
