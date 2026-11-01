//! SQLite の接続・スキーマ移行・トランザクション（src/main/db/database.ts）。

use std::cell::Cell;
use std::path::{Path, PathBuf};

use rusqlite::{Connection, OpenFlags, OptionalExtension};

use crate::error::{DbCode, Error, Result};
use crate::js;

pub const APPLICATION_ID: i64 = 0x504f_4d31;

#[derive(Debug, Clone)]
pub struct Migration { pub version: i64, pub sql: String, pub rebuilds_referenced_tables: bool }

pub fn migrations() -> Vec<Migration> {
    vec![
        Migration { version: 1, sql: include_str!("../migrations/0001.sql").to_string(), rebuilds_referenced_tables: false },
        Migration { version: 2, sql: include_str!("../migrations/0002.sql").to_string(), rebuilds_referenced_tables: true },
        Migration { version: 3, sql: include_str!("../migrations/0003.sql").to_string(), rebuilds_referenced_tables: false },
        // 材料の削除（削除した日時。行は消さない: 取込の判断履歴・作成の受領記録・請求書の明細が参照し、取込の記録は変更できないため）。
        Migration { version: 4, sql: include_str!("../migrations/0004.sql").to_string(), rebuilds_referenced_tables: false },
    ]
}

/// 移行SQLのチェックサム（改行の違いは無視する）。
pub fn checksum(sql: &str) -> String { js::sha256_hex(sql.replace("\r\n", "\n")) }

pub struct Store {
    conn: Connection,
    pub file: PathBuf,
    depth: Cell<u32>,
}

#[derive(Clone, Copy, PartialEq, Eq)]
pub enum Tx { Deferred, Immediate }

fn schema(message: &str) -> Error { Error::db(DbCode::Schema, message) }

pub fn pragma_i64(conn: &Connection, name: &str) -> Result<i64> {
    Ok(conn.query_row(&format!("PRAGMA {name}"), [], |row| row.get::<_, i64>(0))?)
}

pub fn integrity_ok(conn: &Connection) -> Result<bool> {
    let first: String = conn.query_row("PRAGMA integrity_check", [], |row| row.get(0))?;
    Ok(first == "ok")
}

pub fn foreign_key_violations(conn: &Connection) -> Result<usize> {
    let mut statement = conn.prepare("PRAGMA foreign_key_check")?;
    let mut rows = statement.query([])?;
    let mut count = 0;
    while rows.next()?.is_some() { count += 1; }
    Ok(count)
}

/// `mkdtemp(prefix)`（prefix の後ろに 6 文字の英数字を付けたディレクトリを新規作成）。
pub fn make_temp_dir(parent: &Path, prefix: &str) -> std::io::Result<PathBuf> {
    const CHARS: &[u8] = b"ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789";
    for _ in 0..100 {
        let random = uuid::Uuid::new_v4().into_bytes();
        let suffix: String = random.iter().take(6).map(|b| CHARS[*b as usize % CHARS.len()] as char).collect();
        let candidate = parent.join(format!("{prefix}{suffix}"));
        match std::fs::create_dir(&candidate) {
            Ok(()) => return Ok(candidate),
            Err(error) if error.kind() == std::io::ErrorKind::AlreadyExists => continue,
            Err(error) => return Err(error),
        }
    }
    Err(std::io::Error::other("mkdtemp failed"))
}

/// `db.backup(file)`（オンラインバックアップ API で全ページを複製する）。
pub fn backup_to(conn: &Connection, destination: &Path) -> Result<()> {
    let mut target = Connection::open(destination)?;
    {
        let backup = rusqlite::backup::Backup::new(conn, &mut target)?;
        backup.run_to_completion(100, std::time::Duration::from_millis(0), None)?;
    }
    target.close().map_err(|(_, error)| Error::from(error))?;
    Ok(())
}

pub fn open_readonly(file: &Path) -> Result<Connection> {
    Ok(Connection::open_with_flags(file, OpenFlags::SQLITE_OPEN_READ_ONLY | OpenFlags::SQLITE_OPEN_NO_MUTEX)?)
}

