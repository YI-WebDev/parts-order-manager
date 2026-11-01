//! Linux（WebKitGTK）での PDF 化と印刷。開発・テスト用（配布対象は Windows）。

use pom_core::api::PrintOutcome;
use tauri::WebviewWindow;
use tokio::sync::oneshot;
use webkit2gtk::{PrintOperation, PrintOperationExt, PrintOperationResponse};

fn page_setup() -> gtk::PageSetup {
    let setup = gtk::PageSetup::new();
    setup.set_paper_size(&gtk::PaperSize::new(Some("iso_a4")));
    setup.set_orientation(gtk::PageOrientation::Portrait);
    for (side, value) in [(0, 0.4), (1, 0.4), (2, 0.4), (3, 0.4)] {
        match side {
            0 => setup.set_top_margin(value, gtk::Unit::Inch),
            1 => setup.set_bottom_margin(value, gtk::Unit::Inch),
            2 => setup.set_left_margin(value, gtk::Unit::Inch),
            _ => setup.set_right_margin(value, gtk::Unit::Inch),
        }
    }
    setup
}

/// 表示中のページを PDF にする（一時ファイルへ出力して読み込む）。
pub async fn print_to_pdf(window: &WebviewWindow) -> Result<Vec<u8>, String> {
    let directory = std::env::temp_dir().join(format!("pom-pdf-{}", pom_core::js::random_uuid()));
    std::fs::create_dir_all(&directory).map_err(|e| e.to_string())?;
    let file = directory.join("preview.pdf");
    let uri = format!("file://{}", file.display());
    let (sender, receiver) = oneshot::channel::<Result<(), String>>();
    let started = window.with_webview(move |platform| {
        let operation = PrintOperation::new(&platform.inner());
        let settings = gtk::PrintSettings::new();
        settings.set_printer("Print to File");
        settings.set("output-file-format", Some("pdf"));
        settings.set("output-uri", Some(&uri));
        operation.set_print_settings(&settings);
        operation.set_page_setup(&page_setup());
        let sender = std::rc::Rc::new(std::cell::RefCell::new(Some(sender)));
        let failed = sender.clone();
        operation.connect_failed(move |_, error| { if let Some(s) = failed.borrow_mut().take() { let _ = s.send(Err(error.to_string())); } });
        operation.connect_finished(move |_| { if let Some(s) = sender.borrow_mut().take() { let _ = s.send(Ok(())); } });
        operation.print();
    }).is_ok();
    let result = if started { receiver.await.unwrap_or_else(|_| Err("print stopped".into())) } else { Err("preview is closed".into()) };
    let bytes = result.and_then(|_| std::fs::read(&file).map_err(|e| e.to_string()));
    let _ = std::fs::remove_dir_all(&directory);
    bytes
}

/// プリンターを選ぶダイアログを出して印刷する。
pub async fn print(window: &WebviewWindow) -> PrintOutcome {
    let (sender, receiver) = oneshot::channel::<PrintOutcome>();
    let started = window.with_webview(move |platform| {
        let webview = platform.inner();
        let operation = PrintOperation::new(&webview);
        operation.set_page_setup(&page_setup());
        let sender = std::rc::Rc::new(std::cell::RefCell::new(Some(sender)));
        let (failed, finished) = (sender.clone(), sender.clone());
        operation.connect_failed(move |_, _| { if let Some(s) = failed.borrow_mut().take() { let _ = s.send(PrintOutcome::Failed); } });
        operation.connect_finished(move |_| { if let Some(s) = finished.borrow_mut().take() { let _ = s.send(PrintOutcome::Accepted); } });
        let parent = gtk::prelude::WidgetExt::toplevel(&webview).and_then(|w| gtk::glib::object::Cast::downcast::<gtk::Window>(w).ok());
        if operation.run_dialog(parent.as_ref()) != PrintOperationResponse::Print {
            if let Some(s) = sender.borrow_mut().take() { let _ = s.send(PrintOutcome::Cancelled); }
        }
    }).is_ok();
    if !started { return PrintOutcome::Failed; }
    receiver.await.unwrap_or(PrintOutcome::Failed)
}
