//! 変更Excelでの更新取込と材料の手動管理（src/main/reimport）。

use std::collections::{HashMap, HashSet, VecDeque};

use indexmap::IndexMap;
use rusqlite::params;
use serde::{Deserialize, Serialize};
use serde_json::{Map, Value};

use crate::db::{optional, Store, Tx};
use crate::error::{DbCode, Error, ImportCode, Result};
use crate::imports::repository::{
    adoptable, batch_row, counts_json, in_list, incoming_values, insert_batch, insert_decision, insert_item, read_items as read_items_where, row_view, Batch, ImportRow, ImportSummary, Item, BATCH_COLUMNS,
};
use crate::imports::{import_error, limits, Budget, ImportCounts, ParsedWorkbook, IMPORT_RULE};
use crate::js;
use crate::materials::{self, MaterialUpdate, MaterialValues, MATERIAL_COLUMNS, MATERIAL_FIELDS};
use crate::search;
use crate::validate;

pub const REIMPORT_RULE: &str = "initial-ooxml-v1/reimport-v1";

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ManagedMaterial { pub id: String, pub revision: i64, pub category_id: String, pub category_name: String, pub active: bool, pub values: MaterialValues, pub source: Option<ImportRow> }

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SourceAssignment { pub source_batch_id: String, pub item_id: String, pub material_id: String }

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ReimportRow { pub source_batch_id: String, pub source: ImportRow, pub suggested_ids: Vec<String>, pub comparison: String }

#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DecisionView { pub item_id: String, pub material_id: Option<String>, pub decision: String, pub selected_fields: Value, pub reason: String }

#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ReimportReview {
    pub assignments: Vec<SourceAssignment>, pub decisions: Vec<DecisionView>, pub batch: ImportSummary, pub series_id: String, pub stale: bool,
    pub rows: Vec<ReimportRow>, pub materials: Vec<ManagedMaterial>,
    /// 元ブックのどの行からも候補に挙がらなかった有効な材料（Excelに見当たらない材料）。
    pub missing_ids: Vec<String>,
    /// 確認中でない記録から再確認（resume）できない理由。確認中の記録と、再確認できる記録は None。
    pub resume_blocked: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct SeriesOption { pub id: String, pub label: String }

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct CategoryChoice { pub id: String, pub name: String }

/// 材料の新規作成・編集の画面。カテゴリは候補の先頭ページ（search::CATEGORY_PAGE_SIZE 件まで）と総数で、
/// 残りの候補は search::categories で検索・ページ取得する。編集中の材料のカテゴリは material が持つ。
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct MaterialForm { pub material: Option<ManagedMaterial>, pub categories: Vec<CategoryChoice>, pub category_total: i64, pub create_request_id: Option<String> }

// ---- data.ts ----

fn read_items(store: &Store, filter: &str, values: &[String]) -> Result<Vec<Item>> {
    read_items_where(store, filter, values, "原記録の読取上限を超えています。元データは保持されています。")
}

/// 材料と原記録の比較用データ（materialViews）。filter は materials 表に対する条件。削除した材料は含めない。
pub fn material_views(store: &Store, filter: &str, values: &[String]) -> Result<Vec<ManagedMaterial>> {
    let filter = format!("({filter}) AND materials.deleted_at IS NULL");
    let bytes = "length(cast(materials.name||materials.model||materials.manufacturer||materials.quantity||materials.remarks||materials.unit_price as blob))";
    let size: Option<(i64, i64)> = optional(store.conn().query_row(
        &format!("SELECT count(*), coalesce(sum({bytes}+1024+coalesce((select length(cast(i.raw_cells as blob)) from import_items i where i.id=materials.last_source_item_id),0)),0) FROM materials WHERE {filter}"),
        rusqlite::params_from_iter(values.iter()), |row| Ok((row.get(0)?, row.get(1)?)),
    ))?;
    match size { Some((count, total)) if count <= limits::ITEMS as i64 && total <= limits::DATA_BYTES => {} _ => return Err(import_error(ImportCode::Limit, "材料の比較データ量が上限を超えています。")) }
    let mut statement = store.conn().prepare(&format!("SELECT {MATERIAL_COLUMNS} FROM materials WHERE {filter} ORDER BY materials.id ASC"))?;
    let rows: Vec<materials::MaterialRow> = statement.query_map(rusqlite::params_from_iter(values.iter()), materials::material_row)?.collect::<std::result::Result<_, _>>()?;
    let mut result = Vec::with_capacity(rows.len());
    let mut budget = Budget::default();
    for m in rows {
        let item = match &m.last_source_item_id { Some(id) => read_items(store, "id = ?", std::slice::from_ref(id))?.into_iter().next(), None => None };
        let category: Option<String> = optional(store.conn().query_row("SELECT name FROM categories WHERE id = ?", [&m.category_id], |row| row.get(0)))?;
        let row = ManagedMaterial {
            id: m.id, revision: m.revision, category_id: m.category_id, category_name: category.unwrap_or_default(), active: m.active, values: m.values,
            source: match &item { Some(item) => Some(row_view(&item.into(), &HashSet::new())?), None => None },
        };
        budget.add(&row)?;
        result.push(row);
    }
    Ok(result)
}

