//! Windows（WebView2）固有の処理。
//!
//! - 画面の設定（右クリックメニュー・ブラウザーのショートカット・自動入力を無効化。旧 Electron 版の既定に合わせる）
//! - 画面プロセスの停止・応答なしの検知（旧版の render-process-gone・unresponsive）
//! - ドロップしたファイルの場所（旧版の webUtils.getPathForFile）
//! - 印刷プレビューの PDF 化（旧版の printToPDF と同じ引数）と、プリンターを選んでの印刷（旧版の print({ silent: false })）
//! - 確認ダイアログ（TaskDialog。旧版の showMessageBox と同じく本文・詳細・独自ボタン）
//! - 最小化している間の画面のメモリ削減（WebView2 の MemoryUsageTargetLevel）

use std::sync::Arc;
use std::sync::atomic::{AtomicBool, Ordering};

use base64::Engine;
use pom_core::api::{MessageBox, MessageKind, PrintOutcome};
use raw_window_handle::{HasWindowHandle, RawWindowHandle};
use tauri::{WebviewWindow, WindowEvent};
use tokio::sync::oneshot;
use webview2_com::Microsoft::Web::WebView2::Win32::*;
use webview2_com::{
    CallDevToolsProtocolMethodCompletedHandler, ExecuteScriptCompletedHandler, PrintCompletedHandler, PrintToPdfStreamCompletedHandler,
    ProcessFailedEventHandler, WebMessageReceivedEventHandler, take_pwstr,
};
use windows::Win32::Foundation::{HGLOBAL, HWND};
use windows::Win32::System::Com::{IStream, STATFLAG_NONAME, STREAM_SEEK_SET};
use windows::core::{HSTRING, Interface, PCWSTR, PWSTR};

use crate::paths::PRODUCT_NAME;

/// タスクバーでショートカットと同じグループにする（旧版の app.setAppUserModelId。インストーラーのショートカットと一致させる）。
pub fn set_app_user_model_id() {
    use windows::Win32::UI::Shell::SetCurrentProcessExplicitAppUserModelID;
    let _ = unsafe { SetCurrentProcessExplicitAppUserModelID(&HSTRING::from("PartsOrderManager.App")) };
}

/// ウィンドウのハンドル（スレッドをまたいで渡すため数値にする）。
pub fn hwnd_value(window: &WebviewWindow) -> Option<isize> {
    match window.window_handle().ok()?.as_raw() { RawWindowHandle::Win32(handle) => Some(handle.hwnd.get()), _ => None }
}

fn hwnd(value: Option<isize>) -> HWND { HWND(value.unwrap_or(0) as *mut std::ffi::c_void) }

/// 確認ダイアログ（閉じるまで戻らない）。押したボタンの番号を返し、Esc・閉じるは cancel_id。
pub fn task_dialog(owner: Option<isize>, dialog: &MessageBox) -> usize {
    use windows::Win32::UI::Controls::{
        TASKDIALOG_BUTTON, TASKDIALOGCONFIG, TASKDIALOGCONFIG_0, TD_ERROR_ICON, TD_INFORMATION_ICON, TD_WARNING_ICON, TDF_ALLOW_DIALOG_CANCELLATION,
        TDF_POSITION_RELATIVE_TO_WINDOW, TaskDialogIndirect,
    };
    const FIRST: i32 = 100;
    let title = HSTRING::from(dialog.title.as_deref().unwrap_or(PRODUCT_NAME));
    let message = HSTRING::from(dialog.message.as_str());
    let detail = dialog.detail.as_deref().map(HSTRING::from);
    let labels: Vec<HSTRING> = dialog.buttons.iter().map(|b| HSTRING::from(b.as_str())).collect();
    let buttons: Vec<TASKDIALOG_BUTTON> = labels.iter().enumerate().map(|(i, label)| TASKDIALOG_BUTTON { nButtonID: FIRST + i as i32, pszButtonText: PCWSTR(label.as_ptr()) }).collect();
    let icon = match dialog.kind { MessageKind::Info => TD_INFORMATION_ICON, MessageKind::Warning => TD_WARNING_ICON, MessageKind::Error => TD_ERROR_ICON };
    let config = TASKDIALOGCONFIG {
        cbSize: std::mem::size_of::<TASKDIALOGCONFIG>() as u32,
        hwndParent: hwnd(owner),
        dwFlags: TDF_ALLOW_DIALOG_CANCELLATION | TDF_POSITION_RELATIVE_TO_WINDOW,
        pszWindowTitle: PCWSTR(title.as_ptr()),
        Anonymous1: TASKDIALOGCONFIG_0 { pszMainIcon: icon },
        pszMainInstruction: PCWSTR(message.as_ptr()),
        pszContent: detail.as_ref().map(|d| PCWSTR(d.as_ptr())).unwrap_or(PCWSTR::null()),
        cButtons: buttons.len() as u32,
        pButtons: buttons.as_ptr(),
        nDefaultButton: FIRST + dialog.default_id as i32,
        ..Default::default()
    };
    let mut pressed = 0i32;
    if unsafe { TaskDialogIndirect(&config, Some(&mut pressed), None, None) }.is_err() { return dialog.cancel_id; }
    let index = pressed - FIRST;
    if index >= 0 && (index as usize) < dialog.buttons.len() { index as usize } else { dialog.cancel_id }
}

