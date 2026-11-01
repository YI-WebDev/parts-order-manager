//! tests/unit/excel-export.test.ts の移植（保存版からのExcel出力: 出力前の検査・取消・上書き確認・競合・書込失敗・一時ファイルの残留）。
//!
//! 旧テストとの対応:
//! - `excelExporter(store, { choose, overwrite }, [root/database])(request)` は `App::invoke("documents:export-excel", [request])`。
//!   保存ダイアログ（choose）と上書き確認（overwrite）はテスト用の `Host` が答え、呼ばれた回数も数える（vi.fn の代わり）。
//! - node:fs の writeFileSync・renameSync・unlinkSync を1回だけ失敗させるモックは、`Host::fault("write" | "rename" | "unlink")`
//!   が1回だけ true を返すことで起こす（`commitWorkbook` を直接呼ぶテストは `FileOps` を差し替える）。mockRestore は残りの消去。
//! - 旧テストは同じ store を出力と編集・SQL変更に使った。ここでは App が自分の接続を持つため、テスト側は同じDBファイルを
//!   別の接続で開き、編集（documentEditor）・SQL・savedPrintModel に使う。
//! - App は出力成功時に ui-meta.json を書くため、出力先フォルダーの一覧が旧テストと同じになるよう保存場所（user_data）は
//!   DBのフォルダー（保護する場所）にする。
//! - 出力先は旧実装の Windows のドライブ文字の形ではなく、Windows 以外で受け付ける `/` から始まる絶対パス（一時フォルダー）。

mod import_support;

use std::future::Future;
use std::path::{Path, PathBuf};
use std::pin::Pin;
use std::sync::atomic::{AtomicBool, AtomicUsize, Ordering};
use std::sync::{Arc, LazyLock, Mutex};
use std::task::{Context, Poll, Wake, Waker};

use pom_core::api::{App, AppConfig, BoxFuture, Host, MessageBox, OpenDialog, Parent, PrintSession, SaveDialog};
use pom_core::db::Store;
use pom_core::documents::{self, DocumentEditor, SaveReceipt};
use pom_core::error::Error;
use pom_core::exports::{build_workbook, files, saved_print_model, workbook_envelope, ExportRequest, PrintModel};
use pom_core::materials::{self, MaterialValues};
use pom_core::sheet::SheetHeader;
use regex::Regex;
use serde_json::{json, Value};
use tempfile::TempDir;

use import_support::{with_zip64, Zip64};

const DESTINATION_FAIL: &str = "出力先を確認してください。元Excel・内部データ・リンク先への上書きはできません。別のファイル名を選んでください。";

struct ThreadWaker(std::thread::Thread);
impl Wake for ThreadWaker { fn wake(self: Arc<Self>) { self.0.unpark(); } }

fn block_on<F: Future>(future: F) -> F::Output {
    let mut future = std::pin::pin!(future);
    let waker = Waker::from(Arc::new(ThreadWaker(std::thread::current())));
    let mut context = Context::from_waker(&waker);
    loop {
        if let Poll::Ready(value) = future.as_mut().poll(&mut context) { return value; }
        std::thread::park();
    }
}

type Choose = Box<dyn FnMut() -> BoxFuture<'static, Option<PathBuf>> + Send>;
type Overwrite = Box<dyn FnMut() -> bool + Send>;

fn choose_path(path: PathBuf) -> Choose { Box::new(move || { let path = path.clone(); Box::pin(async move { Some(path) }) }) }
fn choose_with(mut pick: impl FnMut() -> Option<PathBuf> + Send + 'static) -> Choose { Box::new(move || { let picked = pick(); Box::pin(async move { picked }) }) }

/// 保存ダイアログ・上書き確認の答えと呼ばれた回数、1回だけ失敗させる操作。
struct ExportHost { choose: Mutex<Choose>, overwrite: Mutex<Overwrite>, chosen: AtomicUsize, confirmed: AtomicUsize, faults: Mutex<Vec<&'static str>> }

impl Host for ExportHost {
    fn open_file(&self, _parent: Parent, _dialog: OpenDialog) -> BoxFuture<'_, Option<PathBuf>> { Box::pin(async { None }) }
    fn save_file(&self, _parent: Parent, _dialog: SaveDialog) -> BoxFuture<'_, Option<PathBuf>> {
        self.chosen.fetch_add(1, Ordering::SeqCst);
        (self.choose.lock().unwrap())()
    }
    fn message_box(&self, _parent: Parent, dialog: MessageBox) -> BoxFuture<'_, usize> {
        self.confirmed.fetch_add(1, Ordering::SeqCst);
        let answer = if (self.overwrite.lock().unwrap())() { 1 } else { dialog.cancel_id };
        Box::pin(async move { answer })
    }
    fn sender_trusted(&self) -> bool { true }
    fn emit_close_requested(&self, _token: &str) {}
    fn close_main_window(&self) {}
    fn quit_after_restore(&self) {}
    fn preview_url(&self, id: &str) -> String { format!("app://print/{id}") }
    fn open_print_preview(&self, _session: Arc<PrintSession>) -> BoxFuture<'_, std::result::Result<(), String>> { Box::pin(async { Err("not used".to_string()) }) }
    fn fault(&self, point: &str) -> bool {
        let mut faults = self.faults.lock().unwrap();
        match faults.iter().position(|f| *f == point) { Some(index) => { faults.remove(index); true } None => false }
    }
}

