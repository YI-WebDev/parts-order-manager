//! tests/unit/backup-archive.test.ts の移植（.pombak の作成と、復元前の検査）。

use std::path::{Path, PathBuf};

use pom_core::backups::{create_archive, inspect_archive};
use pom_core::db::{self, Store};
use pom_core::{js, Error};
use rusqlite::types::Value as SqlValue;
use rusqlite::Connection;
use serde_json::{Map, Value};
use tempfile::TempDir;

/// 1 つのテストの作業領域（afterEach と同じく、DBを閉じてから削除する: フィールドは宣言順に破棄される）。
struct Fixture { db: Store, root: PathBuf, file: PathBuf, bytes: Vec<u8>, _dir: TempDir }

impl Fixture {
    fn work(&self) -> PathBuf { self.root.join("work") }
}

fn fixture() -> Fixture {
    let dir = tempfile::Builder::new().prefix("step11-archive-").tempdir().unwrap();
    let root = dir.path().to_path_buf();
    let db = Store::open_default(&root.join("database")).unwrap();
    db.conn().execute("INSERT INTO categories VALUES(?,?,?,?)", rusqlite::params!["fiction", "  架空\n001 ", 0, 1]).unwrap();
    let file = root.join("fixture.pombak");
    let bytes = create_archive(&db, &root.join("work"), "0.1.0").unwrap();
    std::fs::write(&file, &bytes).unwrap();
    Fixture { db, root, file, bytes, _dir: dir }
}

fn header_length(bytes: &[u8]) -> usize { u32::from_le_bytes(bytes[8..12].try_into().unwrap()) as usize }

/// 目録（JSON）を書き換え、長さを付け直す（JSON.parse → 変更 → JSON.stringify）。
fn change_header(bytes: &[u8], change: impl FnOnce(&mut Map<String, Value>)) -> Vec<u8> {
    let length = header_length(bytes);
    let mut header: Value = serde_json::from_str(std::str::from_utf8(&bytes[12..12 + length]).unwrap()).unwrap();
    change(header.as_object_mut().unwrap());
    let data = js::stringify(&header).into_bytes();
    let mut out = bytes[..8].to_vec();
    out.extend_from_slice(&(data.len() as u32).to_le_bytes());
    out.extend_from_slice(&data);
    out.extend_from_slice(&bytes[12 + length..]);
    out
}

fn category_name(conn: &Connection) -> String {
    conn.query_row("SELECT name FROM categories", [], |row| row.get(0)).unwrap()
}

/// `rejects.toThrow(text)` のうち BackupError のもの（旧実装で確かめた文言そのもの）。
fn assert_backup_error<T>(result: pom_core::Result<T>, message: &str) {
    match result {
        Err(Error::Backup(actual)) => assert_eq!(actual, message),
        Err(other) => panic!("expected BackupError({message}), got {other}"),
        Ok(_) => panic!("expected BackupError({message}), got Ok"),
    }
}

/// zod の検証エラー（ZodError）。
fn assert_validation_error<T>(result: pom_core::Result<T>) {
    match result {
        Err(error) => assert!(error.is_validation(), "expected a validation error, got {error}"),
        Ok(_) => panic!("expected a validation error, got Ok"),
    }
}

#[test]
fn backs_up_committed_wal_and_exact_raw_settings_without_editing_the_live_database() {
    let f = fixture();
    let staged = inspect_archive(&f.file, &f.work(), "0.1.0").unwrap();
    let restored = Store::open_default(&staged.directory).unwrap();
    assert_eq!(category_name(restored.conn()), "  架空\n001 ");
    assert_eq!(staged.materials, 0);
    assert_eq!(staged.documents, 0);
    let receipts: String = restored.conn().query_row("SELECT name FROM sqlite_master WHERE name='material_create_receipts'", [], |row| row.get(0)).unwrap();
    assert_eq!(receipts, "material_create_receipts");
    restored.close();
}

