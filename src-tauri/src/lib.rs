//! 発注書管理（Tauri / WebView2）の本体。業務処理は pom-core、ここはウィンドウ・ダイアログ・OSとのやり取り。

mod dialogs;
#[cfg(feature = "e2e")]
pub mod e2e;
#[cfg(target_os = "linux")]
mod gtk_print;
mod host;
mod instance;
mod paths;
mod preview;
#[cfg(windows)]
mod win;

use std::path::PathBuf;
use std::sync::{Arc, Mutex};

use pom_core::api::{App, AppConfig};
use tauri::webview::{NewWindowResponse, PageLoadEvent, PermissionResponse};
use tauri::{Manager, RunEvent, WebviewUrl, WebviewWindowBuilder, WindowEvent};

use crate::host::{MAIN, Shell, ShellHost, bring_to_front, move_offscreen, placed};
use crate::paths::PRODUCT_NAME;

struct Startup { user_data: PathBuf, version: String, notice: Option<String>, store: Mutex<Option<pom_core::db::Store>> }

fn setup(app: &mut tauri::App, startup: &Startup) -> Result<(), Box<dyn std::error::Error>> {
    let handle = app.handle().clone();
    // E2Eテスト用のビルドだけ、メインウィンドウに e2e コマンドを許可する（配布用のビルドにはコマンド自体がない）。
    #[cfg(feature = "e2e")]
    app.add_capability(tauri::ipc::CapabilityBuilder::new("e2e").window(MAIN).permission("allow-e2e"))?;
    let shell = Shell::new(handle.clone(), startup.user_data.clone());
    app.manage(shell.clone());
    let store = startup.store.lock().unwrap_or_else(|e| e.into_inner()).take().ok_or("database is not open")?;
    let documents_dir = app.path().document_dir().unwrap_or_else(|_| startup.user_data.clone());
    // 出力先にしてはいけない場所（旧版: 保存場所・アプリの場所）
    let mut protected_roots = vec![startup.user_data.clone()];
    if let Some(directory) = std::env::current_exe().ok().and_then(|exe| exe.parent().map(PathBuf::from)) { protected_roots.push(directory); }
    let config = AppConfig { user_data: startup.user_data.clone(), documents_dir, protected_roots, version: startup.version.clone(), recovery_notice: startup.notice.clone() };
    let _ = shell.core.set(App::new(config, store, Arc::new(ShellHost(shell.clone()))));

    let navigating = shell.clone();
    let shown = Arc::new(std::sync::atomic::AtomicBool::new(false));
    let main = placed(WebviewWindowBuilder::new(app, MAIN, WebviewUrl::App("index.html".into())))
        .title(PRODUCT_NAME)
        .inner_size(1120.0, 760.0)
        .min_inner_size(720.0, 520.0)
        .visible(false)
        // WebView2 のデータも保存場所に置く（旧 Electron 版も保存場所に Chromium のデータを置いていた）。
        .data_directory(startup.user_data.clone())
        // ファイルのドロップは画面（HTML）で受ける。行の並べ替えのドラッグ操作もそのまま使える。
        .disable_drag_drop_handler()
        // 最初に読み込むアプリのページ（旧版の app://desktop/index.html に当たる）以外へは移動させない。
        .on_navigation(move |url| navigating.allow_navigation(url))
        .on_new_window(|_, _| NewWindowResponse::Deny)
        .on_download(|_, _| false)
        .on_permission_request(|_, _| PermissionResponse::Deny)
        .on_page_load(move |window, payload| {
            if payload.event() == PageLoadEvent::Finished && !shown.swap(true, std::sync::atomic::Ordering::SeqCst) { let _ = window.show(); bring_to_front(&window); }
        })
        .build()?;
    move_offscreen(&main);
    let closing = shell.clone();
    main.on_window_event(move |event| {
        if let WindowEvent::CloseRequested { api, .. } = event { if !closing.close_requested() { api.prevent_close(); } }
    });
    #[cfg(windows)]
    {
        let (responsive, gone, dropped) = (shell.clone(), shell.clone(), shell.clone());
        let source = shell.clone();
        win::configure_main(&main, Arc::new(win::MainHooks {
            source: Box::new(move |url| source.is_app_url(url)),
            responsive: Box::new(move |value| responsive.set_responsive(value)),
            gone: Box::new(move || gone.renderer_gone()),
            dropped: Box::new(move |token, path| dropped.register_drop(token, path)),
        }));
        win::lower_memory_while_minimized(&main);
    }
    let activate = handle.clone();
    instance::listen(&startup.user_data, move || {
        if let Some(window) = activate.get_webview_window(MAIN) { let _ = window.unminimize(); let _ = window.show(); bring_to_front(&window); }
    });
    Ok(())
}

/// アプリを起動する（ウィンドウを閉じて終了するまで戻らない）。
pub fn run() {
    // 想定外の内部エラーでも、何も出さずに消えないようにする（配布版は panic で即時終了する設定）。
    // E2Eテスト用のビルドでは、ダイアログで止まらないよう標準エラーへ出すだけにする。
    std::panic::set_hook(Box::new(|info| {
        let message = format!("予期しないエラーのため、アプリを終了します。保存済みの内容は保持されています。もう一度起動してください。\n\n{info}");
        if cfg!(feature = "e2e") { eprintln!("{message}"); } else { dialogs::error_box("発注書管理", &message); }
    }));
    #[cfg(windows)]
    win::set_app_user_model_id();
    let launch = match paths::resolve() {
        Ok(launch) => launch,
        Err(message) => { dialogs::error_box("起動できませんでした", &message); return; }
    };
    // 同じ保存場所で起動中なら、そのウィンドウを前面に出して終える。
    let Some(instance) = instance::acquire(&launch.user_data) else { return };
    // 中断した復元の回復と、DBを開く（旧版の start と同じ順序）。
    let (notice, store) = match pom_core::api::start(&launch.user_data) {
        Ok(started) => started,
        Err(error) => { dialogs::error_box("起動できませんでした", &host::startup_message(&error)); return; }
    };
    let context = tauri::generate_context!();
    let startup = Startup { user_data: launch.user_data, version: context.package_info().version.to_string(), notice, store: Mutex::new(Some(store)) };
    let builder = tauri::Builder::default().register_asynchronous_uri_scheme_protocol("print", preview::protocol);
    #[cfg(feature = "e2e")]
    let builder = builder.invoke_handler(tauri::generate_handler![host::ipc, host::e2e]);
    #[cfg(not(feature = "e2e"))]
    let builder = builder.invoke_handler(tauri::generate_handler![host::ipc]);
    let app = match builder.setup(move |app| setup(app, &startup)).build(context) {
        Ok(app) => app,
        Err(error) => {
            dialogs::error_box("起動できませんでした", &format!("画面を表示できませんでした。Microsoft Edge WebView2 ランタイムが入っているか確認してください。\n\n{error}"));
            return;
        }
    };
    app.run(|handle, event| {
        if let RunEvent::Exit = event {
            if let Some(core) = handle.try_state::<Arc<Shell>>().and_then(|shell| shell.core().cloned()) { core.shutdown(); }
        }
    });
    drop(instance);
}
