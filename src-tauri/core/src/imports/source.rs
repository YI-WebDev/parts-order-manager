//! 取込元ファイルの読込（src/main/imports/source.ts・dropped.ts）。

use std::io::Read;
use std::path::{Path, PathBuf};

use super::workbook::parse_workbook;
use super::{extname, import_error, limits, ParsedWorkbook};
use crate::error::{ImportCode, Result};
use crate::js;
use crate::validate;

pub struct Source { pub parsed: ParsedWorkbook, pub hash: String, pub display_name: String }

fn file_name(file: &Path) -> String { file.file_name().map(|n| n.to_string_lossy().into_owned()).unwrap_or_default() }

fn read_bounded(file: &Path) -> Result<Vec<u8>> {
    let info = std::fs::metadata(file)?;
    if !info.is_file() || info.len() > limits::FILE_BYTES as u64 { return Err(import_error(ImportCode::Limit, "16 MiB以下のExcelファイルを選んでください。")); }
    let mut handle = std::fs::File::open(file)?;
    let mut bytes = Vec::with_capacity(info.len() as usize);
    let mut chunk = vec![0u8; 64 * 1024];
    loop {
        let read = handle.read(&mut chunk)?;
        if read == 0 { break; }
        bytes.extend_from_slice(&chunk[..read]);
        if bytes.len() > limits::FILE_BYTES { return Err(import_error(ImportCode::Limit, "Excelの容量が読取上限を超えています。")); }
    }
    Ok(bytes)
}

/// 選んだExcelを読み、作業用の複製から解析し、解析中に元ファイルが変わっていないことを確かめる（inspectSource）。
pub fn inspect_source(file: &Path) -> Result<Source> {
    if extname(&file_name(file)).to_lowercase() != ".xlsx" { return Err(import_error(ImportCode::Format, ".xlsxファイルを選んでください。")); }
    let original = read_bounded(file)?;
    let hash = js::sha256_hex(&original);
    let temp_root = std::env::temp_dir();
    let temporary = crate::db::make_temp_dir(&temp_root, "parts-import-")?;
    if temporary.parent() != Some(temp_root.as_path()) || !file_name(&temporary).starts_with("parts-import-") {
        let _ = std::fs::remove_dir_all(&temporary);
        return Err(import_error(ImportCode::Format, "作業用フォルダーを確認できません。"));
    }
    let result = (|| -> Result<Source> {
        let copy = temporary.join("source.xlsx");
        std::fs::OpenOptions::new().write(true).create_new(true).open(&copy).and_then(|mut f| std::io::Write::write_all(&mut f, &original))?;
        let parsed = parse_workbook(&std::fs::read(&copy)?)?;
        let after = js::sha256_hex(read_bounded(file)?);
        if after != hash { return Err(import_error(ImportCode::Changed, "解析中に元のExcelが変更されました。保存を終えてから選び直してください。")); }
        Ok(Source { parsed, hash: hash.clone(), display_name: file_name(file) })
    })();
    let _ = std::fs::remove_dir_all(&temporary);
    result
}

fn win32_absolute(text: &str) -> bool {
    let b = text.as_bytes();
    matches!(b.first(), Some(b'/') | Some(b'\\')) || (b.len() >= 3 && b[0].is_ascii_alphabetic() && b[1] == b':' && (b[2] == b'/' || b[2] == b'\\'))
}

/// ドロップしたファイルのパス。ファイル選択ダイアログを経ないため、ローカルの絶対パスの.xlsxだけを受け付ける（droppedWorkbookPath）。
pub fn dropped_workbook_path(value: &serde_json::Value) -> Result<PathBuf> {
    let file = validate::no_nul(validate::string(value, 1, 4096)?)?;
    if !win32_absolute(&file) && !file.starts_with('/') { return Err(import_error(ImportCode::Validation, "ファイルの場所を確認できません。クリックしてファイルを選んでください。")); }
    if ["\\\\", "//", "\\/", "/\\"].iter().any(|prefix| file.starts_with(prefix)) { return Err(import_error(ImportCode::Validation, "ネットワーク上のファイルは取り込めません。ローカルのドライブへコピーしてから選んでください。")); }
    let path = PathBuf::from(&file);
    if extname(&file_name(&path)).to_lowercase() != ".xlsx" { return Err(import_error(ImportCode::Format, ".xlsxファイルを選んでください。")); }
    let resolved = std::path::absolute(&path).map_err(|_| import_error(ImportCode::Validation, "ファイルの場所を確認できません。クリックしてファイルを選んでください。"))?;
    Ok(normalize_absolute(&resolved))
}

/// path.resolve と同じく . と .. を取り除く（ファイルシステムは参照しない）。
pub fn normalize_absolute(path: &Path) -> PathBuf {
    use std::path::Component;
    let mut out = PathBuf::new();
    for component in path.components() {
        match component {
            Component::ParentDir => { out.pop(); }
            Component::CurDir => {}
            other => out.push(other.as_os_str()),
        }
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::error::Error;
    use serde_json::json;

    #[test]
    fn dropped_paths_must_be_local_absolute_xlsx() {
        assert!(matches!(dropped_workbook_path(&json!("relative.xlsx")), Err(Error::Import(ImportCode::Validation, _))));
        assert!(matches!(dropped_workbook_path(&json!("//server/share/a.xlsx")), Err(Error::Import(ImportCode::Validation, m)) if m.contains("ネットワーク")));
        assert!(matches!(dropped_workbook_path(&json!("\\\\server\\share\\a.xlsx")), Err(Error::Import(ImportCode::Validation, m)) if m.contains("ネットワーク")));
        assert!(matches!(dropped_workbook_path(&json!("/tmp/a.csv")), Err(Error::Import(ImportCode::Format, _))));
        assert!(matches!(dropped_workbook_path(&json!("")), Err(Error::Validation(_))));
        assert!(matches!(dropped_workbook_path(&json!("/tmp/a\u{0}.xlsx")), Err(Error::Validation(_))));
        #[cfg(unix)]
        assert_eq!(dropped_workbook_path(&json!("/tmp/x/../架空.XLSX")).unwrap(), PathBuf::from("/tmp/架空.XLSX"));
    }
}
