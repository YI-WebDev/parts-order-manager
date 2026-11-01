//! 材料Excelの取込（src/main/imports）。

pub mod cells;
pub mod repository;
pub mod source;
pub mod workbook;

use indexmap::IndexMap;
use serde::{Deserialize, Serialize};

use crate::error::{Error, ImportCode, Result};
use crate::js;

pub const IMPORT_RULE: &str = "initial-ooxml-v1";

pub mod limits {
    pub const FILE_BYTES: usize = 16 * 1024 * 1024;
    pub const INFLATED_BYTES: u64 = 32 * 1024 * 1024;
    pub const PART_BYTES: u64 = 8 * 1024 * 1024;
    pub const ENTRIES: usize = 2048;
    pub const CELLS: usize = 100_000;
    pub const ITEMS: usize = 10_000;
    pub const TEXT: usize = 10_000;
    pub const METADATA: usize = 1024;
    pub const DATA_BYTES: i64 = 16 * 1024 * 1024;
    pub const SHEETS: usize = 32;
}

pub fn import_error(code: ImportCode, message: &str) -> Error { Error::import(code, message) }

/// 元のセル（rawCells の値）。キーの並びは旧実装と同じ（JSON の指紋・容量計算に使う）。
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct OriginalCell {
    pub presence: String,
    pub kind: String,
    pub raw_value: Option<String>,
    pub display_text: String,
    pub format_code: Option<String>,
    pub display_verified: bool,
    #[serde(skip_serializing_if = "Option::is_none", default)]
    pub rich_text: Option<Vec<String>>,
    #[serde(skip_serializing_if = "Option::is_none", default)]
    pub phonetic: Option<Vec<String>>,
    #[serde(skip_serializing_if = "Option::is_none", default)]
    pub formula: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none", default)]
    pub formula_cached_type: Option<String>,
}

pub type RawCells = IndexMap<String, OriginalCell>;

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, Default)]
pub struct ImportCounts { pub candidates: i64, pub held: i64, pub supplements: i64, pub excluded: i64, pub empty: i64, pub applied: i64 }

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ParsedItem {
    pub kind: String,
    pub sheet_name: String,
    pub sheet_order: i64,
    pub row_index: i64,
    pub block: String,
    pub cell_address: Option<String>,
    pub raw_cells: RawCells,
    pub values: Vec<String>,
    pub classification: String,
    pub reason: String,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ParsedWorkbook { pub items: Vec<ParsedItem>, pub counts: ImportCounts }

/// 展開後の保存・確認データ量の上限（ImportBudget）。JSON にしたときの UTF-8 バイト数で数える。
pub struct Budget { remaining: i64 }

impl Default for Budget { fn default() -> Self { Budget { remaining: limits::DATA_BYTES } } }

impl Budget {
    pub fn charge(&mut self, bytes: usize) -> Result<()> {
        self.remaining -= bytes as i64;
        if self.remaining < 0 { return Err(import_error(ImportCode::Limit, "展開後の保存・確認データ量が上限を超えています。")); }
        Ok(())
    }
    pub fn add<T: Serialize + ?Sized>(&mut self, value: &T) -> Result<()> { self.charge(js::json_bytes(value)) }
    /// `budget.add(' '.repeat(n))`
    pub fn add_spaces(&mut self, count: usize) -> Result<()> { self.charge(count + 2) }
    /// 応答用の予算（先頭に 64KiB を確保）
    pub fn response() -> Result<Budget> { let mut budget = Budget::default(); budget.add_spaces(64 * 1024)?; Ok(budget) }
}

/// JavaScript の `Number(string)`。数値にならなければ None（NaN）。
pub fn js_number(text: &str) -> Option<f64> {
    let t = js::trim(text);
    if t.is_empty() { return Some(0.0); }
    let lower = t.to_ascii_lowercase();
    for (prefix, radix) in [("0x", 16), ("0o", 8), ("0b", 2)] {
        if let Some(digits) = lower.strip_prefix(prefix) {
            if digits.is_empty() || !digits.chars().all(|c| c.is_digit(radix)) { return None; }
            return Some(digits.chars().fold(0f64, |acc, c| acc * radix as f64 + c.to_digit(radix).unwrap_or(0) as f64));
        }
    }
    let (sign, body) = match t.as_bytes()[0] { b'+' => (1.0, &t[1..]), b'-' => (-1.0, &t[1..]), _ => (1.0, t) };
    if body == "Infinity" { return Some(sign * f64::INFINITY); }
    let b = body.as_bytes();
    let mut i = 0;
    let digits = |i: &mut usize| { let start = *i; while *i < b.len() && b[*i].is_ascii_digit() { *i += 1; } *i - start };
    let int_digits = digits(&mut i);
    let mut frac_digits = 0;
    if i < b.len() && b[i] == b'.' { i += 1; frac_digits = digits(&mut i); }
    if int_digits + frac_digits == 0 { return None; }
    if i < b.len() && (b[i] == b'e' || b[i] == b'E') {
        i += 1;
        if i < b.len() && (b[i] == b'+' || b[i] == b'-') { i += 1; }
        if digits(&mut i) == 0 { return None; }
    }
    if i != b.len() { return None; }
    body.parse::<f64>().ok().map(|v| sign * v)
}

/// 配列の添字として使える数値（-0 を含む非負の整数）。
pub fn js_index(value: Option<f64>) -> Option<usize> {
    let v = value?;
    (v.is_finite() && v.fract() == 0.0 && v >= 0.0 && v < 9_007_199_254_740_992.0).then_some(v as usize)
}

/// Node の path.extname（ファイル名の部分だけで判定する）。
pub fn extname(file_name: &str) -> &str {
    if file_name == ".." { return ""; }
    match file_name.rfind('.') { None | Some(0) => "", Some(i) => &file_name[i..] }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn numbers_follow_javascript_number_conversion() {
        for (text, expected) in [("", Some(0.0)), (" 1 ", Some(1.0)), ("0x1", Some(1.0)), ("1e0", Some(1.0)), ("1.0", Some(1.0)), ("+1", Some(1.0)), ("0b11", Some(3.0)), ("0o7", Some(7.0)), (" ", Some(0.0)), (".5", Some(0.5)), ("5.", Some(5.0))] {
            assert_eq!(js_number(text), expected, "{text:?}");
        }
        for text in ["abc", "1_0", "-0x1", "e5", "."] { assert_eq!(js_number(text), None, "{text:?}"); }
        assert_eq!(js_number("-0").map(|v| v.is_sign_negative()), Some(true));
        assert_eq!(js_index(js_number("-0")), Some(0));
        assert_eq!(js_index(js_number("1.5")), None);
        assert_eq!(js_number("Infinity"), Some(f64::INFINITY));
    }

    #[test]
    fn extname_matches_node() {
        for (name, ext) in [(".xlsx", ""), ("..xlsx", ".xlsx"), ("a.XLSX", ".XLSX"), ("a.xlsx.", "."), ("a.b.xlsx", ".xlsx"), ("...xlsx", ".xlsx"), ("..", ""), ("a", "")] {
            assert_eq!(extname(name), ext, "{name}");
        }
    }
}
