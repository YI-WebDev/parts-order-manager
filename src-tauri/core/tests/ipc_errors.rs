//! IPC のエラーの応答（形・コード・文言）をチャネルごとに固定する。
//! 系統ごとに形・コードがそろっていない現状（spec/03-ipc-api.md「応答の形」）をそのまま記録し、
//! 応答の組み立てを1か所にまとめる改修で変わらないことを確かめる。

use std::future::Future;
use std::path::PathBuf;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;
use std::task::{Context, Poll, Waker};

use pom_core::api::{App, AppConfig, BoxFuture, Channel, Host, MessageBox, OpenDialog, Parent, PrintSession, SaveDialog};
use pom_core::db::Store;
use serde_json::{json, Value};
use tempfile::TempDir;

struct TestHost { trusted: AtomicBool }

impl Host for TestHost {
    fn open_file(&self, _parent: Parent, _dialog: OpenDialog) -> BoxFuture<'_, Option<PathBuf>> { Box::pin(async { None }) }
    fn save_file(&self, _parent: Parent, _dialog: SaveDialog) -> BoxFuture<'_, Option<PathBuf>> { Box::pin(async { None }) }
    fn message_box(&self, _parent: Parent, dialog: MessageBox) -> BoxFuture<'_, usize> { Box::pin(async move { dialog.cancel_id }) }
    fn sender_trusted(&self) -> bool { self.trusted.load(Ordering::SeqCst) }
    fn emit_close_requested(&self, _token: &str) {}
    fn close_main_window(&self) {}
    fn quit_after_restore(&self) {}
    fn preview_url(&self, id: &str) -> String { format!("app://print/{id}") }
    fn open_print_preview(&self, _session: Arc<PrintSession>) -> BoxFuture<'_, Result<(), String>> { Box::pin(async { Err("not available in tests".to_string()) }) }
}

fn block_on<F: Future>(future: F) -> F::Output {
    let mut future = std::pin::pin!(future);
    let mut context = Context::from_waker(Waker::noop());
    loop {
        if let Poll::Ready(value) = future.as_mut().poll(&mut context) { return value; }
        std::thread::yield_now();
    }
}

fn app() -> (Arc<App>, Arc<TestHost>, TempDir) {
    let dir = tempfile::Builder::new().prefix("ipc-errors-").tempdir().unwrap();
    let user_data = dir.path().to_path_buf();
    let store = Store::open_default(&user_data.join("database")).unwrap();
    let host = Arc::new(TestHost { trusted: AtomicBool::new(true) });
    let config = AppConfig { user_data: user_data.clone(), documents_dir: user_data.clone(), protected_roots: vec![user_data], version: "0.1.0".into(), recovery_notice: None };
    (App::new(config, store, host.clone()), host, dir)
}

const IMPORT_GENERIC: &str = "処理できませんでした。ファイルや保存場所を確認し、履歴から再試行してください。";
const MASTER_GENERIC: &str = "処理できませんでした。入力と原記録は保持されています。保存場所を確認して再試行してください。";
const BACKUP_GENERIC: &str = "処理できませんでした。ほかの処理や印刷プレビューを閉じ、バックアップの形式・版・空き容量・保存先を確認してください。現在のDBは削除しないでください。";
const DOCUMENT_GENERIC: &str = "保存できませんでした。入力は保持されています。保存場所を確認して再試行してください。";

fn coded(code: &str, message: &str) -> Value { json!({ "status": "error", "code": code, "message": message }) }

/// correlationId は応答ごとに変わるので、UUID であることだけ確かめて取り除く。
fn without_correlation(mut reply: Value) -> Value {
    if let Some(object) = reply.as_object_mut() {
        if let Some(id) = object.remove("correlationId") { assert_eq!(id.as_str().map(str::len), Some(36), "{id}"); }
    }
    reply
}

