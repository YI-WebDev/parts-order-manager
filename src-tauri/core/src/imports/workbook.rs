//! 材料Excel（.xlsx）の解析（src/main/imports/workbook.ts・zip.ts・xml.ts）。

use std::collections::HashMap;

use indexmap::IndexMap;
use regex::Regex;
use std::sync::LazyLock;

use super::cells::{formats, missing_cell, read_cell, text_runs};
use super::{import_error, limits, Budget, ImportCounts, OriginalCell, ParsedItem, ParsedWorkbook, RawCells};
use crate::error::{Error, ImportCode, Result};
use crate::js;
use crate::xml::{parse_xml, XmlNode};
use crate::zip::{Archive, ZipError};

const NS: &str = "http://schemas.openxmlformats.org/spreadsheetml/2006/main";
const HEADERS: [&str; 6] = ["品名", "形式又はタイプ", "メーカー", "数量", "備考", "単価"];
const LEFT: [&str; 6] = ["A", "B", "C", "D", "E", "F"];
const RIGHT: [&str; 6] = ["H", "I", "J", "K", "L", "M"];

static KEPT_PART: LazyLock<Regex> = LazyLock::new(|| Regex::new(r"^(\[Content_Types\]\.xml|xl/workbook\.xml|xl/_rels/workbook\.xml\.rels|xl/styles\.xml|xl/sharedStrings\.xml|xl/worksheets/[^/]+\.xml)$").expect("regex"));
static FORBIDDEN_PART: LazyLock<Regex> = LazyLock::new(|| Regex::new(r"(?i)vbaProject|externalLinks/|embeddings/").expect("regex"));
static FORBIDDEN_TYPE: LazyLock<Regex> = LazyLock::new(|| Regex::new(r"(?i)macroEnabled|vbaProject|oleObject").expect("regex"));
static SHEET_PART: LazyLock<Regex> = LazyLock::new(|| Regex::new(r"^xl/worksheets/[^/]+\.xml$").expect("regex"));
static CELL_REF: LazyLock<Regex> = LazyLock::new(|| Regex::new(r"^([A-Z]{1,3})([1-9][0-9]{0,6})$").expect("regex"));
static ANY_REF: LazyLock<Regex> = LazyLock::new(|| Regex::new(r"^([A-Z]+)([0-9]+)$").expect("regex"));

/// 見出しの比較用（NFKC・空白を除く）。
pub fn heading(value: &str) -> String { js::remove_spaces(&js::nfkc(value)) }

fn nonempty(cell: &OriginalCell) -> bool { cell.raw_value.as_deref().is_some_and(|v| !v.is_empty()) || cell.kind == "formula" }

/// 行の値（登録・確認の表示に使う材料の6項目と補足セルの値）。表示文字列の前後の空白（全角・半角）を除く（利用者の指示、2026年10月15日）。
/// 原セル（raw_cells の displayText）は表示文字列のまま残し、「原セルを確認」で見られる。
pub fn cell_value(cell: &OriginalCell) -> String { js::trim(&cell.display_text).to_string() }

