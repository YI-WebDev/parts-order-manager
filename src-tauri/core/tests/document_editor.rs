//! tests/unit/document-editor.test.ts の移植（編集セッション・保存・複製・履歴）。
//!
//! 旧テストは保存の失敗を `toThrow()` だけで確かめていた。ここでは旧実装を同じ手順で動かして確かめた
//! エラーの種類・コード・文言（DatabaseError / ZodError / SqliteError）まで比べる。

use pom_core::db::Store;
use pom_core::documents::{DocumentEditor, EditorSession, History, InvoiceLine, SaveReceipt};
use pom_core::error::{DbCode, Error, Result};
use pom_core::js::random_uuid;
use pom_core::materials::{self, MaterialUpdate, MaterialValues};
use serde_json::{json, Value};
use tempfile::TempDir;

/// 保存先（一時フォルダー）と編集セッション。フィールド順に破棄され、DBを閉じてからフォルダーを消す。
struct Context { store: Store, editor: DocumentEditor, _root: TempDir }

fn fixture() -> Context {
    let root = tempfile::Builder::new().prefix("step07-editor-").tempdir().unwrap();
    let store = Store::open_default(root.path()).unwrap();
    Context { store, editor: DocumentEditor::default(), _root: root }
}

impl Context {
    fn open(&mut self, id: Option<&str>) -> Result<EditorSession> { self.editor.open(&self.store, &json!(id), false) }
    fn duplicate(&mut self, id: &str) -> Result<EditorSession> { self.editor.duplicate(&self.store, &json!(id)) }
    fn add_line(&mut self, session_id: &str, material_id: Option<&str>) -> Result<InvoiceLine> {
        self.editor.add_line(&self.store, &json!({ "sessionId": session_id, "materialId": material_id }))
    }
    fn save(&mut self, request: &Value) -> Result<SaveReceipt> { self.editor.save(&self.store, request) }
    fn list(&self, page: Value) -> Result<History> { self.editor.list(&self.store, &page, None, None) }
    fn title_and_revision(&self, id: &str) -> (String, i64) {
        self.store.conn().query_row("SELECT title, revision FROM documents WHERE id=?", [id], |row| Ok((row.get(0)?, row.get(1)?))).unwrap()
    }
}

fn values() -> MaterialValues {
    MaterialValues { name: "架空材料".into(), model: "001-A".into(), manufacturer: "架空社".into(), quantity: "02 本".into(), remarks: "架空備考".into(), unit_price: "SECRET-PRICE".into() }
}

fn draft(session: &EditorSession) -> Value { serde_json::to_value(&session.draft).unwrap() }

fn line_json(line: &InvoiceLine) -> Value { serde_json::to_value(line).unwrap() }

/// `{ ...value, [key]: field }`
fn with(mut value: Value, key: &str, field: Value) -> Value {
    value[key] = field;
    value
}

fn request_with(session: &EditorSession, draft: Value, request_number: i64, expected_revision: i64, generation: i64) -> Value {
    json!({ "sessionId": session.session_id, "draft": draft, "requestNumber": request_number, "expectedRevision": expected_revision, "generation": generation })
}

/// `request(session)`（下書きは開いたときのまま、要求番号1・世代1・期待版は開いた版）。
fn request(session: &EditorSession) -> Value { request_with(session, draft(session), 1, session.revision, 1) }

/// `request(session, draft)`
fn request_draft(session: &EditorSession, draft: Value) -> Value { request_with(session, draft, 1, session.revision, 1) }

#[track_caller]
fn assert_db_error<T: std::fmt::Debug>(result: Result<T>, code: DbCode, message: &str) {
    match result {
        Err(Error::Db(actual, text)) if actual == code && text == message => {}
        other => panic!("expected DatabaseError {} {message}, got {other:?}", code.as_str()),
    }
}

#[track_caller]
fn assert_validation<T: std::fmt::Debug>(result: Result<T>) {
    assert!(matches!(result, Err(Error::Validation(_))), "expected ZodError, got {result:?}");
}

