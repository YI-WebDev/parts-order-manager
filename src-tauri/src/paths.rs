//! 保存場所（旧 Electron の userData）の決定。
//!
//! - 配布版: %APPDATA%\発注書管理（Electron 版と同じ場所。既存のDB・バックアップ記録をそのまま使う）
//! - 開発版（デバッグビルド）: %APPDATA%\parts-order-manager-development
//! - `--user-data-dir=<フォルダー>` を付けて起動した場合はそのフォルダー（テスト・検証用。Electron と同じ指定方法）

use std::ffi::OsString;
use std::path::PathBuf;

pub const PRODUCT_NAME: &str = "発注書管理";
const DEVELOPMENT_NAME: &str = "parts-order-manager-development";

pub struct Launch {
    pub user_data: PathBuf,
}

/// `--user-data-dir=` の値（最後の指定を使う。Chromium のスイッチと同じ）。
fn explicit_user_data(args: impl IntoIterator<Item = OsString>) -> Option<PathBuf> {
    let mut found = None;
    for arg in args {
        let text = arg.to_string_lossy();
        if let Some(value) = text.strip_prefix("--user-data-dir=") {
            if !value.is_empty() { found = Some(PathBuf::from(value)); }
        }
    }
    found
}

#[cfg(windows)]
fn roaming_app_data() -> Option<PathBuf> {
    use windows::Win32::System::Com::CoTaskMemFree;
    use windows::Win32::UI::Shell::{FOLDERID_RoamingAppData, KF_FLAG_DEFAULT, SHGetKnownFolderPath};
    // Electron の app.getPath('appData') と同じ既知フォルダー。
    unsafe {
        let raw = SHGetKnownFolderPath(&FOLDERID_RoamingAppData, KF_FLAG_DEFAULT, None).ok()?;
        let path = raw.to_string().ok().map(PathBuf::from);
        CoTaskMemFree(Some(raw.0 as *const _));
        path
    }
}

#[cfg(not(windows))]
fn roaming_app_data() -> Option<PathBuf> {
    // Electron（Linux）の appData と同じ: $XDG_CONFIG_HOME または ~/.config
    match std::env::var_os("XDG_CONFIG_HOME").filter(|v| !v.is_empty()) {
        Some(config) => Some(PathBuf::from(config)),
        None => std::env::var_os("HOME").map(|home| PathBuf::from(home).join(".config")),
    }
}

pub fn resolve() -> Result<Launch, String> {
    resolve_from(std::env::args_os().skip(1), cfg!(feature = "e2e"))
}

/// `require_explicit` が真（E2E 用ビルド）のときは `--user-data-dir=` を必須にし、本番の保存場所へ落ちないようにする。
fn resolve_from(args: impl IntoIterator<Item = OsString>, require_explicit: bool) -> Result<Launch, String> {
    let explicit = explicit_user_data(args);
    if require_explicit && explicit.is_none() {
        return Err("E2E 用のビルドは、本番のデータを使わないよう --user-data-dir=<フォルダー> の指定が必要です。".to_string());
    }
    if let Some(explicit) = explicit {
        let user_data = std::path::absolute(&explicit).map_err(|_| "保存場所の指定を確認できません。".to_string())?;
        return Ok(Launch { user_data });
    }
    let base = roaming_app_data().ok_or_else(|| "保存場所（AppData）を確認できません。".to_string())?;
    let name = if cfg!(debug_assertions) { DEVELOPMENT_NAME } else { PRODUCT_NAME };
    Ok(Launch { user_data: base.join(name) })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn user_data_switch_uses_the_last_non_empty_value() {
        let args = ["--flag", "--user-data-dir=/tmp/a", "--user-data-dir=", "--user-data-dir=/tmp/b"].map(OsString::from);
        assert_eq!(explicit_user_data(args), Some(PathBuf::from("/tmp/b")));
        assert_eq!(explicit_user_data(["--user-data-dir", "/tmp/a"].map(OsString::from)), None);
    }

    #[test]
    fn e2e_build_requires_an_explicit_user_data_dir() {
        for args in [vec![], vec!["--flag"], vec!["--user-data-dir="], vec!["--user-data-dir", "/tmp/a"]] {
            assert!(resolve_from(args.into_iter().map(OsString::from), true).is_err());
        }
        let launch = resolve_from(["--user-data-dir=/tmp/a"].map(OsString::from), true).unwrap();
        assert!(launch.user_data.ends_with("a"));
        assert!(resolve_from(std::iter::empty(), false).is_ok());
    }
}
