//! tests/unit/security.test.ts のうち、pom-core に対応する部分の移植。
//!
//! 移植したもの: describe('app.info boundary')（`assertInfoRequest`）。Rust では `App::invoke("app:info", args)` が
//! 「送信元が信頼できる（Host::sender_trusted）」かつ「引数が 0 個」のときだけ応答し、それ以外は
//! 'APP_INFO_REQUEST_REJECTED' で拒否する。送信元のフレームURLが APP_URL と完全一致するかの判定は Tauri 側の Host
//! （src-tauri/src/host.rs の sender_trusted → is_app_url）に移ったため、ここでは URL の不一致を「信頼できない送信元」として確かめる。
//!
//! 移植しないもの（Electron 専用で、Rust の設計には存在しない）:
//! - describe('static assets')（staticAssetPath: app:// プロトコルの静的ファイル解決。Tauri の資源配信が担う）
//! - describe('network and CSP') の 2 件（isAllowedRequest・contentSecurityPolicy・getDevelopmentOrigin:
//!   Electron の要求フィルタと開発サーバーの検証。CSP は tauri.conf.json の app.security.csp に移った）

use std::future::Future;
use std::path::PathBuf;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;
use std::task::{Context, Poll, Waker};

use pom_core::api::{App, AppConfig, BoxFuture, Host, MessageBox, OpenDialog, Parent, PrintSession, SaveDialog};
use pom_core::db::Store;
use serde_json::{json, Value};
use tempfile::TempDir;

/// ダイアログを使わない最小の Host（送信元の信頼だけを切り替える）。
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
    fn open_print_preview(&self, _session: Arc<PrintSession>) -> BoxFuture<'_, Result<(), String>> { Box::pin(async { Err("print preview is not available in tests".to_string()) }) }
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
    let dir = tempfile::Builder::new().prefix("security-").tempdir().unwrap();
    let user_data = dir.path().to_path_buf();
    let store = Store::open_default(&user_data.join("database")).unwrap();
    let host = Arc::new(TestHost { trusted: AtomicBool::new(true) });
    let config = AppConfig { user_data: user_data.clone(), documents_dir: user_data.clone(), protected_roots: vec![user_data], version: "0.1.0".into(), recovery_notice: None };
    (App::new(config, store, host.clone()), host, dir)
}

fn info(app: &Arc<App>, args: Vec<Value>) -> Result<Value, String> { block_on(app.invoke("app:info", args)) }

#[test]
fn app_info_accepts_only_the_trusted_main_frame_at_the_exact_document_with_zero_arguments() {
    let (app, host, _dir) = app();
    // assertInfoRequest(true, APP_URL, APP_URL, []) は通る。
    assert!(info(&app, vec![]).is_ok());
    // 送信元のフレームURLが APP_URL と一致しない（undefined・別オリジン・別ページ・#付き）、または送信元が信頼できない。
    host.trusted.store(false, Ordering::SeqCst);
    assert_eq!(info(&app, vec![]), Err("APP_INFO_REQUEST_REJECTED".to_string()));
    // 引数がある（[{}]）。
    host.trusted.store(true, Ordering::SeqCst);
    assert_eq!(info(&app, vec![json!({})]), Err("APP_INFO_REQUEST_REJECTED".to_string()));
    app.shutdown();
}

#[test]
fn category_candidates_require_a_trusted_sender_one_argument_and_valid_input() {
    let (app, host, _dir) = app();
    let call = |args: Vec<Value>| block_on(app.invoke("materials:categories", args)).expect("handler");
    let valid = json!({ "query": "", "includeInactive": false, "offset": 0 });
    assert_eq!(call(vec![valid.clone()]), json!({ "status": "ok", "data": { "rows": [], "total": 0, "categoryTotal": 0, "materialCount": 0 } }));
    for args in [vec![], vec![valid.clone(), json!(1)], vec![json!({ "query": "", "includeInactive": false, "offset": 0, "path": "C:/x" })]] {
        let reply = call(args);
        assert_eq!((reply["status"].as_str(), reply["code"].as_str()), (Some("error"), Some("VALIDATION")), "{reply}");
    }
    host.trusted.store(false, Ordering::SeqCst);
    assert_eq!(call(vec![valid])["status"], "error");
    app.shutdown();
}

#[test]
fn document_delete_requires_a_trusted_sender_and_valid_ids_and_forgets_export_records() {
    let (app, host, _dir) = app();
    let call = |args: Vec<Value>| block_on(app.invoke("documents:delete", args)).expect("handler");
    let id = pom_core::js::random_uuid();
    app.meta().record_export(&id, 1);
    for args in [vec![], vec![json!([])], vec![json!([id.clone(), id.clone()])], vec![json!(["C:/x"])], vec![json!([id.clone()]), json!(1)]] {
        let reply = call(args);
        assert_eq!((reply["status"].as_str(), reply["code"].as_str()), (Some("error"), Some("VALIDATION")), "{reply}");
    }
    host.trusted.store(false, Ordering::SeqCst);
    let reply = call(vec![json!([id.clone()])]);
    assert_eq!((reply["status"].as_str(), reply["message"].as_str()), (Some("error"), Some("請求書を削除できませんでした。削除はしていません。保存場所を確認して再試行してください。")));
    assert!(app.meta().export_of(&id).is_some());
    host.trusted.store(true, Ordering::SeqCst);
    assert_eq!(call(vec![json!([id.clone()])]), json!({ "status": "ok", "data": { "deleted": 0 } }));
    assert!(app.meta().export_of(&id).is_none());
    app.shutdown();
}

#[test]
fn material_delete_requires_a_trusted_sender_and_valid_ids_and_reports_that_nothing_was_deleted() {
    let (app, host, _dir) = app();
    let call = |args: Vec<Value>| block_on(app.invoke("master:delete", args)).expect("handler");
    let id = pom_core::js::random_uuid();
    for args in [vec![], vec![json!([])], vec![json!([id.clone(), id.clone()])], vec![json!(["C:/x"])], vec![json!([id.clone()]), json!(1)], vec![json!({ "ids": [id.clone()] })]] {
        let reply = call(args);
        assert_eq!((reply["status"].as_str(), reply["code"].as_str(), reply["message"].as_str()), (Some("error"), Some("VALIDATION"), Some("削除する材料を選び直してください。")), "{reply}");
    }
    host.trusted.store(false, Ordering::SeqCst);
    let reply = call(vec![json!([id.clone()])]);
    assert_eq!((reply["status"].as_str(), reply["code"].as_str(), reply["message"].as_str()), (Some("error"), Some("DB"), Some("材料を削除できませんでした。削除はしていません。保存場所を確認して再試行してください。")));
    host.trusted.store(true, Ordering::SeqCst);
    assert_eq!(call(vec![json!([id])]), json!({ "status": "ok", "data": { "deleted": 0 } }));
    app.shutdown();
}
