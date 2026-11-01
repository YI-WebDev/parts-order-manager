//! tests/unit/print-pdf.test.ts の移植（PDF保存: 取消・新規作成・上書き確認・他形式の保護・版の確認・一時ファイルの残留）。
//!
//! 旧テストは savePdf(bytes, { choose, overwrite }, [], verify) を直接呼び、node:fs の writeFileSync・unlinkSync を
//! 1回だけ失敗させていた。ここでは `App::save_pdf` を呼び、保存ダイアログ・上書き確認はテスト用の `Host` が答え、
//! 書込・削除の失敗は `Host::fault`（1回だけ true を返す）で起こす。保護する場所は旧テストと同じく空。
//! 出力先は旧実装の Windows のドライブ文字の形ではなく、Windows 以外で受け付ける `/` から始まる絶対パス（一時フォルダー）。

use std::future::Future;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, AtomicUsize, Ordering};
use std::sync::{Arc, Mutex};
use std::task::{Context, Poll, Wake, Waker};

use pom_core::api::{App, AppConfig, BoxFuture, Host, MessageBox, OpenDialog, Parent, PrintSession, SaveDialog};
use pom_core::db::Store;
use pom_core::error::{Error, Result};
use tempfile::TempDir;

const BYTES: &[u8] = b"%PDF-1.7\nFICTIONAL\n%%EOF";

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

