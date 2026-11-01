//! E2Eテスト用の中継（`--features e2e` のときだけ作る。配布物には含めない）。
//!
//! WebView2 のない環境（Linux の CI など）で、同じ画面（dist）を Chromium から Playwright で操作するために、
//! アプリ本体（pom-core）と E2E の操作口（e2e.rs）を HTTP で提供する。画面側には Tauri の内部 API の代役（/__bridge.js）を入れ、
//! `invoke('ipc')`・`invoke('e2e')`・イベント（終了確認）を HTTP と Server-Sent Events で中継する。
//!
//! 起動: pom-bridge --user-data-dir=<フォルダー> --dist=<dist フォルダー> [--port=<番号>]
//! 起動後、標準出力に `listening <URL>` を1行出す。

use std::io::{BufRead, BufReader, Read, Write};
use std::net::{TcpListener, TcpStream};
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::mpsc;
use std::sync::{Arc, Mutex, OnceLock};

use parts_order_manager_lib::e2e::{Plan, Script};
use pom_core::api::{App, AppConfig, BoxFuture, Host, MessageBox, MessageKind, OpenDialog, Parent, PreviewWindow, PrintOutcome, PrintSession, SaveDialog};
use serde_json::{Value, json};
use tokio::sync::oneshot;

const SHIM: &str = include_str!("pom-bridge.js");
const CSP: &str = "default-src 'none'; script-src 'self'; style-src 'self'; img-src 'self'; font-src 'self'; connect-src 'self'; frame-src 'none'; frame-ancestors 'none'; object-src 'none'; base-uri 'none'; form-action 'none'; worker-src 'none'";

struct OpenPreview { session: Arc<PrintSession>, closed: Option<oneshot::Sender<()>> }

struct Bridge {
    script: Script,
    core: OnceLock<Arc<App>>,
    base: String,
    dist: PathBuf,
    listeners: Mutex<Vec<mpsc::Sender<String>>>,
    trusted: AtomicBool,
    untrusted: AtomicBool,
    unresponsive: AtomicBool,
    asking: AtomicBool,
    preview: Mutex<Option<OpenPreview>>,
}

impl Bridge {
    fn core(&self) -> Arc<App> { self.core.get().expect("core").clone() }

    fn broadcast(&self, event: &str, payload: Value) {
        let message = json!({ "event": event, "payload": payload }).to_string();
        self.listeners.lock().unwrap().retain(|listener| listener.send(message.clone()).is_ok());
    }

    /// アプリの終了（旧版のウィンドウ破棄 → 終了）。応答を返してから終える。
    fn exit_soon(&self, code: i32, shutdown: bool) {
        self.trusted.store(false, Ordering::SeqCst);
        let core = self.core.get().cloned();
        std::thread::spawn(move || {
            std::thread::sleep(std::time::Duration::from_millis(150));
            if shutdown { if let Some(core) = core { core.shutdown(); } }
            std::process::exit(code);
        });
    }

    /// ウィンドウを閉じる操作（旧版の BrowserWindow.close、Tauri 版の Shell::close_requested と同じ判断）。
    async fn close_requested(self: &Arc<Self>) {
        let core = self.core();
        if core.is_closing() { self.exit_soon(0, true); return; }
        if self.unresponsive.load(Ordering::SeqCst) {
            if self.asking.swap(true, Ordering::SeqCst) { return; }
            let answer = BridgeHost(self.clone()).message_box(Parent::Main, MessageBox {
                kind: MessageKind::Warning, title: Some("発注書管理".into()), message: "画面が応答していません。".into(),
                detail: Some("強制終了すると、保存前の入力は失われます。保存済みの内容は保持されます。".into()), buttons: vec!["待つ".into(), "強制終了".into()], default_id: 0, cancel_id: 0,
            }).await;
            if answer == 1 { core.force_closing(); self.exit_soon(0, true); }
            self.asking.store(false, Ordering::SeqCst);
            return;
        }
        if core.request_close() { self.exit_soon(0, true); }
    }

