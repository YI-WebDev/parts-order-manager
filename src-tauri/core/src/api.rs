//! 画面からの要求の受付（旧 Electron の ipcMain.handle 群）。チャネル名・引数・応答の形は旧実装と同じ。
//! ダイアログ・ウィンドウ操作は `Host`（Tauri 本体、またはテスト用の代役）に任せ、ダイアログの表示中はDBを占有しない。

use std::collections::HashSet;
use std::future::Future;
use std::path::{Path, PathBuf};
use std::pin::Pin;
use std::sync::{Arc, Mutex, MutexGuard};

use serde::Serialize;
use serde_json::{json, Value};

use crate::backups::{self, DatabaseGate};
use crate::db::Store;
use crate::documents::{parse_document_ids, DocumentEditor};
use crate::error::{DbCode, Error, Result};
use crate::exports::{self, files};
use crate::imports;
use crate::ipc::{self, BackupOp, DocumentsOp, Failure, ImportsOp, MasterOp, REJECTED};
use crate::js;
use crate::materials;
use crate::printing;
use crate::reimport::{self, MasterService};
use crate::search;
use crate::ui_meta::UiMeta;
use crate::validate;

pub use crate::ipc::Channel;

pub type BoxFuture<'a, T> = Pin<Box<dyn Future<Output = T> + Send + 'a>>;

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct FileFilter { pub name: String, pub extensions: Vec<String> }

/// ダイアログの親ウィンドウ。
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Parent { Main, Preview }

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct OpenDialog { pub title: String, pub filters: Vec<FileFilter> }

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct SaveDialog { pub title: String, pub default_path: PathBuf, pub filters: Vec<FileFilter> }

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum MessageKind { Info, Warning, Error }

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct MessageBox { pub kind: MessageKind, pub title: Option<String>, pub message: String, pub detail: Option<String>, pub buttons: Vec<String>, pub default_id: usize, pub cancel_id: usize }

/// 印刷プレビューのウィンドウ（スクリプト無効のページ）に対する操作。
pub trait PreviewWindow: Send + Sync {
    /// 現在の状態でページを読み直す（状態の文言を表示し直す）。
    fn reload(&self) -> BoxFuture<'_, ()>;
    /// 表示中のページを A4 縦の PDF にする。
    fn print_to_pdf(&self) -> BoxFuture<'_, std::result::Result<Vec<u8>, String>>;
    /// プリンターを選ぶダイアログを出して印刷する。
    fn print(&self) -> BoxFuture<'_, PrintOutcome>;
    fn close(&self);
    fn is_open(&self) -> bool;
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum PrintOutcome { Accepted, Cancelled, Failed }

/// OS・ウィンドウとのやり取り。
pub trait Host: Send + Sync {
    fn open_file(&self, parent: Parent, dialog: OpenDialog) -> BoxFuture<'_, Option<PathBuf>>;
    fn save_file(&self, parent: Parent, dialog: SaveDialog) -> BoxFuture<'_, Option<PathBuf>>;
    /// 押したボタンの番号（閉じた場合は cancel_id）。
    fn message_box(&self, parent: Parent, dialog: MessageBox) -> BoxFuture<'_, usize>;
    /// 要求元が今もアプリの画面（メインウィンドウの所定のページ）か。
    fn sender_trusted(&self) -> bool;
    /// 画面へ終了確認を求める（documents:close-requested）。
    fn emit_close_requested(&self, token: &str);
    /// 終了確認が取れたのでメインウィンドウを閉じる（次のイベントループで）。
    fn close_main_window(&self);
    /// 復元の後、ウィンドウを破棄してアプリを終了する。
    fn quit_after_restore(&self);
    /// 印刷プレビューのページのURL（リンクの基準）。
    fn preview_url(&self, id: &str) -> String;
    /// 印刷プレビューを開き、閉じられるまで待つ。開けなければ Err。
    fn open_print_preview(&self, session: Arc<PrintSession>) -> BoxFuture<'_, std::result::Result<(), String>>;
    /// E2Eテストで障害を起こす箇所か（write・publish・rename・unlink・restore:<段階>）。製品では常に false。
    fn fault(&self, _point: &str) -> bool { false }
}

/// 出力ファイルの書込・新規確定・置換・削除（E2Eテストの障害注入を通す）。
struct HostFs<'a>(&'a dyn Host);
impl files::FileOps for HostFs<'_> {
    fn write(&self, file: &mut std::fs::File, bytes: &[u8]) -> std::io::Result<()> {
        if self.0.fault("write") { return Err(std::io::Error::other("injected write failure")); }
        std::io::Write::write_all(file, bytes)
    }
    fn publish_new(&self, from: &Path, to: &Path) -> std::io::Result<files::Published> {
        if self.0.fault("publish") { return Err(std::io::Error::other("injected publish failure")); }
        files::publish_new(from, to)
    }
    fn rename(&self, from: &Path, to: &Path) -> std::io::Result<()> {
        if self.0.fault("rename") { return Err(std::io::Error::other("injected rename failure")); }
        std::fs::rename(from, to)
    }
    fn unlink(&self, path: &Path) -> std::io::Result<()> {
        if self.0.fault("unlink") { return Err(std::io::Error::other("injected cleanup failure")); }
        std::fs::remove_file(path)
    }
}

