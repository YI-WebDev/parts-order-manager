//! 材料の削除（master:delete。旧実装にはない機能）と、削除した日時の列を足す4版の移行。
//! 削除した材料は行を残したまま、検索・件数・編集・明細への追加から外す（取込の判断履歴・作成の受領記録・請求書の明細が参照するため）。

use pom_core::db::{migrations, pragma_i64, Store};
use pom_core::documents::DocumentEditor;
use pom_core::error::{DbCode, Error};
use pom_core::js::random_uuid;
use pom_core::materials::{self, MaterialValues, MATERIAL_COLUMNS};
use pom_core::reimport::MasterService;
use pom_core::search;
use rusqlite::types::Value as SqlValue;
use rusqlite::{params, Connection, OpenFlags};
use serde_json::{json, Value};
use tempfile::TempDir;

fn values(name: &str) -> MaterialValues {
    MaterialValues { name: name.into(), model: format!("{name}-型式"), manufacturer: "架空社".into(), quantity: "02 本".into(), remarks: "".into(), unit_price: "".into() }
}

fn rows(conn: &Connection, sql: &str) -> Vec<Vec<SqlValue>> {
    let mut statement = conn.prepare(sql).unwrap();
    let width = statement.column_count();
    statement.query_map([], |row| (0..width).map(|index| row.get::<_, SqlValue>(index)).collect()).unwrap().collect::<rusqlite::Result<_>>().unwrap()
}

/// 材料の削除の列（削除した日時・版・更新日時）。
fn deletion(store: &Store, id: &str) -> (Option<String>, i64, String) {
    store.conn().query_row("SELECT deleted_at, revision, updated_at FROM materials WHERE id = ?", [id], |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?))).unwrap()
}

fn search_names(store: &Store, include_inactive: bool) -> Vec<String> {
    search::search(store, &json!({ "query": "", "categoryId": null, "includeInactive": include_inactive, "offset": 0 })).unwrap().rows.into_iter().map(|row| row.name).collect()
}

#[track_caller]
fn assert_db_error<T: std::fmt::Debug>(result: pom_core::Result<T>, code: DbCode, message: &str) {
    match result {
        Err(Error::Db(actual, text)) if actual == code && text == message => {}
        other => panic!("expected DatabaseError {} {message}, got {other:?}", code.as_str()),
    }
}

#[test]
fn upgrades_version3_with_a_verified_backup_and_keeps_every_material_undeleted() {
    let root = tempfile::Builder::new().prefix("material-delete-upgrade-").tempdir().unwrap();
    let old = Store::open(root.path(), &migrations()[..3]).unwrap();
    old.conn().execute("INSERT INTO categories VALUES (?,?,?,?)", params!["category", "架空", 0, 1]).unwrap();
    old.conn().execute("INSERT INTO materials VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)", params!["material", "category", " 原文 ", "001", "架空社", "02 本", "", "0", "原文", 0, 3, None::<String>, "created", "updated"]).unwrap();
    let before = rows(old.conn(), &format!("SELECT {MATERIAL_COLUMNS} FROM materials"));
    old.close();
    let upgraded = Store::open_default(root.path()).unwrap();
    assert_eq!(pragma_i64(upgraded.conn(), "user_version").unwrap(), 4);
    assert_eq!(rows(upgraded.conn(), &format!("SELECT {MATERIAL_COLUMNS} FROM materials")), before);
    assert_eq!(rows(upgraded.conn(), "SELECT deleted_at FROM materials"), vec![vec![SqlValue::Null]]);
    let backups: Vec<_> = std::fs::read_dir(root.path().join("migration-backups")).unwrap().map(|entry| entry.unwrap().path()).collect();
    assert_eq!(backups.len(), 1);
    assert!(backups[0].file_name().unwrap().to_string_lossy().starts_with("v3-"));
    let backup = Connection::open_with_flags(backups[0].join("before.sqlite"), OpenFlags::SQLITE_OPEN_READ_ONLY).unwrap();
    assert_eq!(pragma_i64(&backup, "user_version").unwrap(), 3);
    assert_eq!(rows(&backup, &format!("SELECT {MATERIAL_COLUMNS} FROM materials")), before);
    // 旧版（3版まで）では4版のDBを開かない。
    drop(backup);
    upgraded.close();
    assert_db_error(Store::open(root.path(), &migrations()[..3]).map(|_| ()), DbCode::Schema, "未対応の新しいスキーマです。対応するアプリで開いてください。");
}

