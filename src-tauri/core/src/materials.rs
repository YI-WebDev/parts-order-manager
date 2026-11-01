//! 材料・カテゴリの保存（src/main/db/materials.ts）。

use std::collections::HashSet;

use rusqlite::{params, Row};
use serde::{Deserialize, Serialize};
use serde_json::Value;

use crate::db::{flag, optional, Store};
use crate::error::{DbCode, Error, Result};
use crate::js;
use crate::validate;

use crate::limits::{DELETE_MAX, TEXT_MAX};

/// 材料の6項目（品名・形式・メーカー・数量・備考・単価）。
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, Default)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct MaterialValues { pub name: String, pub model: String, pub manufacturer: String, pub quantity: String, pub remarks: String, pub unit_price: String }

pub const MATERIAL_FIELDS: [&str; 6] = ["name", "model", "manufacturer", "quantity", "remarks", "unitPrice"];

impl MaterialValues {
    /// `materialValues`（strictObject、各10,000文字まで）
    pub fn parse(value: &Value) -> Result<Self> {
        let o = validate::strict(value, &MATERIAL_FIELDS)?;
        Ok(MaterialValues {
            name: o.string("name", 0, TEXT_MAX)?, model: o.string("model", 0, TEXT_MAX)?, manufacturer: o.string("manufacturer", 0, TEXT_MAX)?,
            quantity: o.string("quantity", 0, TEXT_MAX)?, remarks: o.string("remarks", 0, TEXT_MAX)?, unit_price: o.string("unitPrice", 0, TEXT_MAX)?,
        })
    }
    /// 各項目の前後の空白（全角・半角）を除いた値（文中の空白・改行はそのまま）。
    /// 登録する材料の値は、手動の保存・初回取込・更新取込のどの経路でも、DB へ書く create・update でこの形にする（利用者の指示、2026年10月15日）。
    pub fn trimmed(self) -> Self {
        let t = |value: String| js::trim(&value).to_string();
        MaterialValues { name: t(self.name), model: t(self.model), manufacturer: t(self.manufacturer), quantity: t(self.quantity), remarks: t(self.remarks), unit_price: t(self.unit_price) }
    }
    pub fn check(&self) -> Result<()> {
        for text in [&self.name, &self.model, &self.manufacturer, &self.quantity, &self.remarks, &self.unit_price] {
            if js::cp_len(text) > TEXT_MAX { return Err(Error::invalid("material text length")); }
        }
        Ok(())
    }
    pub fn get(&self, field: &str) -> &str {
        match field { "name" => &self.name, "model" => &self.model, "manufacturer" => &self.manufacturer, "quantity" => &self.quantity, "remarks" => &self.remarks, _ => &self.unit_price }
    }
    /// 取込の行の値（品名・形式・メーカー・数量・備考・単価の順）から。
    pub fn from_slice(values: &[String]) -> Self {
        let at = |i: usize| values.get(i).cloned().unwrap_or_default();
        MaterialValues { name: at(0), model: at(1), manufacturer: at(2), quantity: at(3), remarks: at(4), unit_price: at(5) }
    }
}

/// 検索用の文字列（search_text 列）。
pub fn search_text(values: &MaterialValues) -> String {
    let joined = [&values.name, &values.model, &values.manufacturer, &values.quantity, &values.remarks].map(|s| s.as_str()).join(" ");
    js::lower(js::trim(&js::nfkc(&joined)))
}

#[derive(Debug, Clone, PartialEq)]
pub struct MaterialRow {
    pub id: String, pub category_id: String, pub values: MaterialValues, pub search_text: String, pub active: bool, pub revision: i64,
    pub last_source_item_id: Option<String>, pub created_at: String, pub updated_at: String,
}

pub const MATERIAL_COLUMNS: &str = "id, category_id, name, model, manufacturer, quantity, remarks, unit_price, search_text, active, revision, last_source_item_id, created_at, updated_at";

pub fn material_row(row: &Row) -> rusqlite::Result<MaterialRow> {
    Ok(MaterialRow {
        id: row.get(0)?, category_id: row.get(1)?,
        values: MaterialValues { name: row.get(2)?, model: row.get(3)?, manufacturer: row.get(4)?, quantity: row.get(5)?, remarks: row.get(6)?, unit_price: row.get(7)? },
        search_text: row.get(8)?, active: flag(row.get(9)?), revision: row.get(10)?, last_source_item_id: row.get(11)?, created_at: row.get(12)?, updated_at: row.get(13)?,
    })
}

/// `categoryInput`（名前 1〜1000 文字・並び順は0以上）でカテゴリを作る。
pub fn create_category(store: &Store, name: &str, sort_order: i64) -> Result<String> {
    if js::cp_len(name) < 1 || js::cp_len(name) > 1000 || sort_order < 0 { return Err(Error::invalid("category")); }
    let id = js::random_uuid();
    store.conn().execute("INSERT INTO categories (id, name, sort_order, active) VALUES (?, ?, ?, ?)", params![id, name, sort_order, 1])?;
    Ok(id)
}