const ORDER_CONFLICT: &str = "保存要求の順序または版が一致しません。入力を保持し、保存結果を確認してください。";
const SPOOFED: &str = "明細IDまたは出典が一致しません。";
const PAIR: &str = "チェック状態と記号の組合せを確認してください。";

#[test]
fn keeps_main_allocated_ids_snapshots_and_provenance_across_save_master_change_reopen_and_duplicate() {
    let mut c = fixture();
    let category_id = materials::create_category(&c.store, "架空", 0).unwrap();
    let material_id = materials::create(&c.store, &category_id, &values()).unwrap();
    let session = c.open(None).unwrap();
    let line = c.add_line(&session.session_id, Some(&material_id)).unwrap();
    assert!(line_json(&line).get("unitPrice").is_none());
    assert_eq!((line.delivery_state.as_str(), line.mark_output.as_str(), line.model.as_str(), line.quantity.as_str()), ("unknown", "unresolved", "001-A", "02 本"));
    let saved = c.save(&request_draft(&session, with(draft(&session), "lines", json!([line_json(&line)])))).unwrap();
    let changed = MaterialValues { name: "後日変更".into(), ..values() };
    materials::update(&c.store, MaterialUpdate { id: &material_id, category_id: &category_id, expected_revision: 1, values: &changed, active: false }).unwrap();
    let reopened = c.open(Some(&saved.document_id)).unwrap();
    assert_eq!(reopened.draft.lines[0], line);
    let duplicate = c.duplicate(&saved.document_id).unwrap();
    assert_eq!(duplicate.draft.lines[0].name, values().name);
    assert_eq!(duplicate.draft.lines[0].material_id.as_deref(), Some(material_id.as_str()));
    assert_ne!(duplicate.draft.lines[0].id, line.id);
    let copy = c.save(&request(&duplicate)).unwrap();
    assert_ne!(copy.document_id, saved.document_id);
    let history = c.list(json!(0)).unwrap();
    assert_eq!(history.items.iter().find(|item| item.id == copy.document_id).and_then(|item| item.duplicated_from_id.clone()), Some(saved.document_id.clone()));
    assert_eq!(c.open(Some(&saved.document_id)).unwrap().draft.lines[0], line);
}

#[test]
fn saves_header_and_line_text_without_edge_spaces_and_judges_the_date_the_same_way() {
    // 利用者の指示（2026年10月15日）: 明細の文字の欄と帳票上部の欄は、前後の空白（全角・半角）を除いて保存する。管理用タイトルと文中の空白は変えない。
    let mut c = fixture();
    let session = c.open(None).unwrap();
    let line = c.add_line(&session.session_id, None).unwrap();
    let typed = with(with(with(with(with(line_json(&line), "name", json!("　リレー　X")), "model", json!(" 001-A\t")), "manufacturer", json!("\u{a0}架空社\u{3000}")), "quantity", json!(" 2 ")), "remarks", json!(" 備考 中 "));
    let draft = with(with(with(draft(&session), "title", json!(" 題名 ")), "header", json!({ "C2": "　架空宛先 ", "A4": " A", "B4": "B ", "C4": "\u{3000}", "E4": " 2026/9/13 " })), "lines", json!([typed]));
    let saved = c.save(&request_draft(&session, draft)).unwrap();
    let reopened = c.open(Some(&saved.document_id)).unwrap();
    let first = &reopened.draft.lines[0];
    assert_eq!((first.name.as_str(), first.model.as_str(), first.manufacturer.as_str(), first.quantity.as_str(), first.remarks.as_str()), ("リレー　X", "001-A", "架空社", "2", "備考 中"));
    assert_eq!((reopened.draft.header.c2.as_str(), reopened.draft.header.a4.as_str(), reopened.draft.header.b4.as_str(), reopened.draft.header.c4.as_str(), reopened.draft.header.e4.as_str()), ("架空宛先", "A", "B", "", "2026/9/13"));
    assert_eq!(reopened.draft.title, " 題名 ");
    // 一覧の納期の確認も除いた値で判定する（空白付きの日付を「形式の誤り」にしない）。上部欄も除いた形で示す。
    let item = c.list(json!(0)).unwrap().items.into_iter().find(|item| item.id == saved.document_id).expect("saved document");
    // チェックが未選択の明細は、任意の項目のため数えない（利用者の指示、2026年10月16日）。
    assert_eq!((item.c2.as_str(), item.issue_count), ("架空宛先", 0));
    assert_eq!(c.open(Some(&saved.document_id)).unwrap().draft.lines[0].delivery_state, "unknown");
}