/// UIスレッドで WebView2 を操作する。
fn with_core(window: &WebviewWindow, action: impl FnOnce(ICoreWebView2, ICoreWebView2Environment) + Send + 'static) -> bool {
    window.with_webview(move |platform| {
        if let Ok(core) = unsafe { platform.controller().CoreWebView2() } { action(core, platform.environment()); }
    }).is_ok()
}

/// 画面の設定。旧 Electron 版（メニューなし）と同じく、右クリックメニュー・再読込や印刷などのショートカット・自動入力を出さない。
unsafe fn apply_settings(core: &ICoreWebView2) -> windows::core::Result<()> {
    let settings = unsafe { core.Settings()? };
    unsafe {
        settings.SetAreDefaultContextMenusEnabled(false)?;
        settings.SetIsStatusBarEnabled(false)?;
        settings.SetAreHostObjectsAllowed(false)?;
        if let Ok(s3) = settings.cast::<ICoreWebView2Settings3>() { s3.SetAreBrowserAcceleratorKeysEnabled(false)?; }
        if let Ok(s4) = settings.cast::<ICoreWebView2Settings4>() { s4.SetIsGeneralAutofillEnabled(false)?; s4.SetIsPasswordAutosaveEnabled(false)?; }
        if let Ok(s5) = settings.cast::<ICoreWebView2Settings5>() { s5.SetIsPinchZoomEnabled(false)?; }
        if let Ok(s6) = settings.cast::<ICoreWebView2Settings6>() { s6.SetIsSwipeNavigationEnabled(false)?; }
    }
    Ok(())
}

pub fn configure_preview(window: &WebviewWindow) {
    with_core(window, |core, _| { let _ = unsafe { apply_settings(&core) }; });
}

/// メイン画面からの通知の受け口。
pub struct MainHooks {
    /// アプリのページか（ドロップの通知を受けてよい送信元か）
    pub source: Box<dyn Fn(&str) -> bool + Send + Sync>,
    /// 応答なし（true）・応答の回復（false）
    pub responsive: Box<dyn Fn(bool) + Send + Sync>,
    /// 画面プロセスの停止
    pub gone: Box<dyn Fn() + Send + Sync>,
    /// ドロップしたファイル（受付番号・場所）
    pub dropped: Box<dyn Fn(String, String) + Send + Sync>,
}

fn string_message(args: &ICoreWebView2WebMessageReceivedEventArgs) -> Option<String> {
    let mut text = PWSTR::null();
    unsafe { args.TryGetWebMessageAsString(&mut text) }.ok()?;
    Some(take_pwstr(text))
}

fn dropped_path(args: &ICoreWebView2WebMessageReceivedEventArgs) -> Option<String> {
    let objects = unsafe { args.cast::<ICoreWebView2WebMessageReceivedEventArgs2>().ok()?.AdditionalObjects().ok()? };
    let mut count = 0u32;
    unsafe { objects.Count(&mut count) }.ok()?;
    if count != 1 { return None; }
    let file = unsafe { objects.GetValueAtIndex(0).ok()?.cast::<ICoreWebView2File>().ok()? };
    let mut path = PWSTR::null();
    unsafe { file.Path(&mut path) }.ok()?;
    Some(take_pwstr(path))
}

