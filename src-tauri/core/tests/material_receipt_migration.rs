//! tests/unit/material-receipt-migration.test.ts の移植（版2→版3: material_create_receipts の追加）。

use std::collections::BTreeMap;
use std::path::Path;

use pom_core::db::{migrations, Migration, Store};
use rusqlite::types::Value;
use rusqlite::{params, Connection, OpenFlags, OptionalExtension};
use tempfile::TempDir;

type Rows = Vec<BTreeMap<String, Value>>;

/// `.all()`（列名→値の行の並び）。
fn all(conn: &Connection, sql: &str) -> Rows {
    let mut statement = conn.prepare(sql).unwrap();
    let names: Vec<String> = statement.column_names().iter().map(|name| name.to_string()).collect();
    let mut rows = statement.query([]).unwrap();
    let mut out = Vec::new();
    while let Some(row) = rows.next().unwrap() {
        out.push(names.iter().enumerate().map(|(index, name)| (name.clone(), row.get::<_, Value>(index).unwrap())).collect());
    }
    out
}

fn pragma_i64(conn: &Connection, name: &str) -> i64 {
    conn.query_row(&format!("PRAGMA {name}"), [], |row| row.get(0)).unwrap()
}

fn entries(directory: &Path) -> Vec<String> {
    let mut names: Vec<String> = std::fs::read_dir(directory).unwrap().map(|entry| entry.unwrap().file_name().to_string_lossy().into_owned()).collect();
    names.sort();
    names
}

fn fixture() -> (TempDir, Store) {
    let root = tempfile::Builder::new().prefix("step10-receipt-").tempdir().unwrap();
    let store = Store::open(root.path(), &migrations()[..2]).unwrap();
    let db = store.conn();
    db.execute("INSERT INTO categories VALUES (?,?,?,?)", params!["fictional", " 保持 ", 0, 1]).unwrap();
    db.execute("INSERT INTO import_batches VALUES (?,?,?,?,?,?,?,?,?,?,?,?)", params!["batch", "series", None::<String>, "initial", "a".repeat(64), "fictional.xlsx", "1", "applied", "[]", "{}", "{}", "fixture"]).unwrap();
    db.execute("INSERT INTO import_items VALUES (?,?,?,?,?,?,?,?,?,?,?)", params!["item", "batch", "row", "架空", 0, 2, "left", "A2", serde_json::json!({ "A": { "rawValue": " 001 ", "displayText": " 001 " } }).to_string(), "candidate", "fixture"]).unwrap();
    db.execute("INSERT INTO materials VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)", params!["material", "fictional", " 原文 ", "001", "架空", "02 本", "", "0", "原文", 1, 4, "item", "created", "updated"]).unwrap();
    db.execute("INSERT INTO import_decisions VALUES (?,?,?,?,?,?,?,?)", params!["decision", "item", "material", "new", "[]", "架空", "fixture", "batch"]).unwrap();
    db.execute("INSERT INTO documents VALUES (?,?,?,?,?,?,?,?,?)", params!["document", "架空保持", "{}", 2, "1", None::<String>, 0, "created", "updated"]).unwrap();
    db.execute("INSERT INTO document_lines VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)", params!["line", "document", 0, "material", "item", "旧snapshot", "0001", "架空", "0", "", "unknown", "unresolved", "", "unconfirmed"]).unwrap();
    (root, store)
}

const TABLES: [&str; 8] = ["schema_migrations", "categories", "materials", "documents", "document_lines", "import_batches", "import_items", "import_decisions"];

fn before(store: &Store) -> Vec<Rows> {
    TABLES.iter().map(|table| all(store.conn(), &format!("SELECT * FROM {table} ORDER BY rowid"))).collect()
}

#[test]
fn adds_receipts_to_version2_with_verified_backup_while_preserving_every_old_table_and_history() {
    let (root, store) = fixture();
    let contents = before(&store);
    store.close();
    // 受領記録を足す3版までの移行（4版の材料の削除の列は material_deletion.rs で確かめる）。
    let upgraded = Store::open(root.path(), &migrations()[..3]).unwrap();
    assert_eq!(before(&upgraded)[1..], contents[1..]);
    assert_eq!(all(upgraded.conn(), "SELECT * FROM schema_migrations WHERE version<=2 ORDER BY version"), contents[0]);
    let dirs = entries(&root.path().join("migration-backups"));
    assert_eq!(dirs.len(), 1);
    let backup = Connection::open_with_flags(root.path().join("migration-backups").join(&dirs[0]).join("before.sqlite"), OpenFlags::SQLITE_OPEN_READ_ONLY).unwrap();
    assert_eq!(pragma_i64(&backup, "user_version"), 2);
    assert_eq!(all(&backup, "SELECT * FROM categories"), contents[1]);
    assert_eq!(backup.query_row("PRAGMA integrity_check", [], |row| row.get::<_, String>(0)).unwrap(), "ok");
    assert_eq!(pragma_i64(upgraded.conn(), "user_version"), 3);
    assert_eq!(upgraded.conn().query_row("SELECT count(*) AS n FROM material_create_receipts", [], |row| row.get::<_, i64>(0)).unwrap(), 0);
}

#[derive(Clone, Copy, PartialEq)]
enum Failure { Ddl, Backup }

/// `it.each(['DDL','backup'])('preserves version2 and data on receipt migration %s failure')`
fn preserves_version2_and_data_on_receipt_migration_failure(failure: Failure) {
    let (root, store) = fixture();
    let contents = before(&store);
    store.close();
    let receipt = migrations()[2].clone();
    if failure == Failure::Backup { std::fs::write(root.path().join("migration-backups"), "fictional obstruction").unwrap(); }
    let plan: Vec<Migration> = match failure {
        Failure::Ddl => {
            let mut plan = migrations()[..2].to_vec();
            plan.push(Migration { sql: format!("{} INVALID SQL;", receipt.sql), ..receipt });
            plan
        }
        Failure::Backup => migrations(),
    };
    assert!(Store::open(root.path(), &plan).is_err());
    let reopened = Store::open(root.path(), &migrations()[..2]).unwrap();
    assert_eq!(before(&reopened), contents);
    assert_eq!(pragma_i64(reopened.conn(), "user_version"), 2);
    let table: Option<String> = reopened.conn().query_row("SELECT name FROM sqlite_master WHERE name='material_create_receipts'", [], |row| row.get(0)).optional().unwrap();
    assert_eq!(table, None);
}

#[test]
fn preserves_version2_and_data_on_receipt_migration_ddl_failure() {
    preserves_version2_and_data_on_receipt_migration_failure(Failure::Ddl);
}

#[test]
fn preserves_version2_and_data_on_receipt_migration_backup_failure() {
    preserves_version2_and_data_on_receipt_migration_failure(Failure::Backup);
}
