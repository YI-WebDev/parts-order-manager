//! 取込・更新取込・材料管理の結合テストで共有する補助。
//! Excel の組立は旧実装の tests/fixtures/xlsx.ts と同じ内容を作る（ZIP は src/zip.rs の write_fixture を使う）。

#![allow(dead_code)]

use std::path::Path;

use indexmap::IndexMap;
use pom_core::db::Store;
use pom_core::error::Error;
use rusqlite::types::Value as SqlValue;

pub const NS: &str = "http://schemas.openxmlformats.org/spreadsheetml/2006/main";
pub const HEADERS: [&str; 6] = ["品名", "形式又はタイプ", "メーカー", "数量", "備考", "単価"];

/// ZIP の部品（JavaScript のオブジェクトと同じく、既存の名前を上書きしても並びは変わらない）。
pub type Parts = IndexMap<String, String>;

/// `zipParts(parts, compress)`
pub fn zip_parts(parts: &Parts, compress: bool) -> Vec<u8> {
    let entries: Vec<(&str, &[u8])> = parts.iter().map(|(name, value)| (name.as_str(), value.as_bytes())).collect();
    pom_core::zip::write_fixture(&entries, compress)
}

pub fn escape_xml(text: &str) -> String { text.replace('&', "&amp;").replace('<', "&lt;").replace('>', "&gt;").replace('"', "&quot;") }