pub fn configure_main(window: &WebviewWindow, hooks: Arc<MainHooks>) {
    with_core(window, move |core, _| unsafe {
        let _ = apply_settings(&core);
        let mut token = 0i64;
        let failed = hooks.clone();
        let _ = core.add_ProcessFailed(&ProcessFailedEventHandler::create(Box::new(move |sender, args| {
            let Some(args) = args else { return Ok(()) };
            let mut kind = COREWEBVIEW2_PROCESS_FAILED_KIND::default();
            args.ProcessFailedKind(&mut kind)?;
            if kind == COREWEBVIEW2_PROCESS_FAILED_KIND_RENDER_PROCESS_UNRESPONSIVE {
                (failed.responsive)(false);
                // 応答が戻ったら（スクリプトが実行できたら）通常の終了確認へ戻す。旧版の 'responsive' に当たる。
                if let Some(sender) = sender {
                    let recovered = failed.clone();
                    let _ = sender.ExecuteScript(&HSTRING::from("0"), &ExecuteScriptCompletedHandler::create(Box::new(move |result, _| { if result.is_ok() { (recovered.responsive)(true); } Ok(()) })));
                }
            } else if kind == COREWEBVIEW2_PROCESS_FAILED_KIND_RENDER_PROCESS_EXITED || kind == COREWEBVIEW2_PROCESS_FAILED_KIND_BROWSER_PROCESS_EXITED {
                (failed.gone)();
            }
            Ok(())
        })), &mut token);
        let dropped = hooks.clone();
        let _ = core.add_WebMessageReceived(&WebMessageReceivedEventHandler::create(Box::new(move |_, args| {
            let Some(args) = args else { return Ok(()) };
            let mut source = PWSTR::null();
            args.Source(&mut source)?;
            if !(dropped.source)(&take_pwstr(source)) { return Ok(()); }
            if let Some(token) = string_message(&args).and_then(|m| m.strip_prefix("pom-drop:").map(str::to_string)) {
                if let Some(path) = dropped_path(&args) { (dropped.dropped)(token, path); }
            }
            Ok(())
        })), &mut token);
    });
}

/// 最小化している間は、画面（WebView2）のメモリ使用の目標を「低」にし、元に戻したら「通常」へ戻す（Tauri は自動では切り替えない）。
/// スクリプトは止まらないため、自動保存・終了確認はそのまま動く（TrySuspend はスクリプトを止めるので使わない）。
/// 最小化中のメモリはディスクへ退避されることがあり、戻した直後の操作がわずかに遅くなることがある。
pub fn lower_memory_while_minimized(window: &WebviewWindow) {
    let low = AtomicBool::new(false);
    let target = window.clone();
    window.on_window_event(move |event| {
        if !matches!(event, WindowEvent::Resized(_)) { return; }
        let minimized = target.is_minimized().unwrap_or(false);
        if low.swap(minimized, Ordering::SeqCst) == minimized { return; }
        let level = if minimized { COREWEBVIEW2_MEMORY_USAGE_TARGET_LEVEL_LOW } else { COREWEBVIEW2_MEMORY_USAGE_TARGET_LEVEL_NORMAL };
        // 対応していない古い WebView2 ランタイムでは何もしない。
        with_core(&target, move |core, _| { if let Ok(core) = core.cast::<ICoreWebView2_19>() { let _ = unsafe { core.SetMemoryUsageTargetLevel(level) }; } });
    });
}

/// E2Eテスト用: 画面プロセスを異常終了させる（旧版の forcefullyCrashRenderer）。
#[cfg(feature = "e2e")]
pub fn crash_renderer(window: &WebviewWindow) {
    with_core(window, |core, _| unsafe {
        let _ = core.CallDevToolsProtocolMethod(&HSTRING::from("Page.crash"), &HSTRING::from("{}"), &CallDevToolsProtocolMethodCompletedHandler::create(Box::new(|_, _| Ok(()))));
    });
}

// ---- PDF・印刷 ----

/// A4（旧版 printToPDF の pageSize: 'A4' と同じ値。インチ）
const PDF_WIDTH: f64 = 8.27;
const PDF_HEIGHT: f64 = 11.7;
/// 旧版 printToPDF の既定余白（インチ）
const PDF_MARGIN: f64 = 0.4;