// ---- state.ts ----

fn count_or_zero(counts: &Map<String, Value>, key: &str) -> i64 { counts.get(key).and_then(Value::as_i64).unwrap_or(0) }

pub fn summary(batch: &Batch) -> ImportSummary {
    let c = &batch.counts;
    ImportSummary {
        id: batch.id.clone(), display_name: batch.display_name.clone(), created_at: batch.created_at.clone(), status: batch.status.clone(),
        counts: ImportCounts { candidates: count_or_zero(c, "candidates"), held: count_or_zero(c, "held"), supplements: count_or_zero(c, "supplements"), excluded: count_or_zero(c, "excluded"), empty: count_or_zero(c, "empty"), applied: count_or_zero(c, "applied") },
    }
}

/// 材料ごとの版と、材料一式の状態の指紋（targetRevisions）。
pub fn revisions(rows: &[ManagedMaterial]) -> Map<String, Value> {
    let mut map = Map::new();
    for m in rows { map.insert(m.id.clone(), Value::from(m.revision)); }
    let state: Vec<Value> = rows.iter().map(|m| Value::Array(vec![
        Value::String(m.id.clone()), Value::from(m.revision), Value::String(m.category_id.clone()), Value::String(m.category_name.clone()), Value::Bool(m.active),
        serde_json::to_value(&m.values).unwrap_or(Value::Null), m.source.as_ref().map(|s| Value::String(s.id.clone())).unwrap_or(Value::Null),
    ])).collect();
    map.insert(format!("state:{}", js::sha256_hex(js::stringify(&state))), Value::from(0));
    map
}

const COMMITTED_SERIES: &str = "source_series_id in (select source_series_id from import_batches where rule_version='initial-ooxml-v1' and kind in ('initial','resolution') and status='applied')";

pub fn get(store: &Store, input: &str) -> Result<Batch> {
    if !js::is_uuid(input) { return Err(Error::invalid("batchId")); }
    let filter = "id = ? AND rule_version IN (?, ?)";
    let size: Option<i64> = optional(store.conn().query_row(
        &format!("SELECT length(cast(target_item_ids as blob))+length(cast(target_revisions as blob))+length(cast(counts as blob)) FROM import_batches WHERE {filter}"),
        params![input, IMPORT_RULE, REIMPORT_RULE], |row| row.get(0),
    ))?;
    let Some(size) = size else { return Err(import_error(ImportCode::Validation, "取込記録が見つかりません。")) };
    if size > 2_000_000 { return Err(import_error(ImportCode::Limit, "取込確認情報の上限を超えています。")); }
    let batch = optional(store.conn().query_row(&format!("SELECT {BATCH_COLUMNS} FROM import_batches WHERE {filter}"), params![input, IMPORT_RULE, REIMPORT_RULE], batch_row))?
        .ok_or_else(|| import_error(ImportCode::Validation, "取込記録が見つかりません。"))?;
    if batch.target_item_ids.len() > limits::ITEMS || batch.target_item_ids.iter().any(|id| !id.as_str().is_some_and(js::is_uuid)) { return Err(Error::invalid("targetItemIds")); }
    Ok(batch)
}

pub fn series(store: &Store) -> Result<Vec<SeriesOption>> {
    let mut statement = store.conn().prepare(&format!("SELECT source_series_id, display_name FROM import_batches WHERE (kind = 'initial' AND rule_version = ? AND {COMMITTED_SERIES}) LIMIT 100"))?;
    Ok(statement.query_map([IMPORT_RULE], |row| Ok(SeriesOption { id: row.get(0)?, label: row.get(1)? }))?.collect::<std::result::Result<_, _>>()?)
}

pub fn head(store: &Store, series_id: &str) -> Result<Batch> {
    let root: Option<String> = optional(store.conn().query_row(
        &format!("SELECT id FROM import_batches WHERE (source_series_id = ? AND kind = 'initial' AND rule_version = ? AND {COMMITTED_SERIES})"), params![series_id, IMPORT_RULE], |row| row.get(0),
    ))?;
    let Some(root) = root else { return Err(import_error(ImportCode::Validation, "更新元の確定済み系列を選んでください。")) };
    let mut current = get(store, &root)?;
    let mut seen = HashSet::new();
    loop {
        if !seen.insert(current.id.clone()) { return Err(import_error(ImportCode::Conflict, "取込履歴の連鎖を確認できません。")); }
        let mut statement = store.conn().prepare("SELECT id FROM import_batches WHERE (previous_batch_id = ? AND kind = 'reimport' AND status = 'applied') LIMIT 2")?;
        let next: Vec<String> = statement.query_map([&current.id], |row| row.get(0))?.collect::<std::result::Result<_, _>>()?;
        if next.len() > 1 { return Err(import_error(ImportCode::Conflict, "取込履歴が分岐しています。")); }
        match next.into_iter().next() { None => return Ok(current), Some(id) => current = get(store, &id)? }
    }
}

