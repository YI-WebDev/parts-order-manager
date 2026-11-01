//! 請求書のExcel出力（src/main/exports）。

pub mod files;

use std::collections::HashMap;
use std::sync::LazyLock;

use regex::Regex;
use serde::Serialize;
use serde_json::Value;

use crate::db::Store;
use crate::documents::get_document;
use crate::error::{DbCode, Error, Result, WorkbookCode};
use crate::format::{parse_format, CellFormat, HeaderFormats};
use crate::js;
use crate::sheet::{
    cell_style, column_name, entered, line_mark, resolve, row_height, sheet_cells, style_index, valid_date_text, Align, Border, Resolved, SheetCell, SheetHeader, SheetLine, SheetValue, StyleName,
    BOTH_MARK, COLUMN_WIDTHS, DEFAULT_ROW_HEIGHT, FONTS, LINE_ROWS, NUMBER_FORMATS, PRINT_COLUMNS, SHEET_NAME, SHEET_ROWS, STYLE_NAMES,
};
use crate::validate;
use crate::zip::Archive;

pub const LAYOUT_VERSION: &str = "sample-layout-v2";
pub const SPREADSHEET_NS: &str = "http://schemas.openxmlformats.org/spreadsheetml/2006/main";
pub const REL_NS: &str = "http://schemas.openxmlformats.org/officeDocument/2006/relationships";
pub const PACKAGE_REL_NS: &str = "http://schemas.openxmlformats.org/package/2006/relationships";
pub const TEMPLATE_VERSION: &str = "excel-v1";
const XML_LIMIT: usize = 2 * 1024 * 1024;

// ---- layout.ts（固定の構造だけ。入力値はスタイル・URL・名前・ZIP部品に使わない） ----

fn xml_attr(value: &str) -> String { value.replace('&', "&amp;").replace('"', "&quot;").replace('<', "&lt;").replace('>', "&gt;") }

fn edge(side: &str, value: Option<crate::sheet::Edge>) -> String {
    match value { Some(style) => format!("<{side} style=\"{}\"><color indexed=\"64\"/></{side}>", style.as_str()), None => format!("<{side}/>") }
}

fn border_xml(border: &Border) -> String {
    format!("<border>{}{}{}{}<diagonal/></border>", edge("left", border.left), edge("right", border.right), edge("top", border.top), edge("bottom", border.bottom))
}

fn borders() -> Vec<String> {
    let mut seen = Vec::new();
    for name in STYLE_NAMES { let xml = border_xml(&cell_style(name).border); if !seen.contains(&xml) { seen.push(xml); } }
    seen
}

fn font_xml(resolved: &Resolved) -> String {
    let font = &FONTS[resolved.base.font];
    format!(
        "<font>{}{}{}<sz val=\"{}\"/>{}<name val=\"{}\"/><family val=\"{}\"/><charset val=\"128\"/></font>",
        if resolved.bold { "<b/>" } else { "" }, if resolved.italic { "<i/>" } else { "" }, if resolved.underline { "<u/>" } else { "" }, resolved.size,
        resolved.color.as_ref().map(|code| format!("<color rgb=\"FF{code}\"/>")).unwrap_or_default(), font.name, font.family,
    )
}

fn fill_xml(code: &str) -> String { format!("<fill><patternFill patternType=\"solid\"><fgColor rgb=\"FF{code}\"/><bgColor indexed=\"64\"/></patternFill></fill>") }

/// 書式を付けたセルの xf（帳票の既定の xf の後ろに足す）。styles.xml の内容は、帳票の既定の書式と、この並びだけで決まる。
pub type ExtraStyle = (StyleName, CellFormat);

/// styles.xml の内容。extras が空なら帳票の既定の書式だけ（STYLES）。
/// 書式を付けたセルがあれば、その組合せをコメントに記録する（上書き保存の前に、既存ファイルの styles.xml が
/// このアプリの作ったものかを、記録から作り直して一致するかで確かめるため）。
pub fn styles_xml(extras: &[ExtraStyle]) -> String { styles_xml_for(cell_style, extras) }

