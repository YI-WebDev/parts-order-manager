//! 旧実装（TypeScript）と同じ結果を出すための小さな互換関数。
//! 文字数の上限は JavaScript の `length`（UTF-16 の単位数）で数え、JSON は `JSON.stringify` と同じ並び・書式で出力する。

use serde::Serialize;
use sha2::{Digest, Sha256};
use unicode_normalization::UnicodeNormalization;

/// JavaScript の `string.length`（UTF-16 の単位数）。
pub fn len16(value: &str) -> usize {
    value.chars().map(char::len_utf16).sum()
}

/// zod 4 の文字数（Unicode のコードポイント数。z.string().min/max はこの数え方）。
pub fn cp_len(value: &str) -> usize {
    value.chars().count()
}

/// JavaScript の正規表現 `\s` と `String.prototype.trim` が空白とみなす文字。
pub fn is_js_space(c: char) -> bool {
    matches!(c, '\t' | '\n' | '\u{0B}' | '\u{0C}' | '\r' | ' ' | '\u{A0}' | '\u{1680}' | '\u{2000}'..='\u{200A}' | '\u{2028}' | '\u{2029}' | '\u{202F}' | '\u{205F}' | '\u{3000}' | '\u{FEFF}')
}

/// `value.trim()`
pub fn trim(value: &str) -> &str {
    value.trim_matches(is_js_space)
}

/// `value.replace(/\s+/gu, ' ')`
pub fn collapse_spaces(value: &str) -> String {
    let mut out = String::with_capacity(value.len());
    let mut in_space = false;
    for c in value.chars() {
        if is_js_space(c) {
            if !in_space { out.push(' '); }
            in_space = true;
        } else {
            out.push(c);
            in_space = false;
        }
    }
    out
}

/// `value.replace(/\s+/g, '')`
pub fn remove_spaces(value: &str) -> String {
    value.chars().filter(|c| !is_js_space(*c)).collect()
}

/// `value.normalize('NFKC')`
pub fn nfkc(value: &str) -> String {
    value.nfkc().collect()
}

/// `value.toLocaleLowerCase('en-US')`（既定の大文字・小文字対応。語末のシグマも JavaScript と同じく扱う）。
pub fn lower(value: &str) -> String {
    value.to_lowercase()
}

/// `JSON.stringify(value)`。構造体のフィールド順・`IndexMap` の挿入順がそのまま出力順になる。
pub fn stringify<T: Serialize + ?Sized>(value: &T) -> String {
    serde_json::to_string(value).expect("JSON serialization of plain data cannot fail")
}

/// UTF-8 のバイト数（`Buffer.byteLength(JSON.stringify(value))`）。
pub fn json_bytes<T: Serialize + ?Sized>(value: &T) -> usize {
    stringify(value).len()
}

pub fn sha256_hex(data: impl AsRef<[u8]>) -> String {
    hex::encode(Sha256::digest(data.as_ref()))
}

/// `new Date().toISOString()`（UTC・ミリ秒3桁）。
pub fn iso_now() -> String {
    iso_from(chrono::Utc::now())
}

pub fn iso_from(time: chrono::DateTime<chrono::Utc>) -> String {
    time.format("%Y-%m-%dT%H:%M:%S%.3fZ").to_string()
}

/// `crypto.randomUUID()`（小文字の v4 UUID）。
pub fn random_uuid() -> String {
    #[cfg(feature = "sequential-ids")]
    {
        // 差分テスト専用: 旧実装と同じ順に作られた識別子が同じ値になるよう、連番の UUID を返す。
        static NEXT: std::sync::atomic::AtomicU64 = std::sync::atomic::AtomicU64::new(1);
        let n = NEXT.fetch_add(1, std::sync::atomic::Ordering::SeqCst);
        return format!("00000000-0000-4000-8000-{n:012x}");
    }
    #[allow(unreachable_code)]
    uuid::Uuid::new_v4().to_string()
}

/// JavaScript の数値の文字列化（`String(number)`）。帳票の寸法など 1e-6 以上 1e21 未満の値で使う。
pub fn num(value: f64) -> String {
    if value == 0.0 { return "0".into(); }
    let magnitude = value.abs();
    if (1e-6..1e21).contains(&magnitude) { return format!("{value}"); }
    // 指数表記の範囲。帳票では使わないが、JavaScript と同じ形にそろえておく。
    let text = format!("{value:e}");
    let (mantissa, exponent) = text.split_once('e').unwrap_or((&text, "0"));
    let exponent: i32 = exponent.parse().unwrap_or(0);
    format!("{mantissa}e{}{}", if exponent < 0 { "-" } else { "+" }, exponent.abs())
}

/// zod の `z.uuid()` と同じ形式（RFC 9562 の版・変種、または全0・全f）。
pub fn is_uuid(value: &str) -> bool {
    let bytes = value.as_bytes();
    if bytes.len() != 36 { return false; }
    if value == "00000000-0000-0000-0000-000000000000" || value == "ffffffff-ffff-ffff-ffff-ffffffffffff" { return true; }
    for (index, byte) in bytes.iter().enumerate() {
        let ok = match index {
            8 | 13 | 18 | 23 => *byte == b'-',
            14 => (b'1'..=b'8').contains(byte),
            19 => matches!(byte, b'8' | b'9' | b'a' | b'b' | b'A' | b'B'),
            _ => byte.is_ascii_hexdigit(),
        };
        if !ok { return false; }
    }
    true
}