pub fn current_materials(store: &Store, series_id: &str) -> Result<Vec<ManagedMaterial>> {
    material_views(store, "materials.last_source_item_id in (select i.id from import_items i join import_batches b on b.id=i.batch_id where b.source_series_id=?)", &[series_id.to_string()])
}

pub fn items(store: &Store, batch: &Batch) -> Result<Vec<Item>> {
    if batch.kind == "initial" { return read_items(store, "batch_id = ?", std::slice::from_ref(&batch.id)); }
    let ids: Vec<String> = batch.target_item_ids.iter().map(|v| v.as_str().unwrap_or_default().to_string()).collect();
    read_items(store, &in_list("id", ids.len()), &ids)
}

/// 新規・反映・保持の判断が済んだ原記録。
pub fn consumed(store: &Store, ids: &[String]) -> Result<HashSet<String>> {
    let mut statement = store.conn().prepare(&format!("SELECT DISTINCT item_id FROM import_decisions WHERE ({} AND decision IN ('new', 'apply', 'keep'))", in_list("item_id", ids.len())))?;
    Ok(statement.query_map(rusqlite::params_from_iter(ids.iter()), |row| row.get(0))?.collect::<std::result::Result<_, _>>()?)
}

pub fn assignments(store: &Store, source_items: &[Item]) -> Result<Vec<SourceAssignment>> {
    let mut roots: Vec<String> = Vec::new();
    for item in source_items { if !roots.contains(&item.batch_id) { roots.push(item.batch_id.clone()); } }
    if roots.is_empty() { return Ok(Vec::new()); }
    let mut statement = store.conn().prepare(&format!(
        "SELECT DISTINCT import_items.batch_id, import_decisions.item_id, import_decisions.material_id FROM import_decisions INNER JOIN import_items ON import_items.id = import_decisions.item_id WHERE ({} AND import_decisions.decision IN ('new', 'apply')) LIMIT {}",
        in_list("import_items.batch_id", roots.len()), limits::ITEMS + 1))?;
    let found: Vec<(String, String, Option<String>)> = statement.query_map(rusqlite::params_from_iter(roots.iter()), |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?)))?.collect::<std::result::Result<_, _>>()?;
    if found.len() > limits::ITEMS { return Err(import_error(ImportCode::Limit, "元ブックの対応履歴が上限を超えています。")); }
    found.into_iter().map(|(source_batch_id, item_id, material_id)| {
        let material_id = material_id.filter(|id| js::is_uuid(id)).ok_or_else(|| Error::invalid("assignment materialId"))?;
        if !js::is_uuid(&source_batch_id) || !js::is_uuid(&item_id) { return Err(Error::invalid("assignment")); }
        Ok(SourceAssignment { source_batch_id, item_id, material_id })
    }).collect()
}