/// 帳票の既定の書式を中央揃えに変えた版（2026年10月15日）より前に作ったバックアップは、目録に旧既定の styles.xml を埋めている。
/// 同じアプリの版・列幅なら受け付け、それ以外の書式の文字列は今までどおり拒否する。
#[test]
fn accepts_archives_whose_manifest_carries_the_previous_default_styles() {
    let f = fixture();
    let with_styles = |styles: &str| change_header(&f.bytes, |h| { h.get_mut("layout").unwrap().as_object_mut().unwrap().insert("styles".into(), Value::from(styles)); });
    assert_ne!(*pom_core::exports::LEGACY_STYLES, *pom_core::exports::STYLES);
    assert!(pom_core::exports::LEGACY_STYLES.contains("<alignment horizontal=\"left\" indent=\"1\"/>"));
    std::fs::write(&f.file, with_styles(&pom_core::exports::LEGACY_STYLES)).unwrap();
    let staged = inspect_archive(&f.file, &f.work(), "0.1.0").unwrap();
    let restored = Store::open_default(&staged.directory).unwrap();
    assert_eq!(category_name(restored.conn()), "  架空\n001 ");
    restored.close();
    std::fs::write(&f.file, with_styles(&pom_core::exports::LEGACY_STYLES.replace("indent=\"1\"", "indent=\"2\""))).unwrap();
    assert_backup_error(inspect_archive(&f.file, &f.work(), "0.1.0"), "このアプリの版・レイアウト・移行履歴と一致しません。");
    std::fs::write(&f.file, with_styles(&pom_core::exports::STYLES)).unwrap();
    assert!(inspect_archive(&f.file, &f.work(), "0.1.0").is_ok());
}

#[derive(Clone, Copy)]
enum Kind { Future, Path, Extra, Layout, Hash, Truncated }

/// it.each(['future','path','extra','layout','hash','truncated'])('rejects %s archive before restoring')
fn rejects_archive_before_restoring(kind: Kind) {
    let f = fixture();
    let bytes = match kind {
        Kind::Future => change_header(&f.bytes, |h| { h.insert("schemaVersion".into(), Value::from(99)); }),
        Kind::Path => change_header(&f.bytes, |h| { h.insert("entries".into(), serde_json::json!([{ "path": "../outside", "size": 1, "sha256": "0".repeat(64) }])); }),
        Kind::Extra => change_header(&f.bytes, |h| { h.insert("unapproved".into(), Value::from("file")); }),
        Kind::Layout => change_header(&f.bytes, |h| { h.insert("layout".into(), serde_json::json!({})); }),
        Kind::Hash => { let mut bytes = f.bytes.clone(); *bytes.last_mut().unwrap() ^= 1; bytes }
        Kind::Truncated => f.bytes[..f.bytes.len() - 1].to_vec(),
    };
    std::fs::write(&f.file, &bytes).unwrap();
    let result = inspect_archive(&f.file, &f.work(), "0.1.0");
    match kind {
        // 旧実装では目録の zod 検証（ZodError）で止まる。
        Kind::Future | Kind::Path | Kind::Extra | Kind::Layout => assert_validation_error(result),
        Kind::Hash | Kind::Truncated => assert_backup_error(result, "バックアップの長さまたはチェックサムが不正です。"),
    }
    assert_eq!(category_name(f.db.conn()), "  架空\n001 ");
}

#[test]
fn rejects_future_archive_before_restoring() { rejects_archive_before_restoring(Kind::Future); }

#[test]
fn rejects_path_archive_before_restoring() { rejects_archive_before_restoring(Kind::Path); }

#[test]
fn rejects_extra_archive_before_restoring() { rejects_archive_before_restoring(Kind::Extra); }

#[test]
fn rejects_layout_archive_before_restoring() { rejects_archive_before_restoring(Kind::Layout); }

#[test]
fn rejects_hash_archive_before_restoring() { rejects_archive_before_restoring(Kind::Hash); }

#[test]
fn rejects_truncated_archive_before_restoring() { rejects_archive_before_restoring(Kind::Truncated); }

