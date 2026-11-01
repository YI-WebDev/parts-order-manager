//! バックアップの作成・検査・復元と、中断した復元の回復（src/main/backups）。
//! .pombak の形式は旧実装と同じ: "POMBAK01" + ヘッダー長（u32 LE）+ JSON の目録 + SQLite ファイル。

use std::io::{Read, Seek, SeekFrom, Write};
use std::path::{Path, PathBuf};

use rusqlite::Connection;
use serde_json::{json, Value};

use crate::db::{self, migrations, Store};
use crate::error::{Error, Result};
use crate::exports::{LAYOUT_VERSION, STYLES};
use crate::fsx;
use crate::js;
use crate::sheet::COLUMN_WIDTHS;
use crate::validate;

pub const BACKUP_DB_LIMIT: u64 = 128 * 1024 * 1024;
const HEADER_LIMIT: usize = 64 * 1024;
const MAGIC: &[u8; 8] = b"POMBAK01";

fn backup_error(message: &str) -> Error { Error::backup(message) }

pub fn migration_hashes() -> Vec<String> { migrations().iter().map(|m| db::checksum(&m.sql)).collect() }

/// 復元できるいちばん古いスキーマの版（旧版と、材料の削除を足す前のバックアップ）。新しい版へは、復元した後の起動で移行する。
pub const OLDEST_RESTORABLE_SCHEMA: usize = 3;

/// 復元できるスキーマの版か（OLDEST_RESTORABLE_SCHEMA から今の版まで）。
fn restorable_schema(version: i64) -> Option<usize> {
    usize::try_from(version).ok().filter(|version| (OLDEST_RESTORABLE_SCHEMA..=migrations().len()).contains(version))
}

fn width_value(width: f64) -> Value { if width.fract() == 0.0 { Value::from(width as i64) } else { Value::from(width) } }

fn layout_value() -> Value {
    json!({ "version": LAYOUT_VERSION, "columnWidths": COLUMN_WIDTHS.iter().map(|w| width_value(*w)).collect::<Vec<_>>(), "styles": *STYLES })
}

/// sqlite_master の一覧（改行コードの違いは同じ定義とみなす）。
fn objects(conn: &Connection) -> Result<Vec<(String, String, String, Option<String>)>> {
    let mut statement = conn.prepare("SELECT type,name,tbl_name,sql FROM sqlite_master ORDER BY type,name")?;
    let rows = statement.query_map([], |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?, row.get::<_, Option<String>>(3)?.map(|sql| sql.replace("\r\n", "\n")))))?;
    Ok(rows.collect::<std::result::Result<_, _>>()?)
}

fn sidecar(file: &Path, suffix: &str) -> PathBuf { PathBuf::from(format!("{}{suffix}", file.display())) }

/// 検査したDBのスキーマの版と、材料（削除した材料は数えない）・請求書の件数。
pub struct CheckedDatabase { pub schema: usize, pub materials: i64, pub documents: i64 }