pub fn text_cell(reference: &str, text: &str) -> String { format!(r#"<c r="{reference}" t="inlineStr"><is><t xml:space="preserve">{}</t></is></c>"#, escape_xml(text)) }

pub fn number_cell(reference: &str, value: &str, style: u32) -> String { format!(r#"<c r="{reference}" s="{style}"><v>{value}</v></c>"#) }

pub fn header_row() -> String {
    let columns = ["A", "B", "C", "D", "E", "F", "H", "I", "J", "K", "L", "M"];
    let cells: String = columns.iter().enumerate().map(|(i, column)| text_cell(&format!("{column}1"), HEADERS[i % 6])).collect();
    format!(r#"<row r="1">{cells}</row>"#)
}

/// `workbookParts(rows, extra)`
pub fn workbook_parts(rows: &str, extra: &[(&str, &str)]) -> Parts {
    let mut parts = Parts::new();
    let mut put = |name: &str, value: String| { parts.insert(name.to_string(), value); };
    put("[Content_Types].xml", r#"<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/></Types>"#.into());
    put("_rels/.rels", r#"<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/></Relationships>"#.into());
    put("xl/workbook.xml", format!(r#"<workbook xmlns="{NS}" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><sheets><sheet name="架空材料" sheetId="1" r:id="rId1"/></sheets></workbook>"#));
    put("xl/_rels/workbook.xml.rels", r#"<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet1.xml"/></Relationships>"#.into());
    put("xl/styles.xml", format!(r##"<styleSheet xmlns="{NS}"><numFmts count="2"><numFmt numFmtId="164" formatCode="00000"/><numFmt numFmtId="176" formatCode="#,##0;[Red]#,##0"/></numFmts><cellXfs count="4"><xf numFmtId="0"/><xf numFmtId="164"/><xf numFmtId="176"/><xf numFmtId="56"/></cellXfs></styleSheet>"##));
    put("xl/worksheets/sheet1.xml", format!(r#"<worksheet xmlns="{NS}"><sheetData>{}{rows}</sheetData></worksheet>"#, header_row()));
    for (name, value) in extra { put(name, value.to_string()); }
    parts
}

/// `syntheticWorkbook()`
pub fn synthetic_workbook() -> Vec<u8> {
    let row = |n: u32| format!(
        r#"<row r="{n}">{}{}{}{}{}{}{}</row>"#,
        text_cell(&format!("A{n}"), " 架空材料 "), text_cell(&format!("B{n}"), "001-A"), text_cell(&format!("D{n}"), "02 本"), number_cell(&format!("F{n}"), "0", 0),
        text_cell(&format!("H{n}"), "右の架空材料"), text_cell(&format!("I{n}"), "R-01"), number_cell(&format!("K{n}"), "12", 1),
    );
    let rows = format!(r#"{}<row r="3">{}{}</row>{}"#, row(2), text_cell("C3", "架空注記"), text_cell("G3", "架空の未確定補足"), row(5));
    zip_parts(&workbook_parts(&rows, &[]), true)
}

// ---- 異常なZIP（ZIP64 の境界値） ----

fn le16(b: &[u8], at: usize) -> usize { u16::from_le_bytes([b[at], b[at + 1]]) as usize }
fn le32(b: &[u8], at: usize) -> u32 { u32::from_le_bytes([b[at], b[at + 1], b[at + 2], b[at + 3]]) }

/// 中央ディレクトリ項目の書換え。Some の値は32bit欄を 0xFFFFFFFF にして ZIP64 拡張情報（0x0001）へ入れる。
#[derive(Debug, Default, Clone, Copy)]
pub struct Zip64 { pub uncompressed: Option<u64>, pub compressed: Option<u64>, pub offset: Option<u64>, pub encrypted: bool }

/// 部品 `name` の中央ディレクトリ項目の位置（終端記録の直前に中央ディレクトリがあり、コメントのないZIPに限る）。
fn central_entries(bytes: &[u8]) -> (usize, usize, Vec<(usize, usize)>) {
    let end = bytes.len() - 22;
    assert_eq!(le32(bytes, end), 0x0605_4b50, "end of central directory");
    let start = le32(bytes, end + 16) as usize;
    let mut at = start;
    let mut entries = Vec::new();
    for _ in 0..le16(bytes, end + 10) {
        let length = 46 + le16(bytes, at + 28) + le16(bytes, at + 30) + le16(bytes, at + 32);
        entries.push((at, length));
        at += length;
    }
    (start, end, entries)
}

fn entry_name(bytes: &[u8], at: usize) -> &[u8] { &bytes[at + 46..at + 46 + le16(bytes, at + 28)] }

/// 部品 `name` の中央ディレクトリの実際の値（展開後・圧縮後の大きさとローカルヘッダーの位置）。
pub fn actual_zip64(bytes: &[u8], name: &str) -> Zip64 {
    let (_, _, entries) = central_entries(bytes);
    let (at, _) = *entries.iter().find(|(at, _)| entry_name(bytes, *at) == name.as_bytes()).expect("entry");
    Zip64 { uncompressed: Some(le32(bytes, at + 24) as u64), compressed: Some(le32(bytes, at + 20) as u64), offset: Some(le32(bytes, at + 42) as u64), encrypted: false }
}

/// `zip_parts` で作ったZIPの部品 `name` の中央ディレクトリ項目を `values` で書き換える（終端記録の中央ディレクトリの大きさも直す）。
pub fn with_zip64(bytes: &[u8], name: &str, values: Zip64) -> Vec<u8> {
    let (start, end, entries) = central_entries(bytes);
    let mut central = Vec::new();
    let mut found = false;
    for (at, length) in entries {
        let mut entry = bytes[at..at + length].to_vec();
        if entry_name(bytes, at) == name.as_bytes() {
            found = true;
            // ZIP64 拡張情報の値は「展開後・圧縮後・ローカルヘッダーの位置」の順。
            let mut field = Vec::new();
            for (value, position) in [(values.uncompressed, 24), (values.compressed, 20), (values.offset, 42)] {
                let Some(value) = value else { continue };
                entry[position..position + 4].copy_from_slice(&u32::MAX.to_le_bytes());
                field.extend_from_slice(&value.to_le_bytes());
            }
            if values.encrypted { entry[8] |= 1; }
            let extra_end = 46 + le16(&entry, 28) + le16(&entry, 30);
            let mut extra = 1u16.to_le_bytes().to_vec();
            extra.extend_from_slice(&(field.len() as u16).to_le_bytes());
            extra.extend_from_slice(&field);
            let extra_length = (le16(&entry, 30) + extra.len()) as u16;
            entry.splice(extra_end..extra_end, extra);
            entry[30..32].copy_from_slice(&extra_length.to_le_bytes());
        }
        central.extend_from_slice(&entry);
    }
    assert!(found, "missing entry {name}");
    let mut out = bytes[..start].to_vec();
    out.extend_from_slice(&central);
    let mut record = bytes[end..].to_vec();
    record[12..16].copy_from_slice(&(central.len() as u32).to_le_bytes());
    out.extend_from_slice(&record);
    out
}

/// 部品 `name` のローカルヘッダーの追加フィールド長だけを書き換える（後続のバイト列は動かさない）。
pub fn with_local_extra_length(bytes: &[u8], name: &str, length: u16) -> Vec<u8> {
    let offset = actual_zip64(bytes, name).offset.expect("offset") as usize;
    assert_eq!(le32(bytes, offset), 0x0403_4b50, "local file header");
    let mut out = bytes.to_vec();
    out[offset + 28..offset + 30].copy_from_slice(&length.to_le_bytes());
    out
}

// ---- DB ----

/// `mkdtemp(path.join(os.tmpdir(), prefix))`（後片付けは TempDir に任せる）。
pub fn temp_root(prefix: &str) -> tempfile::TempDir { tempfile::Builder::new().prefix(prefix).tempdir().expect("temp dir") }

/// `openDatabase(directory)`
pub fn open(directory: &Path) -> Store { Store::open_default(directory).expect("open database") }

/// `store.close(); store = await openDatabase(directory)`
pub fn reopen(store: Store, directory: &Path) -> Store { store.close(); open(directory) }

/// 架空のカテゴリを `count` 件作る（名前は「架空分類0000」から。並び順は作成順）。作った ID を作成順に返す。
pub fn seed_categories(store: &Store, count: usize) -> Vec<String> {
    store.transaction(pom_core::db::Tx::Immediate, || (0..count).map(|i| pom_core::materials::create_category(store, &format!("架空分類{i:04}"), i as i64)).collect()).expect("seed categories")
}

/// `SELECT count(*) n FROM table`
pub fn count(store: &Store, table: &str) -> i64 { store.conn().query_row(&format!("SELECT count(*) FROM {table}"), [], |row| row.get(0)).expect("count") }

/// `SELECT * FROM table ORDER BY rowid` を表ごとに並べたもの。
pub fn snapshot(store: &Store, tables: &[&str]) -> Vec<Vec<Vec<SqlValue>>> {
    tables.iter().map(|table| {
        let mut statement = store.conn().prepare(&format!("SELECT * FROM {table} ORDER BY rowid")).expect("prepare snapshot");
        let columns = statement.column_count();
        statement.query_map([], |row| (0..columns).map(|i| row.get::<_, SqlValue>(i)).collect::<rusqlite::Result<Vec<_>>>())
            .expect("snapshot").collect::<rusqlite::Result<Vec<_>>>().expect("snapshot rows")
    }).collect()
}

// ---- 例外の確認 ----

/// `error.message`（種類ごとの接頭辞を除いた文言）。
pub fn message(error: &Error) -> String {
    match error {
        Error::Db(_, m) | Error::Import(_, m) | Error::Backup(m) | Error::Gate(m) | Error::ExportFile(m) | Error::Validation(m) | Error::Other(m) => m.clone(),
        other => other.to_string(),
    }
}

/// `expect(fn).toThrow()`（失敗を取り出す）。
#[track_caller]
pub fn thrown<T>(result: pom_core::Result<T>) -> Error {
    match result { Ok(_) => panic!("expected an error, but the call succeeded"), Err(error) => error }
}

/// `expect(fn).toThrow(text)`（文言に text を含む）。
#[track_caller]
pub fn assert_throws<T>(result: pom_core::Result<T>, text: &str) {
    let error = thrown(result);
    assert!(message(&error).contains(text), "expected an error containing {text:?}, got {error}");
}