/// 帳票の既定の書式 default_of（今の既定、または以前の版の既定）で組む styles.xml。
fn styles_xml_for(default_of: fn(StyleName) -> crate::sheet::CellStyle, extras: &[ExtraStyle]) -> String {
    let borders = borders();
    let xf = |num_fmt: u32, font: usize, fill: usize, border: &Border, align: Align, vertical: Option<crate::format::Vertical>, indent: Option<u32>| {
        let border = borders.iter().position(|b| *b == border_xml(border)).map(|i| i as i64).unwrap_or(-1);
        let alignment = if align == Align::General && vertical.is_none() && indent.is_none() { String::new() } else {
            format!(
                "<alignment{}{}{}/>",
                if align == Align::General { String::new() } else { format!(" horizontal=\"{}\"", align.as_str()) },
                vertical.map(|v| format!(" vertical=\"{}\"", v.as_str())).unwrap_or_default(), indent.map(|i| format!(" indent=\"{i}\"")).unwrap_or_default(),
            )
        };
        format!(
            "<xf numFmtId=\"{num_fmt}\" fontId=\"{font}\" fillId=\"{fill}\" borderId=\"{border}\" xfId=\"0\"{}{}{} applyBorder=\"1\"{}>{alignment}</xf>",
            if num_fmt != 0 { " applyNumberFormat=\"1\"" } else { "" }, if font != 0 { " applyFont=\"1\"" } else { "" }, if fill != 0 { " applyFill=\"1\"" } else { "" },
            if alignment.is_empty() { "" } else { " applyAlignment=\"1\"" },
        )
    };
    let num_fmts: String = NUMBER_FORMATS.iter().map(|f| format!("<numFmt numFmtId=\"{}\" formatCode=\"{}\"/>", f.id, xml_attr(f.code))).collect();
    let mut fonts: Vec<String> = FONTS.iter().map(|f| format!("<font><sz val=\"{}\"/><name val=\"{}\"/><family val=\"{}\"/><charset val=\"128\"/></font>", f.size, f.name, f.family)).collect();
    let mut fills: Vec<String> = vec!["<fill><patternFill patternType=\"none\"/></fill>".into(), "<fill><patternFill patternType=\"gray125\"/></fill>".into()];
    let mut xfs: String = STYLE_NAMES.iter().map(|name| { let style = default_of(*name); xf(style.num_fmt, style.font, 0, &style.border, style.align, None, style.indent) }).collect();
    for (name, format) in extras {
        let resolved = resolve(*name, Some(format));
        let font = if resolved.font_changed() {
            let xml = font_xml(&resolved);
            fonts.iter().position(|f| *f == xml).unwrap_or_else(|| { fonts.push(xml); fonts.len() - 1 })
        } else { resolved.base.font };
        let fill = resolved.fill.as_deref().map(|code| { let xml = fill_xml(code); fills.iter().position(|f| *f == xml).unwrap_or_else(|| { fills.push(xml); fills.len() - 1 }) }).unwrap_or(0);
        xfs += &xf(resolved.base.num_fmt, font, fill, &resolved.base.border, resolved.align, resolved.vertical, resolved.indent);
    }
    let record = if extras.is_empty() { String::new() } else {
        let list: Vec<(usize, &CellFormat)> = extras.iter().map(|(name, format)| (style_index(*name), format)).collect();
        format!("<!-- {STYLES_RECORD}{} -->", js::stringify(&list))
    };
    format!(
        "<styleSheet xmlns=\"{SPREADSHEET_NS}\">{record}\n<numFmts count=\"{}\">{num_fmts}</numFmts>\n<fonts count=\"{}\">{}</fonts>\n<fills count=\"{}\">{}</fills>\n<borders count=\"{}\">{}</borders>\n<cellStyleXfs count=\"1\"><xf numFmtId=\"0\" fontId=\"0\" fillId=\"0\" borderId=\"0\"/></cellStyleXfs>\n<cellXfs count=\"{}\">{xfs}</cellXfs>\n<cellStyles count=\"1\"><cellStyle name=\"標準\" xfId=\"0\" builtinId=\"0\"/></cellStyles></styleSheet>",
        NUMBER_FORMATS.len(), fonts.len(), fonts.join(""), fills.len(), fills.join(""), borders.len(), borders.join(""), STYLE_NAMES.len() + extras.len(),
    )
}

const STYLES_RECORD: &str = "parts-order-manager:formats ";

/// 帳票の既定の書式だけの styles.xml（バックアップの目録にも埋める）。
pub static STYLES: LazyLock<String> = LazyLock::new(|| styles_xml(&[]));