#[test]
fn replays_lost_first_receipt_exactly_without_creating_a_second_document_or_revision() {
    let mut c = fixture();
    let session = c.open(None).unwrap();
    let input = request(&session);
    let receipt = c.save(&input).unwrap();
    assert_eq!(c.save(&input).unwrap(), receipt);
    assert_eq!(c.list(json!(0)).unwrap().items.len(), 1);
    let retitled = with(input.clone(), "draft", with(input["draft"].clone(), "title", json!("変更された同番号")));
    assert_db_error(c.save(&retitled), DbCode::Conflict, ORDER_CONFLICT);
    assert_db_error(c.save(&request_with(&session, input["draft"].clone(), 3, 1, 2)), DbCode::Conflict, ORDER_CONFLICT);
    assert_db_error(c.save(&request_with(&session, input["draft"].clone(), 2, 1, 1)), DbCode::Conflict, ORDER_CONFLICT);
}

#[test]
fn rejects_obsolete_sessions_spoofed_lines_and_modified_provenance_or_template() {
    let mut c = fixture();
    let old = c.open(None).unwrap();
    let session = c.open(None).unwrap();
    assert_db_error(c.save(&request(&old)), DbCode::Conflict, "編集セッションが変わりました。入力を保持して再表示してください。");
    let line = line_json(&c.add_line(&session.session_id, None).unwrap());
    let spoofed = [
        (with(line.clone(), "id", json!(random_uuid())), SPOOFED),
        (with(line.clone(), "materialId", json!(random_uuid())), SPOOFED),
        (with(line.clone(), "sourceItemId", json!(random_uuid())), SPOOFED),
        (with(line.clone(), "ruleVersion", json!("invented")), SPOOFED),
        (with(line.clone(), "markOutput", json!("blank")), PAIR),
    ];
    for (changed, message) in spoofed {
        assert_db_error(c.save(&request_draft(&session, with(draft(&session), "lines", json!([changed])))), DbCode::Validation, message);
    }
    assert_db_error(c.save(&request_draft(&session, with(draft(&session), "templateVersion", json!("invented")))), DbCode::Validation, "帳票形式を変更できません。");
    assert_db_error(c.add_line(&session.session_id, Some(&random_uuid())), DbCode::NotFound, "材料が見つからないか無効です。再検索してください。");
}

#[test]
fn retains_stable_new_and_deleted_line_ids_during_reordered_saves() {
    let mut c = fixture();
    let session = c.open(None).unwrap();
    let a = c.add_line(&session.session_id, None).unwrap();
    c.save(&request_draft(&session, with(draft(&session), "lines", json!([line_json(&a)])))).unwrap();
    let b = c.add_line(&session.session_id, None).unwrap();
    c.save(&request_with(&session, with(draft(&session), "lines", json!([line_json(&b), line_json(&a)])), 2, 1, 2)).unwrap();
    let third = c.save(&request_with(&session, with(draft(&session), "lines", json!([line_json(&a)])), 3, 2, 3)).unwrap();
    let ids: Vec<String> = c.open(Some(&third.document_id)).unwrap().draft.lines.into_iter().map(|line| line.id).collect();
    assert_eq!(ids, vec![a.id]);
}