fn read_stream(stream: &IStream) -> windows::core::Result<Vec<u8>> {
    let mut stat = Default::default();
    unsafe { stream.Stat(&mut stat, STATFLAG_NONAME)?; stream.Seek(0, STREAM_SEEK_SET, None)?; }
    let mut bytes = vec![0u8; stat.cbSize as usize];
    let mut filled = 0usize;
    while filled < bytes.len() {
        let mut read = 0u32;
        unsafe { stream.Read(bytes[filled..].as_mut_ptr().cast(), (bytes.len() - filled) as u32, Some(&mut read)).ok()?; }
        if read == 0 { break; }
        filled += read as usize;
    }
    bytes.truncate(filled);
    Ok(bytes)
}

/// WebView2 標準の PDF 出力（DevTools の printToPDF が使えない場合）。
unsafe fn pdf_stream(core: &ICoreWebView2, environment: &ICoreWebView2Environment, sender: oneshot::Sender<Result<Vec<u8>, String>>) -> windows::core::Result<()> {
    let settings = unsafe { environment.cast::<ICoreWebView2Environment6>()?.CreatePrintSettings()? };
    unsafe {
        settings.SetOrientation(COREWEBVIEW2_PRINT_ORIENTATION_PORTRAIT)?;
        settings.SetPageWidth(PDF_WIDTH)?;
        settings.SetPageHeight(PDF_HEIGHT)?;
        settings.SetMarginTop(PDF_MARGIN)?;
        settings.SetMarginBottom(PDF_MARGIN)?;
        settings.SetMarginLeft(PDF_MARGIN)?;
        settings.SetMarginRight(PDF_MARGIN)?;
        settings.SetScaleFactor(1.0)?;
        settings.SetShouldPrintBackgrounds(true)?;
        settings.SetShouldPrintHeaderAndFooter(false)?;
        core.cast::<ICoreWebView2_16>()?.PrintToPdfStream(&settings, &PrintToPdfStreamCompletedHandler::create(Box::new(move |result, stream| {
            let bytes = result.and_then(|_| stream.ok_or_else(|| windows::core::Error::from(windows::Win32::Foundation::E_POINTER))).and_then(|s| read_stream(&s));
            let _ = sender.send(bytes.map_err(|e| e.to_string()));
            Ok(())
        })))
    }
}

/// 表示中のページを PDF にする。旧版 printToPDF と同じ指定（A4・背景あり・ヘッダーなし・CSSの用紙指定を優先）。
pub async fn print_to_pdf(window: &WebviewWindow) -> Result<Vec<u8>, String> {
    let (sender, receiver) = oneshot::channel::<Result<Vec<u8>, String>>();
    let params = serde_json::json!({
        "landscape": false, "displayHeaderFooter": false, "headerTemplate": "", "footerTemplate": "", "printBackground": true, "scale": 1.0,
        "paperWidth": PDF_WIDTH, "paperHeight": PDF_HEIGHT, "marginTop": PDF_MARGIN, "marginBottom": PDF_MARGIN, "marginLeft": PDF_MARGIN, "marginRight": PDF_MARGIN,
        "pageRanges": "", "preferCSSPageSize": true, "generateTaggedPDF": false, "generateDocumentOutline": false, "transferMode": "ReturnAsBase64",
    }).to_string();
    let started = with_core(window, move |core, environment| unsafe {
        let fallback_core = core.clone();
        let handler = CallDevToolsProtocolMethodCompletedHandler::create(Box::new(move |result, json| {
            let decoded = result.ok().and_then(|_| serde_json::from_str::<serde_json::Value>(&json).ok())
                .and_then(|value| value.get("data").and_then(|d| d.as_str()).and_then(|d| base64::engine::general_purpose::STANDARD.decode(d).ok()));
            match decoded {
                Some(bytes) => { let _ = sender.send(Ok(bytes)); }
                None => {
                    // DevTools の印刷が使えない WebView2 では標準の PDF 出力に切り替える。
                    let (inner_sender, inner_receiver) = oneshot::channel();
                    if pdf_stream(&fallback_core, &environment, inner_sender).is_err() { let _ = sender.send(Err("PDF engine unavailable".into())); return Ok(()); }
                    std::thread::spawn(move || { let _ = sender.send(inner_receiver.blocking_recv().unwrap_or_else(|_| Err("PDF engine stopped".into()))); });
                }
            }
            Ok(())
        }));
        if let Err(error) = core.CallDevToolsProtocolMethod(&HSTRING::from("Page.printToPDF"), &HSTRING::from(params), &handler) {
            let _ = error;
        }
    });
    if !started { return Err("preview window is closed".into()); }
    receiver.await.unwrap_or_else(|_| Err("PDF engine stopped".into()))
}

