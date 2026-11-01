//! 画面とアプリ本体（pom-core）の間をつなぐ部分。旧 Electron の Main プロセスのうち、ウィンドウ・ダイアログ・終了確認に当たる。

use std::collections::VecDeque;
use std::path::PathBuf;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex, OnceLock};

use pom_core::api::{App, BoxFuture, Host, MessageBox, MessageKind, OpenDialog, Parent, PrintSession, SaveDialog};
use serde_json::Value;
use tauri::{AppHandle, Emitter, Manager, Runtime, WebviewWindow, WebviewWindowBuilder};
use tokio::sync::Notify;

#[cfg(not(feature = "e2e"))]
use crate::dialogs;
use crate::paths::PRODUCT_NAME;

pub const MAIN: &str = "main";
pub const PREVIEW: &str = "preview";
const CLOSE_EVENT: &str = "documents:close-requested";
#[cfg_attr(not(windows), allow(dead_code))]
const DROP_LIMIT: usize = 16;

/// E2Eテスト用のビルド（Windows）では、ウィンドウを画面の外に置き、フォーカスも取らない（テスト中に利用者の作業を妨げない）。
/// 環境変数 POM_E2E_SHOW を設定すると、通常どおり画面に出して前面に出す（テストの様子を目で確かめるとき）。
pub fn background() -> bool { background_for(cfg!(all(windows, feature = "e2e")), std::env::var_os("POM_E2E_SHOW").is_some()) }
fn background_for(supported: bool, show: bool) -> bool { supported && !show }
/// 画面の外に置くときの左上の位置（物理座標。どのモニターの配置でも見えない遠さ）。
const OFFSCREEN: i32 = -30000;

/// ウィンドウの作成時の設定（background のときだけタスクバーに出さず、アクティブにならない）。
pub fn placed<'a, R: Runtime, M: Manager<R>>(builder: WebviewWindowBuilder<'a, R, M>) -> WebviewWindowBuilder<'a, R, M> {
    if background() { builder.skip_taskbar(true).focusable(false) } else { builder }
}

/// 作成したウィンドウを、表示する前に画面の外へ移す（background のときだけ）。
/// 作成時の位置指定（builder の position）は、どのモニターにも入らない位置だと Windows では既定の位置に戻されるため使わない。
pub fn move_offscreen<R: Runtime>(window: &WebviewWindow<R>) {
    if background() { let _ = window.set_position(tauri::PhysicalPosition::new(OFFSCREEN, OFFSCREEN)); }
}

/// ウィンドウがどれかのモニターに少しでも掛かっているか（E2Eテストの確認用）。
#[cfg(feature = "e2e")]
fn on_screen<R: Runtime>(window: &WebviewWindow<R>) -> bool {
    let (Ok(position), Ok(size), Ok(monitors)) = (window.outer_position(), window.outer_size(), window.available_monitors()) else { return true };
    let (left, top, right, bottom) = (position.x, position.y, position.x + size.width as i32, position.y + size.height as i32);
    monitors.iter().any(|m| { let (p, s) = (m.position(), m.size()); left < p.x + s.width as i32 && p.x < right && top < p.y + s.height as i32 && p.y < bottom })
}

/// ウィンドウを前面に出す（background のときは出さない）。
pub fn bring_to_front<R: Runtime>(window: &WebviewWindow<R>) { if !background() { let _ = window.set_focus(); } }

/// 開いている印刷プレビュー。
pub struct OpenPreview {
    pub session: Arc<PrintSession>,
    pub closed: Option<tokio::sync::oneshot::Sender<()>>,
    pub loaded: Vec<tokio::sync::oneshot::Sender<()>>,
    pub shown: bool,
}