pub struct AppConfig {
    pub user_data: PathBuf,
    pub documents_dir: PathBuf,
    /// 出力先にしてはいけない場所（保存場所・アプリの場所）
    pub protected_roots: Vec<PathBuf>,
    pub version: String,
    pub recovery_notice: Option<String>,
}

#[derive(Default)]
struct Inner {
    store: Option<Store>,
    gate: DatabaseGate,
    editor: DocumentEditor,
    master: MasterService,
    imports_opened: HashSet<String>,
    imports_choosing: bool,
    master_opened: HashSet<String>,
    master_choosing: bool,
    backup_busy: bool,
    inspected: Option<(String, PathBuf, String)>,
    export_busy: bool,
    print_active: bool,
    close_token: Option<String>,
    closing: bool,
}

/// 「Excelを選んで解析」の進行中の印（初回取込と更新取込は別々に1つずつ）。
#[derive(Clone, Copy)]
enum Chooser { Imports, Master }

impl Chooser {
    fn flag(self, inner: &mut Inner) -> &mut bool {
        match self { Chooser::Imports => &mut inner.imports_choosing, Chooser::Master => &mut inner.master_choosing }
    }
}

pub struct App {
    pub config: AppConfig,
    host: Arc<dyn Host>,
    meta: UiMeta,
    inner: Mutex<Inner>,
}

const FEATURES: [&str; 8] = ["app-info", "initial-import", "material-search", "invoice-editor", "excel-export", "print-pdf", "material-management", "backup-restore"];

fn excel_filter() -> Vec<FileFilter> { vec![FileFilter { name: "Excelブック".into(), extensions: vec!["xlsx".into()] }] }
fn backup_filter() -> Vec<FileFilter> { vec![FileFilter { name: "発注書管理バックアップ".into(), extensions: vec!["pombak".into()] }] }

fn to_value<T: Serialize>(value: &T) -> Value { serde_json::to_value(value).unwrap_or(Value::Null) }

/// 要求全体を覆うDBの使用許可（drop で返す）。
struct GateGuard<'a> { app: &'a App }
impl Drop for GateGuard<'_> { fn drop(&mut self) { self.app.lock().gate.release(); } }

impl App {
    pub fn new(config: AppConfig, store: Store, host: Arc<dyn Host>) -> Arc<App> {
        let meta = UiMeta::new(&config.user_data);
        Arc::new(App { config, host, meta, inner: Mutex::new(Inner { store: Some(store), ..Inner::default() }) })
    }

    fn lock(&self) -> MutexGuard<'_, Inner> { self.inner.lock().unwrap_or_else(|e| e.into_inner()) }

    fn trusted(&self) -> Result<()> { if self.host.sender_trusted() { Ok(()) } else { Err(Error::other(REJECTED)) } }

    fn acquire(&self) -> Result<GateGuard<'_>> { self.lock().gate.acquire()?; Ok(GateGuard { app: self }) }

    /// DBを使う同期処理（ロックを取り、閉じたDBではエラー）。
    fn with_store<T>(&self, action: impl FnOnce(&Store, &mut Inner) -> Result<T>) -> Result<T> {
        let mut guard = self.lock();
        let inner = &mut *guard;
        let store = inner.store.take().ok_or_else(|| Error::other("The database connection is not open"))?;
        let result = action(&store, inner);
        inner.store = Some(store);
        result
    }

    pub fn meta(&self) -> &UiMeta { &self.meta }

    /// アプリの終了処理（DBを閉じる）。
    pub fn shutdown(&self) { if let Some(store) = self.lock().store.take() { store.close(); } }

    /// 画面からの要求。Err は旧実装で invoke が reject された場合（app:info の拒否・未知のチャネル）。
    pub async fn invoke(self: &Arc<Self>, channel: &str, args: Vec<Value>) -> std::result::Result<Value, String> {
        let Some(channel) = Channel::parse(channel) else { return Err(format!("No handler registered for '{channel}'")) };
        Ok(match channel {
            Channel::AppInfo => return self.app_info(&args),
            Channel::Backup(op) => self.backup(op, &args).await,
            Channel::Imports(op) => self.imports(op, &args).await,
            Channel::Master(op) => self.master(op, &args).await,
            Channel::MaterialsSearch => self.search_reply(channel, &args, search::search),
            Channel::MaterialsCategories => self.search_reply(channel, &args, search::categories),
            Channel::Documents(op) => self.documents(op, &args),
            Channel::ExportExcel => self.export_excel(&args).await,
            Channel::PrintPreview => self.print_preview(&args).await,
        })
    }

