//! 印刷プレビュー（旧 Electron 版の printing/ipc.ts のウィンドウ部分）。
//!
//! - スクリプト無効・専用のプロファイル（InPrivate）で、保存版の帳票だけを表示する
//! - ページ内のリンク（{url}/save・/print・/close）は移動させずに、操作として受け取る
//! - 開いている間はメインウィンドウを操作できない（旧版の modal: true）
//! - PDF保存・印刷の処理中は閉じさせない

use std::sync::Arc;

use pom_core::api::{BoxFuture, PreviewWindow, PrintOutcome, PrintSession};
use tauri::http::{Request, Response, StatusCode, header};
use tauri::webview::{NewWindowResponse, PageLoadEvent};
use tauri::{Manager, UriSchemeContext, UriSchemeResponder, Url, WebviewUrl, WebviewWindow, WebviewWindowBuilder, WindowEvent};
use tokio::sync::oneshot;

use crate::host::{OpenPreview, PREVIEW, Shell, bring_to_front, move_offscreen, placed};

/// 印刷プレビューのページを返す（専用プロトコル print）。
pub fn protocol(context: UriSchemeContext<'_, tauri::Wry>, request: Request<Vec<u8>>, responder: UriSchemeResponder) {
    let page = (|| {
        if context.webview_label() != PREVIEW || request.method() != tauri::http::Method::GET { return None; }
        let shell = context.app_handle().try_state::<Arc<Shell>>()?;
        let preview = shell.preview.lock().unwrap_or_else(|e| e.into_inner());
        let session = preview.as_ref()?.session.clone();
        drop(preview);
        if request.uri().path() != format!("/{}", session.id) || request.uri().query().is_some() { return None; }
        let (html, csp) = session.page();
        Response::builder().header(header::CONTENT_TYPE, "text/html; charset=utf-8").header("Content-Security-Policy", csp)
            .header("X-Content-Type-Options", "nosniff").header(header::CACHE_CONTROL, "no-store").body(html.into_bytes()).ok()
    })();
    responder.respond(page.unwrap_or_else(|| Response::builder().status(StatusCode::NOT_FOUND).header(header::CONTENT_TYPE, "text/plain").body(b"Not found".to_vec()).expect("static response")));
}

/// ページ内のリンクを操作として受け取る。表示中のページ自体の読込（再表示）だけを許す。
fn navigation(shell: &Arc<Shell>, session: &Arc<PrintSession>, url: &Url) -> bool {
    let text = url.as_str();
    if text == session.url { return true; }
    if let Some(name) = text.strip_prefix(&format!("{}/", session.url)) {
        let (shell, session, name) = (shell.clone(), session.clone(), name.to_string());
        tauri::async_runtime::spawn(async move {
            let Some(window) = shell.app.get_webview_window(PREVIEW) else { return };
            let handle = Handle { shell: shell.clone(), window, session: session.clone() };
            session.action(&name, &handle).await;
        });
    }
    false
}

fn finished_loading(shell: &Arc<Shell>, window: &WebviewWindow) {
    let mut preview = shell.preview.lock().unwrap_or_else(|e| e.into_inner());
    let Some(open) = preview.as_mut() else { return };
    for waiter in open.loaded.drain(..) { let _ = waiter.send(()); }
    if !open.shown {
        open.shown = true;
        let _ = window.show();
        bring_to_front(window);
    }
}

fn closed(shell: &Arc<Shell>) {
    let open = shell.preview.lock().unwrap_or_else(|e| e.into_inner()).take();
    if let Some(main) = shell.main_window() { let _ = main.set_enabled(true); bring_to_front(&main); }
    if let Some(mut open) = open { if let Some(sender) = open.closed.take() { let _ = sender.send(()); } }
}