pub struct Shell {
    pub app: AppHandle,
    /// メイン画面の URL（最初に読み込んだアプリのページ。要求元の確認に使う。旧版の app://desktop/index.html に当たる）
    app_url: OnceLock<String>,
    /// WebView2 のデータの場所（メイン画面と印刷プレビューで同じにする）
    pub webview_data: PathBuf,
    pub core: OnceLock<Arc<App>>,
    unresponsive: AtomicBool,
    asking: AtomicBool,
    drops: Mutex<VecDeque<(String, String)>>,
    dropped: Notify,
    pub preview: Mutex<Option<OpenPreview>>,
    #[cfg(feature = "e2e")]
    pub script: crate::e2e::Script,
    /// E2Eテスト: 次の要求を「信頼できない送信元」（旧版の別ウィンドウ）からのものとして扱う。
    #[cfg(feature = "e2e")]
    pub untrusted: AtomicBool,
}

impl Shell {
    pub fn new(app: AppHandle, webview_data: PathBuf) -> Arc<Shell> {
        Arc::new(Shell {
            app, app_url: OnceLock::new(), webview_data, core: OnceLock::new(), unresponsive: AtomicBool::new(false), asking: AtomicBool::new(false),
            drops: Mutex::new(VecDeque::new()), dropped: Notify::new(), preview: Mutex::new(None),
            #[cfg(feature = "e2e")]
            script: crate::e2e::Script::default(),
            #[cfg(feature = "e2e")]
            untrusted: AtomicBool::new(false),
        })
    }

    pub fn core(&self) -> Option<&Arc<App>> { self.core.get() }

    /// メイン画面の移動の可否。最初の読込（アプリのページ）と、その再読込だけを許す。
    pub fn allow_navigation(&self, url: &tauri::Url) -> bool { self.app_url.get_or_init(|| url.to_string()) == url.as_str() }

    pub fn is_app_url(&self, url: &str) -> bool { self.app_url.get().is_some_and(|app| app == url) }

    pub fn main_window(&self) -> Option<WebviewWindow> { self.app.get_webview_window(MAIN) }

    #[cfg_attr(feature = "e2e", allow(dead_code))]
    fn window(&self, parent: Parent) -> Option<WebviewWindow> { self.app.get_webview_window(match parent { Parent::Main => MAIN, Parent::Preview => PREVIEW }) }

    // ---- 画面の応答・停止 ----

    pub fn set_responsive(&self, responsive: bool) { self.unresponsive.store(!responsive, Ordering::SeqCst); }

    /// 画面プロセスが止まった（旧版の render-process-gone）。通知してからアプリを終える。
    #[cfg_attr(not(any(windows, feature = "e2e")), allow(dead_code))]
    pub fn renderer_gone(self: &Arc<Self>) {
        let Some(core) = self.core() else { return };
        if core.is_closing() { return; }
        core.force_closing();
        let shell = self.clone();
        std::thread::spawn(move || {
            shell.error_box("画面が停止しました", "画面の処理が異常終了したため、アプリを終了します。保存済みの内容は保持されています。もう一度起動してください。");
            shell.destroy_windows();
        });
    }

    #[cfg_attr(not(any(windows, feature = "e2e")), allow(dead_code))]
    pub fn error_box(&self, title: &str, message: &str) {
        #[cfg(feature = "e2e")]
        self.script.error_box(title, message);
        #[cfg(not(feature = "e2e"))]
        dialogs::error_box(title, message);
    }

    pub fn destroy_windows(&self) {
        for window in self.app.webview_windows().into_values() { let _ = window.destroy(); }
    }

    /// メインウィンドウを閉じようとしたとき（旧版の window の 'close'）。閉じてよければ true。
    pub fn close_requested(self: &Arc<Self>) -> bool {
        let Some(core) = self.core().cloned() else { return true };
        if core.is_closing() { return true; }
        if self.unresponsive.load(Ordering::SeqCst) {
            // 画面が終了確認に応答できない状態でも閉じられるようにする。
            if !self.asking.swap(true, Ordering::SeqCst) {
                let shell = self.clone();
                tauri::async_runtime::spawn(async move {
                    let answer = ShellHost(shell.clone()).message_box(Parent::Main, MessageBox {
                        kind: MessageKind::Warning, title: Some(PRODUCT_NAME.into()), message: "画面が応答していません。".into(),
                        detail: Some("強制終了すると、保存前の入力は失われます。保存済みの内容は保持されます。".into()),
                        buttons: vec!["待つ".into(), "強制終了".into()], default_id: 0, cancel_id: 0,
                    }).await;
                    if answer == 1 { core.force_closing(); shell.destroy_windows(); }
                    shell.asking.store(false, Ordering::SeqCst);
                });
            }
            return false;
        }
        core.request_close()
    }

