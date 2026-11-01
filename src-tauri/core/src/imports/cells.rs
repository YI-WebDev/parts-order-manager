//! セルの読込（src/main/imports/cells.ts）。共有文字列・書式・数値の表示を旧実装と同じ規則で求める。

use regex::Regex;
use std::collections::HashMap;
use std::sync::LazyLock;

use super::{import_error, js_index, js_number, limits, OriginalCell};
use crate::error::{ImportCode, Result};
use crate::js::len16;
use crate::xml::XmlNode;

pub fn missing_cell() -> OriginalCell {
    OriginalCell { presence: "missing".into(), kind: "blank".into(), raw_value: None, display_text: String::new(), format_code: None, display_verified: true, rich_text: None, phonetic: None, formula: None, formula_cached_type: None }
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct TextRuns { pub text: String, pub rich_text: Vec<String>, pub phonetic: Vec<String> }

pub fn text_runs(node: &XmlNode) -> Result<TextRuns> {
    let rich_text: Vec<String> = node.children_named("r").map(|run| run.child("t").map(|t| t.text.clone()).unwrap_or_default()).collect();
    let text = node.child("t").map(|t| t.text.clone()).unwrap_or_default() + &rich_text.concat();
    let phonetic: Vec<String> = node.children_named("rPh").map(|run| run.child("t").map(|t| t.text.clone()).unwrap_or_default()).collect();
    if len16(&text) > limits::TEXT || len16(&phonetic.concat()) > limits::TEXT { return Err(import_error(ImportCode::Limit, "セルの文字数が上限を超えています。")); }
    Ok(TextRuns { text, rich_text, phonetic })
}

/// cellXfs の並びごとの表示形式。
pub fn formats(root: Option<&XmlNode>) -> Result<Vec<String>> {
    let Some(root) = root else { return Ok(vec!["General".into()]) };
    let mut builtins: HashMap<String, String> = [("0", "General"), ("1", "0"), ("2", "0.00"), ("3", "#,##0"), ("4", "#,##0.00"), ("49", "@")].into_iter().map(|(k, v)| (k.to_string(), v.to_string())).collect();
    for fmt in root.child("numFmts").unwrap_or(root).children_named("numFmt") {
        let id = fmt.attr("numFmtId");
        let code = fmt.attr("formatCode");
        if id.map(len16).unwrap_or(0) > limits::METADATA || code.map(len16).unwrap_or(0) > limits::METADATA { return Err(import_error(ImportCode::Limit, "書式情報が上限を超えています。")); }
        if let (Some(id), Some(code)) = (id, code) { if !id.is_empty() && !code.is_empty() { builtins.insert(id.to_string(), code.to_string()); } }
    }
    root.child("cellXfs").unwrap_or(root).children_named("xf").map(|xf| {
        let id = xf.attr("numFmtId").unwrap_or("0");
        if len16(id) > limits::METADATA { return Err(import_error(ImportCode::Limit, "書式情報が上限を超えています。")); }
        Ok(builtins.get(id).cloned().unwrap_or_else(|| format!("builtin:{id}")))
    }).collect()
}

// 色名は大文字・小文字を区別しない（Excel は [Red]、LibreOffice は [RED] で保存する）。
static RED_NEGATIVE: LazyLock<Regex> = LazyLock::new(|| Regex::new(r"(?i)^#,##0;\[red\]#,##0$").expect("regex"));
static PLAIN_NUMBER: LazyLock<Regex> = LazyLock::new(|| Regex::new(r"^(0{1,16}|#,##0)(\.0{1,8})?$").expect("regex"));
static NUMERIC_LEXEME: LazyLock<Regex> = LazyLock::new(|| Regex::new(r"^-?[0-9]{1,30}(\.[0-9]{1,30})?$").expect("regex"));

pub fn text_format_supported(format: Option<&str>) -> bool {
    match format { None => false, Some(f) => f == "General" || f == "@" || RED_NEGATIVE.is_match(f) || PLAIN_NUMBER.is_match(f) }
}

/// 10進の数字列に 1 を足す。
fn increment(digits: &str) -> String {
    let mut bytes = digits.as_bytes().to_vec();
    let mut i = bytes.len();
    loop {
        if i == 0 { bytes.insert(0, b'1'); break; }
        i -= 1;
        if bytes[i] == b'9' { bytes[i] = b'0'; } else { bytes[i] += 1; break; }
    }
    String::from_utf8(bytes).unwrap_or_default()
}

fn group_thousands(integer: &str) -> String {
    let mut out = String::with_capacity(integer.len() + integer.len() / 3);
    for (i, c) in integer.chars().enumerate() {
        if i > 0 && (integer.len() - i) % 3 == 0 { out.push(','); }
        out.push(c);
    }
    out
}

pub fn numeric_display(raw: &str, format: &str) -> (String, bool) {
    if !NUMERIC_LEXEME.is_match(raw) { return (raw.to_string(), false); }
    if format == "General" || format == "@" { return (raw.to_string(), true); }
    let negative = raw.starts_with('-');
    let unsigned = if negative { &raw[1..] } else { raw };
    let (whole, decimal) = unsigned.split_once('.').unwrap_or((unsigned, ""));
    let hide_sign = RED_NEGATIVE.is_match(format);
    let pattern = if hide_sign { "#,##0" } else { format };
    if !PLAIN_NUMBER.is_match(pattern) { return (raw.to_string(), false); }
    let (integer_pattern, fraction_pattern) = pattern.split_once('.').unwrap_or((pattern, ""));
    let precision = fraction_pattern.len();
    let mut padded = decimal.to_string();
    while padded.len() < precision { padded.push('0'); }
    let combined = format!("{whole}{}", &padded[..precision]);
    // BigInt と同じく先頭の 0 を除いた整数として扱う。
    let mut scaled = combined.trim_start_matches('0').to_string();
    if scaled.is_empty() { scaled = "0".into(); }
    if decimal.as_bytes().get(precision).is_some_and(|d| *d >= b'5') { scaled = increment(&scaled); }
    let mut digits = scaled;
    while digits.len() < precision + 1 { digits.insert(0, '0'); }
    let mut integer = if precision > 0 { digits[..digits.len() - precision].to_string() } else { digits.clone() };
    integer = if integer_pattern.contains(',') { group_thousands(&integer) } else { let mut s = integer; while s.len() < integer_pattern.len() { s.insert(0, '0'); } s };
    let fraction = if precision > 0 { format!(".{}", &digits[digits.len() - precision..]) } else { String::new() };
    (format!("{}{integer}{fraction}", if negative && !hide_sign { "-" } else { "" }), true)
}

fn digits_only(text: &str) -> bool { !text.is_empty() && text.bytes().all(|b| b.is_ascii_digit()) }

pub fn read_cell(node: &XmlNode, strings: &[TextRuns], styles: &[String]) -> Result<OriginalCell> {
    if node.attrs.values().any(|value| len16(value) > limits::METADATA) { return Err(import_error(ImportCode::Limit, "セルの属性情報が上限を超えています。")); }
    let style_attr = node.attr("s");
    let format_code = js_index(js_number(style_attr.unwrap_or("0"))).and_then(|i| styles.get(i).cloned()).unwrap_or_else(|| format!("style:{}", style_attr.unwrap_or("?")));
    let value = node.child("v").map(|v| v.text.clone());
    let formula = node.child("f");
    if len16(&format_code) > limits::METADATA { return Err(import_error(ImportCode::Limit, "書式情報が上限を超えています。")); }
    // LibreOffice は通常の数式にも aca="false" を付けて保存する。再計算の指定（aca・ca）だけの数式は通常の数式として扱い、
    // 共有・配列数式など、その他の属性付きの数式は従来どおり拒否する。
    if let Some(f) = formula {
        if !f.attrs.iter().all(|(name, flag)| (name == "aca" || name == "ca") && matches!(flag.as_str(), "0" | "1" | "true" | "false")) {
            return Err(import_error(ImportCode::Format, "共有・配列数式など属性付きの数式には対応していません。"));
        }
    }
    let text_verified = text_format_supported(Some(&format_code));
    let present = |kind: &str, raw_value: Option<String>, display_text: String, display_verified: bool| OriginalCell {
        presence: "present".into(), kind: kind.into(), raw_value, display_text, format_code: Some(format_code.clone()), display_verified, rich_text: None, phonetic: None, formula: None, formula_cached_type: None,
    };
    let t = node.attr("t");
    let mut cell = match t.unwrap_or("n") {
        "s" => {
            let runs = value.as_deref().filter(|v| digits_only(v)).and_then(|v| js_index(js_number(v))).and_then(|i| strings.get(i));
            let Some(runs) = runs else { return Err(import_error(ImportCode::Format, "共有文字列の参照が不正です。")) };
            OriginalCell { rich_text: Some(runs.rich_text.clone()), phonetic: Some(runs.phonetic.clone()), ..present("text", Some(runs.text.clone()), runs.text.clone(), text_verified) }
        }
        "inlineStr" => {
            let runs = text_runs(node.child("is").unwrap_or(node))?;
            OriginalCell { rich_text: Some(runs.rich_text), phonetic: Some(runs.phonetic), ..present("text", Some(runs.text.clone()), runs.text, text_verified) }
        }
        "str" => present("text", value.clone(), value.clone().unwrap_or_default(), text_verified),
        "n" => {
            let (text, verified) = match &value { None => (String::new(), true), Some(v) => numeric_display(v, &format_code) };
            present(if value.is_none() { "blank" } else { "number" }, value.clone(), text, verified)
        }
        other => present(other, value.clone(), value.clone().unwrap_or_default(), false),
    };
    if len16(&cell.display_text) > limits::TEXT || value.as_deref().map(len16).unwrap_or(0) > limits::TEXT || formula.map(|f| len16(&f.text)).unwrap_or(0) > limits::TEXT {
        return Err(import_error(ImportCode::Limit, "セルの文字数が上限を超えています。"));
    }
    if let Some(f) = formula {
        cell.kind = "formula".into();
        cell.formula = Some(f.text.clone());
        cell.formula_cached_type = Some(t.unwrap_or("n").to_string());
        cell.display_verified = false;
    }
    Ok(cell)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn numeric_display_matches_the_old_rounding() {
        for (raw, format, text, verified) in [
            ("-1234", "#,##0;[Red]#,##0", "1,234", true), ("00012", "00000", "00012", true), ("12", "00000", "00012", true), ("0", "General", "0", true),
            ("1.25", "0.0", "1.3", true), ("1.24", "0.0", "1.2", true), ("9.99", "0.0", "10.0", true), ("-0", "0", "-0", true), ("1234567", "#,##0", "1,234,567", true),
            ("1234.5", "#,##0", "1,235", true), ("0.5", "0", "1", true), ("1e3", "0", "1e3", false), ("12", "0%", "12", false), ("999.95", "#,##0.0", "1,000.0", true),
        ] {
            assert_eq!(numeric_display(raw, format), (text.to_string(), verified), "{raw} {format}");
        }
    }
}
