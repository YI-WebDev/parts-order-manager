//! 請求書（帳票）の保存と編集セッション（src/main/db/documents.ts・src/main/documents/service.ts）。

use std::collections::{HashMap, HashSet};

use rusqlite::params;
use serde::{Deserialize, Serialize};
use serde_json::Value;

use crate::db::{flag, optional, Store, Tx};
use crate::error::{DbCode, Error, Result};
use crate::format::{parse_header_formats, parse_line_formats, HeaderFormats, LineFormats};
use crate::js;
use crate::materials;
use crate::exports::{blocking_issues, LineCheck};
use crate::sheet::{check_output, SheetHeader};
use crate::ui_meta::UiMeta;
use crate::validate;

pub const DELIVERY_STATES: [&str; 4] = ["unknown", "material_only", "slip_only", "both"];
pub const MARK_OUTPUTS: [&str; 5] = ["unresolved", "blank", "filled_circle", "open_circle", "both_mark"];
use crate::limits::{DELETE_MAX, LIST_PAGE_SIZE, MAX_LINES, QUERY_MAX, TEXT_MAX};

/// 明細（画面とやり取りする形。キーの並びは旧実装の InvoiceLine と同じ）。
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct InvoiceLine {
    pub id: String,
    pub material_id: Option<String>,
    pub source_item_id: Option<String>,
    pub name: String,
    pub model: String,
    pub manufacturer: String,
    pub quantity: String,
    pub remarks: String,
    pub delivery_state: String,
    pub mark_output: String,
    pub observed_mark: Option<String>,
    pub rule_version: String,
    /// セルの書式（移行後に追加。書式のない明細では省く）。
    #[serde(default, skip_serializing_if = "LineFormats::is_empty")]
    pub formats: LineFormats,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct InvoiceDraft {
    pub title: String, pub header: SheetHeader, pub template_version: String, pub lines: Vec<InvoiceLine>,
    /// 帳票上部の入力欄の書式（移行後に追加。書式がなければ省く）。
    #[serde(default, skip_serializing_if = "HeaderFormats::is_empty")]
    pub formats: HeaderFormats,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct EditorSession { pub session_id: String, pub document_id: Option<String>, pub revision: i64, pub draft: InvoiceDraft }

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SaveReceipt { pub session_id: String, pub document_id: String, pub revision: i64, pub request_number: i64, pub generation: i64 }

/// 入力の明細（zod の lineValues。id は新規作成時は省略）。
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct LineInput {
    pub name: String, pub model: String, pub manufacturer: String, pub quantity: String, pub remarks: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub id: Option<String>,
    pub material_id: Option<String>, pub source_item_id: Option<String>, pub delivery_state: String, pub mark_output: String, pub observed_mark: Option<String>, pub rule_version: String,
    #[serde(skip_serializing_if = "LineFormats::is_empty")]
    pub formats: LineFormats,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DraftInput {
    pub title: String, pub header: SheetHeader, pub template_version: String, pub lines: Vec<LineInput>,
    #[serde(skip_serializing_if = "HeaderFormats::is_empty")]
    pub formats: HeaderFormats,
}

/// 明細のキー（formats は書式。移行後に追加した省略可能なキー）。
const LINE_KEYS: [&str; 13] = ["name", "model", "manufacturer", "quantity", "remarks", "id", "materialId", "sourceItemId", "deliveryState", "markOutput", "observedMark", "ruleVersion", "formats"];

pub fn parse_header(value: &Value) -> Result<SheetHeader> {
    let o = validate::strict(value, &["C2", "A4", "B4", "C4", "E4"])?;
    // 帳票上部の欄は前後の空白（全角・半角）を除いて保存する（利用者の指示、2026年10月15日。明細の文字の欄も同じ）。
    let field = |key: &str| -> Result<String> { Ok(js::trim(&o.string(key, 0, TEXT_MAX)?).to_string()) };
    Ok(SheetHeader { c2: field("C2")?, a4: field("A4")?, b4: field("B4")?, c4: field("C4")?, e4: field("E4")? })
}

/// `lineValues`（id_required は `.extend({ id: lineId })`）。
pub fn parse_line(value: &Value, id_required: bool) -> Result<LineInput> {
    let o = validate::strict(value, &LINE_KEYS)?;
    let id = match o.get("id") { None if !id_required => None, Some(v) => Some(validate::uuid(v)?), None => return Err(Error::invalid("line id")) };
    // 明細の文字の欄（品名・形式・メーカー・数量・備考）は前後の空白（全角・半角）を除いて保存する。
    let field = |key: &str| -> Result<String> { Ok(js::trim(&o.string(key, 0, TEXT_MAX)?).to_string()) };
    Ok(LineInput {
        name: field("name")?, model: field("model")?, manufacturer: field("manufacturer")?, quantity: field("quantity")?, remarks: field("remarks")?, id,
        material_id: o.nullable_uuid("materialId")?, source_item_id: o.nullable_uuid("sourceItemId")?,
        delivery_state: validate::one_of(o.req("deliveryState")?, &DELIVERY_STATES)?, mark_output: validate::one_of(o.req("markOutput")?, &MARK_OUTPUTS)?,
        observed_mark: validate::nullable(o.req("observedMark")?, |v| validate::string(v, 0, 128))?, rule_version: o.string("ruleVersion", 1, 100)?,
        formats: o.get("formats").map(parse_line_formats).transpose()?.unwrap_or_default(),
    })
}

/// `documentDraft`（lines_max は通常 10,000、編集画面からの保存は 500）。
pub fn parse_draft(value: &Value, line_ids_required: bool, lines_max: usize) -> Result<DraftInput> {
    let o = validate::strict(value, &["title", "header", "templateVersion", "lines", "formats"])?;
    let title = o.string("title", 0, TEXT_MAX)?;
    let header = parse_header(o.req("header")?)?;
    let template_version = o.string("templateVersion", 1, 100)?;
    let lines = validate::array(o.req("lines")?, lines_max)?.iter().map(|line| parse_line(line, line_ids_required)).collect::<Result<Vec<_>>>()?;
    let formats = o.get("formats").map(parse_header_formats).transpose()?.unwrap_or_default();
    Ok(DraftInput { title, header, template_version, lines, formats })
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct StoredLine { pub line: InvoiceLine, pub document_id: String, pub position: i64 }

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct StoredDocument {
    pub id: String, pub title: String, pub header: SheetHeader, pub formats: HeaderFormats, pub revision: i64, pub template_version: String, pub duplicated_from_id: Option<String>,
    pub archived: bool, pub created_at: String, pub updated_at: String, pub lines: Vec<StoredLine>,
}

/// 書式は documents.header の JSON に "formats"（header: 帳票上部の欄、lines: 明細ID ごと）として一緒に保存する。
/// スキーマを変えないため、書式を知らない版でもDB・バックアップをそのまま開ける（書式は無視される）。書式がなければ従来と同じ JSON。
#[derive(Serialize)]
struct StoredHeader<'a> {
    #[serde(flatten)]
    header: &'a SheetHeader,
    #[serde(skip_serializing_if = "StoredFormats::is_empty")]
    formats: StoredFormats<'a>,
}

#[derive(Serialize)]
struct StoredFormats<'a> {
    #[serde(skip_serializing_if = "HeaderFormats::is_empty")]
    header: &'a HeaderFormats,
    #[serde(skip_serializing_if = "std::collections::BTreeMap::is_empty")]
    lines: std::collections::BTreeMap<&'a str, &'a LineFormats>,
}

impl StoredFormats<'_> {
    fn is_empty(&self) -> bool { self.header.is_empty() && self.lines.is_empty() }
}

fn header_json(draft: &DraftInput, line_ids: &[String]) -> String {
    let lines = draft.lines.iter().zip(line_ids).filter(|(line, _)| !line.formats.is_empty()).map(|(line, id)| (id.as_str(), &line.formats)).collect();
    js::stringify(&StoredHeader { header: &draft.header, formats: StoredFormats { header: &draft.formats, lines } })
}

fn read_header(text: &str) -> Result<SheetHeader> {
    let value: Value = serde_json::from_str(text)?;
    let text_of = |key: &str| value.get(key).and_then(Value::as_str).unwrap_or_default().to_string();
    Ok(SheetHeader { c2: text_of("C2"), a4: text_of("A4"), b4: text_of("B4"), c4: text_of("C4"), e4: text_of("E4") })
}

/// 保存した書式。読めない書式は無視する（帳票の内容は開ける）。
fn read_formats(text: &str) -> (HeaderFormats, HashMap<String, LineFormats>) {
    let Ok(value) = serde_json::from_str::<Value>(text) else { return Default::default() };
    let Some(formats) = value.get("formats") else { return Default::default() };
    let header = formats.get("header").and_then(|v| parse_header_formats(v).ok()).unwrap_or_default();
    let lines = formats.get("lines").and_then(Value::as_object).map(|lines| lines.iter().filter_map(|(id, v)| parse_line_formats(v).ok().map(|f| (id.clone(), f))).collect()).unwrap_or_default();
    (header, lines)
}

fn insert_line(store: &Store, line: &LineInput, id: &str, document_id: &str, position: usize) -> Result<()> {
    store.conn().execute(
        "INSERT INTO document_lines (id, document_id, position, material_id, source_item_id, name, model, manufacturer, quantity, remarks, delivery_state, mark_output, observed_mark, rule_version) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
        params![id, document_id, position as i64, line.material_id, line.source_item_id, line.name, line.model, line.manufacturer, line.quantity, line.remarks, line.delivery_state, line.mark_output, line.observed_mark, line.rule_version],
    )?;
    Ok(())
}

/// documentRepository.create
pub fn create_document(store: &Store, draft: &DraftInput, allocated: Option<(&[String], Option<&str>)>) -> Result<String> {
    if draft.lines.iter().any(|line| line.id.is_some()) { return Err(Error::db(DbCode::Validation, "新規帳票に既存明細IDは指定できません。")); }
    if let Some((ids, _)) = allocated {
        if ids.len() != draft.lines.len() || ids.iter().collect::<HashSet<_>>().len() != ids.len() { return Err(Error::db(DbCode::Validation, "明細IDの数または重複を確認してください。")); }
    }
    let id = js::random_uuid();
    let now = js::iso_now();
    let duplicated_from = match allocated.and_then(|(_, from)| from) { Some(from) if !from.is_empty() => { if !js::is_uuid(from) { return Err(Error::invalid("duplicatedFromId")); } Some(from.to_string()) } _ => None };
    store.transaction(Tx::Deferred, || {
        let mut line_ids = Vec::with_capacity(draft.lines.len());
        for position in 0..draft.lines.len() {
            line_ids.push(match allocated.and_then(|(ids, _)| ids.get(position)) { Some(given) => { if !js::is_uuid(given) { return Err(Error::invalid("lineId")); } given.clone() } None => js::random_uuid() });
        }
        store.conn().execute(
            "INSERT INTO documents (id, title, header, revision, template_version, duplicated_from_id, archived, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)",
            params![id, draft.title, header_json(draft, &line_ids), 1, draft.template_version, duplicated_from, 0, now, now],
        )?;
        for (position, (line, line_id)) in draft.lines.iter().zip(&line_ids).enumerate() {
            insert_line(store, line, line_id, &id, position)?;
        }
        Ok(id.clone())
    })
}

/// documentRepository.get
pub fn get_document(store: &Store, id: &str) -> Result<StoredDocument> {
    if !js::is_uuid(id) { return Err(Error::invalid("documentId")); }
    store.transaction(Tx::Deferred, || {
        let document = optional(store.conn().query_row(
            "SELECT id, title, header, revision, template_version, duplicated_from_id, archived, created_at, updated_at FROM documents WHERE id = ?", [id],
            |row| Ok((row.get::<_, String>(0)?, row.get::<_, String>(1)?, row.get::<_, String>(2)?, row.get::<_, i64>(3)?, row.get::<_, String>(4)?, row.get::<_, Option<String>>(5)?, row.get::<_, i64>(6)?, row.get::<_, String>(7)?, row.get::<_, String>(8)?)),
        ))?.ok_or_else(|| Error::db(DbCode::NotFound, "帳票が見つかりません。"))?;
        let mut statement = store.conn().prepare("SELECT id, document_id, position, material_id, source_item_id, name, model, manufacturer, quantity, remarks, delivery_state, mark_output, observed_mark, rule_version FROM document_lines WHERE document_id = ? ORDER BY position ASC")?;
        let lines = statement.query_map([id], |row| Ok(StoredLine {
            line: InvoiceLine { id: row.get(0)?, material_id: row.get(3)?, source_item_id: row.get(4)?, name: row.get(5)?, model: row.get(6)?, manufacturer: row.get(7)?, quantity: row.get(8)?, remarks: row.get(9)?, delivery_state: row.get(10)?, mark_output: row.get(11)?, observed_mark: row.get(12)?, rule_version: row.get(13)?, formats: LineFormats::default() },
            document_id: row.get(1)?, position: row.get(2)?,
        }))?.collect::<std::result::Result<Vec<_>, _>>()?;
        let (formats, mut line_formats) = read_formats(&document.2);
        let lines = lines.into_iter().map(|mut stored| { stored.line.formats = line_formats.remove(&stored.line.id).unwrap_or_default(); stored }).collect();
        Ok(StoredDocument { id: document.0, title: document.1, header: read_header(&document.2)?, formats, revision: document.3, template_version: document.4, duplicated_from_id: document.5, archived: flag(document.6), created_at: document.7, updated_at: document.8, lines })
    })
}

/// documentRepository.save
pub fn save_document(store: &Store, id: &str, expected_revision: i64, draft: &DraftInput, allocated: &[String]) -> Result<i64> {
    if !js::is_uuid(id) || expected_revision < 1 { return Err(Error::invalid("document save")); }
    store.transaction(Tx::Deferred, || {
        let mut statement = store.conn().prepare("SELECT id FROM document_lines WHERE document_id = ?")?;
        let existing: HashSet<String> = statement.query_map([id], |row| row.get(0))?.collect::<std::result::Result<_, _>>()?;
        let permitted: HashSet<&String> = allocated.iter().collect();
        let supplied: Vec<&String> = draft.lines.iter().filter_map(|line| line.id.as_ref()).collect();
        if supplied.iter().collect::<HashSet<_>>().len() != supplied.len() || supplied.iter().any(|line_id| !existing.contains(*line_id) && !permitted.contains(line_id)) {
            return Err(Error::db(DbCode::Validation, "明細IDの重複または親帳票の不一致です。"));
        }
        let line_ids: Vec<String> = draft.lines.iter().map(|line| line.id.clone().unwrap_or_else(js::random_uuid)).collect();
        let changed = store.conn().execute(
            "UPDATE documents SET title = ?, header = ?, template_version = ?, revision = ?, updated_at = ? WHERE id = ? AND revision = ?",
            params![draft.title, header_json(draft, &line_ids), draft.template_version, expected_revision + 1, js::iso_now(), id, expected_revision],
        )?;
        if changed != 1 { return Err(Error::db(DbCode::Conflict, "帳票は変更されています。再読込してください。")); }
        store.conn().execute("DELETE FROM document_lines WHERE document_id = ?", [id])?;
        for (position, (line, line_id)) in draft.lines.iter().zip(&line_ids).enumerate() {
            insert_line(store, line, line_id, id, position)?;
        }
        Ok(expected_revision + 1)
    })
}

/// 削除する帳票の ID の列（1〜100件・重複なし）。
pub fn parse_document_ids(value: &Value) -> Result<Vec<String>> {
    let items = validate::array(value, DELETE_MAX)?;
    if items.is_empty() { return Err(Error::invalid("documentIds")); }
    let ids = items.iter().map(validate::uuid).collect::<Result<Vec<_>>>()?;
    if ids.iter().collect::<HashSet<_>>().len() != ids.len() { return Err(Error::invalid("documentIds")); }
    Ok(ids)
}

/// 帳票と明細を1つのトランザクションで削除する（すべて削除するか、何も削除しない）。戻り値は削除した帳票の数。
/// 見つからない ID は削除済みとして扱う（応答が失われた後の再送を失敗にしない）。
/// 削除する帳票から複製した帳票は、複製元の参照だけを外す（内容・版・更新日時は変えない。外部キーは ON DELETE RESTRICT のため）。
pub fn delete_documents(store: &Store, ids: &[String]) -> Result<usize> {
    let placeholders = vec!["?"; ids.len()].join(",");
    store.transaction(Tx::Deferred, || {
        store.conn().execute(&format!("UPDATE documents SET duplicated_from_id = NULL WHERE duplicated_from_id IN ({placeholders})"), rusqlite::params_from_iter(ids))?;
        store.conn().execute(&format!("DELETE FROM document_lines WHERE document_id IN ({placeholders})"), rusqlite::params_from_iter(ids))?;
        Ok(store.conn().execute(&format!("DELETE FROM documents WHERE id IN ({placeholders})"), rusqlite::params_from_iter(ids))?)
    })
}

// ---- 編集セッション（documents/service.ts） ----

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct HistoryItem {
    pub id: String, pub title: String, pub updated_at: String, pub revision: i64, pub duplicated_from_id: Option<String>, pub c2: String,
    pub line_count: usize, pub issue_count: usize, pub exported_revision: Option<i64>, pub exported_at: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct History { pub items: Vec<HistoryItem>, pub page: i64, pub has_more: bool }

struct ActiveSession { view: EditorSession, lines: HashMap<String, InvoiceLine>, last: Option<(String, SaveReceipt)> }

#[derive(Default)]
pub struct DocumentEditor { active: Option<ActiveSession>, duplicate_source: Option<String> }

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct SaveBody<'a> { session_id: &'a str, request_number: i64, generation: i64, expected_revision: i64, draft: &'a DraftInput }

impl DocumentEditor {
    fn current(&mut self, id: &str) -> Result<&mut ActiveSession> {
        match &mut self.active {
            Some(active) if active.view.session_id == id => Ok(active),
            _ => Err(Error::db(DbCode::Conflict, "編集セッションが変わりました。入力を保持して再表示してください。")),
        }
    }

    pub fn open(&mut self, store: &Store, input: &Value, duplicate: bool) -> Result<EditorSession> {
        let id = validate::nullable(input, validate::uuid)?;
        let saved = match &id { Some(id) => Some(get_document(store, id)?), None => None };
        let lines: Vec<InvoiceLine> = saved.as_ref().map(|doc| doc.lines.iter().map(|stored| {
            let mut line = stored.line.clone();
            if duplicate { line.id = js::random_uuid(); }
            line
        }).collect()).unwrap_or_default();
        let view = EditorSession {
            session_id: js::random_uuid(),
            document_id: if duplicate { None } else { id.clone() },
            revision: if duplicate { 0 } else { saved.as_ref().map(|doc| doc.revision).unwrap_or(0) },
            draft: InvoiceDraft {
                title: saved.as_ref().map(|doc| doc.title.clone()).unwrap_or_default(),
                header: saved.as_ref().map(|doc| doc.header.clone()).unwrap_or_default(),
                template_version: saved.as_ref().map(|doc| doc.template_version.clone()).unwrap_or_else(|| "excel-v1".into()),
                lines: lines.clone(),
                formats: saved.as_ref().map(|doc| doc.formats.clone()).unwrap_or_default(),
            },
        };
        if js::json_bytes(&view) > 1_048_576 || lines.len() > MAX_LINES { return Err(Error::db(DbCode::Validation, "帳票は編集画面の上限（500行・1MiB）を超えています。元の保存内容は保持されています。")); }
        self.active = Some(ActiveSession { view: view.clone(), lines: lines.into_iter().map(|line| (line.id.clone(), line)).collect(), last: None });
        self.duplicate_source = if duplicate { id } else { None };
        Ok(view)
    }

    /// 帳票を削除する。開いている帳票を削除したときは編集セッションを閉じ、保存前の複製の複製元を削除したときは複製元の記録を外す。
    pub fn delete(&mut self, store: &Store, ids: &[String]) -> Result<usize> {
        let deleted = delete_documents(store, ids)?;
        if self.active.as_ref().and_then(|active| active.view.document_id.as_ref()).is_some_and(|id| ids.contains(id)) { self.active = None; }
        if self.duplicate_source.as_ref().is_some_and(|id| ids.contains(id)) { self.duplicate_source = None; }
        Ok(deleted)
    }

    pub fn duplicate(&mut self, store: &Store, input: &Value) -> Result<EditorSession> {
        let id = validate::uuid(input)?;
        self.open(store, &Value::String(id), true)
    }

    pub fn list(&self, store: &Store, page: &Value, filter: Option<&Value>, meta: Option<&UiMeta>) -> Result<History> {
        let page = validate::int_range(page, 0, 100_000)?;
        let query = match filter { None => String::new(), Some(value) => js::trim(&validate::no_nul(validate::string(value, 0, QUERY_MAX)?)?).to_string() };
        let pattern = format!("%{}%", escape_like(&query));
        let filter_sql = if query.is_empty() { "" } else { " WHERE (title LIKE ?2 ESCAPE '\\' OR json_extract(header, '$.C2') LIKE ?2 ESCAPE '\\')" };
        let fetch = LIST_PAGE_SIZE + 1;
        let sql = format!("SELECT id, title, header, template_version, updated_at, revision, duplicated_from_id FROM documents{filter_sql} ORDER BY updated_at DESC, id DESC LIMIT {fetch} OFFSET ?1");
        let mut statement = store.conn().prepare(&sql)?;
        let map = |row: &rusqlite::Row| Ok((row.get::<_, String>(0)?, row.get::<_, String>(1)?, row.get::<_, String>(2)?, row.get::<_, String>(3)?, row.get::<_, String>(4)?, row.get::<_, i64>(5)?, row.get::<_, Option<String>>(6)?));
        let rows = if query.is_empty() { statement.query_map(params![page * LIST_PAGE_SIZE as i64], map)?.collect::<std::result::Result<Vec<_>, _>>()? } else { statement.query_map(params![page * LIST_PAGE_SIZE as i64, pattern], map)?.collect::<std::result::Result<Vec<_>, _>>()? };
        let visible = &rows[..rows.len().min(LIST_PAGE_SIZE)];
        let mut lines: Vec<(String, String, String, String)> = Vec::new();
        if !visible.is_empty() {
            let placeholders = vec!["?"; visible.len()].join(",");
            let mut statement = store.conn().prepare(&format!("SELECT document_id, delivery_state, mark_output, rule_version FROM document_lines WHERE document_id IN ({placeholders})"))?;
            lines = statement.query_map(rusqlite::params_from_iter(visible.iter().map(|row| row.0.clone())), |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?, row.get(3)?)))?.collect::<std::result::Result<_, _>>()?;
        }
        let mut items = Vec::with_capacity(visible.len());
        for (id, title, header, template_version, updated_at, revision, duplicated_from_id) in visible {
            let header = read_header(header)?;
            let own: Vec<_> = lines.iter().filter(|line| &line.0 == id).collect();
            // 件数だけを使うため、文言に使う品名は読み込まない。
            let issue_count = blocking_issues(template_version, &header.e4, own.iter().map(|line| LineCheck { name: "", delivery_state: &line.1, mark_output: &line.2, rule_version: &line.3 })).len();
            let exported = meta.and_then(|meta| meta.export_of(id));
            items.push(HistoryItem {
                id: id.clone(), title: title.clone(), updated_at: updated_at.clone(), revision: *revision, duplicated_from_id: duplicated_from_id.clone(), c2: header.c2.clone(),
                line_count: own.len(), issue_count, exported_revision: exported.as_ref().map(|e| e.revision), exported_at: exported.map(|e| e.at),
            });
        }
        Ok(History { items, page, has_more: rows.len() > LIST_PAGE_SIZE })
    }

    pub fn add_line(&mut self, store: &Store, input: &Value) -> Result<InvoiceLine> {
        let o = validate::strict(input, &["sessionId", "materialId"])?;
        let session_id = o.uuid("sessionId")?;
        let material_id = o.nullable_uuid("materialId")?;
        let session = self.current(&session_id)?;
        if session.lines.len() >= 2_000 { return Err(Error::db(DbCode::Validation, "この編集セッションの追加上限です。保存して開き直してください。")); }
        let material = match &material_id { Some(id) => materials::find(store, id)?, None => None };
        if material_id.is_some() && !material.as_ref().is_some_and(|m| m.active) { return Err(Error::db(DbCode::NotFound, "材料が見つからないか無効です。再検索してください。")); }
        let field = |f: fn(&materials::MaterialRow) -> &str| material.as_ref().map(|m| f(m).to_string()).unwrap_or_default();
        let line = InvoiceLine {
            id: js::random_uuid(), material_id, source_item_id: material.as_ref().and_then(|m| m.last_source_item_id.clone()),
            name: field(|m| &m.values.name), model: field(|m| &m.values.model), manufacturer: field(|m| &m.values.manufacturer), quantity: field(|m| &m.values.quantity), remarks: field(|m| &m.values.remarks),
            delivery_state: "unknown".into(), mark_output: "unresolved".into(), observed_mark: None, rule_version: "provisional-v1".into(), formats: LineFormats::default(),
        };
        session.lines.insert(line.id.clone(), line.clone());
        Ok(line)
    }

    pub fn save(&mut self, store: &Store, input: &Value) -> Result<SaveReceipt> {
        if js::json_bytes(input) > 1_048_576 { return Err(Error::db(DbCode::Validation, "保存内容は1MiB以内にしてください。")); }
        let o = validate::strict(input, &["sessionId", "requestNumber", "generation", "expectedRevision", "draft"])?;
        let session_id = o.uuid("sessionId")?;
        let request_number = o.int("requestNumber")?;
        let generation = o.int("generation")?;
        let expected_revision = o.int("expectedRevision")?;
        if request_number < 1 || generation < 0 || expected_revision < 0 { return Err(Error::invalid("save numbers")); }
        let draft = parse_draft(o.req("draft")?, true, MAX_LINES)?;
        let duplicate_source = self.duplicate_source.clone();
        let session = self.current(&session_id)?;
        let body = js::stringify(&SaveBody { session_id: &session_id, request_number, generation, expected_revision, draft: &draft });
        if let Some((last_body, receipt)) = &session.last {
            if request_number == receipt.request_number && &body == last_body { return Ok(receipt.clone()); }
        }
        let last = session.last.as_ref().map(|(_, receipt)| receipt);
        if request_number != last.map(|r| r.request_number).unwrap_or(0) + 1 || last.is_some_and(|r| generation <= r.generation) || expected_revision != session.view.revision {
            return Err(Error::db(DbCode::Conflict, "保存要求の順序または版が一致しません。入力を保持し、保存結果を確認してください。"));
        }
        if draft.template_version != session.view.draft.template_version { return Err(Error::db(DbCode::Validation, "帳票形式を変更できません。")); }
        let mut ids = HashSet::new();
        for line in &draft.lines {
            let id = line.id.clone().unwrap_or_default();
            let origin = session.lines.get(&id);
            let Some(origin) = origin.filter(|o| !ids.contains(&id) && line.material_id == o.material_id && line.source_item_id == o.source_item_id && line.observed_mark == o.observed_mark && line.rule_version == o.rule_version) else {
                return Err(Error::db(DbCode::Validation, "明細IDまたは出典が一致しません。"));
            };
            ids.insert(id);
            let unchanged = line.delivery_state == origin.delivery_state && line.mark_output == origin.mark_output;
            if !unchanged && check_output(&line.delivery_state) != Some(line.mark_output.as_str()) { return Err(Error::db(DbCode::Validation, "チェック状態と記号の組合せを確認してください。")); }
        }
        let view = session.view.clone();
        let receipt = store.transaction(Tx::Deferred, || {
            let (document_id, revision) = match &view.document_id {
                None => {
                    let mut stripped = draft.clone();
                    let line_ids: Vec<String> = stripped.lines.iter_mut().map(|line| line.id.take().unwrap_or_default()).collect();
                    (create_document(store, &stripped, Some((&line_ids, duplicate_source.as_deref())))?, 1)
                }
                Some(id) => {
                    let allocated: Vec<String> = draft.lines.iter().filter_map(|line| line.id.clone()).filter(|id| !view.draft.lines.iter().any(|previous| &previous.id == id)).collect();
                    (id.clone(), save_document(store, id, expected_revision, &draft, &allocated)?)
                }
            };
            Ok(SaveReceipt { session_id: session_id.clone(), document_id, revision, request_number, generation })
        })?;
        let session = self.current(&session_id)?;
        session.view = EditorSession {
            session_id: session.view.session_id.clone(), document_id: Some(receipt.document_id.clone()), revision: receipt.revision,
            draft: InvoiceDraft {
                title: draft.title.clone(), header: draft.header.clone(), template_version: draft.template_version.clone(),
                lines: draft.lines.iter().map(|line| InvoiceLine {
                    id: line.id.clone().unwrap_or_default(), material_id: line.material_id.clone(), source_item_id: line.source_item_id.clone(), name: line.name.clone(), model: line.model.clone(),
                    manufacturer: line.manufacturer.clone(), quantity: line.quantity.clone(), remarks: line.remarks.clone(), delivery_state: line.delivery_state.clone(), mark_output: line.mark_output.clone(),
                    observed_mark: line.observed_mark.clone(), rule_version: line.rule_version.clone(), formats: line.formats.clone(),
                }).collect(),
                formats: draft.formats.clone(),
            },
        };
        session.last = Some((body, receipt.clone()));
        Ok(receipt)
    }
}

/// LIKE の特殊文字（\ % _）を \ でエスケープする。
pub fn escape_like(text: &str) -> String {
    let mut out = String::with_capacity(text.len());
    for c in text.chars() { if matches!(c, '\\' | '%' | '_') { out.push('\\'); } out.push(c); }
    out
}