/// テスト側の接続と編集セッション（旧テストの f.store・f.editor）。
struct Db { store: Store, editor: DocumentEditor }

/// `saveNext()`（同じ編集セッションで品名を「次の版」にして版2を保存する）。
fn save_next(db: &Mutex<Db>, session_id: &str, draft: &Value) -> SaveReceipt {
    let mut next = draft.clone();
    for line in next["lines"].as_array_mut().unwrap() { line["name"] = json!("次の版"); }
    let mut guard = db.lock().unwrap();
    let Db { store, editor } = &mut *guard;
    editor.save(store, &json!({ "sessionId": session_id, "requestNumber": 2, "generation": 2, "expectedRevision": 1, "draft": next })).unwrap()
}

/// フィールド順に破棄する（DBを閉じてから一時フォルダーを消す）。
struct Fixture { app: Arc<App>, host: Arc<ExportHost>, db: Arc<Mutex<Db>>, session_id: String, draft: Value, document_id: String, request: Value, target: PathBuf, root: TempDir }

fn request_json(document_id: &str, revision: i64) -> Value { json!({ "documentId": document_id, "revision": revision }) }

fn fixture() -> Fixture {
    let root = tempfile::Builder::new().prefix("step08-export-").tempdir().unwrap();
    let database = root.path().join("database");
    let store = Store::open_default(&database).unwrap();
    let mut editor = DocumentEditor::default();
    let session = editor.open(&store, &Value::Null, false).unwrap();
    let line = editor.add_line(&store, &json!({ "sessionId": session.session_id, "materialId": null })).unwrap();
    let mut line = serde_json::to_value(&line).unwrap();
    for (key, value) in [("name", "保存済み"), ("model", "001-α"), ("quantity", "02 本"), ("deliveryState", "material_only"), ("markOutput", "filled_circle")] { line[key] = json!(value); }
    let mut draft = serde_json::to_value(&session.draft).unwrap();
    draft["title"] = json!("PRIVATE-TITLE");
    draft["lines"] = json!([line]);
    let receipt = editor.save(&store, &json!({ "sessionId": session.session_id, "requestNumber": 1, "generation": 1, "expectedRevision": 0, "draft": draft })).unwrap();
    let target = root.path().join("架空出力.xlsx");
    let host = Arc::new(ExportHost { choose: Mutex::new(choose_path(target.clone())), overwrite: Mutex::new(Box::new(|| true)), chosen: AtomicUsize::new(0), confirmed: AtomicUsize::new(0), faults: Mutex::new(Vec::new()) });
    let config = AppConfig { user_data: database.clone(), documents_dir: root.path().to_path_buf(), protected_roots: vec![database.clone()], version: "0.1.0".into(), recovery_notice: None };
    let app = App::new(config, Store::open_default(&database).unwrap(), host.clone());
    Fixture {
        app, host, db: Arc::new(Mutex::new(Db { store, editor })), session_id: session.session_id, draft,
        request: request_json(&receipt.document_id, receipt.revision), document_id: receipt.document_id, target, root,
    }
}