/// 2026年10月15日より前の既定（見本の左揃え・字下げ）だけの styles.xml。以前の版で作ったバックアップの目録はこれを埋めているため、検査で受け付ける。
pub static LEGACY_STYLES: LazyLock<String> = LazyLock::new(|| styles_xml_for(crate::sheet::legacy_cell_style, &[]));

/// styles.xml がこのアプリの出力したものか（帳票の既定の書式、または記録した書式から作り直して同じ内容になるもの）。
pub fn generated_styles(bytes: &[u8]) -> bool {
    if bytes == STYLES.as_bytes() { return true; }
    let Ok(text) = std::str::from_utf8(bytes) else { return false };
    let Some(rest) = text.strip_prefix(&format!("<styleSheet xmlns=\"{SPREADSHEET_NS}\"><!-- {STYLES_RECORD}")) else { return false };
    let Some((record, _)) = rest.split_once(" -->") else { return false };
    let Ok(Value::Array(items)) = serde_json::from_str::<Value>(record) else { return false };
    let mut extras = Vec::with_capacity(items.len());
    for item in &items {
        let Value::Array(pair) = item else { return false };
        let [index, format] = pair.as_slice() else { return false };
        let Some(name) = index.as_u64().and_then(|i| STYLE_NAMES.get(i as usize)) else { return false };
        let Ok(format) = parse_format(format) else { return false };
        extras.push((*name, format));
    }
    !extras.is_empty() && styles_xml(&extras).as_bytes() == bytes
}

// ---- workbook.ts ----

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PrintModel {
    pub document_id: String, pub revision: i64, pub template_version: String, pub header: SheetHeader, pub lines: Vec<SheetLine>,
    /// 帳票上部の入力欄の書式（明細の書式は lines の各行が持つ）。
    #[serde(skip_serializing_if = "HeaderFormats::is_empty")]
    pub formats: HeaderFormats,
}

static ESCAPED_RUN: LazyLock<Regex> = LazyLock::new(|| Regex::new(r"_x[0-9A-Fa-f]{4}_").expect("regex"));

fn text_xml(value: &str) -> Result<String> {
    if js::len16(value) > 32767 || value.split('\n').count() > 254 { return Err(Error::Workbook(WorkbookCode::Limit)); }
    for c in value.chars() {
        let code = c as u32;
        if (code < 32 && code != 9 && code != 10 && code != 13) || code == 0xfffe || code == 0xffff { return Err(Error::Workbook(WorkbookCode::Text)); }
    }
    let escaped = ESCAPED_RUN.replace_all(value, |m: &regex::Captures| format!("_x005F_{}", &m[0][1..]));
    Ok(escaped.replace('&', "&amp;").replace('<', "&lt;").replace('>', "&gt;").replace('\r', "_x000D_"))
}

/// ブック本体。legacy は以前の出力（計算方法「手動」・印刷範囲がH列まで）で、上書き保存の確認にだけ使う。
pub fn workbook_xml(manual_calc: bool, print_through_h: bool) -> String {
    let last = if print_through_h { 'H' } else { column_name(PRINT_COLUMNS - 1) };
    format!(
        "<workbook xmlns=\"{SPREADSHEET_NS}\" xmlns:r=\"{REL_NS}\"><!-- parts-order-manager:{LAYOUT_VERSION} --><sheets><sheet name=\"{SHEET_NAME}\" sheetId=\"1\" r:id=\"rId1\"/></sheets><definedNames><definedName name=\"_xlnm.Print_Area\" localSheetId=\"0\">{SHEET_NAME}!$A$1:${last}${SHEET_ROWS}</definedName></definedNames>{}</workbook>",
        if manual_calc { "<calcPr calcMode=\"manual\"/>" } else { "" },
    )
}

