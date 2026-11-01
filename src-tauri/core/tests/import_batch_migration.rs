//! tests/unit/import-batch-migration.test.ts の移植（版1→版2: import_batches の作り直しと status='failed'）。

use std::collections::BTreeMap;
use std::path::Path;

use pom_core::db::{migrations, Migration, Store};
use pom_core::js::random_uuid;
use pom_core::materials::MATERIAL_COLUMNS;
use pom_core::Error;
use rusqlite::types::Value;
use rusqlite::{params, Connection, OpenFlags, OptionalExtension};
use tempfile::TempDir;

type Rows = Vec<BTreeMap<String, Value>>;

fn fixture() -> TempDir {
    tempfile::Builder::new().prefix("step04-batch-upgrade-").tempdir().unwrap()
}

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

fn status(conn: &Connection, id: &str) -> Option<String> {
    conn.query_row("SELECT status FROM import_batches WHERE id=?", [id], |row| row.get(0)).optional().unwrap()
}

fn entries(directory: &Path) -> Vec<String> {
    let mut names: Vec<String> = std::fs::read_dir(directory).unwrap().map(|entry| entry.unwrap().file_name().to_string_lossy().into_owned()).collect();
    names.sort();
    names
}

fn batch(db: &Connection, status: &str, previous: Option<&str>) -> String {
    let id = random_uuid();
    db.execute("INSERT INTO import_batches VALUES (?,?,?,?,?,?,?,?,?,?,?,?)", params![id, random_uuid(), previous, "initial", "a".repeat(64), "synthetic.xlsx", "1", status, "[]", "{}", "{}", "fixture"]).unwrap();
    id
}