    async fn ipc(self: &Arc<Self>, channel: String, args: Vec<Value>) -> Result<Value, String> {
        let core = self.core();
        self.unresponsive.store(false, Ordering::SeqCst);
        if channel == "window:close" && args.is_empty() { self.close_requested().await; return Ok(Value::Null); }
        let mut args = args;
        // WebView2 のない環境ではドロップしたファイルの場所を取り出せない（Tauri 版の Linux と同じく空になる）。
        match (channel.as_str(), args.len()) {
            ("imports:choose-from-path", 1) => args[0] = Value::String(String::new()),
            ("reimport:choose-from-path", 2) => args[1] = Value::String(String::new()),
            _ => {}
        }
        if let Some(plan) = self.script.plan(&channel, &args) {
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

    async fn e2e(self: &Arc<Self>, request: Value) -> Result<Value, String> {
        match request["op"].as_str().unwrap_or("") {
            "close" => { let bridge = self.clone(); tokio::spawn(async move { bridge.close_requested().await }); Ok(Value::Null) }
            "destroy" => { self.exit_soon(0, true); Ok(Value::Null) }
            "exit" => { self.exit_soon(request["code"].as_i64().unwrap_or(0) as i32, true); Ok(Value::Null) }
            "unresponsive" => { self.unresponsive.store(request["value"].as_bool().unwrap_or(true), Ordering::SeqCst); Ok(Value::Null) }
            "crash" => {
                let core = self.core();
                if !core.is_closing() {
                    core.force_closing();
                    self.script.error_box("画面が停止しました", "画面の処理が異常終了したため、アプリを終了します。保存済みの内容は保持されています。もう一度起動してください。");
                    self.exit_soon(0, true);
                }
                Ok(Value::Null)
            }
            "windows" => {
                let mut windows = vec![json!({ "label": "main", "url": format!("{}/index.html", self.base), "enabled": true, "visible": true })];
                if let Some(open) = self.preview.lock().unwrap().as_ref() { windows.push(json!({ "label": "preview", "url": open.session.url, "enabled": true, "visible": true })); }
                Ok(Value::Array(windows))
            }
            "untrusted-ipc" => {
                let args = request["args"].as_array().cloned().unwrap_or_default();
                self.untrusted.store(true, Ordering::SeqCst);
                let result = self.ipc(request["channel"].as_str().unwrap_or("").to_string(), args).await;
                self.untrusted.store(false, Ordering::SeqCst);
                Ok(match result { Ok(value) => json!({ "value": value }), Err(error) => json!({ "rejected": error }) })
            }
            "info" => Ok(json!({ "pid": std::process::id(), "appUrl": format!("{}/index.html", self.base), "bridge": true })),
            _ => self.script.control(&request),
        }
    }

    fn preview_closed(&self) {
        if let Some(mut open) = self.preview.lock().unwrap().take() { if let Some(sender) = open.closed.take() { let _ = sender.send(()); } }
    }
}

struct BridgeHost(Arc<Bridge>);

impl Host for BridgeHost {
    fn open_file(&self, parent: Parent, dialog: OpenDialog) -> BoxFuture<'_, Option<PathBuf>> {
        Box::pin(async move { self.0.script.dialog("open", json!({ "title": dialog.title, "filters": dialog.filters.iter().map(|f| &f.name).collect::<Vec<_>>(), "parent": format!("{parent:?}") })).await.as_str().map(PathBuf::from) })
    }
    fn save_file(&self, parent: Parent, dialog: SaveDialog) -> BoxFuture<'_, Option<PathBuf>> {
        Box::pin(async move { self.0.script.dialog("save", json!({ "title": dialog.title, "defaultPath": dialog.default_path, "filters": dialog.filters.iter().map(|f| &f.name).collect::<Vec<_>>(), "parent": format!("{parent:?}") })).await.as_str().map(PathBuf::from) })
    }
    fn message_box(&self, parent: Parent, dialog: MessageBox) -> BoxFuture<'_, usize> {
        Box::pin(async move {
            let answer = self.0.script.dialog("message", json!({ "title": dialog.title, "message": dialog.message, "detail": dialog.detail, "buttons": dialog.buttons, "parent": format!("{parent:?}") })).await;
            answer.as_u64().map(|n| n as usize).unwrap_or(dialog.cancel_id)
        })
    }
    fn sender_trusted(&self) -> bool { self.0.trusted.load(Ordering::SeqCst) && !self.0.untrusted.load(Ordering::SeqCst) }
    fn emit_close_requested(&self, token: &str) { self.0.broadcast("documents:close-requested", Value::String(token.into())); }
    fn close_main_window(&self) { self.0.exit_soon(0, true); }
    fn quit_after_restore(&self) { self.0.exit_soon(0, false); }
    fn preview_url(&self, id: &str) -> String { format!("{}/print/{id}", self.0.base) }
    fn open_print_preview(&self, session: Arc<PrintSession>) -> BoxFuture<'_, Result<(), String>> {
        Box::pin(async move {
            let (sender, receiver) = oneshot::channel();
            *self.0.preview.lock().unwrap() = Some(OpenPreview { session, closed: Some(sender) });
            let _ = receiver.await;
            Ok(())
        })
    }
    fn fault(&self, point: &str) -> bool { self.0.script.fault(point) }
}

/// 中継での印刷プレビュー。PDF は最小の PDF（本物の描画は Tauri 版の試験で確かめる）。
struct BridgePreview { bridge: Arc<Bridge>, session: Arc<PrintSession> }

