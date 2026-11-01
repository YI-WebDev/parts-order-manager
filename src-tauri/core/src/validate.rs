//! zod の検証（strictObject・tuple・uuid・int など）と同じ受け入れ範囲で、JSON の入力を型付きの値へ読む。
//! 失敗はすべて `Error::Validation`（旧実装の ZodError）になる。

use serde_json::{Map, Value};

use crate::error::{Error, Result};
use crate::js;

fn fail(what: &str) -> Error { Error::invalid(what.to_string()) }

/// IPC の引数列（`ipcMain.handle(channel, (event, ...args))` の args）。長さは zod の tuple と同じく厳密に確かめる。
pub fn tuple(args: &[Value], length: usize) -> Result<&[Value]> {
    if args.len() != length { return Err(fail("tuple length")); }
    Ok(args)
}

/// `z.strictObject({...})`: オブジェクトで、未知のキーがないこと。
pub struct Obj<'a> { map: &'a Map<String, Value> }

pub fn strict<'a>(value: &'a Value, keys: &[&str]) -> Result<Obj<'a>> {
    let Value::Object(map) = value else { return Err(fail("object")) };
    if map.keys().any(|key| !keys.contains(&key.as_str())) { return Err(fail("unrecognized keys")); }
    Ok(Obj { map })
}

/// `z.object({...})`（未知のキーは無視）。
pub fn loose<'a>(value: &'a Value) -> Result<Obj<'a>> {
    let Value::Object(map) = value else { return Err(fail("object")) };
    Ok(Obj { map })
}

impl<'a> Obj<'a> {
    /// 値。キーがなければ undefined（None）。
    pub fn get(&self, key: &str) -> Option<&'a Value> { self.map.get(key) }
    /// 必須のキー（undefined は不可）。
    pub fn req(&self, key: &str) -> Result<&'a Value> { self.map.get(key).ok_or_else(|| fail(key)) }
    pub fn string(&self, key: &str, min: usize, max: usize) -> Result<String> { string(self.req(key)?, min, max) }
    pub fn uuid(&self, key: &str) -> Result<String> { uuid(self.req(key)?) }
    pub fn int(&self, key: &str) -> Result<i64> { int(self.req(key)?) }
    pub fn boolean(&self, key: &str) -> Result<bool> { boolean(self.req(key)?) }
    pub fn nullable_uuid(&self, key: &str) -> Result<Option<String>> { nullable(self.req(key)?, uuid) }
    pub fn map(&self) -> &'a Map<String, Value> { self.map }
}

/// `z.string().min(min).max(max)`（zod 4 は文字数をコードポイントで数える）。
pub fn string(value: &Value, min: usize, max: usize) -> Result<String> {
    let Value::String(text) = value else { return Err(fail("string")) };
    let length = js::cp_len(text);
    if length < min || length > max { return Err(fail("string length")); }
    Ok(text.clone())
}

pub fn uuid(value: &Value) -> Result<String> {
    match value { Value::String(text) if js::is_uuid(text) => Ok(text.clone()), _ => Err(fail("uuid")) }
}

/// `z.int()`（安全な整数）。
pub fn int(value: &Value) -> Result<i64> { js::safe_int(value).ok_or_else(|| fail("int")) }

pub fn int_range(value: &Value, min: i64, max: i64) -> Result<i64> {
    let number = int(value)?;
    if number < min || number > max { return Err(fail("int range")); }
    Ok(number)
}

pub fn boolean(value: &Value) -> Result<bool> { value.as_bool().ok_or_else(|| fail("boolean")) }

/// `.nullable()`
pub fn nullable<T>(value: &Value, read: impl FnOnce(&Value) -> Result<T>) -> Result<Option<T>> {
    if value.is_null() { Ok(None) } else { read(value).map(Some) }
}

/// `z.array(...).max(max)`
pub fn array(value: &Value, max: usize) -> Result<&Vec<Value>> {
    match value { Value::Array(items) if items.len() <= max => Ok(items), _ => Err(fail("array")) }
}

/// `z.enum([...])`
pub fn one_of(value: &Value, choices: &[&str]) -> Result<String> {
    match value { Value::String(text) if choices.contains(&text.as_str()) => Ok(text.clone()), _ => Err(fail("enum")) }
}

/// 文字列に NUL を含まない（`.refine(value => !value.includes('\0'))`）。
pub fn no_nul(text: String) -> Result<String> {
    if text.contains('\0') { Err(fail("nul")) } else { Ok(text) }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn strict_objects_reject_extra_keys() {
        let value = json!({ "a": 1, "b": 2 });
        assert!(strict(&value, &["a", "b", "c"]).is_ok());
        assert!(strict(&value, &["a"]).is_err());
        assert!(strict(&json!([]), &[]).is_err());
    }

    #[test]
    fn strings_count_code_points_like_zod() {
        assert!(string(&json!("𠮷"), 0, 1).is_ok());
        assert!(string(&json!("𠮷𠮷"), 0, 1).is_err());
        assert!(string(&json!(1), 0, 2).is_err());
    }

    #[test]
    fn tuples_require_exact_length() {
        assert!(tuple(&[json!(1)], 1).is_ok());
        assert!(tuple(&[], 1).is_err());
        assert!(tuple(&[json!(1), json!(2)], 1).is_err());
    }
}