/// バックアップに使えるDBか（版・構造・移行履歴・整合性）を確かめる。版は OLDEST_RESTORABLE_SCHEMA から今の版までで、構造・移行履歴はその版のものと一致すること。
pub fn validate_backup_database(file: &Path) -> Result<CheckedDatabase> {
    for (candidate, main) in [(file.to_path_buf(), true), (sidecar(file, "-wal"), false), (sidecar(file, "-shm"), false)] {
        let info = match fsx::lstat(&candidate) {
            Ok(info) => Some(info),
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => None,
            Err(error) => return Err(error.into()),
        };
        if info.is_none() && !main { continue; }
        match info { Some(i) if i.is_file && !i.is_symlink && i.nlink == 1 && i.size <= BACKUP_DB_LIMIT => {} _ => return Err(backup_error("DBファイルの形式または容量が不正です。")) }
    }
    let expected = Connection::open_in_memory()?;
    let conn = db::open_readonly(file)?;
    conn.execute_batch("PRAGMA trusted_schema=OFF")?;
    let pages = db::pragma_i64(&conn, "page_count")?;
    let page_size = db::pragma_i64(&conn, "page_size")?;
    if pages <= 0 || page_size <= 0 { return Err(Error::invalid("page_count")); }
    if (pages as u64) * (page_size as u64) > BACKUP_DB_LIMIT { return Err(backup_error("DBの論理容量が128MiBを超えています。")); }
    let mismatch = || backup_error("DBの版または構造が一致しません。");
    if db::pragma_i64(&conn, "application_id")? != db::APPLICATION_ID { return Err(mismatch()); }
    let schema = restorable_schema(db::pragma_i64(&conn, "user_version")?).ok_or_else(mismatch)?;
    expected.execute_batch("PRAGMA foreign_keys=OFF")?;
    expected.execute_batch("BEGIN")?;
    for step in &migrations()[..schema] { expected.execute_batch(&step.sql)?; }
    expected.execute_batch("COMMIT")?;
    if objects(&conn)? != objects(&expected)? { return Err(mismatch()); }
    let mut statement = conn.prepare("SELECT version,hash FROM schema_migrations ORDER BY version")?;
    let history: Vec<(i64, String)> = statement.query_map([], |row| Ok((row.get(0)?, row.get(1)?)))?.collect::<std::result::Result<_, _>>()?;
    let hashes = migration_hashes();
    if history.len() != schema || history.iter().enumerate().any(|(index, (version, hash))| *version != index as i64 + 1 || Some(hash) != hashes.get(index)) { return Err(backup_error("移行履歴が一致しません。")); }
    if !db::integrity_ok(&conn)? || db::foreign_key_violations(&conn)? != 0 { return Err(backup_error("DBの整合性を確認できません。")); }
    let count = |sql: &str| -> Result<i64> { Ok(conn.query_row(sql, [], |row| row.get(0))?) };
    // 削除した材料を記録する列は4版から。
    let materials = count(if schema >= 4 { "SELECT count(*) AS n FROM materials WHERE deleted_at IS NULL" } else { "SELECT count(*) AS n FROM materials" })?;
    Ok(CheckedDatabase { schema, materials, documents: count("SELECT count(*) AS n FROM documents")? })
}

/// 現在のDBを複製して検証し、.pombak の内容を作る。
pub fn create_archive(store: &Store, work_directory: &Path, app_version: &str) -> Result<Vec<u8>> {
    let pages = db::pragma_i64(store.conn(), "page_count")?;
    let page_size = db::pragma_i64(store.conn(), "page_size")?;
    if (pages.max(0) as u64) * (page_size.max(0) as u64) > BACKUP_DB_LIMIT { return Err(backup_error("DBがバックアップ容量上限128MiBを超えています。")); }
    std::fs::create_dir_all(work_directory)?;
    let directory = db::make_temp_dir(work_directory, "backup-")?;
    let file = directory.join("app.sqlite");
    db::backup_to(store.conn(), &file)?;
    if fsx::lstat(&file)?.size > BACKUP_DB_LIMIT { return Err(backup_error("DBがバックアップ容量上限を超えています。")); }
    // 使っているDBは起動時に今の版へ移行済みのため、目録の版は今の版になる。
    let checked = validate_backup_database(&file)?;
    let data = std::fs::read(&file)?;
    if js::cp_len(app_version) > 32 { return Err(Error::invalid("appVersion")); }
    let manifest = json!({
        "format": 1, "appVersion": app_version, "schemaVersion": checked.schema, "createdAt": js::iso_now(), "migrationHashes": &migration_hashes()[..checked.schema],
        "layout": layout_value(), "entries": [{ "path": "database/app.sqlite", "size": data.len(), "sha256": js::sha256_hex(&data) }],
    });
    let header = js::stringify(&manifest).into_bytes();
    if header.len() > HEADER_LIMIT { return Err(backup_error("バックアップ情報が容量上限を超えています。")); }
    let mut out = Vec::with_capacity(12 + header.len() + data.len());
    out.extend_from_slice(MAGIC);
    out.extend_from_slice(&(header.len() as u32).to_le_bytes());
    out.extend_from_slice(&header);
    out.extend_from_slice(&data);
    Ok(out)
}

fn is_hex64(text: &str) -> bool { text.len() == 64 && text.bytes().all(|b| b.is_ascii_digit() || (b'a'..=b'f').contains(&b)) }

struct Manifest { created_at: String, app_version: String, schema: usize, migration_hashes: Vec<String>, layout: (String, Vec<f64>, String), size: i64, sha256: String }

