//! セルの書式（src/shared/cell-format.ts と同じ定義）。Excelプレビューのツールバーで、入力したセル（上部欄・ヘッダー欄・納期と明細のセル）に付ける。
//! 帳票の既定の書式（sheet.rs の STYLES）は変えず、セルごとの差分だけを持つ。指定のない項目は帳票の既定のまま。
//! 色は決まった一覧（PALETTE）から選ぶ。Excel出力・印刷・画面のプレビューが同じ一覧を使う。

use serde::Serialize;
use serde_json::Value;

use crate::error::{Error, Result};
use crate::sheet::{HeaderKey, LineField};
use crate::validate;

/// 選べる文字の大きさ（pt）。行の高さは帳票で固定のため、行に収まる大きさまで。
pub const FONT_SIZES: [u32; 7] = [8, 9, 10, 11, 12, 14, 16];

pub struct Color { pub code: &'static str, pub name: &'static str }

/// 文字の色・塗りつぶしの色（RRGGBB）。先頭8色は淡い色と白・灰色、残り10色はExcelの「標準の色」。
pub const PALETTE: [Color; 18] = [
    Color { code: "FFFFFF", name: "白" }, Color { code: "D9D9D9", name: "淡い灰色" }, Color { code: "808080", name: "灰色" },
    Color { code: "FFF2CC", name: "淡い黄" }, Color { code: "FCE4D6", name: "淡いオレンジ" }, Color { code: "E2EFDA", name: "淡い緑" },
    Color { code: "DDEBF7", name: "淡い青" }, Color { code: "E4DFEC", name: "淡い紫" },
    Color { code: "C00000", name: "濃い赤" }, Color { code: "FF0000", name: "赤" }, Color { code: "FFC000", name: "オレンジ" }, Color { code: "FFFF00", name: "黄" },
    Color { code: "92D050", name: "薄い緑" }, Color { code: "00B050", name: "緑" }, Color { code: "00B0F0", name: "薄い青" }, Color { code: "0070C0", name: "青" },
    Color { code: "002060", name: "濃い青" }, Color { code: "7030A0", name: "紫" },
];

/// 色の一覧での位置（印刷用のクラス名に使う）。
pub fn color_index(code: &str) -> Option<usize> { PALETTE.iter().position(|color| color.code == code) }

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "lowercase")]
pub enum Horizontal { Left, Center, Right }

/// 縦の配置。指定なしはExcelの既定の「下揃え」。
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "lowercase")]
pub enum Vertical { Top, Center }

impl Vertical {
    pub fn as_str(self) -> &'static str { match self { Vertical::Top => "top", Vertical::Center => "center" } }
}

fn is_false(value: &bool) -> bool { !*value }

/// 1つのセルの書式。JSON のキーの並びは src/shared/cell-format.ts の CellFormat と同じ。
#[derive(Debug, Clone, PartialEq, Eq, Default, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CellFormat {
    #[serde(skip_serializing_if = "Option::is_none")]
    pub horizontal: Option<Horizontal>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub vertical: Option<Vertical>,
    #[serde(skip_serializing_if = "is_false")]
    pub bold: bool,
    #[serde(skip_serializing_if = "is_false")]
    pub italic: bool,
    #[serde(skip_serializing_if = "is_false")]
    pub underline: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub size: Option<u32>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub color: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub fill: Option<String>,
}

impl CellFormat {
    pub fn is_empty(&self) -> bool { *self == CellFormat::default() }
}

const FORMAT_KEYS: [&str; 8] = ["horizontal", "vertical", "bold", "italic", "underline", "size", "color", "fill"];

fn palette_color(value: &Value) -> Result<String> {
    match value { Value::String(code) if color_index(code).is_some() => Ok(code.clone()), _ => Err(Error::invalid("color")) }
}

/// 太字などは true だけを受け付ける（指定しないことが「なし」）。
fn flag(value: Option<&Value>) -> Result<bool> {
    match value { None => Ok(false), Some(Value::Bool(true)) => Ok(true), Some(_) => Err(Error::invalid("format flag")) }
}

/// `cellFormat`（strictObject。各項目は省略可）。
pub fn parse_format(value: &Value) -> Result<CellFormat> {
    let o = validate::strict(value, &FORMAT_KEYS)?;
    let horizontal = match o.get("horizontal") {
        None => None,
        Some(v) => Some(match validate::one_of(v, &["left", "center", "right"])?.as_str() { "left" => Horizontal::Left, "center" => Horizontal::Center, _ => Horizontal::Right }),
    };
    let vertical = match o.get("vertical") {
        None => None,
        Some(v) => Some(if validate::one_of(v, &["top", "center"])? == "top" { Vertical::Top } else { Vertical::Center }),
    };
    let size = match o.get("size") {
        None => None,
        Some(v) => { let size = validate::int(v)?; Some(FONT_SIZES.iter().copied().find(|s| i64::from(*s) == size).ok_or_else(|| Error::invalid("size"))?) }
    };
    Ok(CellFormat {
        horizontal, vertical, bold: flag(o.get("bold"))?, italic: flag(o.get("italic"))?, underline: flag(o.get("underline"))?, size,
        color: o.get("color").map(palette_color).transpose()?, fill: o.get("fill").map(palette_color).transpose()?,
    })
}

/// 空の書式（{}）は指定なしとして扱う。
fn parse_optional(value: Option<&Value>) -> Result<Option<CellFormat>> {
    match value { None => Ok(None), Some(v) => { let format = parse_format(v)?; Ok((!format.is_empty()).then_some(format)) } }
}