/// it.each([...])('rejects malicious schema even with recomputed checksum: %s')
fn rejects_malicious_schema_even_with_recomputed_checksum(sql: &str) {
    let f = fixture();
    f.db.conn().execute_batch(sql).unwrap();
    let raw = f.root.join("modified.sqlite");
    db::backup_to(f.db.conn(), &raw).unwrap();
    let payload = std::fs::read(&raw).unwrap();
    let altered = change_header(&f.bytes, |h| {
        h.insert("entries".into(), serde_json::json!([{ "path": "database/app.sqlite", "size": payload.len(), "sha256": js::sha256_hex(&payload) }]));
    });
    let mut bytes = altered[..12 + header_length(&altered)].to_vec();
    bytes.extend_from_slice(&payload);
    std::fs::write(&f.file, &bytes).unwrap();
    // rejects.toThrow('構造')
    assert_backup_error(inspect_archive(&f.file, &f.work(), "0.1.0"), "DBの版または構造が一致しません。");
}

#[test]
fn rejects_malicious_schema_even_with_recomputed_checksum_trigger() {
    rejects_malicious_schema_even_with_recomputed_checksum("CREATE TRIGGER evil AFTER INSERT ON categories BEGIN DELETE FROM materials; END;");
}

#[test]
fn rejects_malicious_schema_even_with_recomputed_checksum_sqlite_prefixed_trigger() {
    rejects_malicious_schema_even_with_recomputed_checksum("CREATE TRIGGER sqliteXevil AFTER INSERT ON categories BEGIN DELETE FROM materials; END;");
}

#[test]
fn rejects_malicious_schema_even_with_recomputed_checksum_sqlite_prefixed_table() {
    rejects_malicious_schema_even_with_recomputed_checksum("CREATE TABLE sqliteExtra (secret TEXT);");
}

/// `SELECT * FROM table` の `.all()`（列名と値の組）。
fn all_rows(conn: &Connection, table: &str) -> Vec<Vec<(String, SqlValue)>> {
    let mut statement = conn.prepare(&format!("SELECT * FROM {table}")).unwrap();
    let names: Vec<String> = statement.column_names().into_iter().map(String::from).collect();
    statement
        .query_map([], |row| names.iter().enumerate().map(|(index, name)| Ok((name.clone(), row.get::<_, SqlValue>(index)?))).collect())
        .unwrap()
        .collect::<rusqlite::Result<_>>()
        .unwrap()
}