/// 材料を登録する。値は前後の空白を除いた形で書く（MaterialValues::trimmed）。
pub fn create(store: &Store, category_id: &str, values: &MaterialValues) -> Result<String> {
    if !js::is_uuid(category_id) { return Err(Error::invalid("categoryId")); }
    values.check()?;
    let values = values.clone().trimmed();
    let id = js::random_uuid();
    let now = js::iso_now();
    store.conn().execute(
        "INSERT INTO materials (id, category_id, name, model, manufacturer, quantity, remarks, unit_price, search_text, active, revision, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
        params![id, category_id, values.name, values.model, values.manufacturer, values.quantity, values.remarks, values.unit_price, search_text(&values), 1, 1, now, now],
    )?;
    Ok(id)
}

/// 削除していない材料（削除した材料は見つからない扱い）。
pub fn get(store: &Store, id: &str) -> Result<MaterialRow> {
    if !js::is_uuid(id) { return Err(Error::invalid("materialId")); }
    find(store, id)?.ok_or_else(|| Error::db(DbCode::NotFound, "材料が見つかりません。"))
}

pub fn find(store: &Store, id: &str) -> Result<Option<MaterialRow>> {
    optional(store.conn().query_row(&format!("SELECT {MATERIAL_COLUMNS} FROM materials WHERE id = ? AND deleted_at IS NULL"), [id], material_row))
}

pub struct MaterialUpdate<'a> { pub id: &'a str, pub expected_revision: i64, pub category_id: &'a str, pub active: bool, pub values: &'a MaterialValues }

/// 材料を更新する。値は前後の空白を除いた形で書く（MaterialValues::trimmed）。
pub fn update(store: &Store, input: MaterialUpdate) -> Result<i64> {
    if !js::is_uuid(input.id) || !js::is_uuid(input.category_id) || input.expected_revision < 1 { return Err(Error::invalid("material update")); }
    input.values.check()?;
    let v = input.values.clone().trimmed();
    let changed = store.conn().execute(
        "UPDATE materials SET name = ?, model = ?, manufacturer = ?, quantity = ?, remarks = ?, unit_price = ?, category_id = ?, active = ?, search_text = ?, revision = ?, updated_at = ? WHERE id = ? AND revision = ? AND deleted_at IS NULL",
        params![v.name, v.model, v.manufacturer, v.quantity, v.remarks, v.unit_price, input.category_id, input.active as i64, search_text(&v), input.expected_revision + 1, js::iso_now(), input.id, input.expected_revision],
    )?;
    if changed != 1 { return Err(Error::db(DbCode::Conflict, "材料は変更されています。再読込してください。")); }
    Ok(input.expected_revision + 1)
}

pub fn set_last_source(store: &Store, material_id: &str, item_id: &str) -> Result<()> {
    store.conn().execute("UPDATE materials SET last_source_item_id = ? WHERE id = ?", params![item_id, material_id])?;
    Ok(())
}

/// 削除する材料の ID の列（1〜100件・重複なし）。
pub fn parse_material_ids(value: &Value) -> Result<Vec<String>> {
    let items = validate::array(value, DELETE_MAX)?;
    if items.is_empty() { return Err(Error::invalid("materialIds")); }
    let ids = items.iter().map(validate::uuid).collect::<Result<Vec<_>>>()?;
    if ids.iter().collect::<HashSet<_>>().len() != ids.len() { return Err(Error::invalid("materialIds")); }
    Ok(ids)
}

/// 材料を削除済みにする（1つの文で。すべて削除するか、何も削除しない）。戻り値は今回削除した数。
/// 行は消さずに削除した日時を記録し、版を上げる（取込の判断履歴・作成の受領記録・請求書の明細が参照し、取込の記録は変更できないため）。
/// 削除済み・存在しない ID は削除済みとして扱う（応答が失われた後の再送を失敗にしない）。
pub fn delete(store: &Store, ids: &[String]) -> Result<usize> {
    let placeholders = vec!["?"; ids.len()].join(",");
    let now = js::iso_now();
    Ok(store.conn().execute(
        &format!("UPDATE materials SET deleted_at = ?, updated_at = ?, revision = revision + 1 WHERE deleted_at IS NULL AND id IN ({placeholders})"),
        rusqlite::params_from_iter([&now, &now].into_iter().chain(ids)),
    )?)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn search_text_normalizes_width_case_and_edges() {
        let values = MaterialValues { name: " ＡＢＣ ".into(), model: "ｶﾀ".into(), manufacturer: "".into(), quantity: "".into(), remarks: "".into(), unit_price: "999".into() };
        assert_eq!(search_text(&values), "abc  カタ");
    }
}