pub fn review(store: &Store, input: &str) -> Result<ReimportReview> {
    let batch = get(store, input)?;
    let old = current_materials(store, &batch.source_series_id)?;
    let source_items = items(store, &batch)?;
    let used = consumed(store, &source_items.iter().map(|i| i.id.clone()).collect::<Vec<_>>())?;
    let mut exact_groups: HashMap<String, Vec<&ManagedMaterial>> = HashMap::new();
    let mut similar_groups: HashMap<String, Vec<&ManagedMaterial>> = HashMap::new();
    for material in &old {
        let Some(source) = &material.source else { continue };
        exact_groups.entry(js::stringify(&source.values)).or_default().push(material);
        similar_groups.entry(js::stringify(&[source.values.first().cloned().unwrap_or_default(), source.values.get(2).cloned().unwrap_or_default()])).or_default().push(material);
    }
    let assigned = assignments(store, &source_items)?;
    let mut budget = Budget::default();
    budget.add(&assigned)?;
    budget.add(&old)?;
    budget.add_spaces(65536)?;
    let mut present: HashSet<&str> = HashSet::new();
    let mut rows = Vec::with_capacity(source_items.len());
    for item in &source_items {
        let source = row_view(&item.into(), &used)?;
        let (similar, exact) = matched(&exact_groups, &similar_groups, &source.values, &incoming_values(item)?);
        let comparison = if source.classification != "candidate" { "held" } else if similar.len() > 1 { "ambiguous" } else if exact && similar.len() == 1 { "same" } else if similar.len() == 1 { "changed" } else { "unmatched" };
        present.extend(similar.iter().map(|m| m.id.as_str()));
        let row = ReimportRow { source_batch_id: item.batch_id.clone(), suggested_ids: similar.iter().take(20).map(|m| m.id.clone()).collect(), comparison: comparison.into(), source };
        budget.add(&row)?;
        rows.push(row);
    }
    // 再確認では未反映の行しか rows に含まれないため、反映済みの行も含めた元ブック全体と比べる。
    let mut roots: Vec<String> = Vec::new();
    for item in &source_items { if !roots.contains(&item.batch_id) { roots.push(item.batch_id.clone()); } }
    if roots.iter().any(|root| root != &batch.id) {
        let shown: HashSet<&str> = source_items.iter().map(|item| item.id.as_str()).collect();
        for item in read_items(store, &in_list("batch_id", roots.len()), &roots)?.iter().filter(|item| !shown.contains(item.id.as_str())) {
            present.extend(matched(&exact_groups, &similar_groups, &row_view(&item.into(), &used)?.values, &incoming_values(item)?).0.iter().map(|m| m.id.as_str()));
        }
    }
    let missing_ids: Vec<String> = old.iter().filter(|m| m.active && !present.contains(m.id.as_str())).map(|m| m.id.clone()).collect();
    let size: Option<(i64, i64)> = optional(store.conn().query_row(
        "SELECT count(*), coalesce(sum(length(cast(selected_fields as blob))+length(cast(reason as blob))+256),0) FROM import_decisions WHERE applied_batch_id = ?", [&batch.id], |row| Ok((row.get(0)?, row.get(1)?)),
    ))?;
    match size { Some((count, bytes)) if count <= (limits::ITEMS * 2) as i64 && bytes <= limits::DATA_BYTES => {} _ => return Err(import_error(ImportCode::Limit, "判断履歴の表示上限を超えています。")) }
    let mut statement = store.conn().prepare("SELECT item_id, material_id, decision, selected_fields, reason FROM import_decisions WHERE applied_batch_id = ?")?;
    let decisions: Vec<DecisionView> = statement.query_map([&batch.id], |row| {
        let fields: String = row.get(3)?;
        Ok(DecisionView { item_id: row.get(0)?, material_id: row.get(1)?, decision: row.get(2)?, selected_fields: serde_json::from_str(&fields).unwrap_or(Value::Null), reason: row.get(4)? })
    })?.collect::<std::result::Result<_, _>>()?;
    budget.add(&decisions)?;
    let stale = batch.status == "preview" && (batch.previous_batch_id.as_deref() != Some(head(store, &batch.source_series_id)?.id.as_str()) || js::stringify(&batch.target_revisions) != js::stringify(&revisions(&old)));
    // resume と同じ条件（別の取込を確認中のときは、その場の状態なので含めない）。
    let resume_blocked = if batch.status == "preview" { None } else {
        match head(store, &batch.source_series_id) {
            Ok(head) if batch.id != head.id && batch.previous_batch_id.as_deref() != Some(head.id.as_str()) => Some(SUPERSEDED.to_string()),
            Ok(_) if !source_items.iter().any(|i| !used.contains(&i.id) && i.classification != "header") => Some(NOTHING_PENDING.to_string()),
            Ok(_) => None,
            Err(Error::Import(_, reason)) => Some(reason),
            Err(error) => return Err(error),
        }
    };
    Ok(ReimportReview { assignments: assigned, decisions, batch: summary(&batch), series_id: batch.source_series_id.clone(), stale, rows, materials: old, missing_ids, resume_blocked })
}

const SUPERSEDED: &str = "後続のExcelが確定済みです。古い取込の再開はできません。原記録は保持されています。";
const NOTHING_PENDING: &str = "未反映の原記録はありません。";

/// 原記録の値に対応しそうな材料（取込時の値が全項目一致する材料、なければ品名とメーカーが一致する材料）。bool は全項目一致か。
fn matched<'a>(exact: &'a HashMap<String, Vec<&'a ManagedMaterial>>, similar: &'a HashMap<String, Vec<&'a ManagedMaterial>>, values: &[String], incoming: &MaterialValues) -> (&'a [&'a ManagedMaterial], bool) {
    match exact.get(&js::stringify(&values)) {
        Some(found) if !found.is_empty() => (found, true),
        _ => (similar.get(&js::stringify(&[&incoming.name, &incoming.manufacturer])).map(Vec::as_slice).unwrap_or(&[]), false),
    }
}

pub fn list(store: &Store) -> Result<Vec<ImportSummary>> {
    let mut statement = store.conn().prepare(&format!("SELECT {BATCH_COLUMNS} FROM import_batches WHERE rule_version = ? ORDER BY created_at DESC LIMIT 100"))?;
    let batches: Vec<Batch> = statement.query_map([REIMPORT_RULE], batch_row)?.collect::<std::result::Result<_, _>>()?;
    Ok(batches.iter().map(summary).collect())
}

// ---- staging.ts ----

fn assert_idle(store: &Store) -> Result<()> {
    let busy: Option<String> = optional(store.conn().query_row("SELECT id FROM import_batches WHERE status = 'preview'", [], |row| row.get(0)))?;
    if busy.is_some() { return Err(import_error(ImportCode::Conflict, "別の取込を確認中です。先に確定または取消してください。")); }
    Ok(())
}