    // ---- ドロップしたファイル ----

    #[cfg_attr(not(any(windows, feature = "e2e")), allow(dead_code))]
    pub fn register_drop(&self, token: String, path: String) {
        let mut drops = self.drops.lock().unwrap_or_else(|e| e.into_inner());
        drops.push_back((token, path));
        while drops.len() > DROP_LIMIT { drops.pop_front(); }
        drop(drops);
        self.dropped.notify_waiters();
    }

    fn take_drop(&self, token: &str) -> Option<String> {
        let mut drops = self.drops.lock().unwrap_or_else(|e| e.into_inner());
        let index = drops.iter().position(|(t, _)| t == token)?;
        drops.remove(index).map(|(_, path)| path)
    }

    /// ドロップの受付番号を場所に置き換える。画面からは場所を直接渡せない（旧版で preload だけが場所を取り出していたのと同じ）。
    async fn dropped_path(&self, token: &Value) -> Value {
        let Some(token) = token.as_str().filter(|t| !t.is_empty()) else { return Value::String(String::new()) };
        // ファイルの通知（WebMessage）と要求（IPC）は別の経路で届くので、少しだけ通知を待つ。
        for _ in 0..20 {
            let notified = self.dropped.notified();
            if let Some(path) = self.take_drop(token) { return Value::String(path); }
            let _ = tokio::time::timeout(std::time::Duration::from_millis(100), notified).await;
        }
        Value::String(self.take_drop(token).unwrap_or_default())
    }

    /// 画面からの要求（旧版の ipcRenderer.invoke）。
    pub async fn ipc(self: &Arc<Self>, channel: String, mut args: Vec<Value>) -> Result<Value, String> {
        let core = self.core().cloned().ok_or("App is not ready")?;
        // 要求が届くのは画面が動いている証拠。
        self.set_responsive(true);
        match (channel.as_str(), args.len()) {
            // 画面の window.close()（旧版ではウィンドウの 'close' と同じ扱い）
            ("window:close", 0) => { if let Some(window) = self.main_window() { let _ = window.close(); } return Ok(Value::Null); }
            ("imports:choose-from-path", 1) => { args[0] = self.dropped_path(&args[0]).await; }
            ("reimport:choose-from-path", 2) => { args[1] = self.dropped_path(&args[1]).await; }
            _ => {}
        }
        #[cfg(feature = "e2e")]
        if let Some(plan) = self.script.plan(&channel, &args) {
            use crate::e2e::Plan;
            let pause = |ms: u64| async move { if ms > 0 { tokio::time::sleep(std::time::Duration::from_millis(ms)).await; } };
            return match plan {
                Plan::Reject => Err(format!("No handler registered for '{channel}'")),
                Plan::Replace { value, hold, delay_ms } => { if let Some(name) = hold { self.script.wait(&name).await; } pause(delay_ms).await; Ok(value) }
                Plan::Call { hold, hold_before, drop_reply, delay_ms } => {
                    if hold_before { if let Some(name) = &hold { self.script.wait(name).await; } }
                    let result = core.invoke(&channel, args).await;
                    if !hold_before { if let Some(name) = &hold { self.script.wait(name).await; } }
                    pause(delay_ms).await;
                    if drop_reply { return Err("fictional lost reply after commit".into()); }
                    result
                }
            };
        }
        core.invoke(&channel, args).await
    }
}

/// pom-core から見た OS・ウィンドウ。
pub struct ShellHost(pub Arc<Shell>);