    // ---- app:info ----

    fn app_info(&self, args: &[Value]) -> std::result::Result<Value, String> {
        if !self.host.sender_trusted() || !args.is_empty() { return Err(REJECTED.into()); }
        Ok(json!({ "recoveryNotice": self.config.recovery_notice, "version": self.config.version, "userDataPath": self.config.user_data.to_string_lossy(), "availableFeatures": FEATURES }))
    }

    // ---- backups ----

    async fn backup(&self, op: BackupOp, args: &[Value]) -> Value {
        match op {
            BackupOp::Create => self.backup_create(args).await,
            BackupOp::Inspect => self.backup_inspect(args).await,
            BackupOp::Restore => self.backup_restore(args).await,
            BackupOp::Status => self.backup_status(args),
        }
    }

    async fn backup_run(&self, op: BackupOp, action: impl Future<Output = Result<Value>>) -> Value {
        let channel = Channel::Backup(op);
        {
            let mut inner = self.lock();
            if inner.backup_busy { return ipc::error_response(&Failure::plain("バックアップ・復元の処理が終わるまでお待ちください。")); }
            if let Err(error) = self.trusted() { return ipc::error_response(&ipc::failure(channel, &error)); }
            inner.backup_busy = true;
        }
        let result = action.await;
        self.lock().backup_busy = false;
        match result { Ok(value) => value, Err(error) => ipc::error_response(&ipc::failure(channel, &error)) }
    }

    async fn backup_create(&self, args: &[Value]) -> Value {
        self.backup_run(BackupOp::Create, async {
            validate::tuple(args, 0)?;
            self.lock().gate.freeze()?;
            let result = self.backup_create_frozen().await;
            self.lock().gate.thaw();
            result
        }).await
    }

    async fn backup_create_frozen(&self) -> Result<Value> {
        let today = &js::iso_now()[..10];
        let chosen = self.host.save_file(Parent::Main, SaveDialog { title: "バックアップを新しい名前で保存".into(), default_path: self.config.documents_dir.join(format!("発注書管理-{today}.pombak")), filters: backup_filter() }).await;
        let Some(chosen) = chosen else { return Ok(json!({ "status": "cancelled" })) };
        self.trusted()?;
        let target = files::inspect_destination(&chosen, &self.config.protected_roots, ".pombak")?;
        if target.original.is_some() { return Ok(ipc::error_response(&Failure::plain("バックアップは上書きしません。新しいファイル名で保存してください。"))); }
        let bytes = self.with_store(|store, _| backups::create_archive(store, &self.config.user_data.join("backup-staging"), &self.config.version))?;
        self.trusted()?;
        let temporary = files::commit_workbook(&target, &bytes, &mut || self.trusted(), &HostFs(&*self.host))?;
        self.meta.record_backup();
        Ok(json!({ "status": "ok", "data": match temporary {
            None => "バックアップを保存しました。暗号化されていないため安全な場所で保管してください。".to_string(),
            Some(name) => format!("バックアップは保存確定済みです。保存先の「{name}」だけが残りました。アプリを終了し、完成した.pombakは残して、この一時ファイルだけを削除してください。削除するまでは同じ出力名を再利用しないでください。"),
        } }))
    }

    async fn backup_inspect(&self, args: &[Value]) -> Value {
        self.backup_run(BackupOp::Inspect, async {
            validate::tuple(args, 0)?;
            self.lock().inspected = None;
            let chosen = self.host.open_file(Parent::Main, OpenDialog { title: "復元するバックアップを検査".into(), filters: backup_filter() }).await;
            let Some(chosen) = chosen else { return Ok(json!({ "status": "cancelled" })) };
            let checked = backups::inspect_archive(&chosen, &self.config.user_data.join("backup-staging"), &self.config.version)?;
            self.trusted()?;
            let id = js::random_uuid();
            self.lock().inspected = Some((id.clone(), checked.directory.clone(), checked.sha256.clone()));
            Ok(json!({ "status": "ok", "data": { "id": id, "createdAt": checked.created_at, "materials": checked.materials, "documents": checked.documents } }))
        }).await
    }