/// 出力するブックの部品（[名前, 内容]）。
pub fn workbook_parts(model: &PrintModel) -> Result<Vec<(&'static str, String)>> {
    if model.template_version != TEMPLATE_VERSION { return Err(Error::Workbook(WorkbookCode::Layout)); }
    if model.lines.len() > LINE_ROWS { return Err(Error::Workbook(WorkbookCode::Limit)); }
    let mut total = 0usize;
    let cells = sheet_cells(&model.header, &model.formats, &model.lines);
    // 書式を付けたセルは、同じ組合せごとに xf を1つ足す（帳票の既定の xf の後ろ）。
    let mut extras: Vec<ExtraStyle> = Vec::new();
    let mut style_of = |item: &SheetCell| -> usize {
        let Some(format) = &item.format else { return style_index(item.style) };
        let key = (item.style, format.clone());
        STYLE_NAMES.len() + extras.iter().position(|extra| *extra == key).unwrap_or_else(|| { extras.push(key); extras.len() - 1 })
    };
    let indexes: Vec<usize> = cells.iter().map(&mut style_of).collect();
    // 空欄は値を持たない書式だけのセルにする（見本と同じく、左のセルの文字がはみ出して表示される）。
    let mut cell = |item: &SheetCell, style: usize| -> Result<String> {
        let head = format!("<c r=\"{}\" s=\"{style}\"", item.reference);
        match &item.value {
            None => Ok(format!("{head}/>")),
            Some(SheetValue::Date { serial, .. }) => Ok(format!("{head}><v>{}</v></c>", js::num(*serial))),
            Some(SheetValue::Text(text)) => {
                let escaped = text_xml(text)?;
                total += escaped.len();
                if total > XML_LIMIT - 65536 { return Err(Error::Workbook(WorkbookCode::Limit)); }
                Ok(format!("{head} t=\"inlineStr\"><is><t xml:space=\"preserve\">{escaped}</t></is></c>"))
            }
        }
    };
    let mut row_cells: HashMap<usize, String> = HashMap::new();
    for (item, style) in cells.iter().zip(&indexes) {
        let xml = cell(item, *style)?;
        row_cells.entry(item.row).or_default().push_str(&xml);
    }
    let rows: String = (1..=SHEET_ROWS).map(|row| {
        let height = row_height(row);
        let cells = row_cells.get(&row).map(String::as_str).unwrap_or("");
        if height == DEFAULT_ROW_HEIGHT && cells.is_empty() { return String::new(); }
        format!("<row r=\"{row}\"{}>{cells}</row>", if height == DEFAULT_ROW_HEIGHT { String::new() } else { format!(" ht=\"{}\" customHeight=\"1\"", js::num(height)) })
    }).collect();
    let columns: String = COLUMN_WIDTHS.iter().enumerate().map(|(index, width)| format!("<col min=\"{0}\" max=\"{0}\" width=\"{1}\" customWidth=\"1\"{2}/>", index + 1, js::num(*width), if index == 1 { " bestFit=\"1\"" } else { "" })).collect();
    Ok(vec![
        ("[Content_Types].xml", "<Types xmlns=\"http://schemas.openxmlformats.org/package/2006/content-types\"><Default Extension=\"rels\" ContentType=\"application/vnd.openxmlformats-package.relationships+xml\"/><Default Extension=\"xml\" ContentType=\"application/xml\"/><Override PartName=\"/xl/workbook.xml\" ContentType=\"application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml\"/><Override PartName=\"/xl/worksheets/sheet1.xml\" ContentType=\"application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml\"/><Override PartName=\"/xl/styles.xml\" ContentType=\"application/vnd.openxmlformats-officedocument.spreadsheetml.styles+xml\"/></Types>".to_string()),
        ("_rels/.rels", format!("<Relationships xmlns=\"{PACKAGE_REL_NS}\"><Relationship Id=\"rId1\" Type=\"{REL_NS}/officeDocument\" Target=\"xl/workbook.xml\"/></Relationships>")),
        ("xl/workbook.xml", workbook_xml(false, false)),
        ("xl/_rels/workbook.xml.rels", format!("<Relationships xmlns=\"{PACKAGE_REL_NS}\"><Relationship Id=\"rId1\" Type=\"{REL_NS}/worksheet\" Target=\"worksheets/sheet1.xml\"/><Relationship Id=\"rId2\" Type=\"{REL_NS}/styles\" Target=\"styles.xml\"/></Relationships>")),
        ("xl/styles.xml", styles_xml(&extras)),
        // 数量などの数字は入力どおり文字列で出力するため、「文字列として保存された数値」の警告表示を止める。
        // 印刷は印刷範囲を1ページに収め、縦で決まる倍率で余る横幅は左右に振り分ける（ページ中央・水平）。
        ("xl/worksheets/sheet1.xml", format!(
            "<worksheet xmlns=\"{SPREADSHEET_NS}\"><sheetPr><pageSetUpPr fitToPage=\"1\"/></sheetPr><dimension ref=\"A1:H{SHEET_ROWS}\"/><sheetViews><sheetView tabSelected=\"1\" workbookViewId=\"0\"/></sheetViews><sheetFormatPr defaultColWidth=\"9\" defaultRowHeight=\"{}\"/><cols>{columns}</cols><sheetData>{rows}</sheetData><printOptions horizontalCentered=\"1\"/><pageMargins left=\"0.7\" right=\"0.7\" top=\"0.75\" bottom=\"0.75\" header=\"0.3\" footer=\"0.3\"/><pageSetup paperSize=\"9\" scale=\"68\" fitToWidth=\"1\" fitToHeight=\"1\" orientation=\"portrait\"/><ignoredErrors><ignoredError sqref=\"A1:H{SHEET_ROWS}\" numberStoredAsText=\"1\"/></ignoredErrors></worksheet>",
            js::num(DEFAULT_ROW_HEIGHT),
        )),
    ])
}

