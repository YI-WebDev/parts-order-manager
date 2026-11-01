//! OSのダイアログ（ファイルを開く・保存・確認・エラー）。
//! 旧 Electron の dialog.showOpenDialog・showSaveDialog・showMessageBox・showErrorBox に当たる。
//! E2Eテスト用のビルドでは代役（e2e.rs）が答えるため、エラー表示以外は使わない。
#![cfg_attr(feature = "e2e", allow(dead_code))]

use std::path::PathBuf;

use pom_core::api::{FileFilter, MessageBox};
use tauri::{AppHandle, WebviewWindow};
use tokio::sync::oneshot;

#[cfg(not(windows))]
use crate::paths::PRODUCT_NAME;

/// 起動失敗・画面停止の通知（アプリを終える前に出す。ボタンは OK だけ）。
pub fn error_box(title: &str, message: &str) {
    #[cfg(windows)]
    {
        use windows::Win32::UI::WindowsAndMessaging::{MB_ICONERROR, MB_OK, MessageBoxW};
        use windows::core::HSTRING;
        unsafe { MessageBoxW(None, &HSTRING::from(message), &HSTRING::from(title), MB_OK | MB_ICONERROR) };
    }
    #[cfg(not(windows))]
    eprintln!("{title}: {message}");
}

fn rfd_filters(mut dialog: rfd::AsyncFileDialog, filters: &[FileFilter]) -> rfd::AsyncFileDialog {
    for filter in filters { dialog = dialog.add_filter(&filter.name, &filter.extensions); }
    dialog
}

#[cfg(not(windows))]
fn blocking_filters(mut dialog: rfd::FileDialog, filters: &[FileFilter]) -> rfd::FileDialog {
    for filter in filters { dialog = dialog.add_filter(&filter.name, &filter.extensions); }
    dialog
}

/// UIスレッドで閉じるまで待つダイアログを出し、結果を受け取る（Linux の GTK 用）。
#[cfg(not(windows))]
async fn on_main_thread<T: Send + 'static>(app: &AppHandle, show: impl FnOnce() -> T + Send + 'static, fallback: T) -> T {
    let (sender, receiver) = oneshot::channel();
    if app.run_on_main_thread(move || { let _ = sender.send(show()); }).is_err() { return fallback; }
    receiver.await.unwrap_or(fallback)
}

pub async fn open_file(app: &AppHandle, parent: Option<WebviewWindow>, title: String, filters: Vec<FileFilter>) -> Option<PathBuf> {
    #[cfg(windows)]
    {
        let _ = app;
        let mut dialog = rfd_filters(rfd::AsyncFileDialog::new().set_title(&title), &filters);
        if let Some(parent) = &parent { dialog = dialog.set_parent(parent); }
        dialog.pick_file().await.map(|file| file.path().to_path_buf())
    }
    #[cfg(not(windows))]
    {
        let _ = rfd_filters;
        on_main_thread(app, move || {
            let mut dialog = blocking_filters(rfd::FileDialog::new().set_title(&title), &filters);
            if let Some(parent) = &parent { dialog = dialog.set_parent(parent); }
            dialog.pick_file()
        }, None).await
    }
}

pub async fn save_file(app: &AppHandle, parent: Option<WebviewWindow>, title: String, default_path: PathBuf, filters: Vec<FileFilter>) -> Option<PathBuf> {
    let directory = default_path.parent().map(PathBuf::from);
    let name = default_path.file_name().map(|n| n.to_string_lossy().into_owned()).unwrap_or_default();
    #[cfg(windows)]
    {
        let _ = app;
        let mut dialog = rfd_filters(rfd::AsyncFileDialog::new().set_title(&title).set_file_name(&name), &filters);
        if let Some(directory) = &directory { dialog = dialog.set_directory(directory); }
        if let Some(parent) = &parent { dialog = dialog.set_parent(parent); }
        dialog.save_file().await.map(|file| file.path().to_path_buf())
    }
    #[cfg(not(windows))]
    {
        on_main_thread(app, move || {
            let mut dialog = blocking_filters(rfd::FileDialog::new().set_title(&title).set_file_name(&name), &filters);
            if let Some(directory) = &directory { dialog = dialog.set_directory(directory); }
            if let Some(parent) = &parent { dialog = dialog.set_parent(parent); }
            dialog.save_file()
        }, None).await
    }
}

/// 確認ダイアログ。押したボタンの番号（Esc・閉じるは cancel_id）。
pub async fn message_box(app: &AppHandle, parent: Option<WebviewWindow>, dialog: MessageBox) -> usize {
    #[cfg(windows)]
    {
        let _ = app;
        let owner = parent.as_ref().and_then(crate::win::hwnd_value);
        let cancel = dialog.cancel_id;
        let (sender, receiver) = oneshot::channel();
        // TaskDialog は自前のメッセージループを持つ。UIスレッドを止めないよう別スレッドで出し、親ウィンドウは操作できなくする。
        std::thread::spawn(move || { let _ = sender.send(crate::win::task_dialog(owner, &dialog)); });
        receiver.await.unwrap_or(cancel)
    }
    #[cfg(not(windows))]
    {
        let cancel = dialog.cancel_id;
        on_main_thread(app, move || {
            use rfd::{MessageButtons, MessageDialogResult, MessageLevel};
            let level = match dialog.kind { pom_core::api::MessageKind::Info => MessageLevel::Info, pom_core::api::MessageKind::Warning => MessageLevel::Warning, pom_core::api::MessageKind::Error => MessageLevel::Error };
            let buttons = match dialog.buttons.as_slice() {
                [one] => MessageButtons::OkCustom(one.clone()),
                [first, second] => MessageButtons::OkCancelCustom(second.clone(), first.clone()),
                [first, second, third, ..] => MessageButtons::YesNoCancelCustom(first.clone(), second.clone(), third.clone()),
                [] => MessageButtons::Ok,
            };
            let description = match &dialog.detail { Some(detail) => format!("{}\n\n{detail}", dialog.message), None => dialog.message.clone() };
            let mut message = rfd::MessageDialog::new().set_level(level).set_title(dialog.title.as_deref().unwrap_or(PRODUCT_NAME)).set_description(description).set_buttons(buttons);
            if let Some(parent) = &parent { message = message.set_parent(parent); }
            match message.show() {
                MessageDialogResult::Custom(text) => dialog.buttons.iter().position(|b| *b == text).unwrap_or(dialog.cancel_id),
                MessageDialogResult::Ok | MessageDialogResult::Yes => 0,
                _ => dialog.cancel_id,
            }
        }, cancel).await
    }
}