    async fn backup_restore(&self, args: &[Value]) -> Value {
        self.backup_run(BackupOp::Restore, async {
            let id = validate::uuid(&validate::tuple(args, 1)?[0])?;
            let candidate = self.lock().inspected.clone();
            let Some(candidate) = candidate.filter(|c| c.0 == id) else { return Ok(ipc::error_response(&Failure::plain("この画面でバックアップを選び直し、検査してください。"))) };
            self.lock().gate.freeze()?;
            let answer = self.host.message_box(Parent::Main, MessageBox {
                kind: MessageKind::Warning, title: Some("バックアップへ復元".into()), message: "現在の全データを退避し、検査したバックアップへ置き換えます。".into(),
                detail: Some("復元後はアプリを終了します。もう一度起動してください。現在のDB・履歴は退避先へ保持します。".into()), buttons: vec!["戻る".into(), "復元して終了".into()], default_id: 0, cancel_id: 0,
            }).await;
            if answer != 1 { self.lock().gate.thaw(); return Ok(json!({ "status": "cancelled" })); }
            if let Err(error) = self.trusted() { self.lock().gate.thaw(); return Err(error); }
            let outcome = {
                let mut inner = self.lock();
                inner.inspected = None;
                backups::begin_restore(&mut inner.store, &candidate.1, &candidate.2, &self.config.user_data, &mut |point| if self.host.fault(&format!("restore:{point:?}").to_lowercase()) { Err(Error::other("injected restore fault")) } else { Ok(()) })
            };
            let message = if outcome.is_ok() { "復元しました。アプリを終了します。もう一度起動して内容を確認してください。復元前のデータは保存場所に退避しています。" } else { "復元を完了できませんでした。アプリを終了します。次回起動時に切替記録を確認し、未完了なら旧データへ回復します。保存場所のDB・退避フォルダー・復元記録を削除しないでください。起動できない場合はそのまま保全して相談してください。" };
            self.host.message_box(Parent::Main, MessageBox { kind: MessageKind::Info, title: None, message: message.into(), detail: None, buttons: vec!["終了する".into()], default_id: 0, cancel_id: 0 }).await;
            self.host.quit_after_restore();
            Ok(json!({ "status": "ok", "data": Value::Null }))
        }).await
    }

    fn backup_status(&self, args: &[Value]) -> Value {
        if self.trusted().is_err() || !args.is_empty() { return ipc::error_response(&Failure::plain("最終バックアップ日時を確認できませんでした。")); }
        json!({ "status": "ok", "data": { "lastCreatedAt": self.meta.last_backup_at() } })
    }

    // ---- imports ----

    async fn imports(self: &Arc<Self>, op: ImportsOp, args: &[Value]) -> Value {
        let result = async {
            self.trusted()?;
            let _gate = self.acquire()?;
            self.imports_action(op, args).await
        }.await;
        ipc::reply(Channel::Imports(op), result)
    }

    fn imports_selected(&self, id: &str) -> Result<()> {
        if self.lock().imports_opened.contains(id) { Ok(()) } else { Err(Error::import(crate::error::ImportCode::Validation, "履歴から取込内容を開いてください。")) }
    }

    fn imports_expose(&self, review: imports::repository::ImportReview) -> Value {
        self.lock().imports_opened.insert(review.batch.id.clone());
        to_value(&review)
    }

    /// 初回取込・更新取込の「Excelを選んで解析」。同時に1つだけ（`chooser` で系統ごとの印を切り替える）。
    async fn stage_source(&self, chooser: Chooser, busy: &str, pick: impl Future<Output = Option<PathBuf>>, stage: impl FnOnce(&imports::source::Source) -> Result<Value>) -> Result<Option<Value>> {
        {
            let mut inner = self.lock();
            let choosing = chooser.flag(&mut inner);
            if *choosing { return Err(Error::import(crate::error::ImportCode::Conflict, busy)); }
            *choosing = true;
        }
        let result = async {
            let Some(file) = pick.await else { return Ok(None) };
            let source = imports::source::inspect_source(&file)?;
            self.trusted()?;
            Ok(Some(stage(&source)?))
        }.await;
        *chooser.flag(&mut self.lock()) = false;
        result
    }

    async fn imports_stage(&self, pick: impl Future<Output = Option<PathBuf>>) -> Result<Option<Value>> {
        self.stage_source(Chooser::Imports, "別のExcelを確認中です。", pick, |source| {
            let review = self.with_store(|store, _| imports::repository::stage(store, &source.parsed, &source.display_name, &source.hash))?;
            Ok(self.imports_expose(review))
        }).await
    }