/// プリンターの選択（Windows 標準の印刷ダイアログ）で選ばれた内容。
struct PrinterChoice { printer: String, copies: i32, collate: bool, grayscale: bool, duplex: i16, landscape: bool, ranges: String }

fn global_wide(handle: HGLOBAL, offset_words: usize) -> String {
    use windows::Win32::System::Memory::{GlobalLock, GlobalUnlock};
    unsafe {
        let base = GlobalLock(handle) as *const u16;
        if base.is_null() { return String::new(); }
        let start = base.add(offset_words);
        let mut length = 0;
        while *start.add(length) != 0 { length += 1; }
        let text = String::from_utf16_lossy(std::slice::from_raw_parts(start, length));
        let _ = GlobalUnlock(handle);
        text
    }
}

/// 印刷ダイアログを出す（閉じるまで戻らない）。取り消しは None。
fn choose_printer(owner: Option<isize>) -> Result<Option<PrinterChoice>, String> {
    use windows::Win32::Graphics::Gdi::{DEVMODEW, DMCOLLATE_TRUE, DMCOLOR_MONOCHROME, DMORIENT_LANDSCAPE};
    use windows::Win32::System::Com::{COINIT_APARTMENTTHREADED, CoInitializeEx, CoUninitialize};
    use windows::Win32::Foundation::GlobalFree;
    use windows::Win32::System::Memory::{GlobalLock, GlobalUnlock};
    use windows::Win32::UI::Controls::Dialogs::{
        DEVNAMES, PD_NOCURRENTPAGE, PD_NOSELECTION, PD_PAGENUMS, PD_RESULT_PRINT, PD_USEDEVMODECOPIESANDCOLLATE, PRINTDLGEXW, PRINTPAGERANGE, PrintDlgExW, START_PAGE_GENERAL,
    };
    unsafe {
        let _ = CoInitializeEx(None, COINIT_APARTMENTTHREADED);
        let mut ranges = [PRINTPAGERANGE::default(); 16];
        let mut dialog = PRINTDLGEXW {
            lStructSize: std::mem::size_of::<PRINTDLGEXW>() as u32,
            hwndOwner: hwnd(owner),
            Flags: PD_NOSELECTION | PD_NOCURRENTPAGE | PD_USEDEVMODECOPIESANDCOLLATE,
            nMaxPageRanges: ranges.len() as u32,
            lpPageRanges: ranges.as_mut_ptr(),
            nMinPage: 1,
            nMaxPage: 9999,
            nCopies: 1,
            nStartPage: START_PAGE_GENERAL,
            ..Default::default()
        };
        let shown = PrintDlgExW(&mut dialog);
        let result = (|| {
            shown.map_err(|e| e.to_string())?;
            if dialog.dwResultAction != PD_RESULT_PRINT { return Ok(None); }
            let names = GlobalLock(dialog.hDevNames) as *const DEVNAMES;
            if names.is_null() { return Err("printer is unknown".to_string()); }
            let device_offset = (*names).wDeviceOffset as usize;
            let _ = GlobalUnlock(dialog.hDevNames);
            let printer = global_wide(dialog.hDevNames, device_offset);
            let mode = GlobalLock(dialog.hDevMode) as *const DEVMODEW;
            let (copies, collate, grayscale, duplex, landscape) = if mode.is_null() { (1, true, false, 1, false) } else {
                let m = &*mode;
                let orientation = m.Anonymous1.Anonymous1.dmOrientation;
                let value = (m.Anonymous1.Anonymous1.dmCopies.max(1) as i32, m.dmCollate == DMCOLLATE_TRUE, m.dmColor == DMCOLOR_MONOCHROME, m.dmDuplex.0, orientation == DMORIENT_LANDSCAPE as i16);
                let _ = GlobalUnlock(dialog.hDevMode);
                value
            };
            let ranges = if dialog.Flags & PD_PAGENUMS == PD_PAGENUMS {
                ranges[..dialog.nPageRanges as usize].iter().map(|r| if r.nFromPage == r.nToPage { r.nFromPage.to_string() } else { format!("{}-{}", r.nFromPage, r.nToPage) }).collect::<Vec<_>>().join(",")
            } else { String::new() };
            Ok(Some(PrinterChoice { printer, copies, collate, grayscale, duplex, landscape, ranges }))
        })();
        if !dialog.hDevMode.is_invalid() { let _ = GlobalFree(Some(dialog.hDevMode)); }
        if !dialog.hDevNames.is_invalid() { let _ = GlobalFree(Some(dialog.hDevNames)); }
        CoUninitialize();
        result
    }
}