pub fn build_workbook(model: &PrintModel) -> Result<Vec<u8>> {
    let parts = workbook_parts(model)?;
    let mut total = 0usize;
    for (_, xml) in &parts { total += xml.len(); if total > XML_LIMIT { return Err(Error::Workbook(WorkbookCode::Limit)); } }
    let refs: Vec<(&str, &[u8])> = parts.iter().map(|(name, xml)| (*name, xml.as_bytes())).collect();
    Ok(crate::zip::write(&refs))
}

// ---- envelope.ts ----

/// 出力したブックの部品（検証用）。読めない場合は ExportFileError、ZIPでない場合は汎用エラー。
pub fn workbook_envelope(bytes: &[u8]) -> Result<HashMap<String, Vec<u8>>> {
    if bytes.len() as u64 > crate::limits::XLSX_VERIFY_MAX { return Err(Error::file("出力ファイルが検証上限を超えています。")); }
    let mut archive = Archive::open(bytes).map_err(|e| Error::other(format!("zip: {}", e.message())))?;
    let unknown = || Error::file("このファイルは確認済みの出力形式ではありません。別の名前で保存してください。");
    let mut parts = HashMap::new();
    let mut total = 0u64;
    while let Some(entry) = archive.next_entry() {
        let entry = entry.map_err(|_| unknown())?;
        // ZIP64 の展開後サイズは u64 全体を取り得るため、合計の桁あふれも上限超過として扱う。
        total = total.checked_add(entry.uncompressed_size).ok_or_else(unknown)?;
        if parts.len() >= 6 || parts.contains_key(&entry.file_name) || total > 4_194_304 || entry.uncompressed_size > 3_145_728 || entry.is_encrypted() || entry.file_name.ends_with('/') { return Err(unknown()); }
        let content = archive.read_entry_data(&entry).map_err(|_| unknown())?;
        if crc32fast::hash(&content) != entry.crc32 { return Err(unknown()); }
        parts.insert(entry.file_name.clone(), content);
    }
    Ok(parts)
}

static LEGACY_WORKBOOKS: LazyLock<[String; 2]> = LazyLock::new(|| [workbook_xml(true, true), workbook_xml(false, true)]);

/// 既存ファイルがこのアプリの出力（同じ部品構成）であることを確かめる。シート本体だけは内容を問わない。
pub fn assert_generated_envelope(actual: &HashMap<String, Vec<u8>>, expected: &HashMap<String, Vec<u8>>) -> Result<()> {
    if actual.len() != expected.len() || actual.len() != 6 { return Err(Error::file("既存ファイルはこのアプリの出力形式ではありません。別の名前で保存してください。")); }
    for (name, bytes) in expected {
        let candidate = actual.get(name);
        // styles.xml はセルの書式によって変わるため、このアプリが作れる内容かを確かめる。
        let known = name == "xl/worksheets/sheet1.xml" || candidate == Some(bytes) || (name == "xl/workbook.xml" && LEGACY_WORKBOOKS.iter().any(|legacy| candidate.map(Vec::as_slice) == Some(legacy.as_bytes())))
            || (name == "xl/styles.xml" && candidate.is_some_and(|candidate| generated_styles(candidate)));
        if candidate.is_none() || !known { return Err(Error::file("既存ファイルの出力形式を確認できません。別の名前で保存してください。")); }
    }
    Ok(())
}

// ---- model.ts ----

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct ExportIssue { pub field: String, pub message: String }

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ExportRequest { pub document_id: String, pub revision: i64 }