    async fn imports_action(&self, op: ImportsOp, args: &[Value]) -> Result<Option<Value>> {
        use imports::repository as repo;
        match op {
            ImportsOp::Choose => {
                validate::tuple(args, 0)?;
                let host = self.host.clone();
                self.imports_stage(async move { host.open_file(Parent::Main, OpenDialog { title: "初回取込のExcelを選択".into(), filters: excel_filter() }).await }).await
            }
            ImportsOp::ChooseFromPath => {
                let file = imports::source::dropped_workbook_path(&validate::tuple(args, 1)?[0])?;
                self.imports_stage(async move { Some(file) }).await
            }
            ImportsOp::List => { validate::tuple(args, 0)?; Ok(Some(to_value(&self.with_store(|store, _| repo::list(store))?))) }
            ImportsOp::Review => {
                let id = validate::uuid(&validate::tuple(args, 1)?[0])?;
                let review = self.with_store(|store, _| repo::review(store, &id))?;
                Ok(Some(self.imports_expose(review)))
            }
            ImportsOp::Cancel => {
                let id = validate::uuid(&validate::tuple(args, 1)?[0])?;
                self.imports_selected(&id)?;
                Ok(Some(to_value(&self.with_store(|store, _| repo::cancel(store, &id))?)))
            }
            ImportsOp::Resume => {
                let id = validate::uuid(&validate::tuple(args, 1)?[0])?;
                self.imports_selected(&id)?;
                let review = self.with_store(|store, _| repo::resume(store, &id))?;
                Ok(Some(self.imports_expose(review)))
            }
            ImportsOp::Apply => {
                let input = &validate::tuple(args, 1)?[0];
                let o = validate::strict(input, &["batchId", "acceptedIds"])?;
                let batch_id = o.uuid("batchId")?;
                validate::array(o.req("acceptedIds")?, 10_000)?.iter().map(validate::uuid).collect::<Result<Vec<_>>>()?;
                self.imports_selected(&batch_id)?;
                Ok(Some(to_value(&self.with_store(|store, _| repo::apply(store, input))?)))
            }
        }
    }

    // ---- master / reimport ----

    async fn master(self: &Arc<Self>, op: MasterOp, args: &[Value]) -> Value {
        let result = async {
            self.trusted()?;
            let _gate = self.acquire()?;
            self.master_action(op, args).await
        }.await;
        ipc::reply(Channel::Master(op), result)
    }

    fn master_selected(&self, id: &str) -> Result<()> {
        if self.lock().master_opened.contains(id) { Ok(()) } else { Err(Error::import(crate::error::ImportCode::Validation, "履歴から今回の取込を開いてください。")) }
    }

    fn master_expose(&self, review: reimport::ReimportReview) -> Value {
        self.lock().master_opened.insert(review.batch.id.clone());
        to_value(&review)
    }

    async fn master_stage(&self, series_id: &str, pick: impl Future<Output = Option<PathBuf>>) -> Result<Option<Value>> {
        self.with_store(|store, _| reimport::head(store, series_id))?;
        self.stage_source(Chooser::Master, "別のExcelを解析中です。", pick, |source| {
            let review = self.with_store(|store, _| reimport::stage(store, series_id, &source.parsed, &source.display_name, &source.hash))?;
            Ok(self.master_expose(review))
        }).await
    }

    async fn master_action(&self, op: MasterOp, args: &[Value]) -> Result<Option<Value>> {
        match op {
            MasterOp::Get => {
                let id = validate::nullable(&validate::tuple(args, 1)?[0], validate::uuid)?;
                Ok(Some(to_value(&self.with_store(|store, inner| inner.master.get(store, id.as_deref()))?)))
            }
            MasterOp::Save => {
                let value = &validate::tuple(args, 1)?[0];
                Ok(Some(to_value(&self.with_store(|store, inner| inner.master.save(store, value))?)))
            }
            MasterOp::Delete => {
                let ids = materials::parse_material_ids(&validate::tuple(args, 1)?[0])?;
                Ok(Some(json!({ "deleted": self.with_store(|store, _| materials::delete(store, &ids))? })))
            }
            MasterOp::Series => { validate::tuple(args, 0)?; Ok(Some(to_value(&self.with_store(|store, _| reimport::series(store))?))) }
            MasterOp::List => { validate::tuple(args, 0)?; Ok(Some(to_value(&self.with_store(|store, _| reimport::list(store))?))) }
            MasterOp::Review => {
                let id = validate::uuid(&validate::tuple(args, 1)?[0])?;
                let review = self.with_store(|store, _| reimport::review(store, &id))?;
                Ok(Some(self.master_expose(review)))
            }
            MasterOp::Cancel => {
                let id = validate::uuid(&validate::tuple(args, 1)?[0])?;
                self.master_selected(&id)?;
                Ok(Some(to_value(&self.with_store(|store, _| reimport::cancel(store, &id))?)))
            }
            MasterOp::Resume => {
                let id = validate::uuid(&validate::tuple(args, 1)?[0])?;
                self.master_selected(&id)?;
                let review = self.with_store(|store, _| reimport::resume(store, &id))?;
                Ok(Some(self.master_expose(review)))
            }
            MasterOp::Apply => {
                let value = &validate::tuple(args, 1)?[0];
                self.master_selected(&validate::loose(value)?.uuid("batchId")?)?;
                Ok(Some(to_value(&self.with_store(|store, _| reimport::apply(store, value))?)))
            }
            MasterOp::Choose => {
                let id = validate::uuid(&validate::tuple(args, 1)?[0])?;
                let host = self.host.clone();
                self.master_stage(&id, async move { host.open_file(Parent::Main, OpenDialog { title: "同じ取込元の変更Excelを選択".into(), filters: excel_filter() }).await }).await
            }
            MasterOp::ChooseFromPath => {
                let args = validate::tuple(args, 2)?;
                let id = validate::uuid(&args[0])?;
                let file = imports::source::dropped_workbook_path(&args[1])?;
                self.master_stage(&id, async move { Some(file) }).await
            }
        }
    }