impl Fixture {
    /// `makeExporter(choose, overwrite)`（省略時は出力先を選び、上書きを認める）。
    fn make_exporter(&self, choose: Option<Choose>, overwrite: Option<Overwrite>) {
        *self.host.choose.lock().unwrap() = choose.unwrap_or_else(|| choose_path(self.target.clone()));
        *self.host.overwrite.lock().unwrap() = overwrite.unwrap_or_else(|| Box::new(|| true));
        self.host.chosen.store(0, Ordering::SeqCst);
        self.host.confirmed.store(0, Ordering::SeqCst);
    }
    fn export(&self, request: &Value) -> Value { block_on(self.app.invoke("documents:export-excel", vec![request.clone()])).expect("export handler") }
    /// `makeExporter()(request)`
    fn export_default(&self, request: &Value) -> Value { self.make_exporter(None, None); self.export(request) }
    fn save_next(&self) -> SaveReceipt { save_next(&self.db, &self.session_id, &self.draft) }
    fn saved_model(&self, revision: i64) -> PrintModel {
        saved_print_model(&self.db.lock().unwrap().store, &ExportRequest { document_id: self.document_id.clone(), revision }).unwrap().0
    }
    fn sql(&self, statement: &str, params: &[&str]) { self.db.lock().unwrap().store.conn().execute(statement, rusqlite::params_from_iter(params)).unwrap(); }
    fn fail_once(&self, point: &'static str) { self.host.faults.lock().unwrap().push(point); }
    /// mockRestore（使われなかった失敗も取り消す）。
    fn restore(&self) { self.host.faults.lock().unwrap().clear(); }
    fn names(&self) -> Vec<String> {
        let mut names: Vec<String> = std::fs::read_dir(self.root.path()).unwrap().map(|e| e.unwrap().file_name().to_string_lossy().into_owned()).collect();
        names.sort();
        names
    }
    fn read_target(&self) -> Vec<u8> { std::fs::read(&self.target).unwrap() }
}

/// `toMatchObject`（期待値のキーだけを、入れ子のオブジェクトも部分的に比べる）。
#[track_caller]
fn assert_match(actual: &Value, expected: Value) {
    fn matches(actual: &Value, expected: &Value) -> bool {
        match expected {
            Value::Object(map) => actual.as_object().is_some_and(|object| map.iter().all(|(key, value)| object.get(key).is_some_and(|found| matches(found, value)))),
            other => actual == other,
        }
    }
    assert!(matches(actual, &expected), "{actual} should match {expected}");
}

#[test]
fn exports_only_saved_snapshots_with_explicit_headers_and_validated_date_after_master_changes() {
    let f = fixture();
    {
        let db = f.db.lock().unwrap();
        let category_id = materials::create_category(&db.store, "PRIVATE-CATEGORY", 0).unwrap();
        let values = MaterialValues { name: "PRIVATE-MATERIAL".into(), model: "PRIVATE-MODEL".into(), quantity: "1".into(), unit_price: "PRIVATE-PRICE".into(), manufacturer: "".into(), remarks: "https://private.invalid/".into() };
        materials::create(&db.store, &category_id, &values).unwrap();
    }
    let result = f.export_default(&f.request);
    assert_match(&result, json!({ "status": "ok", "revision": 1, "cleanup": null }));
    let parts = workbook_envelope(&f.read_target()).unwrap();
    let all: String = parts.values().map(|bytes| String::from_utf8_lossy(bytes).into_owned()).collect();
    assert!(all.contains("保存済み"));
    assert!(all.contains("001-α"));
    assert!(!all.contains("PRIVATE"));
    assert!(!all.contains(&f.document_id));
    assert_eq!(parts.len(), 6);
}

#[test]
fn handles_rows_without_truncating_saved_source_or_silently_accepting_overflow() {
    for count in [0, 1, 47, 48] {
        let f = fixture();
        let id = {
            let db = f.db.lock().unwrap();
            let mut line = f.draft["lines"][0].clone();
            line.as_object_mut().unwrap().remove("id");
            let mut draft = f.draft.clone();
            draft["lines"] = Value::Array(vec![line; count]);
            documents::create_document(&db.store, &documents::parse_draft(&draft, false, 10_000).unwrap(), None).unwrap()
        };
        let result = f.export_default(&request_json(&id, 1));
        assert_eq!(result["status"], if count > 47 { "blocked" } else { "ok" }, "{count}");
        assert_eq!(f.host.chosen.load(Ordering::SeqCst), if count > 47 { 0 } else { 1 }, "{count}");
        assert_eq!(documents::get_document(&f.db.lock().unwrap().store, &id).unwrap().lines.len(), count);
    }
}

#[test]
fn blocks_unresolved_both_mark_without_opening_a_save_dialog() {
    let f = fixture();
    f.sql("UPDATE document_lines SET delivery_state=?, mark_output=? WHERE document_id=?", &["both", "unresolved", &f.document_id]);
    let result = f.export_default(&f.request);
    assert_eq!(result["status"], "blocked");
    assert_eq!(result["issues"], json!([{ "field": "lines.0.mark", "message": "明細1「保存済み」のチェック記号が未確定（材料・伝票とも。「⦿」を選び直してください）" }]));
    assert_eq!(f.host.chosen.load(Ordering::SeqCst), 0);
}

/// チェックは任意の項目（利用者の指示、2026年10月16日）。未選択の明細は止めずに、チェック欄を空欄で出力する。
#[test]
fn exports_an_unselected_check_as_a_blank_cell() {
    let f = fixture();
    f.sql("UPDATE document_lines SET delivery_state=?, mark_output=? WHERE document_id=?", &["unknown", "unresolved", &f.document_id]);
    assert_eq!(f.export_default(&f.request)["status"], "ok");
    assert_eq!(f.host.chosen.load(Ordering::SeqCst), 1);
    let model = f.saved_model(1);
    assert_eq!((model.lines.len(), model.lines[0].mark.as_str(), model.lines[0].name.as_str()), (1, "", "保存済み"));
    let parts = workbook_envelope(&f.read_target()).unwrap();
    let sheet = String::from_utf8(parts["xl/worksheets/sheet1.xml"].clone()).unwrap();
    // チェック欄（A6）は値を持たない書式だけのセル、品名（B6）はそのまま。
    assert!(Regex::new(r#"<c r="A6" s="\d+"/>"#).unwrap().is_match(&sheet), "{sheet}");
    assert!(sheet.contains(r#"<c r="B6" s="#) && sheet.contains(">保存済み</t>"), "{sheet}");
}

#[test]
fn blocks_mismatched_or_unconfirmed_mark() {
    for mark in ["blank", "both_mark", "unresolved", "open_circle"] {
        let f = fixture();
        f.sql("UPDATE document_lines SET mark_output=? WHERE document_id=?", &[mark, &f.document_id]);
        assert_eq!(f.export_default(&f.request)["status"], "blocked", "{mark}");
        assert!(!f.target.exists(), "{mark}");
    }
}

#[test]
fn validates_real_date_while_preserving_input() {
    for date in ["2026-09-13", "2024/2/29", "0001-01-01", "2026-02-29", "2026-13-01", "2026/2-1", "=NOW()"] {
        let f = fixture();
        let header = json!({ "C2": "架空宛先", "A4": "架空A", "B4": "架空B", "C4": "架空C", "E4": date });
        f.sql("UPDATE documents SET header=? WHERE id=?", &[&header.to_string(), &f.document_id]);
        let valid = ["2026-09-13", "2024/2/29", "0001-01-01"].contains(&date);
        assert_eq!(f.export_default(&f.request)["status"], if valid { "ok" } else { "blocked" }, "{date}");
        let expected = SheetHeader { c2: "架空宛先".into(), a4: "架空A".into(), b4: "架空B".into(), c4: "架空C".into(), e4: date.into() };
        assert_eq!(f.saved_model(1).header, expected, "{date}");
    }
}

/// TD-45: 保存した値の前後の空白（JavaScript の trim と同じ全角・半角）は、帳票に置く値からも納期の判定からも除く（プレビューと同じ）。
#[test]
fn places_stored_values_without_surrounding_whitespace_and_judges_the_due_date_after_trimming() {
    let f = fixture();
    let pad = |value: &str| format!("\u{3000} \t{value}\u{A0}\u{FEFF}\u{2028}\n");
    let header = json!({ "C2": pad("架空宛先"), "A4": pad("架空A"), "B4": "\u{3000}", "C4": pad("架空　C"), "E4": pad("2026/10/31") });
    f.sql("UPDATE documents SET header=? WHERE id=?", &[&header.to_string(), &f.document_id]);
    let (name, model, quantity) = (pad("保存済み"), pad("001-α"), pad("02 本"));
    f.sql("UPDATE document_lines SET name=?, model=?, quantity=?, remarks=? WHERE document_id=?", &[&name, &model, &quantity, "\u{3000}", &f.document_id]);
    let saved = f.saved_model(1);
    assert_eq!(saved.header, SheetHeader { c2: "架空宛先".into(), a4: "架空A".into(), b4: "".into(), c4: "架空　C".into(), e4: "2026/10/31".into() });
    assert_eq!((saved.lines[0].name.as_str(), saved.lines[0].model.as_str(), saved.lines[0].quantity.as_str(), saved.lines[0].remarks.as_str()), ("保存済み", "001-α", "02 本", ""));
    assert_eq!(f.export_default(&f.request)["status"], "ok");
    let parts = workbook_envelope(&f.read_target()).unwrap();
    let sheet = String::from_utf8(parts["xl/worksheets/sheet1.xml"].clone()).unwrap();
    assert!(sheet.contains(">架空宛先</t>") && sheet.contains(">保存済み</t>") && sheet.contains(">001-α</t>") && sheet.contains(">02 本</t>") && sheet.contains(">架空　C</t>"), "{sheet}");
    // 納期は除いた後に日付として置く（日付の値、表示は 10月31日）。空白だけの欄と備考は空のセル。
    assert!(Regex::new(r#"<c r="E4" s="\d+"><v>46326</v></c>"#).unwrap().is_match(&sheet), "{sheet}");
    assert!(Regex::new(r#"<c r="B4" s="\d+"/>"#).unwrap().is_match(&sheet) && Regex::new(r#"<c r="F6" s="\d+"/>"#).unwrap().is_match(&sheet), "{sheet}");
    assert!(!sheet.contains("\u{3000} ") && !sheet.contains('\u{FEFF}') && !sheet.contains('\u{A0}'), "{sheet}");
}

/// JavaScript の trim が空白とみなさない文字（U+200B・U+180E・U+0085）は除かない。
#[test]
fn keeps_characters_that_javascript_trim_does_not_treat_as_whitespace() {
    let f = fixture();
    let name = "\u{200B}保存済み\u{180E}\u{85}";
    f.sql("UPDATE document_lines SET name=? WHERE document_id=?", &[name, &f.document_id]);
    assert_eq!(f.saved_model(1).lines[0].name, name);
}

/// 前後に空白のある不正な納期は、除いた後も不正なので出力を止める。
#[test]
fn still_blocks_an_invalid_due_date_after_trimming() {
    let f = fixture();
    let header = json!({ "C2": "", "A4": "", "B4": "", "C4": "", "E4": "\u{3000}2026-02-30 " });
    f.sql("UPDATE documents SET header=? WHERE id=?", &[&header.to_string(), &f.document_id]);
    let result = f.export_default(&f.request);
    assert_eq!(result["status"], "blocked");
    assert_eq!(result["issues"][0]["field"], "E4");
}

#[test]
fn cancels_without_creating_output_or_altering_saved_content() {
    let f = fixture();
    let before = documents::get_document(&f.db.lock().unwrap().store, &f.document_id).unwrap();
    f.make_exporter(Some(choose_with(|| None)), None);
    assert_eq!(f.export(&f.request), json!({ "status": "cancelled" }));
    assert!(!f.target.exists());
    assert_eq!(documents::get_document(&f.db.lock().unwrap().store, &f.document_id).unwrap(), before);
}

#[test]
fn preserves_existing_generated_file_when_overwrite_is_declined() {
    let f = fixture();
    let original = build_workbook(&f.saved_model(1)).unwrap();
    std::fs::write(&f.target, &original).unwrap();
    f.make_exporter(None, Some(Box::new(|| false)));
    assert_eq!(f.export(&f.request)["status"], "cancelled");
    assert_eq!(f.read_target(), original);
}

#[test]
fn overwrites_only_confirmed_generated_output_and_rejects_foreign_file_without_replacing_it() {
    let f = fixture();
    std::fs::write(&f.target, "FOREIGN-SECRET").unwrap();
    assert_eq!(f.export_default(&f.request)["status"], "error");
    assert_eq!(f.host.confirmed.load(Ordering::SeqCst), 0);
    assert_eq!(std::fs::read_to_string(&f.target).unwrap(), "FOREIGN-SECRET");
}

#[test]
fn rejects_revision_changes_while_the_save_dialog_is_open_leaving_the_old_output_unchanged() {
    let f = fixture();
    let original = build_workbook(&f.saved_model(1)).unwrap();
    std::fs::write(&f.target, &original).unwrap();
    let (db, session_id, draft, target) = (f.db.clone(), f.session_id.clone(), f.draft.clone(), f.target.clone());
    f.make_exporter(Some(choose_with(move || { save_next(&db, &session_id, &draft); Some(target.clone()) })), None);
    assert_match(&f.export(&f.request), json!({ "status": "error", "code": "CONFLICT" }));
    assert_eq!(f.read_target(), original);
}

#[test]
fn rejects_destination_replacement_during_overwrite_confirmation() {
    let f = fixture();
    std::fs::write(&f.target, build_workbook(&f.saved_model(1)).unwrap()).unwrap();
    let target = f.target.clone();
    f.make_exporter(None, Some(Box::new(move || { std::fs::write(&target, "CONCURRENT").unwrap(); true })));
    assert_eq!(f.export(&f.request)["status"], "error");
    assert_eq!(std::fs::read_to_string(&f.target).unwrap(), "CONCURRENT");
}

#[test]
fn rejects_an_abnormal_zip64_file_at_the_overwrite_check_without_changing_it_and_keeps_exporting() {
    let f = fixture();
    let generated = build_workbook(&f.saved_model(1)).unwrap();
    // 既存の出力のシート本体を、圧縮後サイズ u64::MAX の ZIP64 項目に書き換える（旧実装は上書き前の検査で panic した）。
    let abnormal = with_zip64(&generated, "xl/worksheets/sheet1.xml", Zip64 { compressed: Some(u64::MAX), ..Zip64::default() });
    let checked = std::panic::catch_unwind(|| workbook_envelope(&abnormal)).expect("workbook_envelope must return an error instead of panicking");
    assert!(matches!(&checked, Err(Error::ExportFile(message)) if message == "このファイルは確認済みの出力形式ではありません。別の名前で保存してください。"), "{checked:?}");
    std::fs::write(&f.target, &abnormal).unwrap();
    let result = f.export_default(&f.request);
    assert_match(&result, json!({ "status": "error", "code": "IO", "message": "このファイルは確認済みの出力形式ではありません。別の名前で保存してください。" }));
    // 上書き確認の前に止まり、選択された既存ファイルは1バイトも変わらず、一時ファイルも残らない。
    assert_eq!(f.host.confirmed.load(Ordering::SeqCst), 0);
    assert_eq!(f.read_target(), abnormal);
    assert!(f.names().iter().all(|name| !name.ends_with(".tmp")), "{:?}", f.names());
    // 同じアプリで続けて別の出力先へ正常に出力できる。
    let other = f.root.path().join("架空出力-別名.xlsx");
    f.make_exporter(Some(choose_path(other.clone())), None);
    assert_eq!(f.export(&f.request)["status"], "ok");
    assert_eq!(std::fs::read(&other).unwrap(), generated);
    assert_eq!(f.read_target(), abnormal);
}

/// 解決されるまで待つ保存ダイアログ（旧テストの chosen の Promise）。一度解決した値は何度でも返す。
#[derive(Default)]
struct Hold { value: Mutex<Option<Option<PathBuf>>>, waker: Mutex<Option<Waker>> }

impl Hold {
    fn release(&self, value: Option<PathBuf>) {
        *self.value.lock().unwrap() = Some(value);
        if let Some(waker) = self.waker.lock().unwrap().take() { waker.wake(); }
    }
}

struct Held(Arc<Hold>);
impl Future for Held {
    type Output = Option<PathBuf>;
    fn poll(self: Pin<&mut Self>, context: &mut Context<'_>) -> Poll<Self::Output> {
        if let Some(value) = self.0.value.lock().unwrap().clone() { return Poll::Ready(value); }
        *self.0.waker.lock().unwrap() = Some(context.waker().clone());
        Poll::Pending
    }
}

#[test]
fn rejects_concurrent_export_and_becomes_usable_after_cancel() {
    let f = fixture();
    let hold = Arc::new(Hold::default());
    let chosen = hold.clone();
    f.make_exporter(Some(Box::new(move || Box::pin(Held(chosen.clone())))), None);
    let mut first = Box::pin(f.app.invoke("documents:export-excel", vec![f.request.clone()]));
    // 1件目は保存ダイアログで待っている。
    assert!(first.as_mut().poll(&mut Context::from_waker(Waker::noop())).is_pending());
    assert_match(&f.export(&f.request), json!({ "status": "error", "code": "BUSY" }));
    hold.release(None);
    assert_eq!(block_on(first).unwrap(), json!({ "status": "cancelled" }));
    assert_eq!(f.export(&f.request), json!({ "status": "cancelled" }));
}

#[test]
fn preserves_old_bytes_when_write_or_rename_fails_and_permits_retry() {
    for operation in ["write", "rename"] {
        let f = fixture();
        let original = build_workbook(&f.saved_model(1)).unwrap();
        std::fs::write(&f.target, &original).unwrap();
        f.fail_once(operation);
        assert_eq!(f.export_default(&f.request)["status"], "error", "{operation}");
        assert_eq!(f.read_target(), original, "{operation}");
        assert!(f.names().iter().all(|name| !name.ends_with(".tmp")), "{operation}: {:?}", f.names());
        f.restore();
        assert_eq!(f.export_default(&f.request)["status"], "ok", "{operation}");
    }
}

/// unlink だけを1回失敗させる（commitWorkbook を直接呼ぶテスト用）。新規出力はハードリンクで確定する（Windows 以外の確定と同じ）。
struct FailUnlinkOnce(AtomicBool);
impl files::FileOps for FailUnlinkOnce {
    fn publish_new(&self, from: &Path, to: &Path) -> std::io::Result<files::Published> { std::fs::hard_link(from, to)?; Ok(files::Published::Linked) }
    fn unlink(&self, path: &Path) -> std::io::Result<()> {
        if !self.0.swap(true, Ordering::SeqCst) { return Err(std::io::Error::other("synthetic cleanup failure")); }
        std::fs::remove_file(path)
    }
}

#[test]
fn reports_post_commit_cleanup_separately_instead_of_pretending_the_completed_output_failed() {
    let f = fixture();
    let target = files::inspect_destination(&f.target, &[], ".xlsx").unwrap();
    let remaining = files::commit_workbook(&target, b"complete", &mut || Ok(()), &FailUnlinkOnce(AtomicBool::new(false))).unwrap();
    let name = remaining.expect("leftover temporary name");
    assert!(Regex::new(r"^.parts-order-[a-f0-9-]+.tmp$").unwrap().is_match(&name), "{name}");
    assert_eq!(std::fs::read_to_string(&f.target).unwrap(), "complete");
}

/// 新規出力を移動で確定する（Windows の確定と同じく、出力先があれば失敗し一時ファイルは残らない）。unlink の呼出しを数える。
#[derive(Default)]
struct MoveOps { unlinked: AtomicUsize }
impl files::FileOps for MoveOps {
    fn publish_new(&self, from: &Path, to: &Path) -> std::io::Result<files::Published> {
        std::fs::hard_link(from, to)?;
        std::fs::remove_file(from)?;
        Ok(files::Published::Moved)
    }
    fn unlink(&self, path: &Path) -> std::io::Result<()> { self.unlinked.fetch_add(1, Ordering::SeqCst); std::fs::remove_file(path) }
}

#[test]
fn completes_a_moved_publication_without_cleanup_or_a_leftover_report() {
    let f = fixture();
    let target = files::inspect_destination(&f.target, &[], ".xlsx").unwrap();
    let ops = MoveOps::default();
    // 移動で確定した一時ファイルは消えているが、後片付けの失敗（NotFound 以外）や残留として扱わない。
    assert_eq!(files::commit_workbook(&target, b"complete", &mut || Ok(()), &ops).unwrap(), None);
    assert_eq!(ops.unlinked.load(Ordering::SeqCst), 0);
    assert_eq!(std::fs::read_to_string(&f.target).unwrap(), "complete");
    assert_eq!(pom_core::fsx::lstat(&f.target).unwrap().nlink, 1);
    assert_eq!(f.names(), vec!["database".to_string(), "架空出力.xlsx".to_string()]);
}

/// 新規確定の直前（出力先の再検査の後）に、別のプロセスが同じ名前のファイルを作る。確定には実際の publish_new を使う。
struct ConcurrentCreate;
impl files::FileOps for ConcurrentCreate {
    fn publish_new(&self, from: &Path, to: &Path) -> std::io::Result<files::Published> {
        std::fs::write(to, "CONCURRENT")?;
        files::publish_new(from, to)
    }
}

/// 新規確定だけを1回失敗させる。
struct FailPublish;
impl files::FileOps for FailPublish {
    fn publish_new(&self, _from: &Path, _to: &Path) -> std::io::Result<files::Published> { Err(std::io::Error::other("synthetic publish failure")) }
}

#[test]
fn new_output_never_replaces_a_file_that_appears_just_before_publication_and_cleans_up_its_temp() {
    let f = fixture();
    let target = files::inspect_destination(&f.target, &[], ".xlsx").unwrap();
    assert_eq!(target.original, None);
    let error = files::commit_workbook(&target, b"complete", &mut || Ok(()), &ConcurrentCreate).unwrap_err();
    assert!(matches!(&error, Error::Other(message) if message.starts_with("io:")), "{error:?}");
    assert_eq!(std::fs::read_to_string(&f.target).unwrap(), "CONCURRENT");
    assert_eq!(f.names(), vec!["database".to_string(), "架空出力.xlsx".to_string()]);
}

#[test]
fn reports_a_failed_new_publication_as_an_error_and_permits_retry() {
    let f = fixture();
    let target = files::inspect_destination(&f.target, &[], ".xlsx").unwrap();
    assert!(matches!(files::commit_workbook(&target, b"complete", &mut || Ok(()), &FailPublish), Err(Error::Other(_))));
    assert!(!f.target.exists());
    assert_eq!(f.names(), vec!["database".to_string()]);
    assert_eq!(files::commit_workbook(&target, b"complete", &mut || Ok(()), &files::RealFs).unwrap(), None);
    assert_eq!(std::fs::read_to_string(&f.target).unwrap(), "complete");
}

/// 書込・新規確定を、指定した種類のOSエラーで1回失敗させる（権限拒否・容量不足・同名ファイルの出現など）。
struct FailWith { write: Option<std::io::ErrorKind>, publish: Option<std::io::ErrorKind> }
impl files::FileOps for FailWith {
    fn write(&self, file: &mut std::fs::File, bytes: &[u8]) -> std::io::Result<()> {
        match self.write { Some(kind) => Err(std::io::Error::from(kind)), None => std::io::Write::write_all(file, bytes) }
    }
    fn publish_new(&self, from: &Path, to: &Path) -> std::io::Result<files::Published> {
        match self.publish { Some(kind) => Err(std::io::Error::from(kind)), None => files::publish_new(from, to) }
    }
}

#[test]
fn reports_permission_capacity_and_collision_failures_of_a_new_output_as_errors_without_leaving_files() {
    use std::io::ErrorKind::{AlreadyExists, PermissionDenied, StorageFull};
    for ops in [
        FailWith { write: Some(StorageFull), publish: None }, FailWith { write: Some(PermissionDenied), publish: None },
        FailWith { write: None, publish: Some(PermissionDenied) }, FailWith { write: None, publish: Some(StorageFull) }, FailWith { write: None, publish: Some(AlreadyExists) },
    ] {
        let f = fixture();
        let target = files::inspect_destination(&f.target, &[], ".xlsx").unwrap();
        let error = files::commit_workbook(&target, b"complete", &mut || Ok(()), &ops).unwrap_err();
        assert!(matches!(&error, Error::Other(message) if message.starts_with("io:")), "{:?}/{:?}: {error:?}", ops.write, ops.publish);
        assert!(!f.target.exists());
        assert_eq!(f.names(), vec!["database".to_string()], "{:?}/{:?}", ops.write, ops.publish);
    }
}

/// 出力先の名前に（壊れた）シンボリックリンクがあると、新規として扱っても確定は失敗し、リンク先を作らない。
#[cfg(unix)]
#[test]
fn never_follows_or_replaces_a_symbolic_link_at_the_destination_name() {
    let f = fixture();
    let elsewhere = f.root.path().join("database").join("リンク先.xlsx");
    std::os::unix::fs::symlink(&elsewhere, &f.target).unwrap();
    // リンク先がない（壊れた）リンクは「出力先なし」と判定されるが、確定はリンクを置き換えず、リンク先も作らない。
    let target = files::inspect_destination(&f.target, &[], ".xlsx").unwrap();
    assert_eq!(target.original, None);
    assert!(files::commit_workbook(&target, b"complete", &mut || Ok(()), &files::RealFs).is_err());
    assert!(!elsewhere.exists());
    assert_eq!(std::fs::read_link(&f.target).unwrap(), elsewhere);
    // リンク先があるリンクは、上書きの対象として受け付けない。
    std::fs::write(&elsewhere, "LINKED-KEEP").unwrap();
    match files::inspect_destination(&f.target, &[], ".xlsx") { Err(Error::ExportFile(message)) if message == DESTINATION_FAIL => {} other => panic!("{other:?}") }
    assert_eq!(std::fs::read_to_string(&elsewhere).unwrap(), "LINKED-KEEP");
    assert!(f.names().iter().all(|name| !OWN_TEMP.is_match(name)), "{:?}", f.names());
}

#[test]
fn the_platform_publication_is_a_move_on_windows_and_a_hard_link_elsewhere() {
    let dir = tempfile::tempdir().unwrap();
    let (from, to) = (dir.path().join(".parts-order-x.tmp"), dir.path().join("架空 出力.pdf"));
    std::fs::write(&from, b"complete").unwrap();
    std::fs::write(&to, b"existing").unwrap();
    // 出力先が既にあれば失敗し、置き換えない。
    assert_eq!(files::publish_new(&from, &to).unwrap_err().kind(), std::io::ErrorKind::AlreadyExists);
    assert_eq!(std::fs::read(&to).unwrap(), b"existing");
    std::fs::remove_file(&to).unwrap();
    let published = files::publish_new(&from, &to).unwrap();
    assert_eq!(std::fs::read(&to).unwrap(), b"complete");
    if cfg!(windows) {
        assert_eq!(published, files::Published::Moved);
        assert!(!from.exists());
    } else {
        assert_eq!(published, files::Published::Linked);
        assert_eq!(std::fs::read(&from).unwrap(), b"complete");
    }
}

#[test]
fn app_reports_an_injected_publication_failure_without_creating_the_output_and_retries() {
    let f = fixture();
    f.fail_once("publish");
    assert_match(&f.export_default(&f.request), json!({ "status": "error", "code": "IO" }));
    assert!(!f.target.exists());
    assert!(f.names().iter().all(|name| !OWN_TEMP.is_match(name)), "{:?}", f.names());
    assert_match(&f.export_default(&f.request), json!({ "status": "ok", "cleanup": null }));
    assert_eq!(f.read_target(), build_workbook(&f.saved_model(1)).unwrap());
    assert_eq!(pom_core::fsx::lstat(&f.target).unwrap().nlink, 1);
    assert!(f.names().iter().all(|name| !OWN_TEMP.is_match(name)), "{:?}", f.names());
}

#[test]
fn rejects_protected_paths_and_hardlink_aliases_without_modifying_data() {
    let f = fixture();
    let database = f.root.path().join("database");
    let protected_file = database.join("test.xlsx");
    std::fs::write(&protected_file, "protected").unwrap();
    let alias = f.root.path().join("alias.xlsx");
    std::fs::hard_link(&protected_file, &alias).unwrap();
    let names = [protected_file.clone(), alias, f.root.path().join("A 部品発注書 2026-latest.xlsx"), f.root.path().join("CON.xlsx"), f.root.path().join("file.xlsx:stream")];
    for name in names {
        match files::inspect_destination(&name, std::slice::from_ref(&database), ".xlsx") {
            Err(Error::ExportFile(message)) if message == DESTINATION_FAIL => {}
            other => panic!("{}: expected the destination ExportFileError, got {other:?}", name.display()),
        }
    }
    assert_eq!(std::fs::read_to_string(&protected_file).unwrap(), "protected");
}

#[test]
fn refuses_renderer_supplied_paths_drafts_obsolete_revision_and_invalid_ids() {
    let f = fixture();
    let mut with_path = f.request.clone();
    with_path["path"] = json!(f.target.to_string_lossy());
    let mut with_draft = f.request.clone();
    with_draft["draft"] = f.draft.clone();
    let mut obsolete = f.request.clone();
    obsolete["revision"] = json!(0);
    for request in [with_path, with_draft, json!({ "documentId": "invalid", "revision": 1 }), obsolete] {
        assert_match(&f.export_default(&request), json!({ "status": "error", "code": "VALIDATION" }));
    }
    f.save_next();
    assert_match(&f.export_default(&f.request), json!({ "status": "error", "code": "CONFLICT" }));
    assert!(!f.target.exists());
}

static OWN_TEMP: LazyLock<Regex> = LazyLock::new(|| Regex::new(r"^\.parts-order-").unwrap());

// 新規出力の確定後に一時ファイルが残るのは、ハードリンクで確定する Windows 以外だけ（Windows は移動で確定し、一時ファイルが残らない）。
#[cfg(not(windows))]
#[test]
fn identifies_only_its_leftover_temp_after_commit_and_recovers_without_removing_the_completed_xlsx() {
    let f = fixture();
    let expected = build_workbook(&f.saved_model(1)).unwrap();
    let unrelated = f.root.path().join("unrelated.tmp");
    std::fs::write(&unrelated, "KEEP").unwrap();
    f.fail_once("unlink");
    let result = f.export_default(&f.request);
    f.restore();
    assert_eq!(result["status"], "ok");
    assert!(result["cleanup"]["temporaryName"].is_string(), "{result}");
    let names: Vec<String> = f.names().into_iter().filter(|name| OWN_TEMP.is_match(name)).collect();
    assert_eq!(names.len(), 1);
    assert_match(&result, json!({ "cleanup": { "temporaryName": names[0] } }));
    assert_eq!(f.read_target(), expected);
    assert_eq!(pom_core::fsx::lstat(&f.target).unwrap().nlink, 2);
    assert_eq!(f.export_default(&f.request)["status"], "error");
    std::fs::remove_file(f.root.path().join(&names[0])).unwrap();
    assert_eq!(f.export_default(&f.request)["status"], "ok");
    assert_eq!(f.read_target(), expected);
    assert_eq!(std::fs::read_to_string(&unrelated).unwrap(), "KEEP");
}

#[cfg(windows)]
#[test]
fn moves_a_new_output_into_place_so_nothing_is_left_to_clean_up_even_if_deletion_would_fail() {
    let f = fixture();
    let expected = build_workbook(&f.saved_model(1)).unwrap();
    f.fail_once("unlink");
    assert_match(&f.export_default(&f.request), json!({ "status": "ok", "cleanup": null }));
    // 一時ファイルを消す必要がないため、差し込んだ削除の失敗は使われずに残る。
    assert_eq!(*f.host.faults.lock().unwrap(), vec!["unlink"]);
    f.restore();
    assert!(f.names().iter().all(|name| !OWN_TEMP.is_match(name)), "{:?}", f.names());
    assert_eq!(f.read_target(), expected);
    assert_eq!(pom_core::fsx::lstat(&f.target).unwrap().nlink, 1);
}

#[test]
fn identifies_precommit_cleanup_failure_after_write_or_rename_without_changing_old_output() {
    for operation in ["write", "rename"] {
        let f = fixture();
        let old = build_workbook(&f.saved_model(1)).unwrap();
        std::fs::write(&f.target, &old).unwrap();
        let receipt = f.save_next();
        f.fail_once(operation);
        f.fail_once("unlink");
        let request = request_json(&receipt.document_id, receipt.revision);
        let result = f.export_default(&request);
        f.restore();
        assert_eq!(result["status"], "error", "{operation}");
        assert!(result["cleanup"]["temporaryName"].is_string(), "{operation}: {result}");
        let name = f.names().into_iter().find(|name| OWN_TEMP.is_match(name)).expect("Missing temp");
        assert_match(&result, json!({ "cleanup": { "temporaryName": name } }));
        assert_eq!(f.read_target(), old, "{operation}");
        std::fs::remove_file(f.root.path().join(&name)).unwrap();
        assert_eq!(f.export_default(&request)["status"], "ok", "{operation}");
        assert_eq!(f.read_target(), build_workbook(&f.saved_model(receipt.revision)).unwrap(), "{operation}");
    }
}