impl Host for ShellHost {
    #[cfg(not(feature = "e2e"))]
    fn open_file(&self, parent: Parent, dialog: OpenDialog) -> BoxFuture<'_, Option<PathBuf>> {
        Box::pin(dialogs::open_file(&self.0.app, self.0.window(parent), dialog.title, dialog.filters))
    }
    #[cfg(feature = "e2e")]
    fn open_file(&self, parent: Parent, dialog: OpenDialog) -> BoxFuture<'_, Option<PathBuf>> {
        Box::pin(async move {
            let answer = self.0.script.dialog("open", serde_json::json!({ "title": dialog.title, "filters": dialog.filters.iter().map(|f| &f.name).collect::<Vec<_>>(), "parent": format!("{parent:?}") })).await;
            answer.as_str().map(PathBuf::from)
        })
    }

    #[cfg(not(feature = "e2e"))]
    fn save_file(&self, parent: Parent, dialog: SaveDialog) -> BoxFuture<'_, Option<PathBuf>> {
        Box::pin(dialogs::save_file(&self.0.app, self.0.window(parent), dialog.title, dialog.default_path, dialog.filters))
    }
    #[cfg(feature = "e2e")]
    fn save_file(&self, parent: Parent, dialog: SaveDialog) -> BoxFuture<'_, Option<PathBuf>> {
        Box::pin(async move {
            let answer = self.0.script.dialog("save", serde_json::json!({ "title": dialog.title, "defaultPath": dialog.default_path, "filters": dialog.filters.iter().map(|f| &f.name).collect::<Vec<_>>(), "parent": format!("{parent:?}") })).await;
            answer.as_str().map(PathBuf::from)
        })
    }

    #[cfg(not(feature = "e2e"))]
    fn message_box(&self, parent: Parent, dialog: MessageBox) -> BoxFuture<'_, usize> {
        Box::pin(dialogs::message_box(&self.0.app, self.0.window(parent), dialog))
    }
    #[cfg(feature = "e2e")]
    fn message_box(&self, parent: Parent, dialog: MessageBox) -> BoxFuture<'_, usize> {
        Box::pin(async move {
            let answer = self.0.script.dialog("message", serde_json::json!({ "title": dialog.title, "message": dialog.message, "detail": dialog.detail, "buttons": dialog.buttons, "parent": format!("{parent:?}") })).await;
            answer.as_u64().map(|n| n as usize).unwrap_or(dialog.cancel_id)
        })
    }

    fn sender_trusted(&self) -> bool {
        #[cfg(feature = "e2e")]
        if self.0.untrusted.load(Ordering::SeqCst) { return false; }
        self.0.main_window().and_then(|window| window.url().ok()).is_some_and(|url| self.0.is_app_url(url.as_str()))
    }

    // 受け手はメイン画面だけ（印刷プレビューはスクリプト無効）。
    fn emit_close_requested(&self, token: &str) { let _ = self.0.app.emit(CLOSE_EVENT, token); }

    fn close_main_window(&self) { if let Some(window) = self.0.main_window() { let _ = window.close(); } }

    fn quit_after_restore(&self) {
        self.0.destroy_windows();
        self.0.app.exit(0);
    }

    fn preview_url(&self, id: &str) -> String {
        if cfg!(windows) { format!("http://print.localhost/{id}") } else { format!("print://localhost/{id}") }
    }

    fn open_print_preview(&self, session: Arc<PrintSession>) -> BoxFuture<'_, Result<(), String>> {
        Box::pin(crate::preview::open(self.0.clone(), session))
    }

    #[cfg(feature = "e2e")]
    fn fault(&self, point: &str) -> bool { self.0.script.fault(point) }
}

/// 画面からの要求の入口（メインウィンドウだけに許可。capabilities/main.json）。
#[tauri::command]
pub async fn ipc(webview: tauri::Webview, shell: tauri::State<'_, Arc<Shell>>, channel: String, args: Vec<Value>) -> Result<Value, String> {
    if webview.label() != MAIN { return Err("IPC_REQUEST_REJECTED".into()); }
    shell.inner().ipc(channel, args).await
}