    // ---- materials:search・materials:categories ----

    /// 検索系の要求（引数1つ）の応答。
    fn search_reply<T: Serialize>(&self, channel: Channel, args: &[Value], action: fn(&Store, &Value) -> Result<T>) -> Value {
        let result = (|| {
            self.trusted()?;
            let input = &validate::tuple(args, 1)?[0];
            Ok(Some(to_value(&self.with_store(|store, _| action(store, input))?)))
        })();
        ipc::reply(channel, result)
    }

    // ---- documents ----

    fn documents(&self, op: DocumentsOp, args: &[Value]) -> Value {
        let result = (|| -> Result<Value> {
            self.trusted()?;
            let _gate = self.acquire()?;
            let single = || -> Result<&Value> { Ok(&validate::tuple(args, 1)?[0]) };
            match op {
                DocumentsOp::Open => Ok(to_value(&self.with_store(|store, inner| inner.editor.open(store, single()?, false))?)),
                DocumentsOp::Duplicate => Ok(to_value(&self.with_store(|store, inner| inner.editor.duplicate(store, single()?))?)),
                DocumentsOp::List => {
                    if args.len() != 1 && args.len() != 2 { return Err(Error::invalid("tuple length")); }
                    Ok(to_value(&self.with_store(|store, inner| inner.editor.list(store, &args[0], args.get(1), Some(&self.meta)))?))
                }
                DocumentsOp::Delete => {
                    let ids = parse_document_ids(single()?)?;
                    let deleted = self.with_store(|store, inner| inner.editor.delete(store, &ids))?;
                    self.meta.forget_exports(&ids);
                    Ok(json!({ "deleted": deleted }))
                }
                DocumentsOp::AddLine => Ok(to_value(&self.with_store(|store, inner| inner.editor.add_line(store, single()?))?)),
                DocumentsOp::Save => Ok(to_value(&self.with_store(|store, inner| inner.editor.save(store, single()?))?)),
                DocumentsOp::Close => {
                    let token = validate::uuid(single()?)?;
                    let mut inner = self.lock();
                    if inner.close_token.as_deref() != Some(token.as_str()) { return Err(Error::db(DbCode::Validation, "終了確認が一致しません。")); }
                    inner.close_token = None;
                    inner.closing = true;
                    drop(inner);
                    self.host.close_main_window();
                    Ok(Value::Null)
                }
            }
        })();
        ipc::reply(Channel::Documents(op), result.map(Some))
    }

    /// ウィンドウを閉じようとしたとき。true なら閉じてよい（終了確認済み）。false なら画面へ確認を求めた。
    pub fn request_close(&self) -> bool {
        let mut inner = self.lock();
        if inner.closing { return true; }
        let token = inner.close_token.get_or_insert_with(js::random_uuid).clone();
        drop(inner);
        self.host.emit_close_requested(&token);
        false
    }

    /// 画面が応答しない・異常終了したときの強制終了。
    pub fn force_closing(&self) { self.lock().closing = true; }
    pub fn is_closing(&self) -> bool { self.lock().closing }

    // ---- Excel 出力 ----

    async fn export_excel(&self, args: &[Value]) -> Value {
        let rejected = || ipc::error_response(&Failure::coded("VALIDATION", "この画面からの出力要求は受け付けられません。"));
        if self.trusted().is_err() || args.len() != 1 { return rejected(); }
        let Ok(_gate) = self.acquire() else { return rejected() };
        let result = self.exporter(&args[0]).await;
        if result.get("status") == Some(&json!("ok")) {
            if let (Some(id), Some(revision)) = (result.get("documentId").and_then(Value::as_str), result.get("revision").and_then(Value::as_i64)) { self.meta.record_export(id, revision); }
        }
        result
    }

    async fn exporter(&self, input: &Value) -> Value {
        {
            let mut inner = self.lock();
            if inner.export_busy { return ipc::error_response(&Failure::coded("BUSY", "Excel出力の終了を待ってください。")); }
            inner.export_busy = true;
        }
        let result = self.export_steps(input).await;
        self.lock().export_busy = false;
        match result {
            Ok(value) => value,
            Err(caught) => {
                let cleanup = if let Error::ExportCleanup { temporary_name, .. } = &caught { Some(temporary_name.clone()) } else { None };
                let mut value = ipc::error_response(&ipc::failure(Channel::ExportExcel, &caught));
                if let Some(name) = cleanup { value["cleanup"] = json!({ "temporaryName": name }); }
                value
            }
        }
    }