/// 有効・無効・残す材料と、手動で作った材料（作成の受領記録つき）、削除する材料を明細に持つ請求書。
struct Context { store: Store, editor: DocumentEditor, master: MasterService, category: String, active: String, inactive: String, kept: String, manual: String, document: String, _root: TempDir }

fn fixture() -> Context {
    let root = tempfile::Builder::new().prefix("material-delete-").tempdir().unwrap();
    let store = Store::open_default(root.path()).unwrap();
    let category = materials::create_category(&store, "架空カテゴリ", 0).unwrap();
    let active = materials::create(&store, &category, &values("架空削除A")).unwrap();
    let inactive = materials::create(&store, &category, &values("架空削除B")).unwrap();
    store.conn().execute("UPDATE materials SET active = 0 WHERE id = ?", [&inactive]).unwrap();
    let kept = materials::create(&store, &category, &values("架空残す")).unwrap();
    let mut master = MasterService::default();
    let form = master.get(&store, None).unwrap();
    let manual = master.save(&store, &json!({ "createRequestId": form.create_request_id, "id": null, "expectedRevision": 0, "categoryId": category, "newCategoryName": "", "active": true, "values": values("架空手動") })).unwrap().id;
    let mut editor = DocumentEditor::default();
    let session = editor.open(&store, &Value::Null, false).unwrap();
    let line = editor.add_line(&store, &json!({ "sessionId": session.session_id, "materialId": active })).unwrap();
    let mut draft = serde_json::to_value(&session.draft).unwrap();
    draft["title"] = json!("架空請求書");
    draft["lines"] = json!([line]);
    let document = editor.save(&store, &json!({ "sessionId": session.session_id, "requestNumber": 1, "generation": 1, "expectedRevision": 0, "draft": draft })).unwrap().document_id;
    Context { store, editor, master, category, active, inactive, kept, manual, document, _root: root }
}

