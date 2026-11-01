//! IPC のチャネル名の一覧と、エラーから応答への変換（`code`・`message`）。
//! 応答のエラーはすべてここで組み立てる。系統ごとの違いは `failure` の表に集めてある（spec/03-ipc-api.md「応答の形」）。

use serde_json::{json, Value};

use crate::error::{DbCode, Error};
use crate::js;
use crate::limits::QUERY_MAX;

/// 送り主を信頼できないとき（`app:info` はこの文字列で reject する）。
pub const REJECTED: &str = "APP_INFO_REQUEST_REJECTED";

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum BackupOp { Create, Inspect, Restore, Status }

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ImportsOp { Choose, ChooseFromPath, List, Review, Apply, Cancel, Resume }

/// 材料台帳（`master:*`）と更新取込（`reimport:*`）。
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum MasterOp { Get, Save, Delete, Series, Choose, ChooseFromPath, List, Review, Apply, Cancel, Resume }

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum DocumentsOp { Open, Duplicate, List, Delete, AddLine, Save, Close }

/// 画面から受け付けるチャネル。`parse` に無い名前は受け付けない（`match` は網羅するので、足し忘れはコンパイルで分かる）。
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Channel {
    AppInfo,
    Backup(BackupOp),
    Imports(ImportsOp),
    Master(MasterOp),
    MaterialsSearch,
    MaterialsCategories,
    Documents(DocumentsOp),
    ExportExcel,
    PrintPreview,
}

impl Channel {
    pub fn parse(name: &str) -> Option<Channel> {
        use Channel::*;
        Some(match name {
            "app:info" => AppInfo,
            "backups:create" => Backup(BackupOp::Create),
            "backups:inspect" => Backup(BackupOp::Inspect),
            "backups:restore" => Backup(BackupOp::Restore),
            "backups:status" => Backup(BackupOp::Status),
            "imports:choose" => Imports(ImportsOp::Choose),
            "imports:choose-from-path" => Imports(ImportsOp::ChooseFromPath),
            "imports:list" => Imports(ImportsOp::List),
            "imports:review" => Imports(ImportsOp::Review),
            "imports:apply" => Imports(ImportsOp::Apply),
            "imports:cancel" => Imports(ImportsOp::Cancel),
            "imports:resume" => Imports(ImportsOp::Resume),
            "master:get" => Master(MasterOp::Get),
            "master:save" => Master(MasterOp::Save),
            "master:delete" => Master(MasterOp::Delete),
            "reimport:series" => Master(MasterOp::Series),
            "reimport:choose" => Master(MasterOp::Choose),
            "reimport:choose-from-path" => Master(MasterOp::ChooseFromPath),
            "reimport:list" => Master(MasterOp::List),
            "reimport:review" => Master(MasterOp::Review),
            "reimport:apply" => Master(MasterOp::Apply),
            "reimport:cancel" => Master(MasterOp::Cancel),
            "reimport:resume" => Master(MasterOp::Resume),
            "materials:search" => MaterialsSearch,
            "materials:categories" => MaterialsCategories,
            "documents:open" => Documents(DocumentsOp::Open),
            "documents:duplicate" => Documents(DocumentsOp::Duplicate),
            "documents:list" => Documents(DocumentsOp::List),
            "documents:delete" => Documents(DocumentsOp::Delete),
            "documents:add-line" => Documents(DocumentsOp::AddLine),
            "documents:save" => Documents(DocumentsOp::Save),
            "documents:close" => Documents(DocumentsOp::Close),
            "documents:export-excel" => ExportExcel,
            "documents:print-preview" => PrintPreview,
            _ => return None,
        })
    }

