//! 画面表示用の補助情報（最終バックアップ日時・請求書ごとの最終出力）。src/main/ui-meta.ts と同じ ui-meta.json を読み書きする。
//! 業務データではないためDBの版を変えず、読めない・壊れている場合は空として扱う。バックアップには含めない。

use std::path::{Path, PathBuf};
use std::sync::Mutex;

use indexmap::IndexMap;
use serde::{Deserialize, Serialize};
use serde_json::Value;

use crate::js;

const MAX_EXPORTS: usize = 5000;

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct ExportRecord { pub revision: i64, pub at: String }

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Default)]
#[serde(rename_all = "camelCase")]
struct Meta { last_backup_at: Option<String>, exports: IndexMap<String, ExportRecord> }

fn parse(text: &str) -> Option<Meta> {
    let value: Value = serde_json::from_str(text).ok()?;
    let object = value.as_object()?;
    if object.keys().any(|k| k != "lastBackupAt" && k != "exports") { return None; }
    let last_backup_at = match object.get("lastBackupAt")? {
        Value::Null => None,
        Value::String(at) if js::is_iso_datetime(at) => Some(at.clone()),
        _ => return None,
    };
    let mut exports = IndexMap::new();
    for (id, entry) in object.get("exports")?.as_object()? {
        if !js::is_uuid(id) { return None; }
        let entry = entry.as_object()?;
        if entry.keys().any(|k| k != "revision" && k != "at") { return None; }
        let revision = js::safe_int(entry.get("revision")?).filter(|r| *r > 0)?;
        let at = entry.get("at")?.as_str().filter(|at| js::is_iso_datetime(at))?.to_string();
        exports.insert(id.clone(), ExportRecord { revision, at });
    }
    Some(Meta { last_backup_at, exports })
}

pub struct UiMeta { file: PathBuf, cache: Mutex<Option<Meta>> }

impl UiMeta {
    pub fn new(directory: &Path) -> UiMeta { UiMeta { file: directory.join("ui-meta.json"), cache: Mutex::new(None) } }

    fn read(&self) -> Meta {
        let mut cache = self.cache.lock().unwrap_or_else(|e| e.into_inner());
        if let Some(meta) = cache.as_ref() { return meta.clone(); }
        let meta = std::fs::read_to_string(&self.file).ok().and_then(|text| parse(&text)).unwrap_or_default();
        *cache = Some(meta.clone());
        meta
    }

    fn write(&self, next: Meta) {
        *self.cache.lock().unwrap_or_else(|e| e.into_inner()) = Some(next.clone());
        let temporary = PathBuf::from(format!("{}.{}.tmp", self.file.display(), std::process::id()));
        let attempt = || -> std::io::Result<()> {
            write_private(&temporary, js::stringify(&next).as_bytes())?;
            std::fs::rename(&temporary, &self.file)
        };
        // 表示用の補助情報のため、書込失敗は業務処理の結果に影響させない。
        let _ = attempt();
    }

    pub fn last_backup_at(&self) -> Option<String> { self.read().last_backup_at }

    pub fn record_backup(&self) {
        let mut meta = self.read();
        meta.last_backup_at = Some(js::iso_now());
        self.write(meta);
    }

    pub fn export_of(&self, document_id: &str) -> Option<ExportRecord> { self.read().exports.get(document_id).cloned() }

    /// 削除した帳票の出力の記録を消す。
    pub fn forget_exports(&self, document_ids: &[String]) {
        let mut meta = self.read();
        let before = meta.exports.len();
        meta.exports.retain(|id, _| !document_ids.contains(id));
        if meta.exports.len() != before { self.write(meta); }
    }

    pub fn record_export(&self, document_id: &str, revision: i64) {
        let mut meta = self.read();
        meta.exports.insert(document_id.to_string(), ExportRecord { revision, at: js::iso_now() });
        let mut entries: Vec<(String, ExportRecord)> = meta.exports.into_iter().collect();
        entries.sort_by(|(_, a), (_, b)| b.at.cmp(&a.at));
        entries.truncate(MAX_EXPORTS);
        meta.exports = entries.into_iter().collect();
        self.write(meta);
    }
}

/// 所有者だけが読み書きできるファイルとして書く（Windows では既定の ACL）。
pub fn write_private(file: &Path, bytes: &[u8]) -> std::io::Result<()> {
    let mut options = std::fs::OpenOptions::new();
    options.write(true).create(true).truncate(true);
    #[cfg(unix)]
    { use std::os::unix::fs::OpenOptionsExt; options.mode(0o600); }
    use std::io::Write;
    let mut handle = options.open(file)?;
    handle.write_all(bytes)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn records_and_reads_back() {
        let dir = tempfile::tempdir().unwrap();
        let meta = UiMeta::new(dir.path());
        assert_eq!(meta.last_backup_at(), None);
        meta.record_backup();
        let id = "2a828729-e846-49ad-ac60-711ce689fcc2";
        meta.record_export(id, 3);
        let reread = UiMeta::new(dir.path());
        assert!(reread.last_backup_at().is_some());
        assert_eq!(reread.export_of(id).map(|e| e.revision), Some(3));
    }

    #[test]
    fn broken_files_read_as_empty() {
        let dir = tempfile::tempdir().unwrap();
        for text in ["{", "{\"lastBackupAt\":null}", "{\"lastBackupAt\":\"x\",\"exports\":{}}", "{\"lastBackupAt\":null,\"exports\":{\"not-uuid\":{\"revision\":1,\"at\":\"2026-01-01T00:00:00.000Z\"}}}"] {
            std::fs::write(dir.path().join("ui-meta.json"), text).unwrap();
            let meta = UiMeta::new(dir.path());
            assert_eq!(meta.last_backup_at(), None);
            assert!(meta.read().exports.is_empty());
        }
    }
}