/// ZIP から必要な部品だけを取り出す（readParts）。
pub fn read_parts(bytes: &[u8]) -> Result<HashMap<String, Vec<u8>>> {
    if bytes.len() > limits::FILE_BYTES { return Err(import_error(ImportCode::Limit, "Excelの容量が16 MiBを超えています。")); }
    // 中央ディレクトリの終端が読めない場合は旧実装でも取込の形式エラーに変換されていなかった。
    let mut archive = Archive::open(bytes).map_err(|e| Error::other(format!("zip: {}", e.message())))?;
    let zip_failure = |_: ZipError| import_error(ImportCode::Format, "ExcelのZIPを正常に読み取れません。");
    let mut parts = HashMap::new();
    let mut seen = std::collections::HashSet::new();
    let mut total: u64 = 0;
    while let Some(entry) = archive.next_entry() {
        let entry = entry.map_err(zip_failure)?;
        if seen.contains(&entry.file_name) { return Err(import_error(ImportCode::Format, "重複したZIP部品があります。")); }
        seen.insert(entry.file_name.clone());
        if seen.len() > limits::ENTRIES { return Err(import_error(ImportCode::Limit, "ZIPの部品数が上限を超えています。")); }
        let over = || import_error(ImportCode::Limit, "ZIPの展開量が上限を超えています。");
        // ZIP64 の展開後サイズは u64 全体を取り得るため、合計の桁あふれも上限超過として扱う。
        total = total.checked_add(entry.uncompressed_size).ok_or_else(over)?;
        if entry.uncompressed_size > limits::PART_BYTES || total > limits::INFLATED_BYTES { return Err(over()); }
        if (entry.external_file_attributes >> 16) & 0xf000 == 0xa000 || entry.is_encrypted() { return Err(import_error(ImportCode::Format, "リンクまたは暗号化されたZIP部品には対応していません。")); }
        if FORBIDDEN_PART.is_match(&entry.file_name) { return Err(import_error(ImportCode::Format, "マクロ・外部ブック参照・埋込ファイルには対応していません。")); }
        if entry.file_name.ends_with('/') { continue; }
        let content = archive.read_entry_data(&entry).map_err(zip_failure)?;
        if crc32fast::hash(&content) != entry.crc32 { return Err(import_error(ImportCode::Format, "ZIPのCRCが一致しません。")); }
        if KEPT_PART.is_match(&entry.file_name) { parts.insert(entry.file_name.clone(), content); }
    }
    Ok(parts)
}

fn required<'a>(parts: &'a HashMap<String, Vec<u8>>, name: &str) -> Result<&'a [u8]> {
    parts.get(name).map(Vec::as_slice).ok_or_else(|| import_error(ImportCode::Format, "必要なExcel部品がありません。"))
}

/// Node の path.posix.normalize（相対パスのみ）。
pub fn posix_normalize(path: &str) -> String {
    let trailing = path.ends_with('/');
    let mut parts: Vec<&str> = Vec::new();
    for segment in path.split('/') {
        match segment {
            "" | "." => {}
            ".." => { if parts.last().is_some_and(|last| *last != "..") { parts.pop(); } else { parts.push(".."); } }
            other => parts.push(other),
        }
    }
    let mut out = parts.join("/");
    if out.is_empty() { out = ".".into(); }
    if trailing { out.push('/'); }
    out
}