fn migrate(conn: &Connection, directory: &Path, plan: &[Migration]) -> Result<()> {
    if plan.is_empty() || plan.iter().enumerate().any(|(index, step)| step.version != index as i64 + 1) { return Err(schema("スキーマ定義が不正です。")); }
    let version = pragma_i64(conn, "user_version")?;
    if version < 0 { return Err(Error::invalid("user_version")); }
    let application_id = pragma_i64(conn, "application_id")?;
    if version > plan.len() as i64 { return Err(schema("未対応の新しいスキーマです。対応するアプリで開いてください。")); }
    if version == 0 {
        let tables: i64 = conn.query_row("SELECT count(*) FROM sqlite_master WHERE name NOT LIKE 'sqlite_%'", [], |row| row.get(0))?;
        if application_id != 0 || tables != 0 { return Err(schema("識別できないスキーマです。初期化せず停止しました。")); }
    } else {
        if application_id != APPLICATION_ID { return Err(schema("異なるアプリのスキーマです。")); }
        let mut statement = conn.prepare("SELECT version, hash FROM schema_migrations ORDER BY version")?;
        let history: Vec<(rusqlite::types::Value, rusqlite::types::Value)> = statement.query_map([], |row| Ok((row.get(0)?, row.get(1)?)))?.collect::<std::result::Result<_, _>>()?;
        let mut parsed = Vec::with_capacity(history.len());
        for (v, h) in history {
            let (rusqlite::types::Value::Integer(v), rusqlite::types::Value::Text(h)) = (v, h) else { return Err(Error::invalid("schema_migrations row")) };
            if v <= 0 { return Err(Error::invalid("schema_migrations version")); }
            parsed.push((v, h));
        }
        if parsed.len() as i64 != version || parsed.iter().enumerate().any(|(index, (v, h))| *v != index as i64 + 1 || *h != checksum(plan.get(index).map(|m| m.sql.as_str()).unwrap_or(""))) {
            return Err(schema("スキーマ履歴が一致しません。初期化せず停止しました。"));
        }
    }
    if !integrity_ok(conn)? || foreign_key_violations(conn)? != 0 { return Err(schema("DBの整合性を確認できません。")); }
    if version == plan.len() as i64 { return Ok(()); }
    if version > 0 {
        let attempt = || -> Result<()> {
            let backups = directory.join("migration-backups");
            std::fs::create_dir_all(&backups)?;
            let destination = make_temp_dir(&backups, &format!("v{version}-"))?;
            let snapshot_path = destination.join("before.sqlite");
            backup_to(conn, &snapshot_path)?;
            let snapshot = open_readonly(&snapshot_path)?;
            let valid = integrity_ok(&snapshot)? && pragma_i64(&snapshot, "user_version")? == version && pragma_i64(&snapshot, "application_id")? == APPLICATION_ID;
            drop(snapshot);
            if !valid { return Err(Error::db(DbCode::Backup, "更新前バックアップを検証できません。")); }
            Ok(())
        };
        match attempt() {
            Ok(()) => {}
            Err(error @ Error::Db(..)) => return Err(error),
            Err(_) => return Err(Error::db(DbCode::Backup, "更新前バックアップに失敗しました。DBを更新せず停止しました。")),
        }
    }
    let pending = &plan[version as usize..];
    let rebuilds = pending.iter().any(|step| step.rebuilds_referenced_tables);
    if rebuilds { conn.execute_batch("PRAGMA foreign_keys=OFF")?; }
    let result = (|| -> Result<()> {
        conn.execute_batch("BEGIN IMMEDIATE")?;
        let body = (|| -> Result<()> {
            for step in pending {
                conn.execute_batch(&step.sql)?;
                conn.execute("INSERT INTO schema_migrations(version, hash) VALUES (?, ?)", rusqlite::params![step.version, checksum(&step.sql)])?;
            }
            if foreign_key_violations(conn)? != 0 { return Err(schema("更新後の参照整合性が不正です。")); }
            conn.execute_batch(&format!("PRAGMA application_id={APPLICATION_ID}"))?;
            conn.execute_batch(&format!("PRAGMA user_version={}", plan.len()))?;
            Ok(())
        })();
        match body {
            Ok(()) => { conn.execute_batch("COMMIT")?; Ok(()) }
            Err(error) => { let _ = conn.execute_batch("ROLLBACK"); Err(error) }
        }
    })();
    if rebuilds { conn.execute_batch("PRAGMA foreign_keys=ON")?; }
    result
}