#[test]
fn retains_raw_import_history_held_rows_settings_snapshots_and_creation_receipts() {
    let f = fixture();
    f.db.conn().execute_batch(&format!(r#"
    INSERT INTO import_batches VALUES ('batch','series',NULL,'initial','{a}','架空.xlsx','v1','preview','[]','{{}}','{{}}','2026-01-01');
    INSERT INTO import_items VALUES ('item','batch','row','架空',0,2,'left',NULL,json_object('raw',' 001'||char(10)),'candidate','fingerprint');
    INSERT INTO materials VALUES ('material','fiction','架空','001','','02 本','行1{newline}行2','000.00','架空',1,1,'item','2026-01-01','2026-01-01',NULL);
    INSERT INTO materials VALUES ('deleted','fiction','架空削除','002','','','','','架空削除',0,2,NULL,'2026-01-01','2026-01-02','2026-01-02');
    INSERT INTO import_decisions VALUES ('decision','item','material','hold','[]','確認待ち','2026-01-01','batch');
    INSERT INTO documents VALUES ('doc','架空帳票','{{}}',1,'v1',NULL,0,'2026-01-01','2026-01-01');
    INSERT INTO document_lines VALUES ('line','doc',0,'material','item','旧snapshot','001','','0','','unknown','unresolved',NULL,'v1');
    INSERT INTO settings VALUES ('last_category_id','fiction');
    INSERT INTO material_create_receipts VALUES ('request','{b}','material','{{"id":"material"}}');
  "#, a = "a".repeat(64), b = "b".repeat(64), newline = "\n")).unwrap();
    let tables = ["categories", "materials", "documents", "document_lines", "import_batches", "import_items", "import_decisions", "settings", "material_create_receipts"];
    let before: Vec<_> = tables.iter().map(|table| all_rows(f.db.conn(), table)).collect();
    std::fs::write(&f.file, create_archive(&f.db, &f.work(), "0.1.0").unwrap()).unwrap();
    let stage = inspect_archive(&f.file, &f.work(), "0.1.0").unwrap();
    // 削除した材料も行ごと保持し、件数には数えない。
    assert_eq!((stage.materials, stage.documents), (1, 1));
    let restored = Store::open_default(&stage.directory).unwrap();
    let after: Vec<_> = tables.iter().map(|table| all_rows(restored.conn(), table)).collect();
    assert_eq!(after, before);
    restored.close();
}

fn extend_file(file: &Path, size: u64) {
    let handle = std::fs::OpenOptions::new().read(true).write(true).open(file).unwrap();
    handle.set_len(size).unwrap();
}

#[test]
fn rejects_oversized_input_before_allocating_its_payload() {
    let f = fixture();
    extend_file(&f.file, 129 * 1024 * 1024);
    // rejects.toThrow('容量')
    assert_backup_error(inspect_archive(&f.file, &f.work(), "0.1.0"), "通常ファイル・容量の条件を満たさないバックアップです。");
}

#[test]
fn rejects_hard_linked_archives_without_relaxing_the_link_protection() {
    let f = fixture();
    std::fs::hard_link(&f.file, f.root.join("second.pombak")).unwrap();
    // rejects.toThrow('通常ファイル')
    assert_backup_error(inspect_archive(&f.file, &f.work(), "0.1.0"), "通常ファイル・容量の条件を満たさないバックアップです。");
}

#[test]
fn rejects_oversized_manifest_length_before_parsing() {
    let f = fixture();
    let mut bytes = f.bytes.clone();
    bytes[8..12].copy_from_slice(&65537u32.to_le_bytes());
    std::fs::write(&f.file, &bytes).unwrap();
    // rejects.toThrow('容量')
    assert_backup_error(inspect_archive(&f.file, &f.work(), "0.1.0"), "バックアップ情報の容量が不正です。");
}

// ---- 保存（backups:create）: Excel・PDF と同じ一時ファイルからの新規確定（publish_new）を通り、既存ファイルは上書きしない ----

mod save {
    use std::future::Future;
    use std::path::PathBuf;
    use std::sync::{Arc, Mutex};
    use std::task::{Context, Poll, Waker};

    use pom_core::api::{App, AppConfig, BoxFuture, Host, MessageBox, OpenDialog, Parent, PrintSession, SaveDialog};
    use pom_core::backups::inspect_archive;
    use pom_core::db::Store;
    use serde_json::Value;

    /// 保存ダイアログで選ぶパスと、1回だけ失敗させる操作。
    struct SaveHost { select: PathBuf, faults: Mutex<Vec<&'static str>> }

    impl Host for SaveHost {
        fn open_file(&self, _parent: Parent, _dialog: OpenDialog) -> BoxFuture<'_, Option<PathBuf>> { Box::pin(async { None }) }
        fn save_file(&self, _parent: Parent, _dialog: SaveDialog) -> BoxFuture<'_, Option<PathBuf>> { let selected = self.select.clone(); Box::pin(async move { Some(selected) }) }
        fn message_box(&self, _parent: Parent, dialog: MessageBox) -> BoxFuture<'_, usize> { Box::pin(async move { dialog.cancel_id }) }
        fn sender_trusted(&self) -> bool { true }
        fn emit_close_requested(&self, _token: &str) {}
        fn close_main_window(&self) {}
        fn quit_after_restore(&self) {}
        fn preview_url(&self, id: &str) -> String { format!("app://print/{id}") }
        fn open_print_preview(&self, _session: Arc<PrintSession>) -> BoxFuture<'_, Result<(), String>> { Box::pin(async { Err("not used".to_string()) }) }
        fn fault(&self, point: &str) -> bool {
            let mut faults = self.faults.lock().unwrap();
            match faults.iter().position(|f| *f == point) { Some(index) => { faults.remove(index); true } None => false }
        }
    }

    fn block_on<F: Future>(future: F) -> F::Output {
        let mut future = std::pin::pin!(future);
        let mut context = Context::from_waker(Waker::noop());
        loop {
            if let Poll::Ready(value) = future.as_mut().poll(&mut context) { return value; }
            std::thread::yield_now();
        }
    }

    fn names(directory: &std::path::Path) -> Vec<String> {
        let mut names: Vec<String> = std::fs::read_dir(directory).unwrap().map(|e| e.unwrap().file_name().to_string_lossy().into_owned()).collect();
        names.sort();
        names
    }

    #[test]
    fn saves_only_new_backups_and_reports_a_failed_publication_without_leaving_files() {
        let dir = tempfile::Builder::new().prefix("backup-save-").tempdir().unwrap();
        let (user_data, output) = (dir.path().join("user"), dir.path().join("out"));
        std::fs::create_dir(&output).unwrap();
        let target = output.join("架空バックアップ.pombak");
        let host = Arc::new(SaveHost { select: target.clone(), faults: Mutex::new(Vec::new()) });
        let config = AppConfig { user_data: user_data.clone(), documents_dir: output.clone(), protected_roots: vec![user_data.clone()], version: "0.1.0".into(), recovery_notice: None };
        let app = App::new(config, Store::open_default(&user_data.join("database")).unwrap(), host.clone());
        let create = || -> Value { block_on(app.invoke("backups:create", vec![])).expect("handler") };
        // 既にあるファイルは上書きしない。
        std::fs::write(&target, "FICTIONAL-KEEP").unwrap();
        let existing = create();
        assert_eq!(existing["status"], "error", "{existing}");
        assert!(existing["message"].as_str().unwrap().contains("上書きしません"), "{existing}");
        assert_eq!(std::fs::read_to_string(&target).unwrap(), "FICTIONAL-KEEP");
        std::fs::remove_file(&target).unwrap();
        // 新規確定に失敗したら、保存先にファイルも一時ファイルも残さない。
        host.faults.lock().unwrap().push("publish");
        assert_eq!(create()["status"], "error");
        assert!(names(&output).is_empty(), "{:?}", names(&output));
        // 再試行で保存でき、検査できる完成ファイルだけが残る。
        let saved = create();
        assert_eq!(saved["status"], "ok", "{saved}");
        assert!(saved["data"].as_str().unwrap().starts_with("バックアップを保存しました"), "{saved}");
        assert_eq!(names(&output), vec!["架空バックアップ.pombak".to_string()]);
        assert_eq!(pom_core::fsx::lstat(&target).unwrap().nlink, 1);
        inspect_archive(&target, &dir.path().join("inspect"), "0.1.0").unwrap();
        app.shutdown();
    }
}

// ---- 材料の削除を足す前（3版）のバックアップ ----

/// 3版のDBのバックアップ（材料1件）。目録の版は3、移行のチェックサムは3つ（材料の削除を足す前の版が作るものと同じ）。
fn version3_archive(root: &Path) -> (PathBuf, Vec<u8>) {
    let old = Store::open(&root.join("old"), &db::migrations()[..3]).unwrap();
    old.conn().execute("INSERT INTO categories VALUES(?,?,?,?)", rusqlite::params!["fiction", "旧版のカテゴリ", 0, 1]).unwrap();
    old.conn().execute("INSERT INTO materials VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)", rusqlite::params!["material", "fiction", "旧版の材料", "001", "", "", "", "", "旧版の材料", 1, 1, None::<String>, "created", "updated"]).unwrap();
    let bytes = create_archive(&old, &root.join("work"), "0.1.0").unwrap();
    old.close();
    let file = root.join("old.pombak");
    std::fs::write(&file, &bytes).unwrap();
    (file, bytes)
}

fn header(bytes: &[u8]) -> Value { serde_json::from_slice(&bytes[12..12 + header_length(bytes)]).unwrap() }

#[test]
fn restores_a_version3_archive_and_upgrades_it_when_the_restored_database_opens() {
    let dir = tempfile::Builder::new().prefix("archive-v3-").tempdir().unwrap();
    let root = dir.path();
    let (file, bytes) = version3_archive(root);
    let hashes = pom_core::backups::migration_hashes();
    assert_eq!(header(&bytes)["schemaVersion"], 3);
    assert_eq!(header(&bytes)["migrationHashes"], serde_json::json!(hashes[..3]));
    let mut live = Some(Store::open_default(&root.join("database")).unwrap());
    let staged = inspect_archive(&file, &root.join("work"), "0.1.0").unwrap();
    assert_eq!((staged.materials, staged.documents), (1, 0));
    pom_core::backups::begin_restore(&mut live, &staged.directory, &staged.sha256, root, &mut |_| Ok(())).unwrap();
    // 復元したDBは開いた時点で4版へ移行し（移行前の複製を残す）、材料は削除していない状態のまま。
    let restored = Store::open_default(&root.join("database")).unwrap();
    assert_eq!(db::pragma_i64(restored.conn(), "user_version").unwrap(), 4);
    let material: (String, Option<String>) = restored.conn().query_row("SELECT name, deleted_at FROM materials", [], |row| Ok((row.get(0)?, row.get(1)?))).unwrap();
    assert_eq!(material, ("旧版の材料".to_string(), None));
    assert_eq!(category_name(restored.conn()), "旧版のカテゴリ");
    let backups: Vec<String> = std::fs::read_dir(root.join("database").join("migration-backups")).unwrap().map(|entry| entry.unwrap().file_name().to_string_lossy().into_owned()).collect();
    assert!(backups.len() == 1 && backups[0].starts_with("v3-"), "{backups:?}");
    // 移行した後のDBは4版のバックアップになる。
    let next = create_archive(&restored, &root.join("work"), "0.1.0").unwrap();
    assert_eq!((header(&next)["schemaVersion"].clone(), header(&next)["migrationHashes"].clone()), (Value::from(4), serde_json::json!(hashes)));
    restored.close();
}

#[test]
fn rejects_archives_whose_manifest_and_database_versions_disagree() {
    let f = fixture();
    let (old_file, old_bytes) = version3_archive(&f.root);
    let hashes = pom_core::backups::migration_hashes();
    let as_version = |bytes: &[u8], version: usize, count: usize| change_header(bytes, |h| { h.insert("schemaVersion".into(), Value::from(version)); h.insert("migrationHashes".into(), serde_json::json!(hashes[..count])); });
    // 目録は3版・DBは4版、目録は4版・DBは3版。
    std::fs::write(&f.file, as_version(&f.bytes, 3, 3)).unwrap();
    assert_backup_error(inspect_archive(&f.file, &f.work(), "0.1.0"), "DBの版または構造が一致しません。");
    std::fs::write(&old_file, as_version(&old_bytes, 4, 4)).unwrap();
    assert_backup_error(inspect_archive(&old_file, &f.work(), "0.1.0"), "DBの版または構造が一致しません。");
    // 版とチェックサムの数が合わない、復元できない古い版（2版）は目録の検証で止まる。
    for (version, count) in [(4, 3), (3, 4), (2, 2)] {
        std::fs::write(&f.file, as_version(&f.bytes, version, count)).unwrap();
        assert_validation_error(inspect_archive(&f.file, &f.work(), "0.1.0"));
    }
    // 3版の目録でも、チェックサムが今の移行と違えば止まる。
    std::fs::write(&old_file, change_header(&old_bytes, |h| { h.insert("migrationHashes".into(), serde_json::json!([hashes[0], hashes[1], "0".repeat(64)])); })).unwrap();
    assert_backup_error(inspect_archive(&old_file, &f.work(), "0.1.0"), "このアプリの版・レイアウト・移行履歴と一致しません。");
    assert_eq!(category_name(f.db.conn()), "  架空\n001 ");
}