const MINIMAL_PDF: &[u8] = b"%PDF-1.4\n1 0 obj<</Type/Catalog/Pages 2 0 R>>endobj\n2 0 obj<</Type/Pages/Kids[3 0 R]/Count 1>>endobj\n3 0 obj<</Type/Page/Parent 2 0 R/MediaBox[0 0 595 842]>>endobj\ntrailer<</Root 1 0 R>>\n%%EOF\n";

impl PreviewWindow for BridgePreview {
    fn reload(&self) -> BoxFuture<'_, ()> { Box::pin(async {}) }
    fn print_to_pdf(&self) -> BoxFuture<'_, Result<Vec<u8>, String>> { Box::pin(async { Ok(MINIMAL_PDF.to_vec()) }) }
    fn print(&self) -> BoxFuture<'_, PrintOutcome> {
        Box::pin(async move {
            match self.bridge.script.print_outcome().as_deref() { Some("success") => PrintOutcome::Accepted, Some("cancel") => PrintOutcome::Cancelled, _ => PrintOutcome::Failed }
        })
    }
    fn close(&self) { self.bridge.preview_closed(); }
    fn is_open(&self) -> bool { self.bridge.preview.lock().unwrap().as_ref().is_some_and(|open| Arc::ptr_eq(&open.session, &self.session)) }
}

// ---- HTTP ----

struct Request { method: String, path: String, body: Vec<u8> }

fn read_request(stream: &TcpStream) -> Option<Request> {
    let mut reader = BufReader::new(stream.try_clone().ok()?);
    let mut line = String::new();
    reader.read_line(&mut line).ok()?;
    let mut parts = line.split_whitespace();
    let (method, path) = (parts.next()?.to_string(), parts.next()?.to_string());
    let mut length = 0usize;
    loop {
        let mut header = String::new();
        reader.read_line(&mut header).ok()?;
        let header = header.trim_end();
        if header.is_empty() { break; }
        if let Some((name, value)) = header.split_once(':') { if name.eq_ignore_ascii_case("content-length") { length = value.trim().parse().ok()?; } }
    }
    let mut body = vec![0u8; length];
    reader.read_exact(&mut body).ok()?;
    Some(Request { method, path, body })
}

fn respond(mut stream: &TcpStream, status: &str, headers: &[(&str, String)], body: &[u8]) {
    let mut head = format!("HTTP/1.1 {status}\r\nContent-Length: {}\r\nConnection: close\r\nCache-Control: no-store\r\n", body.len());
    for (name, value) in headers { head.push_str(&format!("{name}: {value}\r\n")); }
    head.push_str("\r\n");
    let _ = stream.write_all(head.as_bytes());
    let _ = stream.write_all(body);
}

fn not_found(stream: &TcpStream) { respond(stream, "404 Not Found", &[("Content-Type", "text/plain".into())], b"Not found"); }

fn json_response(stream: &TcpStream, result: Result<Value, String>) {
    let body = match result { Ok(value) => json!({ "ok": value }), Err(error) => json!({ "err": error }) };
    respond(stream, "200 OK", &[("Content-Type", "application/json".into())], body.to_string().as_bytes());
}

fn static_file(stream: &TcpStream, dist: &Path, path: &str) {
    let (file, kind) = match path {
        "/" | "/index.html" => {
            let Ok(html) = std::fs::read_to_string(dist.join("index.html")) else { return not_found(stream) };
            let html = html.replacen("<head>", "<head><script src=\"/__bridge.js\"></script>", 1);
            return respond(stream, "200 OK", &[("Content-Type", "text/html; charset=utf-8".into()), ("Content-Security-Policy", CSP.into()), ("X-Content-Type-Options", "nosniff".into())], html.as_bytes());
        }
        "/__bridge.js" => return respond(stream, "200 OK", &[("Content-Type", "text/javascript; charset=utf-8".into())], SHIM.as_bytes()),
        _ => match path.strip_prefix("/assets/") {
            Some(name) if !name.is_empty() && name.chars().all(|c| c.is_ascii_alphanumeric() || "-_.".contains(c)) && !name.contains("..") => {
                (dist.join("assets").join(name), if name.ends_with(".js") { "text/javascript" } else if name.ends_with(".css") { "text/css" } else { "application/octet-stream" })
            }
            _ => return not_found(stream),
        },
    };
    match std::fs::read(file) {
        Ok(bytes) => respond(stream, "200 OK", &[("Content-Type", format!("{kind}; charset=utf-8")), ("X-Content-Type-Options", "nosniff".into())], &bytes),
        Err(_) => not_found(stream),
    }
}

