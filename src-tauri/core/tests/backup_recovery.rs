//! tests/unit/backup-recovery.test.ts の移植（復元の切替と、中断した復元の回復）。
//! 旧テストの fault コールバック（例外で中断）は、begin_restore の `fault` が Err を返すことで再現する。

use std::path::{Path, PathBuf};

use pom_core::backups::{begin_restore, create_archive, inspect_archive, recover_restore, RestorePoint};
use pom_core::db::Store;
use pom_core::{js, Error, Result};
use rusqlite::Connection;
use tempfile::TempDir;

/// 1 つのテストの作業領域（afterEach と同じく、DBを閉じてから削除する: フィールドは宣言順に破棄される）。
struct Fixture { db: Option<Store>, root: PathBuf, staged: PathBuf, sha256: String, _dir: TempDir }

impl Fixture {
    /// `beginRestore(f.db, f.staged, f.root, fault)`
    fn begin_restore(&mut self, fault: &mut dyn FnMut(RestorePoint) -> Result<()>) -> Result<()> {
        begin_restore(&mut self.db, &self.staged, &self.sha256, &self.root, fault)
    }

    /// `f.db.sqlite.open`
    fn is_open(&self) -> bool { self.db.is_some() }

    fn live(&self) -> &Connection { self.db.as_ref().expect("live connection").conn() }

    /// `f.db.close()`
    fn close(&mut self) { if let Some(db) = self.db.take() { db.close(); } }

    fn entries(&self) -> Vec<String> {
        let mut names: Vec<String> = std::fs::read_dir(&self.root).unwrap().map(|entry| entry.unwrap().file_name().to_string_lossy().into_owned()).collect();
        names.sort();
        names
    }

    fn find(&self, prefix: &str) -> String {
        self.entries().into_iter().find(|name| name.starts_with(prefix)).unwrap_or_else(|| panic!("no entry starting with {prefix}"))
    }
}

fn fixture() -> Fixture {
    let dir = tempfile::Builder::new().prefix("step11-recovery-").tempdir().unwrap();
    let root = dir.path().to_path_buf();
    let db = Store::open_default(&root.join("database")).unwrap();
    db.conn().execute("INSERT INTO categories VALUES(?,?,?,?)", rusqlite::params!["fiction", "旧一式", 0, 1]).unwrap();
    let bytes = create_archive(&db, &root.join("work"), "0.1.0").unwrap();
    let file = root.join("fiction.pombak");
    std::fs::write(&file, &bytes).unwrap();
    let staged = inspect_archive(&file, &root.join("work"), "0.1.0").unwrap();
    let stage = Store::open_default(&staged.directory).unwrap();
    stage.conn().execute_batch("UPDATE categories SET name='復元候補'").unwrap();
    stage.close();
    let sha256 = js::sha256_hex(std::fs::read(staged.directory.join("app.sqlite")).unwrap());
    std::fs::write(root.join("database").join("retained-note.txt"), "架空の旧設定").unwrap();
    Fixture { db: Some(db), root, staged: staged.directory, sha256, _dir: dir }
}

/// 障害を起こさない（fault 省略）。
fn no_fault(_: RestorePoint) -> Result<()> { Ok(()) }

/// `p => { if (p === point) throw new Error(message); }`
fn fail_at(point: RestorePoint, message: &'static str) -> impl FnMut(RestorePoint) -> Result<()> {
    move |p| if p == point { Err(Error::other(message)) } else { Ok(()) }
}

fn category_name(conn: &Connection) -> String {
    conn.query_row("SELECT name FROM categories", [], |row| row.get(0)).unwrap()
}

/// `openDatabase(path.join(f.root, 'database'))` で開き直した内容。
fn reopened_name(root: &Path) -> String {
    let reopened = Store::open_default(&root.join("database")).unwrap();
    let name = category_name(reopened.conn());
    reopened.close();
    name
}

/// `rejects.toThrow(text)` のうち BackupError のもの（旧実装で確かめた文言そのもの）。
fn assert_backup_error<T>(result: Result<T>, message: &str) {
    match result {
        Err(Error::Backup(actual)) => assert_eq!(actual, message),
        Err(other) => panic!("expected BackupError({message}), got {other}"),
        Ok(_) => panic!("expected BackupError({message}), got Ok"),
    }
}

/// fault が投げた Error（BackupError ではない、その文言の例外）。
fn assert_fault_error<T>(result: Result<T>, text: &str) {
    match result {
        Err(Error::Other(message)) => assert!(message.contains(text), "unexpected message: {message}"),
        Err(other) => panic!("expected the injected fault ({text}), got {other}"),
        Ok(_) => panic!("expected the injected fault ({text}), got Ok"),
    }
}