pub fn stage(store: &Store, series_id: &str, parsed: &ParsedWorkbook, display_name: &str, hash: &str) -> Result<ReimportReview> {
    if !js::is_uuid(series_id) || js::cp_len(display_name) < 1 || js::cp_len(display_name) > 1000 || hash.len() != 64 || !hash.bytes().all(|b| b.is_ascii_digit() || (b'a'..=b'f').contains(&b)) { return Err(Error::invalid("stage")); }
    let mut budget = Budget::default();
    if parsed.items.len() > limits::ITEMS { return Err(import_error(ImportCode::Limit, "取込行数の上限を超えています。")); }
    for item in &parsed.items { budget.add(item)?; budget.add_spaces(1024)?; }
    store.transaction(Tx::Immediate, || {
        let head = head(store, series_id)?;
        let same: Option<String> = optional(store.conn().query_row(
            "SELECT id FROM import_batches WHERE (source_series_id = ? AND file_sha256 = ?) ORDER BY created_at DESC, import_batches.rowid desc", params![series_id, hash], |row| row.get(0),
        ))?;
        if let Some(same) = same { return review(store, &same); }
        assert_idle(store)?;
        let id = js::random_uuid();
        let ids: Vec<String> = parsed.items.iter().map(|_| js::random_uuid()).collect();
        insert_batch(store, &Batch {
            id: id.clone(), source_series_id: series_id.into(), previous_batch_id: Some(head.id.clone()), kind: "reimport".into(), file_sha256: hash.into(), display_name: display_name.into(),
            rule_version: REIMPORT_RULE.into(), status: "preview".into(), target_item_ids: ids.iter().cloned().map(Value::String).collect(), counts: counts_json(&parsed.counts),
            target_revisions: revisions(&current_materials(store, series_id)?), created_at: js::iso_now(),
        })?;
        for (item, item_id) in parsed.items.iter().zip(&ids) { insert_item(store, item_id, &id, item)?; }
        review(store, &id)
    })
}

pub fn cancel(store: &Store, input: &str) -> Result<ReimportReview> {
    store.transaction(Tx::Immediate, || {
        let batch = get(store, input)?;
        if batch.rule_version != REIMPORT_RULE { return Err(import_error(ImportCode::Conflict, "初回取込の記録は変更できません。")); }
        review(store, &batch.id)?;
        if batch.status == "preview" { store.conn().execute("UPDATE import_batches SET status = 'cancelled' WHERE id = ?", [&batch.id])?; }
        review(store, &batch.id)
    })
}

pub fn resume(store: &Store, input: &str) -> Result<ReimportReview> {
    store.transaction(Tx::Immediate, || {
        let previous = get(store, input)?;
        let head = head(store, &previous.source_series_id)?;
        let current = review(store, &previous.id)?;
        if previous.id != head.id && previous.previous_batch_id.as_deref() != Some(head.id.as_str()) { return Err(import_error(ImportCode::Conflict, SUPERSEDED)); }
        if previous.status == "preview" && !current.stale { return Ok(current); }
        let source = items(store, &previous)?;
        let used = consumed(store, &source.iter().map(|i| i.id.clone()).collect::<Vec<_>>())?;
        let pending: Vec<&Item> = source.iter().filter(|i| !used.contains(&i.id) && i.classification != "header").collect();
        if pending.is_empty() { return Err(import_error(ImportCode::Conflict, NOTHING_PENDING)); }
        if previous.status == "preview" { store.conn().execute("UPDATE import_batches SET status = 'cancelled' WHERE id = ?", [&previous.id])?; }
        assert_idle(store)?;
        let id = js::random_uuid();
        let mut counts = Map::new();
        counts.insert("candidates".into(), Value::from(current.rows.iter().filter(|r| !used.contains(&r.source.id) && r.source.classification == "candidate").count()));
        counts.insert("held".into(), Value::from(pending.len()));
        counts.insert("applied".into(), Value::from(0));
        insert_batch(store, &Batch {
            id: id.clone(), source_series_id: previous.source_series_id.clone(), previous_batch_id: Some(head.id.clone()), kind: "reimport".into(), file_sha256: previous.file_sha256.clone(),
            display_name: previous.display_name.clone(), rule_version: REIMPORT_RULE.into(), status: "preview".into(), target_item_ids: pending.iter().map(|i| Value::String(i.id.clone())).collect(),
            counts, target_revisions: revisions(&current_materials(store, &previous.source_series_id)?), created_at: js::iso_now(),
        })?;
        review(store, &id)
    })
}

// ---- apply.ts ----

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Choice { Hold { item_id: String }, New { item_id: String }, Map { item_id: String, material_id: String, fields: Vec<String> } }

impl Choice {
    fn item_id(&self) -> &str { match self { Choice::Hold { item_id } | Choice::New { item_id } | Choice::Map { item_id, .. } => item_id } }
    fn parse(value: &Value) -> Result<Choice> {
        let action = validate::loose(value)?.get("action").and_then(Value::as_str).ok_or_else(|| Error::invalid("action"))?;
        match action {
            "hold" => Ok(Choice::Hold { item_id: validate::strict(value, &["itemId", "action"])?.uuid("itemId")? }),
            "new" => Ok(Choice::New { item_id: validate::strict(value, &["itemId", "action"])?.uuid("itemId")? }),
            "map" => {
                let o = validate::strict(value, &["itemId", "action", "materialId", "fields"])?;
                let fields = validate::array(o.req("fields")?, 6)?.iter().map(|f| validate::one_of(f, &MATERIAL_FIELDS)).collect::<Result<Vec<_>>>()?;
                Ok(Choice::Map { item_id: o.uuid("itemId")?, material_id: o.uuid("materialId")?, fields })
            }
            _ => Err(Error::invalid("action")),
        }
    }
}