impl Store {
    /// `openDatabase(directory, plan)`
    pub fn open(directory: &Path, plan: &[Migration]) -> Result<Store> {
        if !directory.is_absolute() { return Err(Error::db(DbCode::Validation, "DB保存先はアプリ専用の絶対パスで指定してください。")); }
        std::fs::create_dir_all(directory)?;
        let file = directory.join("app.sqlite");
        let conn = Connection::open(&file)?;
        let setup = (|| -> Result<()> {
            conn.execute_batch("PRAGMA foreign_keys=ON")?;
            migrate(&conn, directory, plan)?;
            let _: String = conn.query_row("PRAGMA journal_mode=WAL", [], |row| row.get(0))?;
            conn.execute_batch("PRAGMA synchronous=FULL")?;
            Ok(())
        })();
        match setup {
            Ok(()) => {
                let store = Store { conn, file, depth: Cell::new(0) };
                crate::search::register(&store)?;
                Ok(store)
            }
            Err(error) => { drop(conn); Err(error) }
        }
    }

    pub fn open_default(directory: &Path) -> Result<Store> { Store::open(directory, &migrations()) }

    pub fn conn(&self) -> &Connection { &self.conn }

    /// `store.sqlite.transaction(fn)`（.immediate() は Tx::Immediate）。入れ子は SAVEPOINT。
    pub fn transaction<T>(&self, kind: Tx, body: impl FnOnce() -> Result<T>) -> Result<T> {
        let depth = self.depth.get();
        if depth == 0 && !self.conn.is_autocommit() { return Err(Error::other("unexpected open transaction")); }
        let name = format!("pom_sp_{depth}");
        if depth == 0 {
            self.conn.execute_batch(if kind == Tx::Immediate { "BEGIN IMMEDIATE" } else { "BEGIN" })?;
        } else {
            self.conn.execute_batch(&format!("SAVEPOINT {name}"))?;
        }
        self.depth.set(depth + 1);
        let result = body();
        self.depth.set(depth);
        match result {
            Ok(value) => {
                let commit = if depth == 0 { self.conn.execute_batch("COMMIT") } else { self.conn.execute_batch(&format!("RELEASE {name}")) };
                if let Err(error) = commit {
                    if depth == 0 { let _ = self.conn.execute_batch("ROLLBACK"); }
                    return Err(error.into());
                }
                Ok(value)
            }
            Err(error) => {
                if depth == 0 { let _ = self.conn.execute_batch("ROLLBACK"); } else { let _ = self.conn.execute_batch(&format!("ROLLBACK TO {name}; RELEASE {name}")); }
                Err(error)
            }
        }
    }

    pub fn close(self) {
        let _ = self.conn.close();
    }
}

/// 1 行の取得（行がなければ None）。
pub fn optional<T>(result: rusqlite::Result<T>) -> Result<Option<T>> { Ok(result.optional()?) }

/// drizzle の boolean 列（1 だけを true とする）。
pub fn flag(value: i64) -> bool { value == 1 }

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn checksums_ignore_crlf() {
        assert_eq!(checksum("a\r\nb"), checksum("a\nb"));
    }

    #[test]
    fn nested_transactions_roll_back_together() {
        let dir = tempfile::tempdir().unwrap();
        let store = Store::open_default(dir.path()).unwrap();
        let result: Result<()> = store.transaction(Tx::Immediate, || {
            store.conn().execute("INSERT INTO categories VALUES ('a','x',0,1)", [])?;
            store.transaction(Tx::Deferred, || { store.conn().execute("INSERT INTO categories VALUES ('b','y',0,1)", [])?; Ok(()) })?;
            Err(Error::other("stop"))
        });
        assert!(result.is_err());
        let count: i64 = store.conn().query_row("SELECT count(*) FROM categories", [], |r| r.get(0)).unwrap();
        assert_eq!(count, 0);
        assert!(store.conn().is_autocommit());
    }
}