/// 目録（スキーマの版は OLDEST_RESTORABLE_SCHEMA から今の版まで、移行のチェックサムはその版の数だけ）。
fn parse_manifest(value: &Value) -> Result<Manifest> {
    let o = validate::strict(value, &["format", "appVersion", "schemaVersion", "createdAt", "migrationHashes", "layout", "entries"])?;
    if o.int("format")? != 1 { return Err(Error::invalid("manifest literal")); }
    let schema = restorable_schema(o.int("schemaVersion")?).ok_or_else(|| Error::invalid("manifest literal"))?;
    let app_version = o.string("appVersion", 0, 32)?;
    let created_at = validate::string(o.req("createdAt")?, 0, usize::MAX)?;
    if !js::is_iso_datetime(&created_at) { return Err(Error::invalid("createdAt")); }
    let hashes = validate::array(o.req("migrationHashes")?, schema)?;
    if hashes.len() != schema { return Err(Error::invalid("migrationHashes")); }
    let migration_hashes = hashes.iter().map(|h| validate::string(h, 0, usize::MAX).and_then(|h| if is_hex64(&h) { Ok(h) } else { Err(Error::invalid("hash")) })).collect::<Result<Vec<_>>>()?;
    let layout = validate::strict(o.req("layout")?, &["version", "columnWidths", "styles"])?;
    let widths = validate::array(layout.req("columnWidths")?, 8)?;
    if widths.len() != 8 { return Err(Error::invalid("columnWidths")); }
    let widths = widths.iter().map(|w| w.as_f64().ok_or_else(|| Error::invalid("width"))).collect::<Result<Vec<_>>>()?;
    let layout = (layout.string("version", 0, usize::MAX)?, widths, layout.string("styles", 0, 20000)?);
    let entries = validate::array(o.req("entries")?, 1)?;
    let [entry] = entries.as_slice() else { return Err(Error::invalid("entries")) };
    let entry = validate::strict(entry, &["path", "size", "sha256"])?;
    if entry.req("path")? != &Value::String("database/app.sqlite".into()) { return Err(Error::invalid("path")); }
    let size = entry.int("size")?;
    if size < 1 || size as u64 > BACKUP_DB_LIMIT { return Err(Error::invalid("size")); }
    let sha256 = entry.string("sha256", 64, 64)?;
    if !is_hex64(&sha256) { return Err(Error::invalid("sha256")); }
    Ok(Manifest { created_at, app_version, schema, migration_hashes, layout, size, sha256 })
}

pub struct Inspected { pub directory: PathBuf, pub sha256: String, pub created_at: String, pub materials: i64, pub documents: i64 }

/// 選んだ .pombak を検査し、復元候補を作業領域へ書き出す（復元はまだしない）。
pub fn inspect_archive(selected: &Path, work_directory: &Path, app_version: &str) -> Result<Inspected> {
    let before = fsx::lstat(selected)?;
    if !before.is_file || before.is_symlink || before.nlink != 1 || before.size < 12 || before.size > BACKUP_DB_LIMIT + HEADER_LIMIT as u64 + 12 { return Err(backup_error("通常ファイル・容量の条件を満たさないバックアップです。")); }
    let mut handle = std::fs::File::open(selected)?;
    let opened = fsx::fstat(&handle)?;
    if opened.dev != before.dev || opened.ino != before.ino || opened.size != before.size || opened.nlink != 1 { return Err(backup_error("検査中にファイルが変更されました。")); }
    let mut data = vec![0u8; opened.size as usize];
    let mut offset = 0;
    handle.seek(SeekFrom::Start(0))?;
    while offset < data.len() {
        let read = handle.read(&mut data[offset..])?;
        if read == 0 { return Err(backup_error("バックアップの末尾が不足しています。")); }
        offset += read;
    }
    let after = fsx::fstat(&handle)?;
    if after.size != opened.size || after.mtime != opened.mtime { return Err(backup_error("検査中にファイルが変更されました。")); }
    drop(handle);
    if &data[..8] != MAGIC { return Err(backup_error("対応するバックアップ形式ではありません。")); }
    let length = u32::from_le_bytes([data[8], data[9], data[10], data[11]]) as usize;
    if length > HEADER_LIMIT || length < 2 || 12 + length > data.len() { return Err(backup_error("バックアップ情報の容量が不正です。")); }
    let text = String::from_utf8_lossy(&data[12..12 + length]);
    let manifest = parse_manifest(&serde_json::from_str::<Value>(&text)?)?;
    let expected_widths: Vec<f64> = COLUMN_WIDTHS.to_vec();
    // 既定の書式は 2026年10月15日に中央揃えへ変えた。それより前の版の目録（旧既定の styles）も、同じアプリの版・列幅なら受け付ける（帳票の既定はDBの内容に関わらないため）。
    let (layout_version, widths, styles) = &manifest.layout;
    let layout_matches = *layout_version == LAYOUT_VERSION && *widths == expected_widths && (*styles == *STYLES || *styles == *crate::exports::LEGACY_STYLES);
    if manifest.app_version != app_version || !layout_matches || manifest.migration_hashes != migration_hashes()[..manifest.schema] {
        return Err(backup_error("このアプリの版・レイアウト・移行履歴と一致しません。"));
    }
    let payload = &data[12 + length..];
    if payload.len() as i64 != manifest.size || js::sha256_hex(payload) != manifest.sha256 { return Err(backup_error("バックアップの長さまたはチェックサムが不正です。")); }
    std::fs::create_dir_all(work_directory)?;
    let directory = db::make_temp_dir(work_directory, "restore-stage-")?;
    let file = directory.join("app.sqlite");
    std::fs::OpenOptions::new().write(true).create_new(true).open(&file)?.write_all(payload)?;
    let checked = validate_backup_database(&file)?;
    if checked.schema != manifest.schema { return Err(backup_error("DBの版または構造が一致しません。")); }
    Ok(Inspected { directory, sha256: js::sha256_hex(payload), created_at: manifest.created_at, materials: checked.materials, documents: checked.documents })
}