/// 保存ダイアログで選ぶパス・上書き確認の答え・1回だけ失敗させる操作。
#[derive(Default)]
struct PdfHost { select: Mutex<Option<PathBuf>>, overwrite: AtomicBool, faults: Mutex<Vec<&'static str>> }

impl Host for PdfHost {
    fn open_file(&self, _parent: Parent, _dialog: OpenDialog) -> BoxFuture<'_, Option<PathBuf>> { Box::pin(async { None }) }
    fn save_file(&self, _parent: Parent, _dialog: SaveDialog) -> BoxFuture<'_, Option<PathBuf>> {
        let selected = self.select.lock().unwrap().clone();
        Box::pin(async move { selected })
    }
    fn message_box(&self, _parent: Parent, dialog: MessageBox) -> BoxFuture<'_, usize> {
        let answer = if self.overwrite.load(Ordering::SeqCst) { 1 } else { dialog.cancel_id };
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

/// フィールド順に破棄する（アプリのDBを閉じてから一時フォルダーを消す）。
struct Fixture { app: Arc<App>, host: Arc<PdfHost>, target: PathBuf, root: TempDir, _app_dir: TempDir }

fn fixture() -> Fixture {
    let root = tempfile::Builder::new().prefix("step09-pdf-").tempdir().unwrap();
    let app_dir = tempfile::Builder::new().prefix("step09-app-").tempdir().unwrap();
    let store = Store::open_default(&app_dir.path().join("database")).unwrap();
    let host = Arc::new(PdfHost::default());
    let config = AppConfig { user_data: app_dir.path().to_path_buf(), documents_dir: root.path().to_path_buf(), protected_roots: vec![], version: "0.1.0".into(), recovery_notice: None };
    let app = App::new(config, store, host.clone());
    Fixture { app, host, target: root.path().join("架空.pdf"), root, _app_dir: app_dir }
}

impl Fixture {
    /// `save(select, overwrite, verify)`
    fn save_with(&self, select: Option<&Path>, overwrite: bool, verify: &(dyn Fn() -> Result<()> + Send + Sync)) -> String {
        *self.host.select.lock().unwrap() = select.map(Path::to_path_buf);
        self.host.overwrite.store(overwrite, Ordering::SeqCst);
        block_on(self.app.save_pdf(BYTES.to_vec(), verify))
    }
    fn save(&self) -> String { self.save_with(Some(&self.target), true, &|| Ok(())) }
    fn fail_once(&self, point: &'static str) { self.host.faults.lock().unwrap().push(point); }
    fn names(&self) -> Vec<String> {
        let mut names: Vec<String> = std::fs::read_dir(self.root.path()).unwrap().map(|e| e.unwrap().file_name().to_string_lossy().into_owned()).collect();
        names.sort();
        names
    }
    fn temp(&self) -> String { self.names().into_iter().find(|name| name.starts_with(".parts-order-")).expect("Missing temp") }
}

#[track_caller]
fn assert_contains(message: &str, part: &str) { assert!(message.contains(part), "{message:?} should contain {part:?}"); }

#[test]
fn cancels_then_creates_and_refuses_or_accepts_explicit_overwrite() {
    let f = fixture();
    assert_contains(&f.save_with(None, true, &|| Ok(())), "取り消し");
    assert!(!f.target.exists());
    assert_contains(&f.save(), "保存しました");
    let original = std::fs::read(&f.target).unwrap();
    assert_contains(&f.save_with(Some(&f.target), false, &|| Ok(())), "取り消し");
    assert_eq!(std::fs::read(&f.target).unwrap(), original);
    assert_contains(&f.save(), "保存しました");
}

#[test]
fn protects_foreign_pdf_and_rejects_incompatible_extensions() {
    let f = fixture();
    std::fs::write(&f.target, "FOREIGN").unwrap();
    assert_contains(&f.save(), "別名");
    assert_eq!(std::fs::read_to_string(&f.target).unwrap(), "FOREIGN");
    assert_contains(&f.save_with(Some(&f.root.path().join("a.xlsx")), true, &|| Ok(())), "出力先");
}

#[test]
fn checks_revision_after_dialog_and_preserves_prior_output_on_conflict() {
    let f = fixture();
    f.save();
    let before = std::fs::read(&f.target).unwrap();
    let count = AtomicUsize::new(0);
    let verify = || if count.fetch_add(1, Ordering::SeqCst) + 1 == 2 { Err(Error::other("conflict")) } else { Ok(()) };
    assert_contains(&f.save_with(Some(&f.target), true, &verify), "保存できません");
    assert_eq!(std::fs::read(&f.target).unwrap(), before);
    assert_eq!(f.names(), vec!["架空.pdf".to_string()]);
}

// 新規出力の確定後に一時ファイルが残るのは、ハードリンクで確定する Windows 以外だけ（Windows は移動で確定し、一時ファイルが残らない）。
#[cfg(not(windows))]
#[test]
fn reports_committed_leftover_exact_temp_and_allows_retry_after_only_temp_removal() {
    let f = fixture();
    f.fail_once("unlink");
    let message = f.save();
    assert_contains(&message, "出力確定済み");
    let temp = f.temp();
    assert_contains(&message, &temp);
    let before = std::fs::read(&f.target).unwrap();
    assert_contains(&f.save(), "出力先");
    std::fs::remove_file(f.root.path().join(&temp)).unwrap();
    assert_eq!(std::fs::read(&f.target).unwrap(), before);
    assert_contains(&f.save(), "保存しました");
}

#[test]
fn reports_uncommitted_leftover_on_write_failure_without_changing_original() {
    let f = fixture();
    f.save();
    let before = std::fs::read(&f.target).unwrap();
    f.fail_once("write");
    f.fail_once("unlink");
    let message = f.save();
    assert_contains(&message, "出力未確定");
    assert_eq!(std::fs::read(&f.target).unwrap(), before);
    let temp = f.temp();
    assert_contains(&message, &temp);
    std::fs::remove_file(f.root.path().join(&temp)).unwrap();
    assert_contains(&f.save(), "保存しました");
}

#[cfg(windows)]
#[test]
fn moves_a_new_pdf_into_place_so_nothing_is_left_to_clean_up_even_if_deletion_would_fail() {
    let f = fixture();
    f.fail_once("unlink");
    assert_contains(&f.save(), "PDFを保存しました");
    // 一時ファイルを消す必要がないため、差し込んだ削除の失敗は使われずに残る。
    assert_eq!(*f.host.faults.lock().unwrap(), vec!["unlink"]);
    assert_eq!(f.names(), vec!["架空.pdf".to_string()]);
    assert_eq!(pom_core::fsx::lstat(&f.target).unwrap().nlink, 1);
}

#[test]
fn reports_a_failed_new_pdf_publication_without_creating_the_file_and_retries() {
    let f = fixture();
    f.fail_once("publish");
    assert_contains(&f.save(), "PDFを保存できませんでした。");
    assert!(f.names().is_empty(), "{:?}", f.names());
    assert_contains(&f.save(), "PDFを保存しました");
    let saved = std::fs::read(&f.target).unwrap();
    assert!(saved.starts_with(BYTES) && saved.ends_with(pom_core::printing::PDF_MARKER));
    assert_eq!(f.names(), vec!["架空.pdf".to_string()]);
    assert_eq!(pom_core::fsx::lstat(&f.target).unwrap().nlink, 1);
}