    pub fn name(self) -> &'static str {
        use Channel::*;
        match self {
            AppInfo => "app:info",
            Backup(BackupOp::Create) => "backups:create",
            Backup(BackupOp::Inspect) => "backups:inspect",
            Backup(BackupOp::Restore) => "backups:restore",
            Backup(BackupOp::Status) => "backups:status",
            Imports(ImportsOp::Choose) => "imports:choose",
            Imports(ImportsOp::ChooseFromPath) => "imports:choose-from-path",
            Imports(ImportsOp::List) => "imports:list",
            Imports(ImportsOp::Review) => "imports:review",
            Imports(ImportsOp::Apply) => "imports:apply",
            Imports(ImportsOp::Cancel) => "imports:cancel",
            Imports(ImportsOp::Resume) => "imports:resume",
            Master(MasterOp::Get) => "master:get",
            Master(MasterOp::Save) => "master:save",
            Master(MasterOp::Delete) => "master:delete",
            Master(MasterOp::Series) => "reimport:series",
            Master(MasterOp::Choose) => "reimport:choose",
            Master(MasterOp::ChooseFromPath) => "reimport:choose-from-path",
            Master(MasterOp::List) => "reimport:list",
            Master(MasterOp::Review) => "reimport:review",
            Master(MasterOp::Apply) => "reimport:apply",
            Master(MasterOp::Cancel) => "reimport:cancel",
            Master(MasterOp::Resume) => "reimport:resume",
            MaterialsSearch => "materials:search",
            MaterialsCategories => "materials:categories",
            Documents(DocumentsOp::Open) => "documents:open",
            Documents(DocumentsOp::Duplicate) => "documents:duplicate",
            Documents(DocumentsOp::List) => "documents:list",
            Documents(DocumentsOp::Delete) => "documents:delete",
            Documents(DocumentsOp::AddLine) => "documents:add-line",
            Documents(DocumentsOp::Save) => "documents:save",
            Documents(DocumentsOp::Close) => "documents:close",
            ExportExcel => "documents:export-excel",
            PrintPreview => "documents:print-preview",
        }
    }
}