fn seed(db: &Connection) -> String {
    let applied = batch(db, "applied", None);
    let preview = batch(db, "preview", Some(&applied));
    batch(db, "cancelled", Some(&applied));
    let item = random_uuid();
    let category = random_uuid();
    let material = random_uuid();
    let document = random_uuid();
    let raw = serde_json::json!({ "A": { "presence": "present", "kind": "text", "rawValue": " 001 ", "displayText": " 001 ", "formatCode": "@", "displayVerified": true } }).to_string();
    db.execute("INSERT INTO import_items VALUES (?,?,?,?,?,?,?,?,?,?,?)", params![item, applied, "row", "架空シート", 0, 3, "left", "A3", raw, "review", "fixture-fingerprint"]).unwrap();
    db.execute("INSERT INTO categories VALUES (?,?,?,?)", params![category, "架空", 0, 1]).unwrap();
    db.execute("INSERT INTO materials VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)", params![material, category, " 001 ", "02", "架空", "02 本", "備考", "001.00", "001", 1, 7, item, "created", "updated"]).unwrap();
    db.execute("INSERT INTO import_decisions VALUES (?,?,?,?,?,?,?,?)", params![random_uuid(), item, material, "apply", r#"["name"]"#, "架空判断", "fixture", applied]).unwrap();
    db.execute("INSERT INTO documents VALUES (?,?,?,?,?,?,?,?,?)", params![document, "架空帳票", r#"{"C2":"","A4":"","B4":"","C4":"","E4":""}"#, 4, "1", None::<String>, 0, "created", "updated"]).unwrap();
    db.execute("INSERT INTO document_lines VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)", params![random_uuid(), document, 0, material, item, "旧snapshot", "02", "架空", "02 本", "備考", "unknown", "unresolved", "", "unconfirmed"]).unwrap();
    preview
}

/// 各表の内容。材料は版1からある列だけ（4版で足した削除の列は、移行の後に空であることを別に確かめる）。
fn contents(db: &Connection) -> Vec<(&'static str, Rows)> {
    ["import_batches", "import_items", "import_decisions", "categories", "materials", "documents", "document_lines"]
        .into_iter().map(|table| (table, all(db, &format!("SELECT {} FROM {table} ORDER BY id", if table == "materials" { MATERIAL_COLUMNS } else { "*" })))).collect()
}

#[test]
fn stores_failed_on_a_fresh_database_and_reads_it_after_reopening() {
    let root = fixture();
    let first = Store::open_default(root.path()).unwrap();
    let id = batch(first.conn(), "preview", None);
    first.conn().execute("UPDATE import_batches SET status=? WHERE id=?", ["failed", id.as_str()]).unwrap();
    first.close();
    let reopened = Store::open_default(root.path()).unwrap();
    assert_eq!(status(reopened.conn(), &id).as_deref(), Some("failed"));
    assert_eq!(pragma_i64(reopened.conn(), "user_version"), migrations().len() as i64);
    assert_eq!(pragma_i64(reopened.conn(), "foreign_keys"), 1);
}

#[test]
fn upgrades_referenced_version1_batches_without_changing_raw_data_snapshots_or_old_history() {
    let root = fixture();
    let old = Store::open(root.path(), &migrations()[..1]).unwrap();
    let preview = seed(old.conn());
    let before = contents(old.conn());
    let history = all(old.conn(), "SELECT * FROM schema_migrations WHERE version=1");
    // old は開いたまま更新する。
    let upgraded = Store::open_default(root.path()).unwrap();
    assert_eq!(contents(upgraded.conn()), before);
    assert_eq!(upgraded.conn().query_row("SELECT count(*) FROM materials WHERE deleted_at IS NOT NULL", [], |row| row.get::<_, i64>(0)).unwrap(), 0);
    assert_eq!(all(upgraded.conn(), "SELECT * FROM schema_migrations WHERE version=1"), history);
    assert_eq!(pragma_i64(upgraded.conn(), "user_version"), migrations().len() as i64);
    assert_eq!(all(upgraded.conn(), "PRAGMA foreign_key_check"), Rows::new());
    assert_eq!(pragma_i64(upgraded.conn(), "foreign_keys"), 1);
    let backups = entries(&root.path().join("migration-backups"));
    assert_eq!(backups.len(), 1);
    let backup = Connection::open_with_flags(root.path().join("migration-backups").join(&backups[0]).join("before.sqlite"), OpenFlags::SQLITE_OPEN_READ_ONLY).unwrap();
    assert_eq!(contents(&backup), before);
    assert_eq!(pragma_i64(&backup, "user_version"), 1);
    assert_eq!(backup.query_row("PRAGMA integrity_check", [], |row| row.get::<_, String>(0)).unwrap(), "ok");
    upgraded.conn().execute("UPDATE import_batches SET status=? WHERE id=?", ["failed", preview.as_str()]).unwrap();
    assert_eq!(status(upgraded.conn(), &preview).as_deref(), Some("failed"));
    assert!(upgraded.conn().execute_batch("DELETE FROM import_items").is_err());
    assert!(upgraded.conn().execute_batch("DELETE FROM import_decisions").is_err());
    assert!(upgraded.conn().execute_batch("DELETE FROM import_batches").is_err());
    assert!(upgraded.conn().execute("UPDATE import_batches SET previous_batch_id=? WHERE id=?", [random_uuid(), preview.clone()]).is_err());
    old.close();
    upgraded.close();
    drop(backup);
    let reopened = Store::open_default(root.path()).unwrap();
    assert_eq!(status(reopened.conn(), &preview).as_deref(), Some("failed"));
    assert_eq!(entries(&root.path().join("migration-backups")), backups);
}

/// `it.each([...])('rolls back the actual table rebuild on $name')`
fn rolls_back_the_actual_table_rebuild(sql: &str) {
    let root = fixture();
    let old = Store::open(root.path(), &migrations()[..1]).unwrap();
    seed(old.conn());
    let before = contents(old.conn());
    let history = all(old.conn(), "SELECT * FROM schema_migrations");
    old.close();
    let plan = migrations();
    let first = plan[0].clone();
    let second = plan[1].clone();
    assert!(Store::open(root.path(), &[first, Migration { sql: format!("{}\n{sql}", second.sql), ..second }]).is_err());
    let reopened = Store::open(root.path(), &migrations()[..1]).unwrap();
    assert_eq!(contents(reopened.conn()), before);
    assert_eq!(all(reopened.conn(), "SELECT * FROM schema_migrations"), history);
    assert_eq!(pragma_i64(reopened.conn(), "user_version"), 1);
    assert_eq!(pragma_i64(reopened.conn(), "foreign_keys"), 1);
    let rebuilt: Option<String> = reopened.conn().query_row("SELECT name FROM sqlite_master WHERE name='import_batches_v2'", [], |row| row.get(0)).optional().unwrap();
    assert_eq!(rebuilt, None);
    assert!(reopened.conn().execute_batch("UPDATE import_batches SET status='failed'").is_err());
}

#[test]
fn rolls_back_the_actual_table_rebuild_on_ddl_failure() {
    rolls_back_the_actual_table_rebuild("INVALID SQL;");
}

#[test]
fn rolls_back_the_actual_table_rebuild_on_foreign_key_failure_before_commit() {
    rolls_back_the_actual_table_rebuild("UPDATE import_batches SET previous_batch_id='missing';");
}

#[test]
fn does_not_rebuild_referenced_tables_when_the_update_backup_cannot_be_created() {
    let root = fixture();
    let old = Store::open(root.path(), &migrations()[..1]).unwrap();
    seed(old.conn());
    let before = contents(old.conn());
    old.close();
    std::fs::write(root.path().join("migration-backups"), "synthetic obstruction").unwrap();
    match Store::open_default(root.path()) {
        Err(Error::Db(_, message)) => assert!(message.contains("バックアップ"), "message {message:?}"),
        Err(other) => panic!("expected DatabaseError containing バックアップ, got {other}"),
        Ok(_) => panic!("expected DatabaseError containing バックアップ, got Ok"),
    }
    let reopened = Store::open(root.path(), &migrations()[..1]).unwrap();
    assert_eq!(contents(reopened.conn()), before);
    assert_eq!(pragma_i64(reopened.conn(), "user_version"), 1);
}
