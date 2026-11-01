//! tests/unit/database-migrations.test.ts の移植（SQLite の初期化と移行の安全性）。

use std::path::Path;

use pom_core::db::{migrations, Migration, Store};
use pom_core::Error;
use rusqlite::{Connection, OpenFlags, OptionalExtension};
use tempfile::TempDir;

fn directory() -> TempDir {
    tempfile::Builder::new().prefix("step04-db-").tempdir().unwrap()
}

fn pragma_i64(conn: &Connection, name: &str) -> i64 {
    conn.query_row(&format!("PRAGMA {name}"), [], |row| row.get(0)).unwrap()
}

fn integrity(conn: &Connection) -> String {
    conn.query_row("PRAGMA integrity_check", [], |row| row.get(0)).unwrap()
}

fn category_name(conn: &Connection) -> Option<String> {
    conn.query_row("SELECT name FROM categories", [], |row| row.get(0)).optional().unwrap()
}

fn entries(directory: &Path) -> Vec<String> {
    let mut names: Vec<String> = std::fs::read_dir(directory).unwrap().map(|entry| entry.unwrap().file_name().to_string_lossy().into_owned()).collect();
    names.sort();
    names
}

/// 既存の移行に1段だけ足した計画。
fn plan_with(sql: &str) -> Vec<Migration> {
    let mut plan = migrations();
    plan.push(Migration { version: plan.len() as i64 + 1, sql: sql.into(), rebuilds_referenced_tables: false });
    plan
}

/// `rejects.toThrow(text)`: DatabaseError で、文言に text を含む。
fn assert_db_error_contains<T>(result: pom_core::Result<T>, text: &str) {
    match result {
        Err(Error::Db(_, message)) => assert!(message.contains(text), "message {message:?} does not contain {text:?}"),
        Err(other) => panic!("expected DatabaseError containing {text:?}, got {other}"),
        Ok(_) => panic!("expected DatabaseError containing {text:?}, got Ok"),
    }
}

#[test]
fn creates_an_empty_database_enables_foreign_keys_reopens_without_reseeding() {
    let root = directory();
    let first = Store::open_default(root.path()).unwrap();
    assert_eq!(pragma_i64(first.conn(), "foreign_keys"), 1);
    assert_eq!(first.conn().query_row("SELECT count(*) AS n FROM materials", [], |row| row.get::<_, i64>(0)).unwrap(), 0);
    first.conn().execute("INSERT INTO categories VALUES (?, ?, ?, ?)", rusqlite::params!["fixture", "架空", 0, 1]).unwrap();
    first.close();
    let second = Store::open_default(root.path()).unwrap();
    assert_eq!(category_name(second.conn()).as_deref(), Some("架空"));
    assert_eq!(pragma_i64(second.conn(), "user_version"), migrations().len() as i64);
    assert!(!entries(root.path()).contains(&"migration-backups".to_string()));
}

#[test]
fn backs_up_committed_wal_data_before_an_upgrade() {
    let root = directory();
    let first = Store::open_default(root.path()).unwrap();
    first.conn().execute("INSERT INTO categories VALUES (?, ?, ?, ?)", rusqlite::params!["fixture", "WAL保持", 0, 1]).unwrap();
    // first は開いたまま（WAL にだけある確定済みの変更もバックアップに入ること）。
    let upgraded = Store::open(root.path(), &plan_with("CREATE TABLE upgrade_probe (id TEXT);")).unwrap();
    let backups = entries(&root.path().join("migration-backups"));
    assert_eq!(backups.len(), 1);
    let backup = Connection::open_with_flags(root.path().join("migration-backups").join(&backups[0]).join("before.sqlite"), OpenFlags::SQLITE_OPEN_READ_ONLY).unwrap();
    assert_eq!(category_name(&backup).as_deref(), Some("WAL保持"));
    assert_eq!(pragma_i64(&backup, "user_version"), migrations().len() as i64);
    assert_eq!(integrity(&backup), "ok");
    assert_eq!(pragma_i64(upgraded.conn(), "user_version"), migrations().len() as i64 + 1);
    drop(backup);
    upgraded.close();
    first.close();
}

#[test]
fn rolls_back_failed_ddl_and_keeps_the_prior_version_and_data() {
    let root = directory();
    let first = Store::open_default(root.path()).unwrap();
    first.conn().execute("INSERT INTO categories VALUES (?, ?, ?, ?)", rusqlite::params!["fixture", "保持", 0, 1]).unwrap();
    first.close();
    assert!(Store::open(root.path(), &plan_with("CREATE TABLE partial_change(id TEXT); INVALID SQL;")).is_err());
    let reopened = Store::open_default(root.path()).unwrap();
    let partial: Option<String> = reopened.conn().query_row("SELECT name FROM sqlite_master WHERE name='partial_change'", [], |row| row.get(0)).optional().unwrap();
    assert_eq!(partial, None);
    assert_eq!(category_name(reopened.conn()).as_deref(), Some("保持"));
}

#[test]
fn stops_before_migration_when_backup_cannot_be_created() {
    let root = directory();
    let first = Store::open_default(root.path()).unwrap();
    first.close();
    std::fs::write(root.path().join("migration-backups"), "blocked fixture").unwrap();
    assert!(Store::open(root.path(), &plan_with("CREATE TABLE forbidden_change(id TEXT);")).is_err());
    let reopened = Store::open_default(root.path()).unwrap();
    assert_eq!(pragma_i64(reopened.conn(), "user_version"), migrations().len() as i64);
}

#[test]
fn refuses_a_future_schema_without_rewriting_its_file() {
    let root = directory();
    let first = Store::open_default(root.path()).unwrap();
    first.conn().execute_batch("PRAGMA user_version=99").unwrap();
    first.close();
    let before = std::fs::read(root.path().join("app.sqlite")).unwrap();
    assert_db_error_contains(Store::open_default(root.path()), "未対応");
    assert_eq!(std::fs::read(root.path().join("app.sqlite")).unwrap(), before);
}

#[test]
fn refuses_unrelated_databases_and_edited_migration_histories() {
    let root = directory();
    let unrelated = Connection::open(root.path().join("app.sqlite")).unwrap();
    unrelated.execute_batch("CREATE TABLE untouched (id TEXT)").unwrap();
    unrelated.close().unwrap();
    assert_db_error_contains(Store::open_default(root.path()), "スキーマ");
    let other_root = directory();
    let first = Store::open_default(other_root.path()).unwrap();
    first.conn().execute_batch("UPDATE schema_migrations SET hash='tampered'").unwrap();
    first.close();
    assert_db_error_contains(Store::open_default(other_root.path()), "スキーマ");
}