/// エラーの応答の中身。`code` が無い系統（バックアップ・印刷）は `status` と `message` だけの応答になる。
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Failure { pub code: Option<&'static str>, pub message: String }

impl Failure {
    pub fn coded(code: &'static str, message: impl Into<String>) -> Self { Failure { code: Some(code), message: message.into() } }
    pub fn plain(message: impl Into<String>) -> Self { Failure { code: None, message: message.into() } }
}

/// エラーの応答の組み立て（唯一の場所）。`code` があれば `correlationId`（記録・突き合わせ用）も付ける。
pub fn error_response(failure: &Failure) -> Value {
    match failure.code {
        Some(code) => json!({ "status": "error", "code": code, "message": failure.message, "correlationId": js::random_uuid() }),
        None => json!({ "status": "error", "message": failure.message }),
    }
}

/// 処理の結果（`None` は取消）から応答を作る。取込・材料台帳・検索・請求書が使う。
pub fn reply(channel: Channel, result: Result<Option<Value>, Error>) -> Value {
    match result {
        Ok(None) => json!({ "status": "cancelled" }),
        Ok(Some(data)) => json!({ "status": "ok", "data": data }),
        Err(error) => error_response(&failure(channel, &error)),
    }
}

const IMPORT_FAILED: &str = "処理できませんでした。ファイルや保存場所を確認し、履歴から再試行してください。";
const MASTER_FAILED: &str = "処理できませんでした。入力と原記録は保持されています。保存場所を確認して再試行してください。";
const BACKUP_FAILED: &str = "処理できませんでした。ほかの処理や印刷プレビューを閉じ、バックアップの形式・版・空き容量・保存先を確認してください。現在のDBは削除しないでください。";
const DOCUMENT_SAVE_FAILED: &str = "保存できませんでした。入力は保持されています。保存場所を確認して再試行してください。";
const EXPORT_FAILED: &str = "Excelを出力できませんでした。保存先の空き容量・アクセス権・ファイルの使用状態を確認し、再試行してください。";
const PRINT_FAILED: &str = "印刷プレビューを開けませんでした。保存版・文字量・出力条件を確認してください。";

/// エラーを `(code, message)` に対応づける表。チャネルの系統ごとに現状の対応を保っている。
pub fn failure(channel: Channel, error: &Error) -> Failure {
    match channel {
        Channel::AppInfo => Failure::plain(REJECTED),
        Channel::Backup(_) => Failure::plain(match error {
            Error::Gate(message) | Error::Backup(message) => message.clone(),
            Error::ExportCleanup { temporary_name, .. } => format!("保存は確定していません。保存先の自作一時ファイル「{temporary_name}」だけが残りました。アプリを終了し、完成ファイルを削除せず、その一時ファイルだけを削除して別名で再試行してください。"),
            _ => BACKUP_FAILED.to_string(),
        }),
        Channel::Imports(_) => match error {
            Error::Import(code, message) => Failure::coded(code.as_str(), message.clone()),
            Error::Validation(_) => Failure::coded("VALIDATION", IMPORT_FAILED),
            _ => Failure::coded("IO", IMPORT_FAILED),
        },
        // 削除は1つの文で行うため、失敗したときは1件も削除していない。
        Channel::Master(MasterOp::Delete) => match error {
            Error::Gate(message) => Failure::coded("DB", message.clone()),
            Error::Validation(_) => Failure::coded("VALIDATION", "削除する材料を選び直してください。"),
            _ => Failure::coded("DB", "材料を削除できませんでした。削除はしていません。保存場所を確認して再試行してください。"),
        },
        Channel::Master(_) => match error {
            Error::Import(code, message) => Failure::coded(code.as_str(), message.clone()),
            Error::Db(_, message) => Failure::coded("VALIDATION", message.clone()),
            Error::Validation(_) => Failure::coded("VALIDATION", MASTER_FAILED),
            _ => Failure::coded("IO", MASTER_FAILED),
        },
        Channel::MaterialsSearch | Channel::MaterialsCategories => {
            let invalid = matches!(error, Error::Validation(_) | Error::Db(..));
            let search = channel == Channel::MaterialsSearch;
            match (invalid, search) {
                (true, true) => Failure::coded("VALIDATION", format!("検索条件を確認してください。検索語は{QUERY_MAX}文字以内です。")),
                (true, false) => Failure::coded("VALIDATION", format!("カテゴリの検索条件を確認してください。検索語は{QUERY_MAX}文字以内です。")),
                (false, true) => Failure::coded("DB", "検索できませんでした。もう一度検索してください。"),
                (false, false) => Failure::coded("DB", "カテゴリを読み込めませんでした。もう一度お試しください。"),
            }
        }
        Channel::Documents(op) => match error {
            Error::Db(code @ (DbCode::Conflict | DbCode::NotFound | DbCode::Validation), message) => Failure::coded(code.as_str(), message.clone()),
            Error::Db(_, message) => Failure::coded("DB", message.clone()),
            Error::Validation(_) => Failure::coded("VALIDATION", "入力値や文字数を確認してください。"),
            // 削除はトランザクションごと取り消すため、失敗したときは1件も削除していない。
            Error::Gate(message) if op == DocumentsOp::Delete => Failure::coded("DB", message.clone()),
            _ if op == DocumentsOp::Delete => Failure::coded("DB", "請求書を削除できませんでした。削除はしていません。保存場所を確認して再試行してください。"),
            _ => Failure::coded("DB", DOCUMENT_SAVE_FAILED),
        },
        Channel::ExportExcel => {
            let error = match error { Error::ExportCleanup { cause, .. } => cause.as_ref(), other => other };
            let code = match error { Error::Validation(_) | Error::Workbook(_) => "VALIDATION", Error::Db(DbCode::Conflict, _) => "CONFLICT", Error::Db(DbCode::NotFound, _) => "NOT_FOUND", _ => "IO" };
            Failure::coded(code, match error {
                Error::Workbook(_) => "出力できない文字・文字量または帳票形式です。入力内容は保持されています。制御文字・文字数・帳票形式を確認してください。".to_string(),
                Error::Db(_, message) | Error::ExportFile(message) => message.clone(),
                Error::ExportCleanup { .. } => "出力確定前の処理と一時ファイルの削除に失敗しました。".to_string(),
                Error::Validation(_) => "保存済み帳票と版を指定してください。".to_string(),
                _ => EXPORT_FAILED.to_string(),
            })
        }
        Channel::PrintPreview => Failure::plain(PRINT_FAILED),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::error::{ImportCode, WorkbookCode};

    fn imports() -> Channel { Channel::Imports(ImportsOp::List) }
    fn master() -> Channel { Channel::Master(MasterOp::Save) }
    fn documents() -> Channel { Channel::Documents(DocumentsOp::Save) }

    #[test]
    fn import_errors_keep_their_own_code_and_other_errors_become_io() {
        let conflict = Error::import(ImportCode::Conflict, "別のExcelを確認中です。");
        assert_eq!(failure(imports(), &conflict), Failure::coded("CONFLICT", "別のExcelを確認中です。"));
        assert_eq!(failure(imports(), &Error::invalid("x")).code, Some("VALIDATION"));
        assert_eq!(failure(imports(), &Error::other("x")), Failure::coded("IO", IMPORT_FAILED));
    }

    #[test]
    fn master_maps_database_errors_to_validation_but_delete_to_db() {
        let not_found = Error::db(DbCode::NotFound, "材料が見つかりません。");
        assert_eq!(failure(master(), &not_found), Failure::coded("VALIDATION", "材料が見つかりません。"));
        assert_eq!(failure(Channel::Master(MasterOp::Delete), &Error::other("x")).code, Some("DB"));
        assert_eq!(failure(Channel::Master(MasterOp::Delete), &Error::Gate("バックアップ・復元中です。完了までお待ちください。".into())), Failure::coded("DB", "バックアップ・復元中です。完了までお待ちください。"));
        // 更新取込の削除ではない系統のゲートの文言は汎用に隠れる
        assert_eq!(failure(master(), &Error::Gate("busy".into())), Failure::coded("IO", MASTER_FAILED));
    }

    #[test]
    fn documents_keep_database_codes_and_show_the_gate_message_only_for_delete() {
        assert_eq!(failure(documents(), &Error::db(DbCode::Conflict, "更新されています。")), Failure::coded("CONFLICT", "更新されています。"));
        assert_eq!(failure(documents(), &Error::db(DbCode::Schema, "x")).code, Some("DB"));
        assert_eq!(failure(documents(), &Error::Gate("busy".into())), Failure::coded("DB", DOCUMENT_SAVE_FAILED));
        assert_eq!(failure(Channel::Documents(DocumentsOp::Delete), &Error::Gate("busy".into())), Failure::coded("DB", "busy"));
    }

    #[test]
    fn search_messages_depend_on_the_channel_and_whether_the_input_was_invalid() {
        let search = failure(Channel::MaterialsSearch, &Error::invalid("x"));
        assert_eq!(search, Failure::coded("VALIDATION", "検索条件を確認してください。検索語は256文字以内です。"));
        assert_eq!(failure(Channel::MaterialsCategories, &Error::invalid("x")).message, "カテゴリの検索条件を確認してください。検索語は256文字以内です。");
        assert_eq!(failure(Channel::MaterialsSearch, &Error::other("x")), Failure::coded("DB", "検索できませんでした。もう一度検索してください。"));
    }

    #[test]
    fn export_unwraps_cleanup_errors_and_maps_codes() {
        let wrapped = Error::ExportCleanup { temporary_name: "a.tmp".into(), cause: Box::new(Error::Workbook(WorkbookCode::Limit)) };
        assert_eq!(failure(Channel::ExportExcel, &wrapped).code, Some("VALIDATION"));
        assert_eq!(failure(Channel::ExportExcel, &Error::db(DbCode::NotFound, "無い")), Failure::coded("NOT_FOUND", "無い"));
        assert_eq!(failure(Channel::ExportExcel, &Error::other("x")), Failure::coded("IO", EXPORT_FAILED));
    }

    #[test]
    fn backup_and_print_responses_have_no_code_or_correlation_id() {
        let backup = error_response(&failure(Channel::Backup(BackupOp::Create), &Error::backup("形式が不正です。")));
        assert_eq!(backup, json!({ "status": "error", "message": "形式が不正です。" }));
        let print = error_response(&failure(Channel::PrintPreview, &Error::other("x")));
        assert_eq!(print, json!({ "status": "error", "message": PRINT_FAILED }));
        let coded = error_response(&Failure::coded("DB", "x"));
        assert_eq!(coded["code"], "DB");
        assert_eq!(coded["correlationId"].as_str().map(str::len), Some(36));
    }

    #[test]
    fn reply_distinguishes_cancelled_ok_and_error() {
        assert_eq!(reply(imports(), Ok(None)), json!({ "status": "cancelled" }));
        assert_eq!(reply(imports(), Ok(Some(json!(1)))), json!({ "status": "ok", "data": 1 }));
        assert_eq!(reply(imports(), Err(Error::other("x")))["code"], "IO");
    }

    #[test]
    fn parse_rejects_unknown_and_look_alike_names() {
        assert_eq!(Channel::parse("reimport:choose-from-path"), Some(Channel::Master(MasterOp::ChooseFromPath)));
        for name in ["", "imports", "documents:Close", "documents:close ", "master:apply"] { assert_eq!(Channel::parse(name), None, "{name:?}"); }
    }
}