pub fn apply(store: &Store, input: &Value) -> Result<ReimportReview> {
    Budget::default().add(input)?;
    let o = validate::strict(input, &["batchId", "choices", "inactiveIds", "confirmed"])?;
    let batch_id = o.uuid("batchId")?;
    let choices = validate::array(o.req("choices")?, limits::ITEMS)?.iter().map(Choice::parse).collect::<Result<Vec<_>>>()?;
    let inactive_ids = validate::array(o.req("inactiveIds")?, limits::ITEMS)?.iter().map(validate::uuid).collect::<Result<Vec<_>>>()?;
    if o.req("confirmed")? != &Value::Bool(true) { return Err(Error::invalid("confirmed")); }
    store.transaction(Tx::Immediate, || {
        let batch = get(store, &batch_id)?;
        if batch.rule_version != REIMPORT_RULE { return Err(import_error(ImportCode::Conflict, "初回取込の確認画面を利用してください。")); }
        if batch.status == "applied" { return review(store, &batch.id); }
        let current = review(store, &batch.id)?;
        if batch.status != "preview" || current.stale { return Err(import_error(ImportCode::Conflict, "材料または取込履歴が変更されています。再確認してから適用してください。")); }
        let rows_by_id: HashMap<&str, &ReimportRow> = current.rows.iter().map(|r| (r.source.id.as_str(), r)).collect();
        let source_items = items(store, &batch)?;
        let by_item: HashMap<&str, &Item> = source_items.iter().map(|i| (i.id.as_str(), i)).collect();
        let old: HashMap<&str, &ManagedMaterial> = current.materials.iter().map(|m| (m.id.as_str(), m)).collect();
        let selected: HashMap<&str, &Choice> = choices.iter().map(|c| (c.item_id(), c)).collect();
        let inactive: HashSet<&String> = inactive_ids.iter().collect();
        let used = consumed(store, &source_items.iter().map(|i| i.id.clone()).collect::<Vec<_>>())?;
        if selected.len() != choices.len() || selected.len() != source_items.len() || inactive.len() != inactive_ids.len() { return Err(import_error(ImportCode::Validation, "確認行に重複または不足があります。")); }
        let mut mapped: HashSet<&str> = HashSet::new();
        for choice in &choices {
            let row = rows_by_id.get(choice.item_id());
            let (Some(row), Some(item)) = (row, by_item.get(choice.item_id())) else { return Err(import_error(ImportCode::Conflict, "対象の原記録は異なるか、既に反映済みです。")) };
            if used.contains(choice.item_id()) { return Err(import_error(ImportCode::Conflict, "対象の原記録は異なるか、既に反映済みです。")); }
            // 要確認の行も品名があれば、利用者が確認したうえで反映・新規追加できる（初回取込と同じ）。列見出しと補足セル・品名のない行は保留のみ。
            if !matches!(choice, Choice::Hold { .. }) && (item.classification == "header" || !adoptable(item)) { return Err(import_error(ImportCode::Validation, "要確認の原記録は保留してください。")); }
            if let Choice::Map { item_id, material_id, fields } = choice {
                if !old.contains_key(material_id.as_str()) || mapped.contains(material_id.as_str()) || inactive.contains(material_id) || fields.iter().collect::<HashSet<_>>().len() != fields.len() {
                    return Err(import_error(ImportCode::Validation, "対応する材料または選択項目が一致しません。"));
                }
                if current.assignments.iter().any(|a| a.source_batch_id == row.source_batch_id && &a.material_id == material_id && &a.item_id != item_id) {
                    return Err(import_error(ImportCode::Conflict, "同じ元ブックの別行が既にこの材料へ対応しています。別の材料を選ぶか保留してください。"));
                }
                mapped.insert(material_id);
            }
        }
        for id in &inactive_ids { if !old.contains_key(id.as_str()) { return Err(import_error(ImportCode::Validation, "無効化対象はこのExcel系列の材料に限ります。")); } }
        let now = js::iso_now();
        let mut categories: IndexMap<String, String> = IndexMap::new();
        let mut applied = 0i64;
        for m in &current.materials { if let Some(source) = &m.source { categories.entry(source.sheet_name.clone()).or_insert_with(|| m.category_id.clone()); } }
        // シートの材料をすべて削除した後に新規追加するときも、削除した材料のカテゴリへ入れる（同じ名前のカテゴリを増やさない）。
        let mut statement = store.conn().prepare(
            "SELECT import_items.sheet_name, materials.category_id FROM materials INNER JOIN import_items ON import_items.id = materials.last_source_item_id INNER JOIN import_batches ON import_batches.id = import_items.batch_id \
             WHERE import_batches.source_series_id = ? AND materials.deleted_at IS NOT NULL ORDER BY materials.id ASC")?;
        let deleted: Vec<(String, String)> = statement.query_map([&batch.source_series_id], |row| Ok((row.get(0)?, row.get(1)?)))?.collect::<std::result::Result<_, _>>()?;
        for (sheet_name, category_id) in deleted { categories.entry(sheet_name).or_insert(category_id); }
        for item in &source_items {
            let Some(selection) = selected.get(item.id.as_str()) else { return Err(import_error(ImportCode::Validation, "確認行が不足しています。")) };
            let mut target: Option<String> = None;
            let mut fields: Vec<String> = Vec::new();
            match selection {
                Choice::New { .. } => {
                    let category = match categories.get(&item.sheet_name) { Some(c) => c.clone(), None => { let c = materials::create_category(store, &item.sheet_name, item.sheet_order)?; categories.insert(item.sheet_name.clone(), c.clone()); c } };
                    target = Some(materials::create(store, &category, &incoming_values(item)?)?);
                    fields = MATERIAL_FIELDS.iter().map(|f| f.to_string()).collect();
                }
                Choice::Map { material_id, fields: chosen, .. } => {
                    let current_material = old.get(material_id.as_str()).ok_or_else(|| import_error(ImportCode::Conflict, "対象材料が見つかりません。"))?;
                    let incoming = incoming_values(item)?;
                    let pick = |key: &str| if chosen.iter().any(|f| f == key) { incoming.get(key).to_string() } else { current_material.values.get(key).to_string() };
                    let values = MaterialValues { name: pick("name"), model: pick("model"), manufacturer: pick("manufacturer"), quantity: pick("quantity"), remarks: pick("remarks"), unit_price: pick("unitPrice") };
                    materials::update(store, MaterialUpdate { id: material_id, expected_revision: current_material.revision, category_id: &current_material.category_id, active: current_material.active, values: &values })?;
                    target = Some(material_id.clone());
                    fields = chosen.clone();
                }
                Choice::Hold { .. } => {}
            }
            if let Some(target) = &target { materials::set_last_source(store, target, &item.id)?; applied += 1; }
            let decision = match selection { Choice::New { .. } => "new", Choice::Map { .. } => "apply", Choice::Hold { .. } => if item.classification == "header" { "non_material" } else { "hold" } };
            let reason = match selection { Choice::Map { .. } => "利用者が同一材料と確認。選択項目をExcelから反映、その他はアプリ値を保持", Choice::New { .. } => "利用者が別の新規材料として確認", Choice::Hold { .. } => "未選択・要確認の原記録を保留" };
            let field_refs: Vec<&str> = fields.iter().map(String::as_str).collect();
            insert_decision(store, &item.id, target.as_deref(), decision, &field_refs, reason, &now, &batch.id)?;
        }
        for m in &current.materials {
            let Some(source) = &m.source else { continue };
            if mapped.contains(m.id.as_str()) { continue; }
            let deactivate = inactive.contains(&m.id);
            if deactivate { materials::update(store, MaterialUpdate { id: &m.id, expected_revision: m.revision, category_id: &m.category_id, active: false, values: &m.values })?; }
            insert_decision(store, &source.id, Some(&m.id), "keep", &[], if deactivate { "利用者が未対応材料の無効化を明示" } else { "今回対応しない既存材料を保持" }, &now, &batch.id)?;
        }
        let mut counts = batch.counts.clone();
        counts.insert("applied".into(), Value::from(applied));
        counts.insert("held".into(), Value::from(source_items.iter().filter(|i| i.classification != "header").count() as i64 - applied));
        counts.insert("inactivated".into(), Value::from(inactive.len()));
        store.conn().execute("UPDATE import_batches SET status = 'applied', counts = ? WHERE id = ?", params![js::stringify(&counts), batch.id])?;
        review(store, &batch.id)
    })
}