/// zod の `z.iso.datetime()`（既定: Z のみ・秒必須・小数秒は任意桁）。
pub fn is_iso_datetime(value: &str) -> bool {
    let Some((date, time)) = value.split_once('T') else { return false };
    if !is_iso_date(date) { return false; }
    let Some(time) = time.strip_suffix('Z') else { return false };
    let b = time.as_bytes();
    if b.len() < 8 || b[2] != b':' || b[5] != b':' { return false; }
    let two = |i: usize| b[i].is_ascii_digit() && b[i + 1].is_ascii_digit();
    if !two(0) || !two(3) || !two(6) { return false; }
    let hour = (b[0] - b'0') * 10 + (b[1] - b'0');
    if hour > 23 || b[3] > b'5' || b[6] > b'5' { return false; }
    match &b[8..] {
        [] => true,
        [b'.', rest @ ..] => !rest.is_empty() && rest.iter().all(u8::is_ascii_digit),
        _ => false,
    }
}

fn is_iso_date(value: &str) -> bool {
    let b = value.as_bytes();
    if b.len() != 10 || b[4] != b'-' || b[7] != b'-' || !b.iter().enumerate().all(|(i, c)| i == 4 || i == 7 || c.is_ascii_digit()) { return false; }
    let year = &value[0..4];
    let month: u32 = value[5..7].parse().unwrap_or(0);
    let day: u32 = value[8..10].parse().unwrap_or(0);
    if month == 2 && day == 29 {
        // zod: \d\d[2468][048]|\d\d[13579][26]|\d\d0[48]|[02468][048]00|[13579][26]00
        let y = year.as_bytes();
        let (c, d) = (y[2], y[3]);
        return (matches!(c, b'2' | b'4' | b'6' | b'8') && matches!(d, b'0' | b'4' | b'8'))
            || (matches!(c, b'1' | b'3' | b'5' | b'7' | b'9') && matches!(d, b'2' | b'6'))
            || (c == b'0' && matches!(d, b'4' | b'8'))
            || (&year[2..] == "00" && ((matches!(y[0], b'0' | b'2' | b'4' | b'6' | b'8') && matches!(y[1], b'0' | b'4' | b'8')) || (matches!(y[0], b'1' | b'3' | b'5' | b'7' | b'9') && matches!(y[1], b'2' | b'6'))));
    }
    match month {
        1 | 3 | 5 | 7 | 8 | 10 | 12 => (1..=31).contains(&day),
        4 | 6 | 9 | 11 => (1..=30).contains(&day),
        2 => (1..=28).contains(&day),
        _ => false,
    }
}

/// `Number.isSafeInteger` を満たす JSON の数値を整数として読む（`1.0` も整数）。
pub fn safe_int(value: &serde_json::Value) -> Option<i64> {
    const MAX: f64 = 9_007_199_254_740_991.0;
    if let Some(i) = value.as_i64() { return (i.unsigned_abs() <= MAX as u64).then_some(i); }
    if value.as_u64().is_some() { return None; }
    let f = value.as_f64()?;
    (f.fract() == 0.0 && f.abs() <= MAX).then_some(f as i64)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn utf16_length_counts_surrogate_pairs_twice() {
        assert_eq!(len16("abc"), 3);
        assert_eq!(len16("架空"), 2);
        assert_eq!(len16("𠮷"), 2);
    }

    #[test]
    fn numbers_print_like_javascript() {
        for (value, text) in [(7.0, "7"), (27.33203125, "27.33203125"), (-0.5, "-0.5"), (0.64, "0.64"), (1123.0, "1123"), (12.5, "12.5")] {
            assert_eq!(num(value), text);
        }
        assert_eq!(num(1e21), "1e+21");
        assert_eq!(num(1.5e-7), "1.5e-7");
    }

    #[test]
    fn uuid_format_matches_zod() {
        assert!(is_uuid("2a828729-e846-49ad-ac60-711ce689fcc2"));
        assert!(is_uuid("2A828729-E846-49AD-AC60-711CE689FCC2"));
        assert!(is_uuid("00000000-0000-4000-8000-000000000000"));
        assert!(is_uuid("00000000-0000-0000-0000-000000000000"));
        assert!(!is_uuid("2a828729-e846-09ad-ac60-711ce689fcc2"));
        assert!(!is_uuid("2a828729-e846-49ad-cc60-711ce689fcc2"));
        assert!(!is_uuid("2a828729e84649adac60711ce689fcc2"));
    }

    #[test]
    fn iso_datetime_matches_zod() {
        assert!(is_iso_datetime("2026-10-12T03:04:05.678Z"));
        assert!(is_iso_datetime("2024-02-29T00:00:00Z"));
        assert!(!is_iso_datetime("2023-02-29T00:00:00Z"));
        assert!(!is_iso_datetime("2026-10-12T03:04Z"));
        assert!(!is_iso_datetime("2026-10-12T24:00:00Z"));
        assert!(!is_iso_datetime("2026-10-12T03:04:05+09:00"));
        assert!(is_iso_datetime("2000-02-29T00:00:00Z"));
        assert!(!is_iso_datetime("1900-02-29T00:00:00Z"));
        assert!(iso_now().len() == 24 && is_iso_datetime(&iso_now()));
    }

    #[test]
    fn spaces_follow_javascript_regexp() {
        assert_eq!(collapse_spaces("a \t\u{3000}b\u{85}c"), "a b\u{85}c");
        assert_eq!(trim("\u{FEFF} a \u{3000}"), "a");
    }

    #[test]
    fn safe_integers() {
        assert_eq!(safe_int(&serde_json::json!(1.0)), Some(1));
        assert_eq!(safe_int(&serde_json::json!(1.5)), None);
        assert_eq!(safe_int(&serde_json::json!(9_007_199_254_740_992_u64)), None);
    }
}