/// `exportRequest`（strictObject { documentId: uuid, revision: 正の整数 }）
pub fn parse_export_request(value: &Value) -> Result<ExportRequest> {
    let o = validate::strict(value, &["documentId", "revision"])?;
    let document_id = o.uuid("documentId")?;
    let revision = o.int("revision")?;
    if revision < 1 { return Err(Error::invalid("revision")); }
    Ok(ExportRequest { document_id, revision })
}

/// 明細1行ぶんの出力前の確認に必要な値。
pub struct LineCheck<'a> { pub name: &'a str, pub delivery_state: &'a str, pub mark_output: &'a str, pub rule_version: &'a str }

/// 出力を止める理由（出力前の確認）。Excel出力・印刷・一覧の件数（issueCount）はすべてこの関数の結果を使う。
/// 画面側の同じ規則は src/shared/export-issues.ts（文言も同じ表）。納期は前後の空白を除いた後で判定する。
/// 並びは 帳票形式 → 納期 → 47行超過 → 明細ごとの記号。`field` は本体との約束事（templateVersion・E4・lines・lines.<番号>.mark）。
pub fn blocking_issues<'a>(template_version: &str, due_date: &str, lines: impl ExactSizeIterator<Item = LineCheck<'a>>) -> Vec<ExportIssue> {
    let mut issues = Vec::new();
    if template_version != TEMPLATE_VERSION { issues.push(ExportIssue { field: "templateVersion".into(), message: "この帳票形式のExcel出力には対応していません".into() }); }
    let due_date = entered(due_date);
    if !due_date.is_empty() && !valid_date_text(due_date) { issues.push(ExportIssue { field: "E4".into(), message: "納期の形式（実在する日付を YYYY-MM-DD または YYYY/M/D）".into() }); }
    if lines.len() > LINE_ROWS { issues.push(ExportIssue { field: "lines".into(), message: format!("明細が{LINE_ROWS}行を{}行超えています（出力方法は未確定）", lines.len() - LINE_ROWS) }); }
    for (index, line) in lines.enumerate() {
        if line_mark(line.delivery_state, line.mark_output, line.rule_version).is_some() { continue; }
        let name = js::collapse_spaces(line.name);
        let name = if js::trim(&name).is_empty() { "（品名なし）" } else { js::trim(&name) };
        let message = if line.delivery_state == "both" { format!("明細{}「{name}」のチェック記号が未確定（材料・伝票とも。「{BOTH_MARK}」を選び直してください）", index + 1) } else { format!("明細{}「{name}」のチェック状態と記号が一致していません", index + 1) };
        issues.push(ExportIssue { field: format!("lines.{index}.mark"), message });
    }
    issues
}