// ---- master.ts ----

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct ReceiptResult { id: String, revision: i64, category_id: String, category_name: String, active: bool, values: MaterialValues, source: Option<()> }

#[derive(Default)]
pub struct MasterService { issued: VecDeque<String> }

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct SaveContent<'a> { id: &'a Option<String>, expected_revision: i64, category_id: &'a Option<String>, new_category_name: &'a str, active: bool, values: &'a MaterialValues }

impl MasterService {
    pub fn get(&mut self, store: &Store, id: Option<&str>) -> Result<MaterialForm> {
        let material = match id {
            Some(id) => Some(material_views(store, "materials.id = ?", &[id.to_string()])?.into_iter().next().ok_or_else(|| Error::db(DbCode::NotFound, "材料が見つかりません。"))?),
            None => None,
        };
        // カテゴリの総数では画面を止めない（返すのは候補の先頭ページだけ）。
        let (page, category_total) = search::category_page(store, "", true, search::CATEGORY_PAGE_SIZE, 0)?;
        let choices = page.into_iter().map(|c| CategoryChoice { id: c.id, name: c.name }).collect();
        let create_request_id = id.is_none().then(js::random_uuid);
        let result = MaterialForm { material, categories: choices, category_total, create_request_id: create_request_id.clone() };
        Budget::default().add(&result)?;
        if let Some(request) = create_request_id {
            if self.issued.len() >= 128 { self.issued.pop_front(); }
            self.issued.push_back(request);
        }
        Ok(result)
    }