#[test]
fn deleting_hides_materials_from_search_counts_forms_and_new_lines_but_keeps_rows_and_references() {
    let mut c = fixture();
    let (_, revision, _) = deletion(&c.store, &c.active);
    assert_eq!(materials::delete(&c.store, &[c.active.clone(), c.inactive.clone(), c.manual.clone()]).unwrap(), 3);
    // 行は残り、削除した日時を記録して版を上げ、更新日時を削除した日時にする。
    let (deleted_at, next, changed_at) = deletion(&c.store, &c.active);
    assert!(deleted_at.as_deref().is_some_and(pom_core::js::is_iso_datetime), "{deleted_at:?}");
    assert_eq!((next, Some(changed_at.as_str())), (revision + 1, deleted_at.as_deref()));
    assert_eq!(deletion(&c.store, &c.kept).0, None);
    // 検索・カテゴリの件数・材料の総数に出ない（無効も表示するときも）。
    assert_eq!(search_names(&c.store, false), ["架空残す"]);
    assert_eq!(search_names(&c.store, true), ["架空残す"]);
    let total = |include_inactive: bool| search::search(&c.store, &json!({ "query": "架空", "categoryId": c.category, "includeInactive": include_inactive, "offset": 0 })).unwrap().total;
    assert_eq!((total(false), total(true)), (1, 1));
    for include_inactive in [false, true] {
        let page = search::categories(&c.store, &json!({ "query": "", "includeInactive": include_inactive, "offset": 0 })).unwrap();
        assert_eq!((page.rows[0].count, page.material_count), (1, 1));
        let listed = search::search(&c.store, &json!({ "query": "", "categoryId": null, "includeInactive": include_inactive, "offset": 0 })).unwrap();
        assert_eq!(listed.categories[0].count, 1);
    }
    // 編集を開けず、保存は競合（開いていた画面からの保存を含む）。明細へも追加できない。
    assert_db_error(c.master.get(&c.store, Some(&c.active)), DbCode::NotFound, "材料が見つかりません。");
    assert_db_error(c.master.save(&c.store, &json!({ "id": c.inactive, "expectedRevision": 2, "categoryId": c.category, "newCategoryName": "", "active": true, "values": values("架空復活") })), DbCode::Conflict, "材料は変更されています。再読込してください。");
    assert!(deletion(&c.store, &c.inactive).0.is_some());
    assert_db_error(materials::get(&c.store, &c.active), DbCode::NotFound, "材料が見つかりません。");
    let session = c.editor.open(&c.store, &json!(c.document), false).unwrap();
    assert_db_error(c.editor.add_line(&c.store, &json!({ "sessionId": session.session_id, "materialId": c.manual })), DbCode::NotFound, "材料が見つからないか無効です。再検索してください。");
    // 削除した材料を明細に持つ請求書は、明細の値のまま開け、保存できる。
    let line = &session.draft.lines[0];
    assert_eq!((line.material_id.as_deref(), line.name.as_str(), line.model.as_str()), (Some(c.active.as_str()), "架空削除A", "架空削除A-型式"));
    let mut draft = serde_json::to_value(&session.draft).unwrap();
    draft["title"] = json!("架空請求書（削除の後）");
    c.editor.save(&c.store, &json!({ "sessionId": session.session_id, "requestNumber": 1, "generation": 1, "expectedRevision": session.revision, "draft": draft })).unwrap();
    let session = c.editor.open(&c.store, &json!(c.document), false).unwrap();
    assert_eq!((session.draft.title.as_str(), session.draft.lines[0].material_id.as_deref()), ("架空請求書（削除の後）", Some(c.active.as_str())));
    // 作成の受領記録と参照の整合性はそのまま。
    assert_eq!(c.store.conn().query_row("SELECT count(*) FROM material_create_receipts WHERE material_id = ?", [&c.manual], |row| row.get::<_, i64>(0)).unwrap(), 1);
    assert_eq!(pom_core::db::foreign_key_violations(c.store.conn()).unwrap(), 0);
    // 応答が失われた後の再送（削除済み）と、存在しない ID は成功にする（0件。版・日時も変えない）。
    let again = deletion(&c.store, &c.active);
    assert_eq!(materials::delete(&c.store, &[c.active.clone(), random_uuid()]).unwrap(), 0);
    assert_eq!(deletion(&c.store, &c.active), again);
    // ほかの材料は変わらず、明細へ追加できる。
    let added = c.editor.add_line(&c.store, &json!({ "sessionId": session.session_id, "materialId": c.kept })).unwrap();
    assert_eq!(added.name, "架空残す");
}

#[test]
fn a_failed_deletion_deletes_none_of_the_requested_materials() {
    let c = fixture();
    c.store.conn().execute_batch(&format!("CREATE TRIGGER fail_material_delete BEFORE UPDATE OF deleted_at ON materials WHEN old.id = '{}' BEGIN SELECT RAISE(ABORT, 'synthetic failure'); END", c.kept)).unwrap();
    assert!(matches!(materials::delete(&c.store, &[c.active.clone(), c.kept.clone()]), Err(Error::Other(_))));
    for id in [&c.active, &c.kept] { assert_eq!(deletion(&c.store, id).0, None); }
    assert_eq!(search_names(&c.store, false).len(), 3);
}

#[test]
fn delete_ids_must_be_one_to_one_hundred_unique_uuids() {
    let valid: Vec<String> = (0..100).map(|_| random_uuid()).collect();
    assert_eq!(materials::parse_material_ids(&json!(valid)).unwrap(), valid);
    let one = random_uuid();
    for input in [json!([]), json!(null), json!(one), json!({ "ids": [one] }), json!([one, one]), json!(["not-a-uuid"]), json!([1]), json!((0..101).map(|_| random_uuid()).collect::<Vec<_>>())] {
        assert!(matches!(materials::parse_material_ids(&input), Err(Error::Validation(_))), "{input}");
    }
}