pub fn saved_print_model(store: &Store, request: &ExportRequest) -> Result<(PrintModel, Vec<ExportIssue>)> {
    let saved = get_document(store, &request.document_id)?;
    if saved.revision != request.revision { return Err(Error::db(DbCode::Conflict, "保存版が変わりました。最新の保存を確認して出力し直してください。")); }
    let issues = blocking_issues(&saved.template_version, &saved.header.e4, saved.lines.iter().map(|stored| LineCheck { name: &stored.line.name, delivery_state: &stored.line.delivery_state, mark_output: &stored.line.mark_output, rule_version: &stored.line.rule_version }));
    // 帳票に置く値は前後の空白を除いた形（画面のプレビューと同じ。2026年10月15日より前に保存した空白付きの値も除く）。
    let header = SheetHeader { c2: entered(&saved.header.c2).into(), a4: entered(&saved.header.a4).into(), b4: entered(&saved.header.b4).into(), c4: entered(&saved.header.c4).into(), e4: entered(&saved.header.e4).into() };
    let mut lines = Vec::new();
    for stored in &saved.lines {
        let line = &stored.line;
        if let Some(mark) = line_mark(&line.delivery_state, &line.mark_output, &line.rule_version) {
            lines.push(SheetLine { name: entered(&line.name).into(), model: entered(&line.model).into(), manufacturer: entered(&line.manufacturer).into(), quantity: entered(&line.quantity).into(), remarks: entered(&line.remarks).into(), mark: mark.to_string(), formats: line.formats.clone() });
        }
    }
    Ok((PrintModel { document_id: saved.id, revision: saved.revision, template_version: saved.template_version, header, lines, formats: saved.formats }, issues))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn check<'a>(name: &'a str, delivery_state: &'a str, mark_output: &'a str, rule_version: &'a str) -> LineCheck<'a> { LineCheck { name, delivery_state, mark_output, rule_version } }

    /// 出力前の確認の状態表: 状態・記号の組合せ × 規則の版 → 止める理由（画面側 tests/unit/export-issues.test.ts と同じ文言・並び）。
    #[test]
    fn blocking_issues_follow_the_state_table_and_share_one_wording() {
        let ok = [("unknown", "unresolved"), ("material_only", "filled_circle"), ("slip_only", "open_circle"), ("both", "both_mark")];
        for (state, output) in ok { assert!(blocking_issues(TEMPLATE_VERSION, "", [check("品", state, output, "provisional-v1")].into_iter()).is_empty(), "{state}/{output}"); }
        let message = |state, output, rule, name| blocking_issues(TEMPLATE_VERSION, "", [check(name, state, output, rule)].into_iter());
        assert_eq!(message("both", "unresolved", "provisional-v1", " 品　\n名 "), vec![ExportIssue { field: "lines.0.mark".into(), message: "明細1「品 名」のチェック記号が未確定（材料・伝票とも。「⦿」を選び直してください）".into() }]);
        assert_eq!(message("both", "filled_circle", "provisional-v1", "").len(), 1);
        assert_eq!(message("material_only", "open_circle", "provisional-v1", "")[0].message, "明細1「（品名なし）」のチェック状態と記号が一致していません");
        assert_eq!(message("unknown", "blank", "provisional-v1", "x").len(), 1);
        assert_eq!(message("slip_only", "open_circle", "v0", "x")[0].message, "明細1「x」のチェック状態と記号が一致していません");
        assert_eq!(message("both", "both_mark", "v0", "x")[0].message, "明細1「x」のチェック記号が未確定（材料・伝票とも。「⦿」を選び直してください）");
    }

    #[test]
    fn blocking_issues_judge_the_due_date_after_trimming_and_order_template_date_overflow_marks() {
        let line = || check("x", "unknown", "unresolved", "provisional-v1");
        for (due, blocked) in [("", false), ("\u{3000}2026/10/31 ", false), ("\u{3000}", false), ("2026-02-30", true), ("\u{3000}2026-02-30\u{FEFF}", true), ("\u{200B}2026-10-31", true)] {
            assert_eq!(blocking_issues(TEMPLATE_VERSION, due, [line()].into_iter()).len(), usize::from(blocked), "{due:?}");
        }
        let lines = (0..LINE_ROWS + 2).map(|index| if index == 1 { check("x", "both", "unresolved", "provisional-v1") } else { line() });
        let issues = blocking_issues("excel-v0", "翌週", lines);
        let fields: Vec<&str> = issues.iter().map(|issue| issue.field.as_str()).collect();
        assert_eq!(fields, ["templateVersion", "E4", "lines", "lines.1.mark"]);
        assert_eq!(issues[0].message, "この帳票形式のExcel出力には対応していません");
        assert_eq!(issues[1].message, "納期の形式（実在する日付を YYYY-MM-DD または YYYY/M/D）");
        assert_eq!(issues[2].message, "明細が47行を2行超えています（出力方法は未確定）");
        assert_eq!(blocking_issues(TEMPLATE_VERSION, "", (0..LINE_ROWS).map(|_| line())).len(), 0);
    }

    #[test]
    fn text_escaping_matches_excel_rules() {
        assert_eq!(text_xml("a&<b>\r_x0041_").unwrap(), "a&amp;&lt;b&gt;_x000D__x005F_x0041_");
        assert!(matches!(text_xml("\u{1}"), Err(Error::Workbook(WorkbookCode::Text))));
        assert!(matches!(text_xml(&"\n".repeat(254)), Err(Error::Workbook(WorkbookCode::Limit))));
        assert!(text_xml(&"\n".repeat(253)).is_ok());
    }

    #[test]
    fn styles_have_unique_borders_and_seventeen_formats() {
        assert!(STYLES.contains("<cellXfs count=\"17\">"));
        assert!(STYLES.starts_with("<styleSheet xmlns=\"http://schemas.openxmlformats.org/spreadsheetml/2006/main\">\n<numFmts count=\"2\"><numFmt numFmtId=\"176\" formatCode=\"#,##0;[Red]#,##0\"/><numFmt numFmtId=\"177\" formatCode=\"m&quot;月&quot;d&quot;日&quot;\"/></numFmts>"));
    }
}