/// 旧版 print の用紙（A4、ミクロン単位の 210×297 mm をインチにした値）と余白（top/bottom 72・left/right 68 ポイント）
const PRINT_WIDTH: f64 = 210.0 / 25.4;
const PRINT_HEIGHT: f64 = 297.0 / 25.4;
const PRINT_MARGIN_Y: f64 = 72.0 / 72.0;
const PRINT_MARGIN_X: f64 = 68.0 / 72.0;

/// プリンターを選んで印刷する（旧版 print({ silent: false, printBackground: true, pageSize: 'A4', margins }) に当たる）。
pub async fn print(window: &WebviewWindow) -> PrintOutcome {
    let owner = hwnd_value(window);
    let (chosen_sender, chosen_receiver) = oneshot::channel();
    std::thread::spawn(move || { let _ = chosen_sender.send(choose_printer(owner)); });
    let choice = match chosen_receiver.await {
        Ok(Ok(Some(choice))) => choice,
        Ok(Ok(None)) => return PrintOutcome::Cancelled,
        _ => return PrintOutcome::Failed,
    };
    let (sender, receiver) = oneshot::channel::<PrintOutcome>();
    let started = with_core(window, move |core, environment| unsafe {
        let run = || -> windows::core::Result<()> {
            let settings = environment.cast::<ICoreWebView2Environment6>()?.CreatePrintSettings()?;
            settings.SetOrientation(if choice.landscape { COREWEBVIEW2_PRINT_ORIENTATION_LANDSCAPE } else { COREWEBVIEW2_PRINT_ORIENTATION_PORTRAIT })?;
            settings.SetPageWidth(PRINT_WIDTH)?;
            settings.SetPageHeight(PRINT_HEIGHT)?;
            settings.SetMarginTop(PRINT_MARGIN_Y)?;
            settings.SetMarginBottom(PRINT_MARGIN_Y)?;
            settings.SetMarginLeft(PRINT_MARGIN_X)?;
            settings.SetMarginRight(PRINT_MARGIN_X)?;
            settings.SetScaleFactor(1.0)?;
            settings.SetShouldPrintBackgrounds(true)?;
            settings.SetShouldPrintHeaderAndFooter(false)?;
            let extended = settings.cast::<ICoreWebView2PrintSettings2>()?;
            extended.SetPrinterName(&HSTRING::from(choice.printer.as_str()))?;
            extended.SetCopies(choice.copies)?;
            extended.SetCollation(if choice.collate { COREWEBVIEW2_PRINT_COLLATION_COLLATED } else { COREWEBVIEW2_PRINT_COLLATION_UNCOLLATED })?;
            extended.SetColorMode(if choice.grayscale { COREWEBVIEW2_PRINT_COLOR_MODE_GRAYSCALE } else { COREWEBVIEW2_PRINT_COLOR_MODE_COLOR })?;
            extended.SetDuplex(match choice.duplex { 2 => COREWEBVIEW2_PRINT_DUPLEX_TWO_SIDED_LONG_EDGE, 3 => COREWEBVIEW2_PRINT_DUPLEX_TWO_SIDED_SHORT_EDGE, _ => COREWEBVIEW2_PRINT_DUPLEX_ONE_SIDED })?;
            if !choice.ranges.is_empty() { extended.SetPageRanges(&HSTRING::from(choice.ranges.as_str()))?; }
            let done = sender;
            core.cast::<ICoreWebView2_16>()?.Print(&settings, &PrintCompletedHandler::create(Box::new(move |result, status| {
                let _ = done.send(if result.is_ok() && status == COREWEBVIEW2_PRINT_STATUS_SUCCEEDED { PrintOutcome::Accepted } else { PrintOutcome::Failed });
                Ok(())
            })))
        };
        let _ = run();
    });
    if !started { return PrintOutcome::Failed; }
    receiver.await.unwrap_or(PrintOutcome::Failed)
}
