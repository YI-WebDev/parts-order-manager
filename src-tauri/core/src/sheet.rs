//! 請求書Excel（excel-v1）の帳票レイアウト。src/shared/invoice-sheet.ts・sheet-geometry.ts・date-text.ts と同じ定義で、
//! Excel出力と印刷・PDFが使う。画面のプレビュー（TypeScript）と値がずれないことは tests/unit/sheet-parity.test.ts が（examples/harness の sheetDefinitions 経由で）今の src/shared と突き合わせて確かめる。

use std::sync::LazyLock;

use crate::format::{CellFormat, HeaderFormats, Horizontal, LineFormats, Vertical};

pub const SHEET_NAME: &str = "請求書";
/// 列 A〜H の幅（Excelの文字数単位）。
pub const COLUMN_WIDTHS: [f64; 8] = [7.0, 27.33203125, 24.44140625, 9.88671875, 11.109375, 23.77734375, 9.0, 9.0];
/// 印刷する列数（A〜G）。
pub const PRINT_COLUMNS: usize = 7;
pub const SHEET_ROWS: usize = 56;
pub const LINE_FIRST_ROW: usize = 6;
pub use crate::limits::LINE_ROWS;
pub const DEFAULT_ROW_HEIGHT: f64 = 13.2;

/// 行の高さ（pt）。
pub fn row_height(row: usize) -> f64 {
    if row == 2 { 27.0 } else if (4..=52).contains(&row) { 21.15 } else { DEFAULT_ROW_HEIGHT }
}

pub fn column_name(column: usize) -> char { (b'A' + column as u8) as char }

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Edge { Thin, Double }