#[test]
fn restores_in_a_closed_connection_and_retains_the_complete_previous_directory() {
    let mut f = fixture();
    f.begin_restore(&mut no_fault).unwrap();
    assert!(!f.is_open());
    assert_eq!(recover_restore(&f.root).unwrap(), None);
    assert_eq!(reopened_name(&f.root), "復元候補");
    let old = f.find("database-before-");
    assert_eq!(std::fs::read_to_string(f.root.join(old).join("retained-note.txt")).unwrap(), "架空の旧設定");
}

/// it.each(['prepared','closed','retained','installed','verified'])('recovers old whole state after interruption at %s and recovery is idempotent')
fn recovers_old_whole_state_after_interruption(point: RestorePoint) {
    let mut f = fixture();
    // rejects.toThrow('simulated')
    assert_fault_error(f.begin_restore(&mut fail_at(point, "simulated termination")), "simulated");
    f.close();
    let first = recover_restore(&f.root).unwrap().expect("recovery message");
    assert!(first.contains("戻しました"), "unexpected message: {first}");
    assert_eq!(recover_restore(&f.root).unwrap(), None);
    assert_eq!(reopened_name(&f.root), "旧一式");
    assert_eq!(std::fs::read_to_string(f.root.join("database").join("retained-note.txt")).unwrap(), "架空の旧設定");
}

#[test]
fn recovers_old_whole_state_after_interruption_at_prepared_and_recovery_is_idempotent() { recovers_old_whole_state_after_interruption(RestorePoint::Prepared); }

#[test]
fn recovers_old_whole_state_after_interruption_at_closed_and_recovery_is_idempotent() { recovers_old_whole_state_after_interruption(RestorePoint::Closed); }

#[test]
fn recovers_old_whole_state_after_interruption_at_retained_and_recovery_is_idempotent() { recovers_old_whole_state_after_interruption(RestorePoint::Retained); }

#[test]
fn recovers_old_whole_state_after_interruption_at_installed_and_recovery_is_idempotent() { recovers_old_whole_state_after_interruption(RestorePoint::Installed); }

#[test]
fn recovers_old_whole_state_after_interruption_at_verified_and_recovery_is_idempotent() { recovers_old_whole_state_after_interruption(RestorePoint::Verified); }

#[test]
fn keeps_committed_new_state_after_interruption_following_the_durable_success_marker() {
    let mut f = fixture();
    assert_fault_error(f.begin_restore(&mut fail_at(RestorePoint::Committed, "simulated termination")), "simulated");
    let message = recover_restore(&f.root).unwrap().expect("recovery message");
    assert!(message.contains("復元済み"), "unexpected message: {message}");
    assert_eq!(reopened_name(&f.root), "復元候補");
}

#[test]
fn leaves_current_connection_untouched_when_journal_creation_fails() {
    let mut f = fixture();
    std::fs::write(f.root.join("restore-journal.json"), "blocked").unwrap();
    assert_backup_error(f.begin_restore(&mut no_fault), "既存の復元記録があります。再起動後に確認してください。");
    assert!(f.is_open());
    assert_eq!(category_name(f.live()), "旧一式");
}

#[test]
fn refuses_traversal_in_an_untrusted_recovery_journal_without_moving_current_data() {
    let f = fixture();
    std::fs::write(f.root.join("restore-journal.json"), js::stringify(&serde_json::json!({ "version": 1, "id": "../../outside" }))).unwrap();
    // 旧実装では journal の zod 検証（uuid）で止まる。
    match recover_restore(&f.root) {
        Err(error) => assert!(error.is_validation(), "expected a validation error, got {error}"),
        Ok(value) => panic!("expected a validation error, got Ok({value:?})"),
    }
    assert!(f.is_open());
}

#[test]
fn rejects_a_database_changed_after_inspection_before_closing_the_live_connection() {
    let mut f = fixture();
    let changed = Store::open_default(&f.staged).unwrap();
    changed.conn().execute_batch("UPDATE categories SET name='確認後変更'").unwrap();
    changed.close();
    // rejects.toThrow('確認後')
    assert_backup_error(f.begin_restore(&mut no_fault), "確認後に復元候補が変更されました。再確認してください。");
    assert!(f.is_open());
}