    async fn export_steps(&self, input: &Value) -> Result<Value> {
        let request = exports::parse_export_request(input)?;
        let (model, issues) = self.with_store(|store, _| exports::saved_print_model(store, &request))?;
        if !issues.is_empty() { return Ok(json!({ "status": "blocked", "issues": issues })); }
        let bytes = exports::build_workbook(&model)?;
        let envelope = exports::workbook_envelope(&bytes)?;
        let selected = self.host.save_file(Parent::Main, SaveDialog { title: "Excelを出力".into(), default_path: self.config.documents_dir.join("請求書.xlsx"), filters: excel_filter() }).await;
        let Some(selected) = selected else { return Ok(json!({ "status": "cancelled" })) };
        let target = files::inspect_destination(&selected, &self.config.protected_roots, ".xlsx")?;
        if target.original.is_some() {
            exports::assert_generated_envelope(&exports::workbook_envelope(&std::fs::read(&target.file)?)?, &envelope)?;
            let answer = self.host.message_box(Parent::Main, MessageBox { kind: MessageKind::Warning, title: Some("出力ファイルの上書き確認".into()), message: "選択した出力ファイルを今回の保存版で置き換えますか？".into(), detail: None, buttons: vec!["戻る".into(), "上書きする".into()], default_id: 0, cancel_id: 0 }).await;
            if answer != 1 { return Ok(json!({ "status": "cancelled" })); }
        }
        files::assert_destination_current(&target)?;
        let temporary = self.with_store(|store, _| files::commit_workbook(&target, &bytes, &mut || {
            let (current, issues) = exports::saved_print_model(store, &request)?;
            if !issues.is_empty() || current != model { return Err(Error::db(DbCode::Conflict, "保存版または出力条件が変わりました。出力をやり直してください。")); }
            Ok(())
        }, &HostFs(&*self.host)))?;
        Ok(json!({ "status": "ok", "cleanup": temporary.map(|name| json!({ "temporaryName": name })), "documentId": request.document_id, "revision": request.revision }))
    }

    // ---- 印刷・PDF ----

    async fn print_preview(self: &Arc<Self>, args: &[Value]) -> Value {
        if self.lock().print_active { return ipc::error_response(&Failure::plain("開いている印刷プレビューを閉じてください。")); }
        let result = self.print_steps(args).await;
        self.lock().print_active = false;
        match result {
            Ok(value) => value,
            Err(error) => ipc::error_response(&ipc::failure(Channel::PrintPreview, &error)),
        }
    }

    async fn print_steps(self: &Arc<Self>, args: &[Value]) -> Result<Value> {
        self.trusted()?;
        if args.len() != 1 { return Err(Error::invalid("args")); }
        let _gate = self.acquire()?;
        let request = exports::parse_export_request(&args[0])?;
        let (model, issues) = self.with_store(|store, _| exports::saved_print_model(store, &request))?;
        if !issues.is_empty() { return Ok(json!({ "status": "blocked", "issues": issues })); }
        // Excel と同じ文字・容量の制約をウィンドウを作る前に確かめる。
        exports::build_workbook(&model)?;
        self.lock().print_active = true;
        let id = js::random_uuid();
        let session = Arc::new(PrintSession { app: self.clone(), request, model, url: self.host.preview_url(&id), id, status: Mutex::new(String::new()), working: Mutex::new(false) });
        self.host.open_print_preview(session).await.map_err(Error::other)?;
        Ok(json!({ "status": "closed" }))
    }

    /// 保存版が出力準備時と同じか（印刷・PDFの各段階で確かめる）。
    fn verify_print(&self, request: &exports::ExportRequest, model: &exports::PrintModel) -> Result<()> {
        let (current, issues) = self.with_store(|store, _| exports::saved_print_model(store, request))?;
        if !issues.is_empty() || &current != model { return Err(Error::other("Saved revision changed")); }
        Ok(())
    }