#[test]
fn rolls_back_failed_saves_and_retries_the_same_request_after_failure_without_losing_the_prior_snapshot() {
    let mut c = fixture();
    let session = c.open(None).unwrap();
    let line = c.add_line(&session.session_id, None).unwrap();
    let first = c.save(&request_draft(&session, with(with(draft(&session), "title", json!("保持")), "lines", json!([line_json(&line)])))).unwrap();
    c.store.conn().execute_batch("CREATE TRIGGER fail_document_line BEFORE INSERT ON document_lines BEGIN SELECT RAISE(ABORT,'synthetic failure'); END").unwrap();
    let next = request_with(&session, with(with(draft(&session), "title", json!("最新")), "lines", json!([with(line_json(&line), "name", json!("最新明細"))])), 2, 1, 2);
    // 旧実装は SqliteError（SQLITE_CONSTRAINT_TRIGGER: synthetic failure）。
    match c.save(&next) {
        Err(Error::Other(message)) => assert!(message.contains("synthetic failure"), "{message}"),
        other => panic!("expected an SQLite error, got {other:?}"),
    }
    assert_eq!(c.title_and_revision(&first.document_id), ("保持".to_string(), 1));
    c.store.conn().execute_batch("DROP TRIGGER fail_document_line").unwrap();
    assert_eq!(c.save(&next).unwrap().revision, 2);
}

#[test]
fn bounds_draft_size_row_counts_and_history_input_without_writes() {
    let mut c = fixture();
    let session = c.open(None).unwrap();
    let line = line_json(&c.add_line(&session.session_id, None).unwrap());
    assert_validation(c.save(&request_draft(&session, with(draft(&session), "lines", Value::Array(vec![line; 501])))));
    assert_db_error(c.save(&request_draft(&session, with(draft(&session), "title", json!("x".repeat(1_048_577))))), DbCode::Validation, "保存内容は1MiB以内にしてください。");
    assert_validation(c.list(json!(-1)));
    assert_eq!(c.list(json!(0)).unwrap().items.len(), 0);
}

#[test]
fn keeps_the_database_revision_and_contents_after_an_independent_conflicting_write() {
    let mut c = fixture();
    let session = c.open(None).unwrap();
    let first = c.save(&request(&session)).unwrap();
    c.store.conn().execute("UPDATE documents SET title=?, revision=2 WHERE id=?", ["別の保存", first.document_id.as_str()]).unwrap();
    assert_db_error(c.save(&request_with(&session, with(draft(&session), "title", json!("衝突入力")), 2, 1, 2)), DbCode::Conflict, "帳票は変更されています。再読込してください。");
    assert_eq!(c.title_and_revision(&first.document_id), ("別の保存".to_string(), 2));
}

#[test]
fn rejects_cumulative_payloads_even_when_individual_editable_fields_are_valid() {
    let mut c = fixture();
    let session = c.open(None).unwrap();
    let lines: Vec<Value> = (0..110).map(|_| with(line_json(&c.add_line(&session.session_id, None).unwrap()), "remarks", json!("x".repeat(10_000)))).collect();
    match c.save(&request_draft(&session, with(draft(&session), "lines", Value::Array(lines)))) {
        Err(Error::Db(DbCode::Validation, message)) => assert!(message.contains("1MiB"), "{message}"),
        other => panic!("expected the 1MiB DatabaseError, got {other:?}"),
    }
    assert_eq!(c.list(json!(0)).unwrap().items.len(), 0);
}

#[test]
fn permits_only_confirmed_check_pairs_including_both_with_the_double_circle_mark() {
    let mut c = fixture();
    let session = c.open(None).unwrap();
    let line = line_json(&c.add_line(&session.session_id, None).unwrap());
    let checked = |state: &str, mark: &str| with(draft(&session), "lines", json!([with(with(line.clone(), "deliveryState", json!(state)), "markOutput", json!(mark))]));
    let first = c.save(&request_draft(&session, checked("material_only", "filled_circle"))).unwrap();
    c.save(&request_with(&session, checked("slip_only", "open_circle"), 2, 1, 2)).unwrap();
    match c.save(&request_with(&session, checked("both", "unresolved"), 3, 2, 3)) {
        Err(Error::Db(DbCode::Validation, message)) => { assert!(message.contains("組合せ"), "{message}"); assert_eq!(message, PAIR); }
        other => panic!("expected the pair DatabaseError, got {other:?}"),
    }
    c.save(&request_with(&session, checked("both", "both_mark"), 3, 2, 3)).unwrap();
    let saved = &c.open(Some(&first.document_id)).unwrap().draft.lines[0];
    assert_eq!((saved.delivery_state.as_str(), saved.mark_output.as_str()), ("both", "both_mark"));
}