// ---- recovery.ts ----

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum RestorePoint { Prepared, Closed, Retained, Installed, Verified, Committed }

fn exists(path: &Path) -> Result<bool> {
    match std::fs::symlink_metadata(path) {
        Ok(_) => Ok(true),
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(false),
        Err(error) => Err(error.into()),
    }
}

fn directory(path: &Path) -> Result<()> {
    let info = fsx::lstat(path)?;
    if !info.is_dir || info.is_symlink { return Err(backup_error("復元領域が通常のディレクトリではありません。")); }
    Ok(())
}

fn durable(file: &Path, value: &str) -> Result<()> {
    if exists(file)? { return Err(backup_error("既存の復元記録があります。再起動後に確認してください。")); }
    let temporary = PathBuf::from(format!("{}.pending-{}", file.display(), js::random_uuid()));
    let mut handle = std::fs::OpenOptions::new().write(true).create_new(true).open(&temporary)?;
    handle.write_all(value.as_bytes())?;
    handle.sync_all()?;
    drop(handle);
    std::fs::rename(&temporary, file)?;
    Ok(())
}

fn read_journal(file: &Path) -> Result<String> {
    let info = fsx::lstat(file)?;
    if !info.is_file || info.is_symlink || info.nlink != 1 || info.size > 1024 { return Err(backup_error("復元記録が不正です。自動復元を停止しました。")); }
    let value: Value = serde_json::from_str(&std::fs::read_to_string(file)?)?;
    let o = validate::strict(&value, &["version", "id"])?;
    if o.int("version")? != 1 { return Err(Error::invalid("journal version")); }
    o.uuid("id")
}

/// 起動時に、中断した復元を確定または取り消す。
pub fn recover_restore(root: &Path) -> Result<Option<String>> {
    directory(root)?;
    let journal_path = root.join("restore-journal.json");
    if !exists(&journal_path)? { return Ok(None); }
    let id = read_journal(&journal_path)?;
    let current = root.join("database");
    let retained = root.join(format!("database-before-{id}"));
    let marker = root.join(format!("restore-committed-{id}.json"));
    if exists(&marker)? {
        let committed = read_journal(&marker)?;
        if committed != id { return Err(backup_error("復元完了記録が一致しません。")); }
        directory(&current)?;
        validate_backup_database(&current.join("app.sqlite"))?;
        std::fs::rename(&journal_path, root.join(format!("restore-finished-{id}.json")))?;
        return Ok(Some("復元済みDBの整合性を確認しました。復元前のDB一式は端末内に保持しています。".into()));
    }
    if exists(&retained)? {
        directory(&retained)?;
        if exists(&current)? {
            directory(&current)?;
            std::fs::rename(&current, root.join(format!("database-interrupted-{id}")))?;
        }
        std::fs::rename(&retained, &current)?;
    }
    directory(&current)?;
    validate_backup_database(&current.join("app.sqlite"))?;
    std::fs::rename(&journal_path, root.join(format!("restore-rolled-back-{id}.json")))?;
    Ok(Some("中断した復元を取り消し、復元前のDB一式へ戻しました。退避資料は端末内に保持しています。".into()))
}

