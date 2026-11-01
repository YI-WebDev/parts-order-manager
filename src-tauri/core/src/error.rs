//! 旧実装の例外クラスに対応するエラー。IPC の応答では種類ごとに利用者向けの文言・コードへ変換する。

use std::fmt;

/// `DatabaseError` のコード。
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum DbCode { Conflict, NotFound, Validation, Schema, Backup }

impl DbCode {
    pub fn as_str(self) -> &'static str {
        match self { DbCode::Conflict => "CONFLICT", DbCode::NotFound => "NOT_FOUND", DbCode::Validation => "VALIDATION", DbCode::Schema => "SCHEMA", DbCode::Backup => "BACKUP" }
    }
}

/// `ImportError` のコード。
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ImportCode { Format, Limit, Changed, Conflict, Validation, Db }

impl ImportCode {
    pub fn as_str(self) -> &'static str {
        match self { ImportCode::Format => "FORMAT", ImportCode::Limit => "LIMIT", ImportCode::Changed => "CHANGED", ImportCode::Conflict => "CONFLICT", ImportCode::Validation => "VALIDATION", ImportCode::Db => "DB" }
    }
}

/// `WorkbookError` のコード。
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum WorkbookCode { Limit, Text, Layout }

#[derive(Debug)]
pub enum Error {
    /// `DatabaseError`
    Db(DbCode, String),
    /// `ImportError`
    Import(ImportCode, String),
    /// `BackupError`
    Backup(String),
    /// `DatabaseGateError`
    Gate(String),
    /// `ExportFileError`
    ExportFile(String),
    /// `ExportCleanupError`（一時ファイルを消せなかった。cause は元の失敗）
    ExportCleanup { temporary_name: String, cause: Box<Error> },
    /// `WorkbookError`
    Workbook(WorkbookCode),
    /// zod の検証エラー
    Validation(String),
    /// その他（入出力・SQLite・XML の構文など）。利用者には汎用の文言を出す。
    Other(String),
}

pub type Result<T> = std::result::Result<T, Error>;

impl Error {
    pub fn db(code: DbCode, message: impl Into<String>) -> Self { Error::Db(code, message.into()) }
    pub fn import(code: ImportCode, message: impl Into<String>) -> Self { Error::Import(code, message.into()) }
    pub fn backup(message: impl Into<String>) -> Self { Error::Backup(message.into()) }
    pub fn file(message: impl Into<String>) -> Self { Error::ExportFile(message.into()) }
    pub fn invalid(message: impl Into<String>) -> Self { Error::Validation(message.into()) }
    pub fn other(message: impl Into<String>) -> Self { Error::Other(message.into()) }

    pub fn is_validation(&self) -> bool { matches!(self, Error::Validation(_)) }
    /// `error instanceof ExportFileError`（ExportCleanupError は ExportFileError の派生）
    pub fn is_export_file(&self) -> bool { matches!(self, Error::ExportFile(_) | Error::ExportCleanup { .. }) }
}

impl fmt::Display for Error {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Error::Db(code, message) => write!(f, "DatabaseError {}: {message}", code.as_str()),
            Error::Import(code, message) => write!(f, "ImportError {}: {message}", code.as_str()),
            Error::Backup(message) => write!(f, "BackupError: {message}"),
            Error::Gate(message) => write!(f, "DatabaseGateError: {message}"),
            Error::ExportFile(message) => write!(f, "ExportFileError: {message}"),
            Error::ExportCleanup { temporary_name, cause } => write!(f, "ExportCleanupError {temporary_name}: {cause}"),
            Error::Workbook(code) => write!(f, "Workbook {code:?}"),
            Error::Validation(message) => write!(f, "ValidationError: {message}"),
            Error::Other(message) => write!(f, "Error: {message}"),
        }
    }
}

impl std::error::Error for Error {}

impl From<rusqlite::Error> for Error {
    fn from(error: rusqlite::Error) -> Self { Error::Other(format!("sqlite: {error}")) }
}

impl From<std::io::Error> for Error {
    fn from(error: std::io::Error) -> Self { Error::Other(format!("io: {error}")) }
}

impl From<serde_json::Error> for Error {
    fn from(error: serde_json::Error) -> Self { Error::Other(format!("json: {error}")) }
}