    pub fn save(&mut self, store: &Store, raw: &Value) -> Result<ManagedMaterial> {
        Budget::default().add(raw)?;
        let o = validate::strict(raw, &["createRequestId", "id", "expectedRevision", "categoryId", "newCategoryName", "active", "values"])?;
        let create_request_id = match o.get("createRequestId") { None => None, Some(v) => Some(validate::uuid(v)?) };
        let id = o.nullable_uuid("id")?;
        let expected_revision = o.int("expectedRevision")?;
        if expected_revision < 0 { return Err(Error::invalid("expectedRevision")); }
        let category_id = o.nullable_uuid("categoryId")?;
        let new_category_name = o.string("newCategoryName", 0, 1000)?;
        let active = o.boolean("active")?;
        let values = MaterialValues::parse(o.req("values")?)?;
        // 品名は必須（画面と同じく、前後の空白だけの品名も空として扱う）。
        if js::trim(&values.name).is_empty() { return Err(Error::db(DbCode::Validation, "品名を入力してください。")); }
        let issued = self.issued.clone();
        let saved = store.transaction(Tx::Immediate, || {
            if id.is_none() && expected_revision != 0 { return Err(Error::db(DbCode::Validation, "新規材料の版が一致しません。")); }
            if id.is_some() && expected_revision < 1 { return Err(Error::db(DbCode::Validation, "編集対象の版が必要です。")); }
            let request_hash = js::sha256_hex(js::stringify(&SaveContent { id: &id, expected_revision, category_id: &category_id, new_category_name: &new_category_name, active, values: &values }));
            if id.is_none() {
                let Some(request) = &create_request_id else { return Err(Error::db(DbCode::Validation, "新規作成画面から保存してください。")) };
                let receipt: Option<(String, String)> = optional(store.conn().query_row("SELECT request_hash, result_json FROM material_create_receipts WHERE request_id = ?", [request], |row| Ok((row.get(0)?, row.get(1)?))))?;
                if let Some((hash, result_json)) = receipt {
                    if hash != request_hash { return Err(Error::db(DbCode::Conflict, "同じ作成要求の内容が異なります。保存済みの材料を確認してください。")); }
                    Budget::default().add(&result_json)?;
                    let decoded: Value = serde_json::from_str(&result_json)?;
                    let parsed = parse_receipt(&decoded)?;
                    return Ok(ManagedMaterial { id: parsed.id, revision: parsed.revision, category_id: parsed.category_id, category_name: parsed.category_name, active: parsed.active, values: parsed.values, source: None });
                }
                if !issued.contains(request) { return Err(Error::db(DbCode::Validation, "新規作成要求が失効しています。保存済みの材料を確認してから新規画面を開いてください。")); }
            } else if create_request_id.is_some() {
                return Err(Error::db(DbCode::Validation, "既存材料の編集に新規作成要求は使えません。"));
            }
            let category = match &category_id {
                Some(category) => {
                    let exists: Option<String> = optional(store.conn().query_row("SELECT id FROM categories WHERE id = ?", [category], |row| row.get(0)))?;
                    if !new_category_name.is_empty() || exists.is_none() { return Err(Error::db(DbCode::Validation, "カテゴリを選び直してください。")); }
                    category.clone()
                }
                None => {
                    if js::trim(&new_category_name).is_empty() { return Err(Error::db(DbCode::Validation, "新しいカテゴリ名を入力してください。")); }
                    materials::create_category(store, &new_category_name, 0)?
                }
            };
            let material_id = match &id {
                None => {
                    let created = materials::create(store, &category, &values)?;
                    if !active { materials::update(store, MaterialUpdate { id: &created, expected_revision: 1, category_id: &category, active: false, values: &values })?; }
                    created
                }
                Some(id) => { materials::update(store, MaterialUpdate { id, expected_revision, category_id: &category, active, values: &values })?; id.clone() }
            };
            let saved = material_views(store, "materials.id = ?", std::slice::from_ref(&material_id))?.into_iter().next().ok_or_else(|| Error::db(DbCode::NotFound, "材料を確認できません。"))?;
            if id.is_none() {
                if let Some(request) = &create_request_id {
                    if saved.source.is_some() { return Err(Error::invalid("receipt source")); }
                    let receipt = ReceiptResult { id: saved.id.clone(), revision: saved.revision, category_id: saved.category_id.clone(), category_name: saved.category_name.clone(), active: saved.active, values: saved.values.clone(), source: None };
                    store.conn().execute("INSERT INTO material_create_receipts (request_id, request_hash, material_id, result_json) VALUES (?, ?, ?, ?)", params![request, request_hash, material_id, js::stringify(&receipt)])?;
                }
            }
            Ok(saved)
        })?;
        if let Some(request) = &create_request_id { self.issued.retain(|r| r != request); }
        Ok(saved)
    }
}

fn parse_receipt(value: &Value) -> Result<ReceiptResult> {
    let o = validate::strict(value, &["id", "revision", "categoryId", "categoryName", "active", "values", "source"])?;
    let revision = o.int("revision")?;
    if revision < 1 || !o.req("source")?.is_null() { return Err(Error::invalid("receipt")); }
    Ok(ReceiptResult { id: o.uuid("id")?, revision, category_id: o.uuid("categoryId")?, category_name: o.string("categoryName", 0, 1000)?, active: o.boolean("active")?, values: MaterialValues::parse(o.req("values")?)?, source: None })
}