fn same_path(a: &Path, b: &Path) -> bool {
    let normalize = |p: &Path| crate::imports::source::normalize_absolute(&std::path::absolute(p).unwrap_or_else(|_| p.to_path_buf()));
    normalize(a) == normalize(b)
}

/// 検査済みの候補へ切り替える。現在のDBは database-before-<id> として残す。
pub fn begin_restore(store: &mut Option<Store>, staged_directory: &Path, staged_sha256: &str, root: &Path, fault: &mut dyn FnMut(RestorePoint) -> Result<()>) -> Result<()> {
    directory(root)?;
    let current = root.join("database");
    let Some(live) = store.as_ref() else { return Err(backup_error("現在のDB領域が一致しません。")) };
    if !same_path(&live.file, &root.join("database").join("app.sqlite")) { return Err(backup_error("現在のDB領域が一致しません。")); }
    validate_backup_database(&live.file)?;
    let relative = staged_directory.strip_prefix(root).ok().map(Path::to_path_buf);
    let Some(relative) = relative.filter(|r| !r.as_os_str().is_empty() && r.components().all(|c| matches!(c, std::path::Component::Normal(_)))) else { return Err(backup_error("復元候補が専用領域の外にあります。")) };
    if relative.components().next().map(|c| c.as_os_str() == "database").unwrap_or(true) { return Err(backup_error("復元候補が専用領域の外にあります。")); }
    let mut ancestor = root.to_path_buf();
    for part in relative.components() { ancestor.push(part.as_os_str()); directory(&ancestor)?; }
    directory(&current)?;
    let mut files = Vec::new();
    for entry in std::fs::read_dir(staged_directory)? { files.push(entry?.file_name().to_string_lossy().into_owned()); }
    if files.iter().any(|f| !["app.sqlite", "app.sqlite-shm", "app.sqlite-wal"].contains(&f.as_str())) { return Err(backup_error("復元候補に許可されていないファイルがあります。")); }
    for name in &files {
        let info = fsx::lstat(&staged_directory.join(name))?;
        if !info.is_file || info.is_symlink || info.nlink != 1 || (name.ends_with("-wal") && info.size != 0) { return Err(backup_error("復元候補に通常ファイル以外が含まれます。")); }
    }
    let staged_file = staged_directory.join("app.sqlite");
    validate_backup_database(&staged_file)?;
    if js::sha256_hex(std::fs::read(&staged_file)?) != staged_sha256 { return Err(backup_error("確認後に復元候補が変更されました。再確認してください。")); }
    std::fs::OpenOptions::new().read(true).write(true).open(&staged_file)?.sync_all()?;
    let id = js::random_uuid();
    let journal = js::stringify(&json!({ "version": 1, "id": id }));
    durable(&root.join("restore-journal.json"), &journal)?;
    fault(RestorePoint::Prepared)?;
    if let Some(live) = store.take() { live.close(); }
    fault(RestorePoint::Closed)?;
    std::fs::rename(&current, root.join(format!("database-before-{id}")))?;
    fault(RestorePoint::Retained)?;
    std::fs::rename(staged_directory, &current)?;
    fault(RestorePoint::Installed)?;
    let reopened = Store::open_default(&current)?;
    reopened.close();
    fault(RestorePoint::Verified)?;
    durable(&root.join(format!("restore-committed-{id}.json")), &journal)?;
    fault(RestorePoint::Committed)?;
    recover_restore(root)?;
    Ok(())
}

// ---- gate.ts ----

/// 要求全体（ダイアログ・解析を含む）を覆う、バックアップ・復元との排他。
#[derive(Debug, Default)]
pub struct DatabaseGate { active: usize, frozen: bool }

impl DatabaseGate {
    pub fn acquire(&mut self) -> Result<()> {
        if self.frozen { return Err(Error::Gate("バックアップ・復元中です。完了までお待ちください。".into())); }
        self.active += 1;
        Ok(())
    }
    pub fn release(&mut self) { self.active = self.active.saturating_sub(1); }
    pub fn freeze(&mut self) -> Result<()> {
        if self.frozen || self.active != 0 { return Err(Error::Gate("処理中の要求があります。ファイル選択・取込・出力・印刷プレビューを完了または取り消して、もう一度操作してください。".into())); }
        self.frozen = true;
        Ok(())
    }
    pub fn thaw(&mut self) { self.frozen = false; }
    pub fn active(&self) -> usize { self.active }
    pub fn is_frozen(&self) -> bool { self.frozen }
}