/// 印刷プレビューを開き、閉じられるまで待つ。
pub async fn open(shell: Arc<Shell>, session: Arc<PrintSession>) -> Result<(), String> {
    let main = shell.main_window().ok_or("main window is closed")?;
    let url = Url::parse(&session.url).map_err(|e| e.to_string())?;
    let (closed_sender, closed_receiver) = oneshot::channel();
    *shell.preview.lock().unwrap_or_else(|e| e.into_inner()) = Some(OpenPreview { session: session.clone(), closed: Some(closed_sender), loaded: Vec::new(), shown: false });
    let (nav_shell, nav_session, load_shell) = (shell.clone(), session.clone(), shell.clone());
    let built = placed(WebviewWindowBuilder::new(&shell.app, PREVIEW, WebviewUrl::CustomProtocol(url)))
        .title("印刷プレビュー").inner_size(960.0, 800.0).min_inner_size(720.0, 520.0).visible(false)
        .parent(&main).map_err(|e| e.to_string())?
        .disable_javascript()
        .incognito(true)
        .disable_drag_drop_handler()
        .data_directory(shell.webview_data.clone())
        .on_navigation(move |url| navigation(&nav_shell, &nav_session, url))
        .on_new_window(|_, _| NewWindowResponse::Deny)
        .on_download(|_, _| false)
        .on_permission_request(|_, _| tauri::webview::PermissionResponse::Deny)
        .on_page_load(move |window, payload| { if payload.event() == PageLoadEvent::Finished { finished_loading(&load_shell, &window); } })
        .build();
    let window = match built {
        Ok(window) => window,
        Err(error) => { shell.preview.lock().unwrap_or_else(|e| e.into_inner()).take(); return Err(error.to_string()); }
    };
    move_offscreen(&window);
    #[cfg(windows)]
    crate::win::configure_preview(&window);
    // 開いている間はメインウィンドウを操作できない（旧版の modal）。
    let _ = main.set_enabled(false);
    let (event_shell, event_session) = (shell.clone(), session.clone());
    window.on_window_event(move |event| match event {
        WindowEvent::CloseRequested { api, .. } => { if event_session.is_working() { api.prevent_close(); } }
        WindowEvent::Destroyed => closed(&event_shell),
        _ => {}
    });
    let _ = closed_receiver.await;
    Ok(())
}

/// pom-core から見たプレビューのウィンドウ。
struct Handle { shell: Arc<Shell>, window: WebviewWindow, session: Arc<PrintSession> }

impl Handle {
    fn current(&self) -> bool {
        self.shell.preview.lock().unwrap_or_else(|e| e.into_inner()).as_ref().is_some_and(|open| Arc::ptr_eq(&open.session, &self.session))
    }
}

impl PreviewWindow for Handle {
    fn reload(&self) -> BoxFuture<'_, ()> {
        Box::pin(async move {
            let (sender, receiver) = oneshot::channel();
            {
                let mut preview = self.shell.preview.lock().unwrap_or_else(|e| e.into_inner());
                let Some(open) = preview.as_mut().filter(|open| Arc::ptr_eq(&open.session, &self.session)) else { return };
                open.loaded.push(sender);
            }
            let Ok(url) = Url::parse(&self.session.url) else { return };
            if self.window.navigate(url).is_err() { return; }
            // 閉じられた場合は待つ相手がいなくなる。
            let _ = receiver.await;
        })
    }

    fn print_to_pdf(&self) -> BoxFuture<'_, Result<Vec<u8>, String>> {
        Box::pin(async move {
            #[cfg(windows)]
            { crate::win::print_to_pdf(&self.window).await }
            #[cfg(target_os = "linux")]
            { crate::gtk_print::print_to_pdf(&self.window).await }
        })
    }

    fn print(&self) -> BoxFuture<'_, PrintOutcome> {
        Box::pin(async move {
            #[cfg(feature = "e2e")]
            if let Some(outcome) = self.shell.script.print_outcome() {
                return match outcome.as_str() { "success" => PrintOutcome::Accepted, "cancel" => PrintOutcome::Cancelled, _ => PrintOutcome::Failed };
            }
            #[cfg(windows)]
            { crate::win::print(&self.window).await }
            #[cfg(target_os = "linux")]
            { crate::gtk_print::print(&self.window).await }
        })
    }

    fn close(&self) { let _ = self.window.close(); }

    fn is_open(&self) -> bool { self.current() && self.shell.app.get_webview_window(PREVIEW).is_some() }
}