/// 帳票上部の入力欄（C2・A4・B4・C4・E4）の書式。
#[derive(Debug, Clone, PartialEq, Eq, Default, Serialize)]
pub struct HeaderFormats {
    #[serde(rename = "C2", skip_serializing_if = "Option::is_none")] pub c2: Option<CellFormat>,
    #[serde(rename = "A4", skip_serializing_if = "Option::is_none")] pub a4: Option<CellFormat>,
    #[serde(rename = "B4", skip_serializing_if = "Option::is_none")] pub b4: Option<CellFormat>,
    #[serde(rename = "C4", skip_serializing_if = "Option::is_none")] pub c4: Option<CellFormat>,
    #[serde(rename = "E4", skip_serializing_if = "Option::is_none")] pub e4: Option<CellFormat>,
}

impl HeaderFormats {
    pub fn is_empty(&self) -> bool { *self == HeaderFormats::default() }
    pub fn get(&self, key: HeaderKey) -> Option<&CellFormat> {
        match key { HeaderKey::C2 => self.c2.as_ref(), HeaderKey::A4 => self.a4.as_ref(), HeaderKey::B4 => self.b4.as_ref(), HeaderKey::C4 => self.c4.as_ref(), HeaderKey::E4 => self.e4.as_ref() }
    }
}

/// `headerFormats`（strictObject。キーは帳票上部の入力欄）。
pub fn parse_header_formats(value: &Value) -> Result<HeaderFormats> {
    let o = validate::strict(value, &["C2", "A4", "B4", "C4", "E4"])?;
    Ok(HeaderFormats { c2: parse_optional(o.get("C2"))?, a4: parse_optional(o.get("A4"))?, b4: parse_optional(o.get("B4"))?, c4: parse_optional(o.get("C4"))?, e4: parse_optional(o.get("E4"))? })
}

/// 明細1行のセル（チェック・品名・型式・メーカー・数量・備考）の書式。
#[derive(Debug, Clone, PartialEq, Eq, Default, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct LineFormats {
    #[serde(skip_serializing_if = "Option::is_none")] pub mark: Option<CellFormat>,
    #[serde(skip_serializing_if = "Option::is_none")] pub name: Option<CellFormat>,
    #[serde(skip_serializing_if = "Option::is_none")] pub model: Option<CellFormat>,
    #[serde(skip_serializing_if = "Option::is_none")] pub manufacturer: Option<CellFormat>,
    #[serde(skip_serializing_if = "Option::is_none")] pub quantity: Option<CellFormat>,
    #[serde(skip_serializing_if = "Option::is_none")] pub remarks: Option<CellFormat>,
}

impl LineFormats {
    pub fn is_empty(&self) -> bool { *self == LineFormats::default() }
    pub fn get(&self, field: LineField) -> Option<&CellFormat> {
        match field {
            LineField::Mark => self.mark.as_ref(), LineField::Name => self.name.as_ref(), LineField::Model => self.model.as_ref(),
            LineField::Manufacturer => self.manufacturer.as_ref(), LineField::Quantity => self.quantity.as_ref(), LineField::Remarks => self.remarks.as_ref(),
        }
    }
}

/// `lineFormats`（strictObject。キーは明細の欄）。
pub fn parse_line_formats(value: &Value) -> Result<LineFormats> {
    let o = validate::strict(value, &["mark", "name", "model", "manufacturer", "quantity", "remarks"])?;
    Ok(LineFormats {
        mark: parse_optional(o.get("mark"))?, name: parse_optional(o.get("name"))?, model: parse_optional(o.get("model"))?,
        manufacturer: parse_optional(o.get("manufacturer"))?, quantity: parse_optional(o.get("quantity"))?, remarks: parse_optional(o.get("remarks"))?,
    })
}

// serde の Deserialize は JSON から読むときだけ使う（検証は上の parse_* で行う）。
impl<'de> serde::Deserialize<'de> for LineFormats {
    fn deserialize<D: serde::Deserializer<'de>>(deserializer: D) -> std::result::Result<Self, D::Error> {
        let value = Value::deserialize(deserializer)?;
        parse_line_formats(&value).map_err(|_| serde::de::Error::custom("invalid line formats"))
    }
}

impl<'de> serde::Deserialize<'de> for HeaderFormats {
    fn deserialize<D: serde::Deserializer<'de>>(deserializer: D) -> std::result::Result<Self, D::Error> {
        let value = Value::deserialize(deserializer)?;
        parse_header_formats(&value).map_err(|_| serde::de::Error::custom("invalid header formats"))
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn formats_accept_only_known_values() {
        let format = parse_format(&json!({ "horizontal": "center", "vertical": "top", "bold": true, "size": 14, "color": "FF0000", "fill": "FFF2CC" })).unwrap();
        assert_eq!(crate::js::stringify(&format), r#"{"horizontal":"center","vertical":"top","bold":true,"size":14,"color":"FF0000","fill":"FFF2CC"}"#);
        for bad in [json!({ "horizontal": "justify" }), json!({ "vertical": "bottom" }), json!({ "bold": false }), json!({ "size": 13 }), json!({ "size": 11.5 }), json!({ "color": "ff0000" }), json!({ "fill": "123456" }), json!({ "font": "x" }), json!([])] {
            assert!(parse_format(&bad).is_err(), "{bad}");
        }
    }

    #[test]
    fn empty_formats_are_dropped() {
        assert!(parse_header_formats(&json!({ "C2": {} })).unwrap().is_empty());
        assert_eq!(parse_line_formats(&json!({ "name": { "italic": true } })).unwrap().name, Some(CellFormat { italic: true, ..CellFormat::default() }));
        assert!(parse_line_formats(&json!({ "C2": {} })).is_err());
    }
}