    /// PDF を保存する（savePdf）。戻り値はプレビューに表示する文言。
    pub async fn save_pdf(&self, bytes: Vec<u8>, verify: &(dyn Fn() -> Result<()> + Send + Sync)) -> String {
        let result = async {
            if bytes.len() > crate::limits::PDF_MAX || !bytes.starts_with(b"%PDF-") { return Err(Error::file("PDFの形式または容量を確認できませんでした。保存していません。")); }
            verify()?;
            let selected = self.host.save_file(Parent::Preview, SaveDialog { title: "PDFを保存".into(), default_path: self.config.documents_dir.join("請求書.pdf"), filters: vec![FileFilter { name: "PDF".into(), extensions: vec!["pdf".into()] }] }).await;
            let Some(selected) = selected else { return Ok("PDF保存を取り消しました。".to_string()) };
            let target = files::inspect_destination(&selected, &self.config.protected_roots, ".pdf")?;
            if target.original.is_some() {
                let original = std::fs::read(&target.file)?;
                if !original.starts_with(b"%PDF-") || !original.ends_with(printing::PDF_MARKER) { return Err(Error::file("このアプリの形式以外のPDFは上書きできません。別名で保存してください。")); }
                let answer = self.host.message_box(Parent::Preview, MessageBox { kind: MessageKind::Warning, title: None, message: "既存PDFをこの保存版で上書きしますか？".into(), detail: None, buttons: vec!["戻る".into(), "上書きする".into()], default_id: 0, cancel_id: 0 }).await;
                if answer != 1 { return Ok("上書きを取り消しました。既存PDFは保持されています。".to_string()); }
            }
            files::assert_destination_current(&target)?;
            let mut content = bytes.clone();
            content.extend_from_slice(printing::PDF_MARKER);
            let remaining = files::commit_workbook(&target, &content, &mut || verify(), &HostFs(&*self.host))?;
            Ok(match remaining { None => "PDFを保存しました。紙への印刷は行っていません。".to_string(), Some(name) => format!("PDFは出力確定済みです。一時ファイルが残りました。{}", printing::pdf_recovery(&name)) })
        }.await;
        match result {
            Ok(message) => message,
            Err(Error::ExportCleanup { temporary_name, .. }) => format!("PDFは出力未確定です。既存ファイルは保持されています。{}", printing::pdf_recovery(&temporary_name)),
            Err(Error::ExportFile(message)) => message,
            Err(_) => "PDFを保存できませんでした。既存ファイルは保持されています。保存先の空き容量・アクセス権・使用状態を確認して再試行してください。".to_string(),
        }
    }
}

/// 開いている印刷プレビュー（1つだけ）。
pub struct PrintSession {
    app: Arc<App>,
    request: exports::ExportRequest,
    model: exports::PrintModel,
    pub id: String,
    pub url: String,
    status: Mutex<String>,
    working: Mutex<bool>,
}

impl PrintSession {
    /// 表示するページ（HTML）と、付けるCSP。
    pub fn page(&self) -> (String, String) {
        let status = self.status.lock().unwrap_or_else(|e| e.into_inner()).clone();
        (printing::print_html(&self.model, &self.url, &status), printing::page_style(&self.model).1.to_string())
    }

    /// 出力処理中はウィンドウを閉じさせない。
    pub fn is_working(&self) -> bool { *self.working.lock().unwrap_or_else(|e| e.into_inner()) }

    fn set_status(&self, text: &str) { *self.status.lock().unwrap_or_else(|e| e.into_inner()) = text.to_string(); }

    /// ページ内のリンク（{url}/close・/print・/save）を押したとき。
    pub async fn action(&self, name: &str, window: &dyn PreviewWindow) {
        if self.is_working() || !window.is_open() { return; }
        if name == "close" { window.close(); return; }
        if name != "save" && name != "print" { return; }
        *self.working.lock().unwrap_or_else(|e| e.into_inner()) = true;
        let app = &self.app;
        let verify = || app.verify_print(&self.request, &self.model);
        let result = async {
            self.set_status(if name == "save" { "PDFを作成しています。完了するまでお待ちください。" } else { "プリンターの選択・印刷結果を待っています。" });
            window.reload().await;
            verify()?;
            if name == "save" {
                let bytes = window.print_to_pdf().await.map_err(Error::other)?;
                verify()?;
                let message = app.save_pdf(bytes, &verify).await;
                self.set_status(&message);
            } else {
                let message = match window.print().await {
                    PrintOutcome::Accepted => "印刷処理を受け付けました。紙への印刷完了はプリンターで確認してください。",
                    PrintOutcome::Cancelled => "印刷を取り消しました。",
                    PrintOutcome::Failed => "印刷処理を確認できませんでした。プリンターと印刷キューを確認してから再試行してください。",
                };
                self.set_status(message);
            }
            Ok::<(), Error>(())
        }.await;
        if result.is_err() { self.set_status("出力を完了できませんでした。最新の保存版・出力条件・プリンターを確認してください。"); }
        *self.working.lock().unwrap_or_else(|e| e.into_inner()) = false;
        if window.is_open() { window.reload().await; }
    }
}

/// 起動時の処理: 保存場所を用意し（Electron は起動時に userData を作っていた）、中断した復元の回復と、DBを開く。
pub fn start(user_data: &Path) -> Result<(Option<String>, Store)> {
    std::fs::create_dir_all(user_data)?;
    let notice = backups::recover_restore(user_data)?;
    let store = Store::open_default(&user_data.join("database"))?;
    Ok((notice, store))
}