/// E2Eテストの操作（`--features e2e` のビルドだけ）。
#[cfg(feature = "e2e")]
#[tauri::command]
pub async fn e2e(webview: tauri::Webview, shell: tauri::State<'_, Arc<Shell>>, request: Value) -> Result<Value, String> {
    if webview.label() != MAIN { return Err("E2E_REQUEST_REJECTED".into()); }
    let shell = shell.inner().clone();
    match request["op"].as_str().unwrap_or("") {
        "close" => { if let Some(window) = shell.main_window() { let _ = window.close(); } Ok(Value::Null) }
        "destroy" => { shell.destroy_windows(); Ok(Value::Null) }
        "exit" => { shell.app.exit(request["code"].as_i64().unwrap_or(0) as i32); Ok(Value::Null) }
        "unresponsive" => { shell.set_responsive(!request["value"].as_bool().unwrap_or(true)); Ok(Value::Null) }
        "crash" => {
            #[cfg(windows)]
            if let Some(window) = shell.main_window() { crate::win::crash_renderer(&window); }
            #[cfg(not(windows))]
            shell.renderer_gone();
            Ok(Value::Null)
        }
        "windows" => Ok(Value::Array(shell.app.webview_windows().values().map(|w| serde_json::json!({ "label": w.label(), "url": w.url().map(|u| u.to_string()).unwrap_or_default(), "enabled": w.is_enabled().unwrap_or(true), "visible": w.is_visible().unwrap_or(false), "focused": w.is_focused().unwrap_or(false), "onScreen": on_screen(w) })).collect())),
        "preview-navigate" => {
            // 印刷プレビューのページ内リンク（{url}/save など）を押したときと同じ移動を起こす（WebDriver からプレビューを操作できない環境用）。
            let window = shell.app.get_webview_window(PREVIEW).ok_or("preview is not open")?;
            let base = shell.preview.lock().unwrap_or_else(|e| e.into_inner()).as_ref().map(|open| open.session.url.clone()).ok_or("preview is not open")?;
            let url = tauri::Url::parse(&format!("{base}/{}", request["name"].as_str().unwrap_or(""))).map_err(|e| e.to_string())?;
            window.navigate(url).map_err(|e| e.to_string())?;
            Ok(Value::Null)
        }
        "drop" => { shell.register_drop(request["token"].as_str().unwrap_or("").into(), request["path"].as_str().unwrap_or("").into()); Ok(Value::Null) }
        "untrusted-ipc" => {
            // 旧版テストの「別ウィンドウからの要求」。要求1つだけを信頼できない送信元として処理する。
            let args = request["args"].as_array().cloned().unwrap_or_default();
            shell.untrusted.store(true, Ordering::SeqCst);
            let result = shell.ipc(request["channel"].as_str().unwrap_or("").to_string(), args).await;
            shell.untrusted.store(false, Ordering::SeqCst);
            Ok(match result { Ok(value) => serde_json::json!({ "value": value }), Err(error) => serde_json::json!({ "rejected": error }) })
        }
        "info" => Ok(serde_json::json!({ "pid": std::process::id(), "appUrl": shell.app_url.get(), "webviewData": shell.webview_data })),
        _ => shell.script.control(&request),
    }
}

/// 起動時のエラー文言（旧版: DB のエラーはその文言、それ以外は共通の案内）。
pub fn startup_message(error: &pom_core::Error) -> String {
    match error {
        pom_core::Error::Db(_, message) => message.clone(),
        _ => "アプリを終了して、もう一度起動してください。DBを削除せず、保存場所・空き容量・配布ファイルを確認してください。".into(),
    }
}

#[cfg(test)]
mod tests {
    use super::background_for;

    #[test]
    fn windows_stay_in_the_background_only_for_supported_builds_unless_shown() {
        assert!(background_for(true, false));
        assert!(!background_for(true, true));
        assert!(!background_for(false, false));
        assert!(!background_for(false, true));
    }
}