#[test]
fn keeps_an_unchanged_both_line_saved_before_the_double_circle_mark_was_decided() {
    let mut c = fixture();
    let session = c.open(None).unwrap();
    let line = c.add_line(&session.session_id, None).unwrap();
    let first = c.save(&request_draft(&session, with(draft(&session), "lines", json!([line_json(&line)])))).unwrap();
    c.store.conn().execute("UPDATE document_lines SET delivery_state=?, mark_output=? WHERE id=?", ["both", "unresolved", line.id.as_str()]).unwrap();
    let reopened = c.open(Some(&first.document_id)).unwrap();
    c.save(&request_draft(&reopened, with(draft(&reopened), "title", json!("題名だけ変更")))).unwrap();
    let saved = &c.open(Some(&first.document_id)).unwrap().draft.lines[0];
    assert_eq!((saved.delivery_state.as_str(), saved.mark_output.as_str()), ("both", "unresolved"));
}

// ---- 削除（documents:delete。旧実装にはない機能） ----

/// 明細 `lines` 行の帳票を新規に保存して ID を返す（この後、編集セッションはこの帳票を開いたまま）。
fn saved_document(c: &mut Context, title: &str, lines: usize) -> String {
    let session = c.open(None).unwrap();
    let lines: Vec<Value> = (0..lines).map(|_| line_json(&c.add_line(&session.session_id, None).unwrap())).collect();
    c.save(&request_draft(&session, with(with(draft(&session), "title", json!(title)), "lines", Value::Array(lines)))).unwrap().document_id
}

fn ids(values: &[&str]) -> Vec<String> { values.iter().map(|value| value.to_string()).collect() }

fn count(c: &Context, sql: &str, id: &str) -> i64 { c.store.conn().query_row(sql, [id], |row| row.get(0)).unwrap() }

#[test]
fn deletes_documents_with_their_lines_in_one_transaction_and_treats_missing_ids_as_already_deleted() {
    let mut c = fixture();
    let first = saved_document(&mut c, "削除1", 2);
    let second = saved_document(&mut c, "削除2", 0);
    let kept = saved_document(&mut c, "残す", 3);
    assert_eq!(c.editor.delete(&c.store, &ids(&[&first, &second])).unwrap(), 2);
    for id in [&first, &second] {
        assert_eq!(count(&c, "SELECT count(*) FROM documents WHERE id=?", id), 0);
        assert_eq!(count(&c, "SELECT count(*) FROM document_lines WHERE document_id=?", id), 0);
    }
    assert_eq!(count(&c, "SELECT count(*) FROM document_lines WHERE document_id=?", &kept), 3);
    assert_eq!(c.list(json!(0)).unwrap().items.iter().map(|item| item.title.as_str()).collect::<Vec<_>>(), ["残す"]);
    assert_db_error(c.open(Some(&first)), DbCode::NotFound, "帳票が見つかりません。");
    // 応答が失われた後の再送（削除済みの ID）と、存在しない ID は成功にする（0件）。
    assert_eq!(c.editor.delete(&c.store, &ids(&[&first, &random_uuid()])).unwrap(), 0);
    assert_eq!(pom_core::db::foreign_key_violations(c.store.conn()).unwrap(), 0);
}

#[test]
fn rolls_back_every_deletion_when_one_statement_fails() {
    let mut c = fixture();
    let first = saved_document(&mut c, "削除1", 1);
    let second = saved_document(&mut c, "削除2", 1);
    c.store.conn().execute_batch(&format!("CREATE TRIGGER fail_document_delete BEFORE DELETE ON documents WHEN old.id = '{second}' BEGIN SELECT RAISE(ABORT, 'synthetic failure'); END")).unwrap();
    assert!(matches!(c.editor.delete(&c.store, &ids(&[&first, &second])), Err(Error::Other(_))));
    for id in [&first, &second] {
        assert_eq!(count(&c, "SELECT count(*) FROM documents WHERE id=?", id), 1);
        assert_eq!(count(&c, "SELECT count(*) FROM document_lines WHERE document_id=?", id), 1);
    }
}