/// it.each([false,true])('continues recovery interrupted between rollback renames, old moved=%s')
fn continues_recovery_interrupted_between_rollback_renames(old_moved: bool) {
    let mut f = fixture();
    assert_fault_error(f.begin_restore(&mut fail_at(RestorePoint::Installed, "stop")), "stop");
    let retained = f.find("database-before-");
    let id = &retained["database-before-".len()..];
    std::fs::rename(f.root.join("database"), f.root.join(format!("database-interrupted-{id}"))).unwrap();
    if old_moved { std::fs::rename(f.root.join(&retained), f.root.join("database")).unwrap(); }
    let message = recover_restore(&f.root).unwrap().expect("recovery message");
    assert!(message.contains("戻しました"), "unexpected message: {message}");
    assert_eq!(reopened_name(&f.root), "旧一式");
}

#[test]
fn continues_recovery_interrupted_between_rollback_renames_old_moved_false() { continues_recovery_interrupted_between_rollback_renames(false); }

#[test]
fn continues_recovery_interrupted_between_rollback_renames_old_moved_true() { continues_recovery_interrupted_between_rollback_renames(true); }

#[test]
fn fails_closed_on_a_corrupted_committed_marker_while_retaining_both_database_directories() {
    let mut f = fixture();
    assert_fault_error(f.begin_restore(&mut fail_at(RestorePoint::Committed, "stop")), "stop");
    let marker = f.find("restore-committed-");
    std::fs::write(f.root.join(marker), "partial").unwrap();
    // 旧実装では JSON.parse の SyntaxError（BackupError ではない）。
    match recover_restore(&f.root) {
        Err(Error::Other(_)) => {}
        Err(other) => panic!("expected a JSON syntax error, got {other}"),
        Ok(value) => panic!("expected a JSON syntax error, got Ok({value:?})"),
    }
    assert_eq!(f.entries().into_iter().filter(|name| name.starts_with("database")).count(), 2);
}

#[derive(Clone, Copy)]
enum Unrecoverable { Schema, Size }

/// it.each(['schema','size'])('refuses unrecoverable current DB %s before journal creation or close')
fn refuses_unrecoverable_current_db_before_journal_creation_or_close(kind: Unrecoverable) {
    let mut f = fixture();
    let expected = match kind {
        Unrecoverable::Schema => {
            f.live().execute_batch("CREATE TABLE outside_policy(value TEXT)").unwrap();
            "DBの版または構造が一致しません。"
        }
        Unrecoverable::Size => {
            let file = f.db.as_ref().unwrap().file.clone();
            std::fs::OpenOptions::new().read(true).write(true).open(file).unwrap().set_len(129 * 1024 * 1024).unwrap();
            "DBファイルの形式または容量が不正です。"
        }
    };
    assert_backup_error(f.begin_restore(&mut no_fault), expected);
    assert!(f.is_open());
    assert_eq!(category_name(f.live()), "旧一式");
    assert!(!f.entries().contains(&"restore-journal.json".to_string()));
    assert_eq!(f.entries().into_iter().filter(|name| name.starts_with("database-before-")).collect::<Vec<_>>(), Vec::<String>::new());
}

#[test]
fn refuses_unrecoverable_current_db_schema_before_journal_creation_or_close() { refuses_unrecoverable_current_db_before_journal_creation_or_close(Unrecoverable::Schema); }

#[test]
fn refuses_unrecoverable_current_db_size_before_journal_creation_or_close() { refuses_unrecoverable_current_db_before_journal_creation_or_close(Unrecoverable::Size); }

#[test]
fn rejects_logical_page_capacity_exceeding_the_limit_across_individually_bounded_main_and_wal_files() {
    let mut f = fixture();
    let file = f.db.as_ref().unwrap().file.clone();
    let _: i64 = f.live().query_row("PRAGMA wal_autocheckpoint=0", [], |row| row.get(0)).unwrap();
    f.live().execute("INSERT INTO categories VALUES('large1',zeroblob(?),0,1)", [63 * 1024 * 1024]).unwrap();
    f.live().query_row("PRAGMA wal_checkpoint(TRUNCATE)", [], |_| Ok(())).unwrap();
    f.live().execute("INSERT INTO categories VALUES('large2',zeroblob(?),0,1)", [66 * 1024 * 1024]).unwrap();
    assert!(std::fs::metadata(&file).unwrap().len() < 128 * 1024 * 1024);
    assert!(std::fs::metadata(format!("{}-wal", file.display())).unwrap().len() < 128 * 1024 * 1024);
    // rejects.toThrow('容量')
    assert_backup_error(f.begin_restore(&mut no_fault), "DBの論理容量が128MiBを超えています。");
    assert!(f.is_open());
    assert!(!f.entries().contains(&"restore-journal.json".to_string()));
}