#[test]
fn untrusted_sender_gets_each_family_own_error_shape() {
    let (app, host, _dir) = app();
    host.trusted.store(false, Ordering::SeqCst);
    let uuid = pom_core::js::random_uuid();
    let call = |channel: &str, args: Vec<Value>| without_correlation(block_on(app.invoke(channel, args)).expect(channel));
    let no_code = |message: &str| json!({ "status": "error", "message": message });

    // バックアップ・印刷: code も correlationId もない
    for channel in ["backups:create", "backups:inspect"] { assert_eq!(call(channel, vec![]), no_code(BACKUP_GENERIC), "{channel}"); }
    assert_eq!(call("backups:restore", vec![json!(uuid)]), no_code(BACKUP_GENERIC));
    assert_eq!(call("backups:status", vec![]), no_code("最終バックアップ日時を確認できませんでした。"));
    assert_eq!(call("documents:print-preview", vec![json!({})]), no_code("印刷プレビューを開けませんでした。保存版・文字量・出力条件を確認してください。"));

    // 取込: 汎用の失敗は IO
    for (channel, args) in [("imports:choose", vec![]), ("imports:choose-from-path", vec![json!(1)]), ("imports:list", vec![]), ("imports:review", vec![json!(uuid)]), ("imports:apply", vec![json!({})]), ("imports:cancel", vec![json!(uuid)]), ("imports:resume", vec![json!(uuid)])] {
        assert_eq!(call(channel, args), coded("IO", IMPORT_GENERIC), "{channel}");
    }
    // 材料台帳・更新取込: 汎用の失敗は IO、削除だけ DB
    for (channel, args) in [("master:get", vec![json!(null)]), ("master:save", vec![json!({})]), ("reimport:series", vec![]), ("reimport:choose", vec![json!(uuid)]), ("reimport:choose-from-path", vec![json!(uuid), json!(1)]), ("reimport:list", vec![]), ("reimport:review", vec![json!(uuid)]), ("reimport:apply", vec![json!({})]), ("reimport:cancel", vec![json!(uuid)]), ("reimport:resume", vec![json!(uuid)])] {
        assert_eq!(call(channel, args), coded("IO", MASTER_GENERIC), "{channel}");
    }
    assert_eq!(call("master:delete", vec![json!([uuid])]), coded("DB", "材料を削除できませんでした。削除はしていません。保存場所を確認して再試行してください。"));
    // 検索: 汎用の失敗は DB
    assert_eq!(call("materials:search", vec![json!({})]), coded("DB", "検索できませんでした。もう一度検索してください。"));
    assert_eq!(call("materials:categories", vec![json!({})]), coded("DB", "カテゴリを読み込めませんでした。もう一度お試しください。"));
    // 請求書: 汎用の失敗は DB、削除だけ文言が違う
    for (channel, args) in [("documents:open", vec![json!({})]), ("documents:duplicate", vec![json!({})]), ("documents:list", vec![json!(0)]), ("documents:add-line", vec![json!({})]), ("documents:save", vec![json!({})]), ("documents:close", vec![json!(uuid)])] {
        assert_eq!(call(channel, args), coded("DB", DOCUMENT_GENERIC), "{channel}");
    }
    assert_eq!(call("documents:delete", vec![json!([uuid])]), coded("DB", "請求書を削除できませんでした。削除はしていません。保存場所を確認して再試行してください。"));
    // Excel出力: 受け付けない要求は VALIDATION
    assert_eq!(call("documents:export-excel", vec![json!({})]), coded("VALIDATION", "この画面からの出力要求は受け付けられません。"));
    // app:info だけは reject
    assert_eq!(block_on(app.invoke("app:info", vec![])), Err("APP_INFO_REQUEST_REJECTED".to_string()));
    app.shutdown();
}

#[test]
fn unknown_or_look_alike_channels_are_rejected_not_routed_to_a_handler() {
    let (app, _host, _dir) = app();
    for channel in ["", "imports", "imports:", "imports:unknown", "reimport:choose-from-pat", "documents:closed", "Documents:close", "master:apply", "backups:status "] {
        assert_eq!(block_on(app.invoke(channel, vec![])), Err(format!("No handler registered for '{channel}'")), "{channel:?}");
    }
    app.shutdown();
}

#[test]
fn channel_names_round_trip_and_cover_every_registered_channel() {
    let names = [
        "app:info", "backups:create", "backups:inspect", "backups:restore", "backups:status",
        "imports:choose", "imports:choose-from-path", "imports:list", "imports:review", "imports:apply", "imports:cancel", "imports:resume",
        "master:get", "master:save", "master:delete", "reimport:series", "reimport:choose", "reimport:choose-from-path", "reimport:list", "reimport:review", "reimport:apply", "reimport:cancel", "reimport:resume",
        "materials:search", "materials:categories",
        "documents:open", "documents:duplicate", "documents:list", "documents:delete", "documents:add-line", "documents:save", "documents:close", "documents:export-excel", "documents:print-preview",
    ];
    for name in names { assert_eq!(Channel::parse(name).map(Channel::name), Some(name), "{name}"); }
    assert_eq!(Channel::parse("documents:unknown"), None);
}