#[test]
fn deleting_a_duplicate_source_keeps_the_copy_and_only_drops_its_reference() {
    let mut c = fixture();
    let source = saved_document(&mut c, "複製元", 1);
    let duplicate = c.duplicate(&source).unwrap();
    let copy = c.save(&request(&duplicate)).unwrap().document_id;
    let before: (i64, String) = c.store.conn().query_row("SELECT revision, updated_at FROM documents WHERE id=?", [&copy], |row| Ok((row.get(0)?, row.get(1)?))).unwrap();
    assert_eq!(c.editor.delete(&c.store, &ids(&[&source])).unwrap(), 1);
    let after: (i64, String, Option<String>) = c.store.conn().query_row("SELECT revision, updated_at, duplicated_from_id FROM documents WHERE id=?", [&copy], |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?))).unwrap();
    assert_eq!(after, (before.0, before.1, None));
    assert_eq!(count(&c, "SELECT count(*) FROM document_lines WHERE document_id=?", &copy), 1);
    assert_eq!(pom_core::db::foreign_key_violations(c.store.conn()).unwrap(), 0);
    // 複製元と複製を同時に削除しても、外部キー（ON DELETE RESTRICT）の順番で失敗しない。
    let parent = saved_document(&mut c, "親", 1);
    let duplicate = c.duplicate(&parent).unwrap();
    let child = c.save(&request(&duplicate)).unwrap().document_id;
    let duplicate = c.duplicate(&child).unwrap();
    let grandchild = c.save(&request(&duplicate)).unwrap().document_id;
    assert_eq!(c.editor.delete(&c.store, &ids(&[&grandchild, &parent, &child])).unwrap(), 3);
    assert_eq!(c.list(json!(0)).unwrap().items.iter().map(|item| item.id.as_str()).collect::<Vec<_>>(), [copy.as_str()]);
}

#[test]
fn deleting_the_open_document_closes_its_session_and_unsaved_copies_forget_the_source() {
    let mut c = fixture();
    let other = saved_document(&mut c, "別の帳票", 0);
    let open = saved_document(&mut c, "開いている帳票", 0);
    let session = c.open(Some(&open)).unwrap();
    // ほかの帳票を削除しても、開いている帳票の編集は続けられる。
    c.editor.delete(&c.store, &ids(&[&other])).unwrap();
    c.add_line(&session.session_id, None).unwrap();
    c.editor.delete(&c.store, &ids(&[&open])).unwrap();
    assert_db_error(c.add_line(&session.session_id, None), DbCode::Conflict, "編集セッションが変わりました。入力を保持して再表示してください。");
    assert_db_error(c.save(&request(&session)), DbCode::Conflict, "編集セッションが変わりました。入力を保持して再表示してください。");
    // 保存前の複製の複製元を削除しても、複製は複製元の記録なしで保存できる。
    let source = saved_document(&mut c, "複製元", 1);
    let copy = c.duplicate(&source).unwrap();
    c.editor.delete(&c.store, &ids(&[&source])).unwrap();
    let saved = c.save(&request(&copy)).unwrap();
    assert_eq!(c.list(json!(0)).unwrap().items.iter().find(|item| item.id == saved.document_id).map(|item| item.duplicated_from_id.clone()), Some(None));
    assert_eq!(pom_core::db::foreign_key_violations(c.store.conn()).unwrap(), 0);
}

#[test]
fn delete_ids_must_be_one_to_one_hundred_unique_uuids() {
    use pom_core::documents::parse_document_ids;
    let valid: Vec<String> = (0..100).map(|_| random_uuid()).collect();
    assert_eq!(parse_document_ids(&json!(valid)).unwrap(), valid);
    let one = random_uuid();
    for input in [json!([]), json!(null), json!(one), json!({ "ids": [one] }), json!([one, one]), json!(["not-a-uuid"]), json!([1]), json!((0..101).map(|_| random_uuid()).collect::<Vec<_>>())] {
        assert_validation(parse_document_ids(&input));
    }
}