pub fn parse_workbook(bytes: &[u8]) -> Result<ParsedWorkbook> {
    let parts = read_parts(bytes)?;
    let content_types = parse_xml(required(&parts, "[Content_Types].xml")?)?;
    if content_types.children.iter().any(|node| FORBIDDEN_TYPE.is_match(node.attr("ContentType").unwrap_or(""))) { return Err(import_error(ImportCode::Format, "マクロ・埋込ファイルには対応していません。")); }
    let book = parse_xml(required(&parts, "xl/workbook.xml")?)?;
    if book.name != "workbook" || book.uri != NS { return Err(import_error(ImportCode::Format, "未対応のExcel形式です。")); }
    let sheets: Vec<&XmlNode> = book.child("sheets").unwrap_or(&book).children_named("sheet").collect();
    if sheets.is_empty() || sheets.len() > limits::SHEETS { return Err(import_error(ImportCode::Limit, "シート数が読取範囲外です。")); }
    let relationships = parse_xml(required(&parts, "xl/_rels/workbook.xml.rels")?)?;
    let strings = match parts.get("xl/sharedStrings.xml") { Some(part) => parse_xml(part)?.children_named("si").map(text_runs).collect::<Result<Vec<_>>>()?, None => Vec::new() };
    let styles = match parts.get("xl/styles.xml") { Some(part) => formats(Some(&parse_xml(part)?))?, None => formats(None)? };
    let mut items: Vec<ParsedItem> = Vec::new();
    let mut cells_budget = Budget::default();
    let mut items_budget = Budget::default();
    let mut append = |items: &mut Vec<ParsedItem>, item: ParsedItem| -> Result<()> {
        if items.len() >= limits::ITEMS { return Err(import_error(ImportCode::Limit, "取込項目数が上限を超えています。")); }
        items_budget.add(&item)?;
        items.push(item);
        Ok(())
    };
    let (mut empty, mut cell_count, mut material_sheets) = (0i64, 0usize, 0usize);
    for (sheet_index, sheet) in sheets.iter().enumerate() {
        let sheet_name = match sheet.attr("name") { Some(name) if !name.is_empty() && js::len16(name) <= 1000 => name.to_string(), _ => return Err(import_error(ImportCode::Format, "シート名が不正です。")) };
        let relation_id = sheet.attrs.iter().find(|(key, _)| *key == "r:id" || key.ends_with(":id")).map(|(_, value)| value.as_str());
        let relation = relationships.children.iter().find(|node| node.attr("Id") == relation_id);
        let target = relation.and_then(|r| r.attr("Target"));
        let Some(target) = target.filter(|t| !t.is_empty()) else { return Err(import_error(ImportCode::Format, "シート参照が不正です。")) };
        let relation = relation.expect("target implies relation");
        if relation.attr("TargetMode") == Some("External") || !relation.attr("Type").is_some_and(|t| t.ends_with("/worksheet")) { return Err(import_error(ImportCode::Format, "シート参照が不正です。")); }
        let part = match target.strip_prefix('/') { Some(rest) => rest.to_string(), None => posix_normalize(&format!("xl/{target}")) };
        if !SHEET_PART.is_match(&part) { return Err(import_error(ImportCode::Format, "シート参照先が許可範囲外です。")); }
        let root = parse_xml(required(&parts, &part)?)?;
        if root.name != "worksheet" || root.uri != NS { return Err(import_error(ImportCode::Format, "未対応のシート構造です。")); }
        let mut cells: IndexMap<String, OriginalCell> = IndexMap::new();
        let mut max_row: i64 = 1;
        let Some(sheet_data) = root.child("sheetData") else { return Err(import_error(ImportCode::Format, "シートのセル領域がありません。")) };
        for row in sheet_data.children_named("row") {
            let hidden = matches!(row.attr("hidden"), Some("1") | Some("true"));
            for node in row.children_named("c") {
                let reference = node.attr("r");
                let captures = reference.and_then(|r| CELL_REF.captures(r));
                let (Some(reference), Some(captures)) = (reference, captures) else { return Err(import_error(ImportCode::Format, "セル座標が不正または重複しています。")) };
                if cells.contains_key(reference) { return Err(import_error(ImportCode::Format, "セル座標が不正または重複しています。")); }
                let row_index: i64 = captures[2].parse().unwrap_or(i64::MAX);
                cell_count += 1;
                if cell_count > limits::CELLS || row_index > 10_000 { return Err(import_error(ImportCode::Limit, "セル数または行数が上限を超えています。")); }
                let cell = read_cell(node, &strings, &styles)?;
                cells_budget.add(&cell)?;
                if nonempty(&cell) { max_row = max_row.max(row_index); }
                let stored = if hidden { OriginalCell { display_verified: false, ..cell } } else { cell };
                cells.insert(reference.to_string(), stored);
            }
        }
        let missing = missing_cell();
        let at = |reference: &str| cells.get(reference).unwrap_or(&missing);
        if sheet_name == "請求書" && ["品名", "形式又はタイプ", "メーカー", "数量", "備考"].iter().enumerate().all(|(i, name)| heading(&at(&format!("{}5", (b'B' + i as u8) as char)).display_text) == heading(name)) { continue; }
        let blocks = [("left", LEFT), ("right", RIGHT)];
        if !blocks.iter().all(|(_, columns)| columns.iter().enumerate().all(|(i, column)| heading(&at(&format!("{column}1")).display_text) == heading(HEADERS[i]))) {
            return Err(import_error(ImportCode::Format, &format!("材料表の左右の見出しを確認できません（シート順{}）。", sheet_index + 1)));
        }
        material_sheets += 1;
        let hidden_sheet = sheet.attr("state").is_some_and(|state| state != "visible");
        let unusual = hidden_sheet || root.child("mergeCells").is_some() || root.child("cols").unwrap_or(&root).children_named("col").any(|col| matches!(col.attr("hidden"), Some("1") | Some("true")));
        for row_index in 1..=max_row {
            for (block, columns) in &blocks {
                let raw_cells: RawCells = columns.iter().map(|column| (column.to_string(), at(&format!("{column}{row_index}")).clone())).collect();
                let values: Vec<String> = raw_cells.values().map(cell_value).collect();
                if !raw_cells.values().any(nonempty) { empty += 1; continue; }
                let header = values.iter().enumerate().all(|(i, value)| heading(value) == heading(HEADERS[i]));
                let safe = !unusual && raw_cells.values().all(|cell| cell.display_verified && cell.kind != "formula");
                let complete = !values[0].is_empty() && !values[1].is_empty();
                let classification = if header && safe { "header" } else if safe && complete { "candidate" } else { "held" };
                let reason = if classification == "header" { "列見出し" } else if !safe { "数式・未対応表示形式・非表示等を要確認" } else if !complete { "品名または形式が未記入" } else { "品名・形式を確認" };
                append(&mut items, ParsedItem { kind: "row".into(), sheet_name: sheet_name.clone(), sheet_order: sheet_index as i64 + 1, row_index, block: block.to_string(), cell_address: None, raw_cells, values, classification: classification.into(), reason: reason.into() })?;
            }
        }
        for (reference, cell) in &cells {
            let Some(captures) = ANY_REF.captures(reference) else { continue };
            let column = &captures[1];
            if !nonempty(cell) || (column != "G" && column.len() == 1 && ("A"..="M").contains(&column)) { continue; }
            let mut raw_cells = RawCells::new();
            raw_cells.insert(reference.clone(), cell.clone());
            append(&mut items, ParsedItem {
                kind: "supplement".into(), sheet_name: sheet_name.clone(), sheet_order: sheet_index as i64 + 1, row_index: captures[2].parse().unwrap_or(0), block: "supplement".into(),
                cell_address: Some(reference.clone()), raw_cells, values: vec![cell_value(cell)], classification: "supplement".into(), reason: "左右の関連先が未確定の補足セル".into(),
            })?;
        }
        if items.len() > limits::ITEMS { return Err(import_error(ImportCode::Limit, "取込項目数が上限を超えています。")); }
    }
    if material_sheets == 0 { return Err(import_error(ImportCode::Format, "材料表がありません。")); }
    let count = |classification: &str| items.iter().filter(|item| item.classification == classification).count() as i64;
    let counts = ImportCounts { candidates: count("candidate"), held: count("held"), supplements: count("supplement"), excluded: count("header"), empty, applied: 0 };
    Ok(ParsedWorkbook { items, counts })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn posix_normalize_matches_node() {
        assert_eq!(posix_normalize("xl/worksheets/../worksheets/./sheet1.xml"), "xl/worksheets/sheet1.xml");
        assert_eq!(posix_normalize("xl/../../outside.xml"), "../outside.xml");
        assert_eq!(posix_normalize("xl//a/"), "xl/a/");
        assert_eq!(posix_normalize("xl/a/.."), "xl");
    }

    #[test]
    fn headings_ignore_width_and_spaces() {
        assert_eq!(heading("形式又はﾀｲﾌﾟ "), heading("形式又はタイプ"));
    }
}
