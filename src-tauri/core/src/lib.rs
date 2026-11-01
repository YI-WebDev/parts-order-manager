//! 発注書管理の業務処理。Tauri（画面・OSのダイアログ）には依存せず、単体テストと差分テストで旧実装と同じ動作を確かめる。

pub mod api;
pub mod backups;
pub mod db;
pub mod documents;
pub mod error;
pub mod exports;
pub mod format;
pub mod fsx;
pub mod imports;
pub mod ipc;
pub mod js;
pub mod limits;
pub mod materials;
pub mod printing;
pub mod reimport;
pub mod search;
pub mod sheet;
pub mod ui_meta;
pub mod validate;
pub mod xml;
pub mod zip;

pub use error::{Error, Result};