impl Edge {
    pub fn as_str(self) -> &'static str { match self { Edge::Thin => "thin", Edge::Double => "double" } }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Default)]
pub struct Border { pub left: Option<Edge>, pub right: Option<Edge>, pub top: Option<Edge>, pub bottom: Option<Edge> }

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Align { General, Left, Center, Right }

impl Align {
    pub fn as_str(self) -> &'static str { match self { Align::General => "general", Align::Left => "left", Align::Center => "center", Align::Right => "right" } }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct CellStyle { pub font: usize, pub num_fmt: u32, pub border: Border, pub align: Align, pub indent: Option<u32> }

pub struct Font { pub name: &'static str, pub size: u32, pub family: u32 }

/// 0 は標準スタイル（列幅の基準になる既定フォント）。セルは明朝体を使う。
pub const FONTS: [Font; 3] = [
    Font { name: "ＭＳ Ｐゴシック", size: 11, family: 3 },
    Font { name: "ＭＳ Ｐ明朝", size: 11, family: 1 },
    Font { name: "ＭＳ Ｐ明朝", size: 9, family: 1 },
];
pub struct NumberFormat { pub id: u32, pub code: &'static str }
pub const NUMBER_FORMATS: [NumberFormat; 2] = [NumberFormat { id: 176, code: "#,##0;[Red]#,##0" }, NumberFormat { id: 177, code: "m\"月\"d\"日\"" }];
const QUANTITY_FORMAT: u32 = 176;
const DATE_FORMAT: u32 = 177;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum StyleName { Normal, Text, HeadFirst, Head, HeadLabel, HeadDate, HeadEnd, TitleFirst, Title, TitleQuantity, TitleBox, Mark, LineText, LineCenter, LineQuantity, LineRemarks, LineEnd }

/// cellXfs の並び順。0 番は標準スタイル。
pub const STYLE_NAMES: [StyleName; 17] = [
    StyleName::Normal, StyleName::Text, StyleName::HeadFirst, StyleName::Head, StyleName::HeadLabel, StyleName::HeadDate, StyleName::HeadEnd,
    StyleName::TitleFirst, StyleName::Title, StyleName::TitleQuantity, StyleName::TitleBox, StyleName::Mark, StyleName::LineText,
    StyleName::LineCenter, StyleName::LineQuantity, StyleName::LineRemarks, StyleName::LineEnd,
];

const T: Option<Edge> = Some(Edge::Thin);
const D: Option<Edge> = Some(Edge::Double);
const N: Option<Edge> = None;
const fn style(font: usize, num_fmt: u32, left: Option<Edge>, right: Option<Edge>, top: Option<Edge>, bottom: Option<Edge>, align: Align, indent: Option<u32>) -> CellStyle {
    CellStyle { font, num_fmt, border: Border { left, right, top, bottom }, align, indent }
}

/// 帳票の既定の書式。文字のあるセルの横位置は、利用者の指示（2026年10月15日）で見本の左揃え・字下げをやめ、すべて中央揃え（縦位置はExcelの既定の下揃え）。
pub fn cell_style(name: StyleName) -> CellStyle {
    use Align::*;
    match name {
        StyleName::Normal => style(0, 0, N, N, N, N, General, None),
        StyleName::Text => style(1, 0, N, N, N, N, Center, None),
        StyleName::HeadFirst => style(1, 0, T, N, T, D, Center, None),
        StyleName::Head => style(1, 0, T, T, T, D, Center, None),
        StyleName::HeadLabel => style(1, 0, N, N, T, D, Center, None),
        StyleName::HeadDate => style(1, DATE_FORMAT, T, T, T, D, Center, None),
        StyleName::HeadEnd => style(1, 0, N, N, N, D, Center, None),
        StyleName::TitleFirst => style(1, 0, T, N, D, D, Center, None),
        StyleName::Title => style(1, 0, T, N, D, D, Center, None),
        StyleName::TitleQuantity => style(1, QUANTITY_FORMAT, T, N, D, D, Center, None),
        StyleName::TitleBox => style(1, 0, T, T, D, D, Center, None),
        StyleName::Mark => style(2, 0, T, T, N, T, Center, None),
        StyleName::LineText => style(1, 0, T, N, N, T, Center, None),
        StyleName::LineCenter => style(1, 0, T, N, N, T, Center, None),
        StyleName::LineQuantity => style(1, QUANTITY_FORMAT, T, N, N, T, Center, None),
        StyleName::LineRemarks => style(1, 0, T, T, N, T, Center, None),
        StyleName::LineEnd => style(1, 0, T, T, N, T, Center, None),
    }
}

pub fn style_index(name: StyleName) -> usize { STYLE_NAMES.iter().position(|value| *value == name).unwrap_or(0) }

/// 2026年10月15日より前の既定（見本どおり、上部欄・凡例・チェック・「チェック」見出しは標準、品名・形式・備考は左揃えで字下げ1）。
/// 以前の版で作ったバックアップの目録（既定の styles.xml を埋めてある）を受け付けるためだけに残す。
pub fn legacy_cell_style(name: StyleName) -> CellStyle {
    let base = cell_style(name);
    match name {
        StyleName::Text | StyleName::TitleFirst | StyleName::Mark => CellStyle { align: Align::General, indent: None, ..base },
        StyleName::LineText | StyleName::LineRemarks => CellStyle { align: Align::Left, indent: Some(1), ..base },
        _ => base,
    }
}

#[derive(Debug, Clone, PartialEq)]
pub enum SheetValue { Text(String), Date { serial: f64, month: u32, day: u32 } }

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum HeaderKey { C2, A4, B4, C4, E4 }

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum LineField { Mark, Name, Model, Manufacturer, Quantity, Remarks }

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum CellSource { Header(HeaderKey), Line { index: usize, field: LineField } }

#[derive(Debug, Clone, PartialEq)]
pub struct SheetCell { pub row: usize, pub column: usize, pub reference: String, pub style: StyleName, pub value: Option<SheetValue>, pub source: Option<CellSource>, pub format: Option<CellFormat> }

#[derive(Debug, Clone, PartialEq, Eq, Default, serde::Serialize, serde::Deserialize)]
pub struct SheetHeader {
    #[serde(rename = "C2")] pub c2: String,
    #[serde(rename = "A4")] pub a4: String,
    #[serde(rename = "B4")] pub b4: String,
    #[serde(rename = "C4")] pub c4: String,
    #[serde(rename = "E4")] pub e4: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Default, serde::Serialize)]
pub struct SheetLine {
    pub name: String, pub model: String, pub manufacturer: String, pub quantity: String, pub remarks: String, pub mark: String,
    #[serde(skip_serializing_if = "LineFormats::is_empty")]
    pub formats: LineFormats,
}

impl SheetLine {
    fn field(&self, field: LineField) -> &str {
        match field { LineField::Mark => &self.mark, LineField::Name => &self.name, LineField::Model => &self.model, LineField::Manufacturer => &self.manufacturer, LineField::Quantity => &self.quantity, LineField::Remarks => &self.remarks }
    }
}

/// 「材料伝票共に納品」の記号（U+29BF）。
pub const BOTH_MARK: &str = "⦿";

/// チェックの状態と記号の対応表（規則 provisional-v1）。(delivery_state, mark_output, 帳票に置く記号)。
/// 状態と記号の対応はここだけで定義する（画面側は src/shared/invoice-sheet.ts の CHECK_STATES）。
pub const CHECK_STATES: [(&str, &str, &str); 4] = [("unknown", "unresolved", ""), ("material_only", "filled_circle", "●"), ("slip_only", "open_circle", "○"), ("both", "both_mark", BOTH_MARK)];

/// 状態に対応する記号の出力値（mark_output）。表にない状態は None。
pub fn check_output(delivery_state: &str) -> Option<&'static str> {
    CHECK_STATES.iter().find(|entry| entry.0 == delivery_state).map(|entry| entry.1)
}

/// 明細のチェック記号（規則 provisional-v1）。チェックは任意の項目で、未選択は空欄 ""（利用者の指示、2026年10月16日。それまでは出力を止めていた）。
/// 記号未確定・状態と記号の不一致は None（出力を止める）。
pub fn line_mark(delivery_state: &str, mark_output: &str, rule_version: &str) -> Option<&'static str> {
    if rule_version != "provisional-v1" { return None; }
    CHECK_STATES.iter().find(|entry| entry.0 == delivery_state && entry.1 == mark_output).map(|entry| entry.2)
}

/// 納期（E4）の判定（src/shared/date-text.ts の validDateText）。
pub fn valid_date_text(value: &str) -> bool {
    parse_date_text(value).is_some()
}

fn parse_date_text(value: &str) -> Option<(i64, u32, u32)> {
    // /^([0-9]{4})([-/])([0-9]{1,2})([-/])([0-9]{1,2})$/
    let b = value.as_bytes();
    if b.len() < 8 || !b[..4].iter().all(u8::is_ascii_digit) { return None; }
    let separator = b[4];
    if separator != b'-' && separator != b'/' { return None; }
    let rest = &value[5..];
    let (month, day) = rest.split_once(['-', '/'])?;
    let second = rest.as_bytes()[month.len()];
    if second != separator { return None; }
    let digits = |part: &str| (1..=2).contains(&part.len()) && part.bytes().all(|c| c.is_ascii_digit());
    if !digits(month) || !digits(day) { return None; }
    let year: i64 = value[..4].parse().ok()?;
    let month: u32 = month.parse().ok()?;
    let day: u32 = day.parse().ok()?;
    let leap = year % 4 == 0 && (year % 100 != 0 || year % 400 == 0);
    let days = match month { 1 | 3 | 5 | 7 | 8 | 10 | 12 => 31, 4 | 6 | 9 | 11 => 30, 2 => if leap { 29 } else { 28 }, _ => return None };
    (year >= 1 && day >= 1 && day <= days).then_some((year, month, day))
}

/// 1970-01-01 からの日数（先発グレゴリオ暦）。
fn days_from_civil(year: i64, month: u32, day: u32) -> i64 {
    let y = if month <= 2 { year - 1 } else { year };
    let era = if y >= 0 { y } else { y - 399 } / 400;
    let yoe = y - era * 400;
    let m = month as i64;
    let doy = (153 * (if m > 2 { m - 3 } else { m + 9 }) + 2) / 5 + day as i64 - 1;
    let doe = yoe * 365 + yoe / 4 - yoe / 100 + doy;
    era * 146_097 + doe - 719_468
}

/// 納期（E4）。実在する日付は日付シリアル値（表示は m月d日）、それ以外は入力文字列のまま。
pub fn date_value(input: &str) -> Option<SheetValue> {
    if input.is_empty() { return None; }
    if let Some((year, month, day)) = parse_date_text(input) {
        // 1900年2月以前はExcelの日付シリアル値が実際の日付とずれるため文字列で出力する。
        if year > 1900 || (year == 1900 && month >= 3) {
            // Date.UTC は 0〜99 年を 1900 年代として扱うが、ここに来るのは 1900 年3月以降だけ。
            let serial = (days_from_civil(year, month, day) - days_from_civil(1899, 12, 30)) as f64;
            return Some(SheetValue::Date { serial, month, day });
        }
    }
    Some(SheetValue::Text(input.to_string()))
}

fn text(value: &str) -> Option<SheetValue> { (!value.is_empty()).then(|| SheetValue::Text(value.to_string())) }

/// 帳票に置く入力値（帳票上部の欄と明細の値）と納期の判定に使う値。前後の空白を除く（JavaScript の `trim` と同じ文字。src/shared/invoice-sheet.ts の entered）。
pub fn entered(value: &str) -> &str { crate::js::trim(value) }

const LINE_COLUMNS: [(Option<LineField>, StyleName); 7] = [
    (Some(LineField::Mark), StyleName::Mark), (Some(LineField::Name), StyleName::LineText), (Some(LineField::Model), StyleName::LineText),
    (Some(LineField::Manufacturer), StyleName::LineCenter), (Some(LineField::Quantity), StyleName::LineQuantity), (Some(LineField::Remarks), StyleName::LineRemarks),
    (None, StyleName::LineEnd),
];

/// 帳票の全セル（行優先・列順）。lines は先頭 47 行までを帳票に配置する。書式は入力欄（帳票上部と明細）のセルにだけ付く。
pub fn sheet_cells(header: &SheetHeader, formats: &HeaderFormats, lines: &[SheetLine]) -> Vec<SheetCell> {
    let mut cells = Vec::with_capacity(400);
    let mut put = |row: usize, column: usize, style: StyleName, value: Option<SheetValue>, source: Option<CellSource>| {
        let format = match source {
            Some(CellSource::Header(key)) => formats.get(key).cloned(),
            Some(CellSource::Line { index, field }) => lines.get(index).and_then(|line| line.formats.get(field).cloned()),
            None => None,
        }.filter(|format| !format.is_empty());
        cells.push(SheetCell { row, column, reference: format!("{}{row}", column_name(column)), style, value, source, format });
    };
    let head = |key: HeaderKey| Some(CellSource::Header(key));
    put(2, 2, StyleName::Text, text(entered(&header.c2)), head(HeaderKey::C2));
    put(4, 0, StyleName::HeadFirst, text(entered(&header.a4)), head(HeaderKey::A4));
    put(4, 1, StyleName::Head, text(entered(&header.b4)), head(HeaderKey::B4));
    put(4, 2, StyleName::Head, text(entered(&header.c4)), head(HeaderKey::C4));
    put(4, 3, StyleName::HeadLabel, text("納期"), None);
    put(4, 4, StyleName::HeadDate, date_value(entered(&header.e4)), head(HeaderKey::E4));
    put(4, 5, StyleName::HeadEnd, None, None);
    put(5, 0, StyleName::TitleFirst, text("チェック"), None);
    for (column, label) in ["品　　　名", "形式又はタイプ", "メーカー"].iter().enumerate() { put(5, column + 1, StyleName::Title, text(label), None); }
    put(5, 4, StyleName::TitleQuantity, text("数量"), None);
    put(5, 5, StyleName::TitleBox, text("備　考"), None);
    put(5, 6, StyleName::TitleBox, None, None);
    for index in 0..LINE_ROWS {
        let line = lines.get(index);
        for (column, (field, style)) in LINE_COLUMNS.iter().enumerate() {
            match (line, field) {
                (Some(line), Some(field)) => put(LINE_FIRST_ROW + index, column, *style, text(entered(line.field(*field))), Some(CellSource::Line { index, field: *field })),
                _ => put(LINE_FIRST_ROW + index, column, *style, None, None),
            }
        }
    }
    put(53, 1, StyleName::Text, text("チェック欄記入　　"), None);
    put(53, 2, StyleName::Text, text("材料のみ　●"), None);
    put(54, 2, StyleName::Text, text("伝票のみ　○"), None);
    put(55, 2, StyleName::Text, text(&format!("材料伝票共に納品{BOTH_MARK}")), None);
    cells
}

/// 書式を当てたセルの見た目（Excelの書式・印刷・画面のプレビューが同じ規則で使う。src/shared/cell-format.ts の resolveStyle）。
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Resolved {
    pub base: CellStyle, pub size: u32, pub bold: bool, pub italic: bool, pub underline: bool, pub color: Option<String>, pub fill: Option<String>,
    pub align: Align, pub vertical: Option<Vertical>, pub indent: Option<u32>,
}

impl Resolved {
    /// 帳票の既定の文字（フォント）から変わっているか。
    pub fn font_changed(&self) -> bool { self.size != FONTS[self.base.font].size || self.bold || self.italic || self.underline || self.color.is_some() }
}

/// 帳票の既定の書式に、セルの書式を重ねる。字下げは既定と同じ左揃えのときだけ残す（Excelでも中央揃えにすると字下げは外れる）。
pub fn resolve(style: StyleName, format: Option<&CellFormat>) -> Resolved {
    let base = cell_style(style);
    let empty = CellFormat::default();
    let format = format.unwrap_or(&empty);
    let align = match format.horizontal { None => base.align, Some(Horizontal::Left) => Align::Left, Some(Horizontal::Center) => Align::Center, Some(Horizontal::Right) => Align::Right };
    let indent = if format.horizontal.is_none() || (align == Align::Left && base.align == Align::Left) { base.indent } else { None };
    Resolved {
        base, size: format.size.unwrap_or(FONTS[base.font].size), bold: format.bold, italic: format.italic, underline: format.underline,
        color: format.color.clone(), fill: format.fill.clone(), align, vertical: format.vertical, indent,
    }
}

/// セルの表示文字列。折り返しなしのExcelでは改行は表示されないため除く。
pub fn display_text(value: Option<&SheetValue>) -> String {
    match value {
        None => String::new(),
        Some(SheetValue::Date { month, day, .. }) => format!("{month}月{day}日"),
        Some(SheetValue::Text(text)) => text.replace(['\r', '\n'], ""),
    }
}

// ---- 寸法（src/shared/sheet-geometry.ts） ----

const DIGIT: f64 = 8.0;
/// セル内の左右の余白と、字下げ 1 段分の幅（px）。
pub const PAD: i64 = 2;
pub const INDENT: i64 = 10;
pub const COLUMNS: usize = COLUMN_WIDTHS.len();

pub struct CssFont { pub family: &'static str, pub size: &'static str }
pub const CSS_FONTS: [CssFont; 3] = [
    CssFont { family: "\"ＭＳ Ｐゴシック\", \"MS PGothic\", sans-serif", size: "11pt" },
    CssFont { family: "\"ＭＳ Ｐ明朝\", \"MS PMincho\", serif", size: "11pt" },
    CssFont { family: "\"ＭＳ Ｐ明朝\", \"MS PMincho\", serif", size: "9pt" },
];

struct Geometry { widths: Vec<i64>, heights: Vec<i64>, xs: Vec<i64>, ys: Vec<i64> }

static GEOMETRY: LazyLock<Geometry> = LazyLock::new(|| {
    let widths: Vec<i64> = COLUMN_WIDTHS.iter().map(|width| (((256.0 * width + (128.0 / DIGIT).trunc()) / 256.0) * DIGIT).trunc() as i64).collect();
    let heights: Vec<i64> = (0..SHEET_ROWS).map(|index| js_round(row_height(index + 1) * 4.0 / 3.0)).collect();
    let offsets = |sizes: &[i64]| { let mut all = vec![0]; for size in sizes { all.push(all.last().copied().unwrap_or(0) + size); } all };
    Geometry { xs: offsets(&widths), ys: offsets(&heights), widths, heights }
});

/// `Math.round`（0.5 は正の無限大方向）。
fn js_round(value: f64) -> i64 { (value + 0.5).floor() as i64 }

/// 列の左端（px）。column は 0 始まり。
pub fn x(column: usize) -> i64 { GEOMETRY.xs.get(column).copied().unwrap_or(0) }
/// 行の上端（px）。row は 1 始まり。
pub fn y(row: usize) -> i64 { if row == 0 { 0 } else { GEOMETRY.ys.get(row - 1).copied().unwrap_or(0) } }
pub fn w(column: usize) -> i64 { GEOMETRY.widths.get(column).copied().unwrap_or(0) }
pub fn h(row: usize) -> i64 { if row == 0 { 0 } else { GEOMETRY.heights.get(row - 1).copied().unwrap_or(0) } }
pub fn width() -> i64 { x(COLUMNS) }
pub fn height() -> i64 { y(SHEET_ROWS + 1) }
/// 印刷範囲（A〜G列）の幅。
pub fn print_width() -> i64 { x(PRINT_COLUMNS) }
pub fn cell_key(row: usize, column: usize) -> usize { row * 16 + column }

static STYLE_AT: LazyLock<std::collections::HashMap<usize, CellStyle>> = LazyLock::new(|| {
    sheet_cells(&SheetHeader::default(), &HeaderFormats::default(), &[]).iter().map(|cell| (cell_key(cell.row, cell.column), cell_style(cell.style))).collect()
});

fn stronger(a: Option<Edge>, b: Option<Edge>) -> Option<Edge> {
    if a == Some(Edge::Double) || b == Some(Edge::Double) { Some(Edge::Double) } else { a.or(b) }
}

fn style_at(row: usize, column: Option<usize>) -> Option<&'static CellStyle> { column.and_then(|column| STYLE_AT.get(&cell_key(row, column))) }

/// 行 row の下端の罫線。
pub fn bottom_edge(row: usize, column: usize) -> Option<Edge> {
    stronger(style_at(row, Some(column)).and_then(|s| s.border.bottom), style_at(row + 1, Some(column)).and_then(|s| s.border.top))
}

/// 列 column の左端の罫線。
pub fn left_edge(row: usize, column: usize) -> Option<Edge> {
    stronger(style_at(row, column.checked_sub(1)).and_then(|s| s.border.right), style_at(row, Some(column)).and_then(|s| s.border.left))
}

pub struct BorderPaths { pub thin: String, pub double: String }

/// 罫線の SVG パス。細線は 1px、二重線は 1px の隙間を挟んだ 2 本。
pub static BORDER_PATHS: LazyLock<BorderPaths> = LazyLock::new(|| {
    use crate::js::num;
    let (mut thin, mut double) = (String::new(), String::new());
    for row in 0..=SHEET_ROWS {
        let mut column = 0;
        while column < COLUMNS {
            let edge = bottom_edge(row, column);
            let mut end = column + 1;
            while end < COLUMNS && bottom_edge(row, end) == edge { end += 1; }
            let top = y(row + 1) as f64;
            let (left, right) = (x(column) - 1, x(end));
            match edge {
                Some(Edge::Thin) => thin += &format!("M{left} {}H{right}", num(top - 0.5)),
                Some(Edge::Double) => double += &format!("M{left} {}H{right}M{left} {}H{right}", num(top - 1.5), num(top + 0.5)),
                None => {}
            }
            column = end;
        }
    }
    for column in 0..=COLUMNS {
        let mut row = 1;
        while row <= SHEET_ROWS {
            let edge = left_edge(row, column);
            let mut end = row + 1;
            while end <= SHEET_ROWS && left_edge(end, column) == edge { end += 1; }
            let left = x(column) as f64;
            let (top, bottom) = (y(row) - 1, y(end));
            match edge {
                Some(Edge::Thin) => thin += &format!("M{} {top}V{bottom}", num(left - 0.5)),
                Some(Edge::Double) => double += &format!("M{} {top}V{bottom}M{} {top}V{bottom}", num(left - 1.5), num(left + 0.5)),
                None => {}
            }
            row = end;
        }
    }
    BorderPaths { thin, double }
});

/// 左寄せの文字がExcelと同じくはみ出せる列数（自分の列＋右に続く空欄、columns 列目まで）。
pub fn overflow_columns(row: usize, column: usize, empty: impl Fn(usize, usize) -> bool, columns: usize) -> usize {
    let mut span = 1;
    while column + span < columns && empty(row, column + span) { span += 1; }
    span
}

/// 右揃えの文字がExcelと同じくはみ出せる列数（自分の列＋左に続く空欄、A列まで）。
pub fn overflow_columns_left(row: usize, column: usize, empty: impl Fn(usize, usize) -> bool) -> usize {
    let mut span = 1;
    while span <= column && empty(row, column - span) { span += 1; }
    span
}

/// 中央揃えの文字がはみ出せる、左右に続く空欄の数（左はA列まで、右は columns 列目まで）。
/// 文字はセルの中央に置いたまま、両側へ同じ幅だけはみ出す（片側だけ空欄のときははみ出さない）。
pub fn overflow_sides(row: usize, column: usize, empty: impl Fn(usize, usize) -> bool, columns: usize) -> (usize, usize) {
    (overflow_columns_left(row, column, &empty) - 1, overflow_columns(row, column, &empty, columns) - 1)
}

/// 中央揃えの文字が両側へ同じ幅ではみ出すときの、片側の幅の上限（px。左右の空欄の幅のうち短い方）。
pub fn side_room(column: usize, (left, right): (usize, usize)) -> i64 {
    let left_px: i64 = (1..=left).map(|k| w(column - k)).sum();
    let right_px: i64 = (1..=right).map(|k| w(column + k)).sum();
    left_px.min(right_px)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn date_text_rules() {
        for value in ["2024-02-29", "2024/2/29", "0001-01-01", "2026-9-13", "9999/12/31"] { assert!(valid_date_text(value), "{value}"); }
        for value in ["2023-02-29", "2024-02/29", "24-02-29", "2024-13-01", "2024-00-10", "2024-1-0", "0000-01-01", "2024-001-01", " 2024-01-01", "２０２４-01-01"] { assert!(!valid_date_text(value), "{value}"); }
    }

    #[test]
    fn excel_serials_match_date_utc() {
        assert_eq!(date_value("1900-03-01"), Some(SheetValue::Date { serial: 61.0, month: 3, day: 1 }));
        assert_eq!(date_value("2026-09-13"), Some(SheetValue::Date { serial: 46278.0, month: 9, day: 13 }));
        assert_eq!(date_value("1900-02-28"), Some(SheetValue::Text("1900-02-28".into())));
        assert_eq!(date_value("翌週"), Some(SheetValue::Text("翌週".into())));
        assert_eq!(date_value(""), None);
    }

    #[test]
    fn marks() {
        assert_eq!(line_mark("unknown", "unresolved", "provisional-v1"), Some(""));
        assert_eq!(line_mark("unknown", "unresolved", "v0"), None);
        assert_eq!(line_mark("both", "both_mark", "provisional-v1"), Some("⦿"));
        assert_eq!(line_mark("both", "filled_circle", "provisional-v1"), None);
        assert_eq!(line_mark("material_only", "filled_circle", "v0"), None);
        for (state, output, mark) in CHECK_STATES { assert_eq!((check_output(state), line_mark(state, output, "provisional-v1")), (Some(output), Some(mark))); }
        assert_eq!(check_output("other"), None);
    }

    #[test]
    fn placed_values_and_due_date_ignore_surrounding_javascript_whitespace() {
        let pad = |value: &str| format!("\u{3000} \t{value}\u{A0}\u{FEFF}\u{2028}");
        let header = SheetHeader { c2: pad("宛先"), a4: "\u{3000}".into(), b4: String::new(), c4: pad("a\u{3000}b"), e4: pad("2026-09-13") };
        let line = SheetLine { name: pad("品"), model: "\u{200B}型".into(), manufacturer: String::new(), quantity: pad("1"), remarks: "\n".into(), mark: String::new(), formats: Default::default() };
        let cells = sheet_cells(&header, &HeaderFormats::default(), &[line]);
        let value = |reference: &str| cells.iter().find(|cell| cell.reference == reference).unwrap().value.clone();
        assert_eq!(value("C2"), Some(SheetValue::Text("宛先".into())));
        assert_eq!(value("A4"), None);
        assert_eq!(value("C4"), Some(SheetValue::Text("a\u{3000}b".into())));
        assert_eq!(value("E4"), Some(SheetValue::Date { serial: 46278.0, month: 9, day: 13 }));
        assert_eq!(value("B6"), Some(SheetValue::Text("品".into())));
        assert_eq!(value("C6"), Some(SheetValue::Text("\u{200B}型".into())));
        assert_eq!(value("E6"), Some(SheetValue::Text("1".into())));
        assert_eq!(value("F6"), None);
    }

    #[test]
    fn geometry_matches_excel_pixels() {
        assert_eq!((0..8).map(w).collect::<Vec<_>>(), vec![56, 219, 196, 79, 89, 190, 72, 72]);
        assert_eq!(h(1), 18);
        assert_eq!(h(2), 36);
        assert_eq!(h(4), 28);
    }

    #[test]
    fn centred_text_spills_evenly_into_empty_neighbours() {
        // src/shared/sheet-geometry.ts の overflowSides・sideRoom と同じ規則（tests/unit/sheet-geometry.test.ts と同じ組合せ）。
        let empty_except = |filled: &'static [usize]| move |_row: usize, column: usize| !filled.contains(&column);
        assert_eq!(overflow_sides(2, 2, empty_except(&[2]), COLUMNS), (2, 5));
        assert_eq!(overflow_sides(2, 2, empty_except(&[2]), PRINT_COLUMNS), (2, 4));
        assert_eq!(overflow_sides(6, 1, empty_except(&[0, 1]), COLUMNS), (0, COLUMNS - 2));
        assert_eq!(overflow_sides(6, 1, empty_except(&[0, 1, 2]), COLUMNS), (0, 0));
        assert_eq!(overflow_sides(6, 0, empty_except(&[0]), COLUMNS), (0, COLUMNS - 1));
        assert_eq!(overflow_sides(6, COLUMNS - 1, empty_except(&[COLUMNS - 1]), COLUMNS), (COLUMNS - 1, 0));
        assert_eq!(side_room(2, (2, 4)), (w(1) + w(0)).min(w(3) + w(4) + w(5) + w(6)));
        assert_eq!(side_room(2, (1, 1)), w(1).min(w(3)));
        assert_eq!(side_room(2, (0, 4)), 0);
        assert_eq!(side_room(2, (2, 0)), 0);
    }
}