fn print_page(stream: &TcpStream, bridge: &Arc<Bridge>, rest: &str) {
    let session = bridge.preview.lock().unwrap().as_ref().map(|open| open.session.clone());
    let Some(session) = session else { return not_found(stream) };
    let (id, action) = rest.split_once('/').map(|(id, action)| (id, Some(action))).unwrap_or((rest, None));
    if id != session.id { return not_found(stream); }
    if let Some(name) = action {
        let handle = BridgePreview { bridge: bridge.clone(), session: session.clone() };
        tauri::async_runtime::block_on(session.action(name, &handle));
        if !handle.is_open() { return respond(stream, "200 OK", &[("Content-Type", "text/html; charset=utf-8".into())], "<!doctype html><title>閉じました</title>".as_bytes()); }
        return respond(stream, "303 See Other", &[("Location", session.url.clone())], b"");
    }
    let (html, csp) = session.page();
    respond(stream, "200 OK", &[("Content-Type", "text/html; charset=utf-8".into()), ("Content-Security-Policy", csp), ("X-Content-Type-Options", "nosniff".into())], html.as_bytes());
}

fn events(stream: TcpStream, bridge: &Arc<Bridge>) {
    let (sender, receiver) = mpsc::channel::<String>();
    bridge.listeners.lock().unwrap().push(sender);
    let mut stream = stream;
    if stream.write_all(b"HTTP/1.1 200 OK\r\nContent-Type: text/event-stream\r\nCache-Control: no-store\r\nConnection: keep-alive\r\n\r\n: open\n\n").is_err() { return; }
    while let Ok(message) = receiver.recv() {
        if stream.write_all(format!("data: {message}\n\n").as_bytes()).is_err() { break; }
    }
}

fn handle(stream: TcpStream, bridge: Arc<Bridge>) {
    let Some(request) = read_request(&stream) else { return };
    let path = request.path.split('?').next().unwrap_or("").to_string();
    match (request.method.as_str(), path.as_str()) {
        ("GET", "/events") => events(stream, &bridge),
        ("GET", p) if p.starts_with("/print/") => print_page(&stream, &bridge, &p["/print/".len()..]),
        ("GET", p) => static_file(&stream, &bridge.dist, p),
        ("POST", p) if p.starts_with("/invoke/") => {
            let command = &p["/invoke/".len()..];
            let input: Value = serde_json::from_slice(&request.body).unwrap_or(Value::Null);
            let result = tauri::async_runtime::block_on(async {
                match command {
                    "ipc" => {
                        let channel = input["channel"].as_str().map(str::to_string);
                        let args = input["args"].as_array().cloned();
                        match (channel, args) { (Some(channel), Some(args)) => bridge.ipc(channel, args).await, _ => Err("invalid args for command ipc".into()) }
                    }
                    "e2e" => bridge.e2e(input["request"].clone()).await,
                    other => Err(format!("Command {other} not found")),
                }
            });
            json_response(&stream, result);
        }
        _ => not_found(&stream),
    }
}

fn argument(name: &str) -> Option<String> { std::env::args().skip(1).find_map(|arg| arg.strip_prefix(&format!("--{name}=")).map(str::to_string)) }

fn main() {
    let user_data = PathBuf::from(argument("user-data-dir").expect("--user-data-dir"));
    let dist = PathBuf::from(argument("dist").unwrap_or_else(|| "dist".into()));
    let listener = TcpListener::bind(("127.0.0.1", argument("port").and_then(|p| p.parse().ok()).unwrap_or(0))).expect("bind");
    let base = format!("http://127.0.0.1:{}", listener.local_addr().expect("address").port());
    // 旧版と同じく、同じ保存場所では1つしか起動しない。
    std::fs::create_dir_all(&user_data).expect("user data");
    let lock = std::fs::OpenOptions::new().create(true).truncate(false).write(true).open(user_data.join("lockfile")).expect("lockfile");
    if lock.try_lock().is_err() { eprintln!("already running"); std::process::exit(0); }
    let (notice, store) = match pom_core::api::start(&user_data) {
        Ok(started) => started,
        Err(error) => { eprintln!("起動できませんでした: {error}"); std::process::exit(1); }
    };
    let bridge = Arc::new(Bridge {
        script: Script::default(), core: OnceLock::new(), base: base.clone(), dist, listeners: Mutex::new(Vec::new()),
        trusted: AtomicBool::new(true), untrusted: AtomicBool::new(false), unresponsive: AtomicBool::new(false), asking: AtomicBool::new(false), preview: Mutex::new(None),
    });
    let documents = user_data.join("documents");
    let config = AppConfig { user_data: user_data.clone(), documents_dir: documents, protected_roots: vec![user_data.clone()], version: env!("CARGO_PKG_VERSION").into(), recovery_notice: notice };
    let _ = bridge.core.set(App::new(config, store, Arc::new(BridgeHost(bridge.clone()))));
    println!("listening {base}");
    let _ = std::io::stdout().flush();
    for stream in listener.incoming().flatten() {
        let bridge = bridge.clone();
        std::thread::spawn(move || handle(stream, bridge));
    }
    drop(lock);
}
