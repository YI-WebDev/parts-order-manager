//! 出力先の検査と、一時ファイルを経由した確定（src/main/exports/files.ts）。

use std::io::Write;
use std::path::{Path, PathBuf};
use std::sync::LazyLock;

use regex::Regex;

use crate::error::{Error, Result};
use crate::fsx;
use crate::imports::extname;
use crate::js;


fn fail<T>() -> Result<T> { Err(Error::file("出力先を確認してください。元Excel・内部データ・リンク先への上書きはできません。別のファイル名を選んでください。")) }

/// 既存ファイルの指紋（通常ファイル・リンクでない・ハードリンクなし・8MiB以下に限る）。
fn fingerprint(file: &Path) -> Result<String> {
    let Ok(info) = fsx::lstat(file) else { return fail() };
    if !info.is_file || info.is_symlink || info.nlink != 1 || info.size > crate::limits::XLSX_VERIFY_MAX { return fail(); }
    let bytes = std::fs::read(file)?;
    Ok(format!("{}:{}:{}:{}:{}:{}", info.dev, info.ino, info.size, info.mtime, info.ctime, js::sha256_hex(bytes)))
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Destination { pub file: PathBuf, pub parent: PathBuf, pub original: Option<String> }

static FORBIDDEN_CHARS: LazyLock<Regex> = LazyLock::new(|| Regex::new(r#"[<>:"|?*]"#).expect("regex"));
static RESERVED: LazyLock<Regex> = LazyLock::new(|| Regex::new(r"(?i)^(con|prn|aux|nul|com[1-9]|lpt[1-9])[.]").expect("regex"));

fn lower(path: &Path) -> String { path.to_string_lossy().to_lowercase() }

fn separator() -> &'static str { std::path::MAIN_SEPARATOR_STR }

/// 選択されたパスがローカルドライブの絶対パスか（Windows は C:\ の形だけ。他のOSは開発・テスト用に / から始まる形）。
fn local_absolute(selected: &str) -> bool {
    if cfg!(windows) {
        let b = selected.as_bytes();
        b.len() >= 3 && b[0].is_ascii_alphabetic() && b[1] == b':' && (b[2] == b'\\' || b[2] == b'/')
    } else {
        selected.starts_with('/') && !selected.starts_with("//")
    }
}

pub fn inspect_destination(selected: &Path, protected_roots: &[PathBuf], extension: &str) -> Result<Destination> {
    let text = selected.to_string_lossy();
    let name = selected.file_name().map(|n| n.to_string_lossy().into_owned()).unwrap_or_default();
    if !selected.is_absolute() || !local_absolute(&text) || extname(&name).to_lowercase() != extension { return fail(); }
    let file = crate::imports::source::normalize_absolute(&std::path::absolute(selected)?);
    let base = file.file_name().map(|n| n.to_string_lossy().into_owned()).unwrap_or_default();
    if FORBIDDEN_CHARS.is_match(&base) || base.ends_with('.') || base.ends_with(' ') || RESERVED.is_match(&base) || base.to_lowercase() == "a 部品発注書 2026-latest.xlsx" { return fail(); }
    let Some(directory) = file.parent() else { return fail() };
    // realpathSync・statSync の失敗（フォルダーがない等）は旧実装でも出力先エラーではなく入出力エラーになる。
    let parent = fsx::realpath(directory)?;
    if !std::fs::metadata(&parent)?.is_dir() { return fail(); }
    let actual = lower(&parent.join(&base));
    for root in protected_roots {
        let resolved = if fsx::exists(root) { fsx::realpath(root)? } else { crate::imports::source::normalize_absolute(&std::path::absolute(root).unwrap_or_else(|_| root.clone())) };
        let resolved = lower(&resolved);
        if actual == resolved || actual.starts_with(&format!("{resolved}{}", separator())) { return fail(); }
    }
    let target = parent.join(&base);
    let original = if fsx::exists(&file) { Some(fingerprint(&file)?) } else { None };
    Ok(Destination { file: target, parent, original })
}

pub fn assert_destination_current(target: &Destination) -> Result<()> {
    let Some(directory) = target.file.parent() else { return fail() };
    let parent = fsx::realpath(directory)?;
    if lower(&parent) != lower(&target.parent) { return fail(); }
    let changed = match &target.original { None => fsx::exists(&target.file), Some(original) => !fsx::exists(&target.file) || &fingerprint(&target.file)? != original };
    if changed { return Err(Error::file("選択後に出力先が変わりました。既存ファイルは上書きせず、選択し直してください。")); }
    Ok(())
}

/// 新規出力の確定のしかた（確定後の一時ファイルの後片付けが変わる）。
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Published {
    /// 一時ファイルへのハードリンクとして出力先を作った。一時ファイルは残るため削除する。
    Linked,
    /// 一時ファイルを出力先の名前へ移動した。一時ファイルは残らない。
    Moved,
}

/// 書込・新規確定・置換・削除（テストで失敗を差し込むための境界）。
pub trait FileOps {
    fn write(&self, file: &mut std::fs::File, bytes: &[u8]) -> std::io::Result<()> { file.write_all(bytes) }
    /// 完成した一時ファイルを、出力先がまだ無い場合に限って出力先として確定する（`publish_new`）。
    fn publish_new(&self, from: &Path, to: &Path) -> std::io::Result<Published> { publish_new(from, to) }
    fn rename(&self, from: &Path, to: &Path) -> std::io::Result<()> { std::fs::rename(from, to) }
    fn unlink(&self, path: &Path) -> std::io::Result<()> { std::fs::remove_file(path) }
}

/// 同じフォルダーにある完成した一時ファイル `from` を、`to` がまだ無い場合に限って `to` として確定する。
/// `to` が既にある（検査の後に別のプロセスが作った場合を含む）ときは失敗し、決して置き換えない。
///
/// - Windows: `MoveFileExW` で移動する（置換・別ボリュームへのコピー・再起動時の実行はどれも指定しない）。
///   ハードリンクを作れない exFAT・FAT32 の保存先でも動く。名前の衝突の確認と移動はファイルシステムが一度に行う。
/// - その他: ハードリンクを排他的に作る（`to` があれば EEXIST）。一時ファイルは残る。
///
/// 書込の途中で電源が切れた場合の扱いは保存先のファイルシステムによって異なる（FAT・exFAT は NTFS と同じ保証にならない）。
/// ここで保証するのは、ハードリンクなしでの新規確定と、既にある出力先を上書きしないことだけ。
pub fn publish_new(from: &Path, to: &Path) -> std::io::Result<Published> {
    #[cfg(windows)]
    {
        win::move_without_replacing(from, to)?;
        Ok(Published::Moved)
    }
    #[cfg(not(windows))]
    {
        std::fs::hard_link(from, to)?;
        Ok(Published::Linked)
    }
}

#[cfg(windows)]
mod win {
    use std::ffi::OsString;
    use std::os::windows::ffi::OsStrExt;
    use std::path::{Component, Path, Prefix};

    /// 絶対パスを `\\?\` 形式の NUL 終端 UTF-16 にする（std::fs と同じく MAX_PATH を超えるパスも扱うため）。
    /// `\\?\` 形式では Win32 がパスを正規化しないので、部品ごとに組み直して区切りを `\` にそろえ、`..` を含むパスは拒否する。
    fn verbatim(path: &Path) -> std::io::Result<Vec<u16>> {
        let invalid = || std::io::Error::new(std::io::ErrorKind::InvalidInput, "path must be a normalized absolute local or UNC path");
        let mut components = path.components();
        let Some(Component::Prefix(prefix)) = components.next() else { return Err(invalid()) };
        let mut text = OsString::new();
        match prefix.kind() {
            Prefix::Disk(_) => { text.push(r"\\?\"); text.push(prefix.as_os_str()); }
            Prefix::UNC(server, share) => { text.push(r"\\?\UNC\"); text.push(server); text.push(r"\"); text.push(share); }
            Prefix::VerbatimDisk(_) | Prefix::Verbatim(_) | Prefix::VerbatimUNC(..) => text.push(prefix.as_os_str()),
            Prefix::DeviceNS(_) => return Err(invalid()),
        }
        if components.next() != Some(Component::RootDir) { return Err(invalid()); }
        for component in components {
            let Component::Normal(name) = component else { return Err(invalid()) };
            text.push(r"\"); text.push(name);
        }
        let mut wide: Vec<u16> = text.encode_wide().collect();
        // 途中の NUL は Win32 にはそこで終わるパスとして渡ってしまうため拒否する。
        if wide.contains(&0) { return Err(invalid()); }
        wide.push(0);
        Ok(wide)
    }

    /// `MoveFileExW(from, to, 0)`: `to` が既にあれば ERROR_ALREADY_EXISTS で失敗し、置き換えない。
    pub fn move_without_replacing(from: &Path, to: &Path) -> std::io::Result<()> {
        use windows_sys::Win32::Storage::FileSystem::MoveFileExW;
        let (from, to) = (verbatim(from)?, verbatim(to)?);
        // SAFETY: from・to はこの呼出しの間生きている NUL 終端の UTF-16 で、途中に NUL を含まない。
        // フラグ 0 は MOVEFILE_REPLACE_EXISTING・MOVEFILE_COPY_ALLOWED・MOVEFILE_DELAY_UNTIL_REBOOT のどれも指定しない。
        let moved = unsafe { MoveFileExW(from.as_ptr(), to.as_ptr(), 0) };
        // 失敗の理由は、ほかの API を呼ぶ前に取り出す。
        if moved == 0 { return Err(std::io::Error::last_os_error()); }
        Ok(())
    }

    #[cfg(test)]
    mod tests {
        use super::*;

        fn text(path: &str) -> String { let wide = verbatim(Path::new(path)).unwrap(); String::from_utf16(&wide[..wide.len() - 1]).unwrap() }

        #[test]
        fn converts_only_normalized_absolute_paths() {
            assert_eq!(text(r"C:\出力\請求書.xlsx"), r"\\?\C:\出力\請求書.xlsx");
            assert_eq!(text(r"\\server\share\a.pdf"), r"\\?\UNC\server\share\a.pdf");
            assert_eq!(text(r"\\?\D:\a.pombak"), r"\\?\D:\a.pombak");
            for rejected in [r"relative\a.xlsx", r"\rooted\a.xlsx", r"C:a.xlsx", r"C:\x\..\a.xlsx", r"\\.\COM1"] {
                assert!(verbatim(Path::new(rejected)).is_err(), "{rejected}");
            }
        }

        #[test]
        fn moves_without_replacing_an_existing_destination() {
            let dir = tempfile::tempdir().unwrap();
            let (from, to) = (dir.path().join("from.tmp"), dir.path().join("to.xlsx"));
            std::fs::write(&from, b"new").unwrap();
            std::fs::write(&to, b"existing").unwrap();
            let error = move_without_replacing(&from, &to).unwrap_err();
            assert_eq!(error.kind(), std::io::ErrorKind::AlreadyExists, "{error}");
            assert_eq!(std::fs::read(&to).unwrap(), b"existing");
            std::fs::remove_file(&to).unwrap();
            move_without_replacing(&from, &to).unwrap();
            assert!(!from.exists());
            assert_eq!(std::fs::read(&to).unwrap(), b"new");
        }
    }
}

pub struct RealFs;
impl FileOps for RealFs {}

fn open_exclusive(path: &Path) -> std::io::Result<std::fs::File> {
    let mut options = std::fs::OpenOptions::new();
    options.write(true).read(true).create_new(true);
    #[cfg(unix)]
    { use std::os::unix::fs::OpenOptionsExt; options.mode(0o600); }
    options.open(path)
}

/// 一時ファイルに書いて検証し、版を確かめてから出力先へ確定する。残った一時ファイルの名前を返す（なければ None）。
pub fn commit_workbook(target: &Destination, bytes: &[u8], verify_revision: &mut dyn FnMut() -> Result<()>, ops: &dyn FileOps) -> Result<Option<String>> {
    let temporary = target.parent.join(format!(".parts-order-{}.tmp", js::random_uuid()));
    let mut created = false;
    let mut committed = false;
    let mut temporary_name: Option<String> = None;
    let mut failure: Option<Error> = None;
    let attempt = (|| -> Result<()> {
        assert_destination_current(target)?;
        let mut handle = open_exclusive(&temporary)?;
        created = true;
        ops.write(&mut handle, bytes)?;
        handle.sync_all()?;
        let size = handle.metadata()?.len();
        drop(handle);
        if size != bytes.len() as u64 || std::fs::read(&temporary)? != bytes { return Err(Error::file("一時ファイルの検証に失敗しました。既存ファイルは保持されています。")); }
        verify_revision()?;
        assert_destination_current(target)?;
        if target.original.is_none() {
            // 新規作成は出力先がまだ無い場合に限って確定し、後から現れた出力先を上書きしない。
            // 移動で確定した場合は一時ファイルが残らない（ハードリンクで確定した場合は一時ファイルを下で削除する）。
            if ops.publish_new(&temporary, &target.file)? == Published::Moved { created = false; }
        } else {
            // Windows の置換は完成した一時ファイルがそろってから行う。
            ops.rename(&temporary, &target.file)?;
            created = false;
        }
        committed = true;
        Ok(())
    })();
    if let Err(error) = attempt { failure = Some(error); }
    if created {
        if let Err(error) = ops.unlink(&temporary) {
            if error.kind() != std::io::ErrorKind::NotFound {
                temporary_name = temporary.file_name().map(|n| n.to_string_lossy().into_owned());
                if !committed && failure.is_none() { failure = Some(error.into()); }
            }
        }
    }
    match (failure, temporary_name) {
        (Some(cause), Some(name)) => Err(Error::ExportCleanup { temporary_name: name, cause: Box::new(cause) }),
        (Some(cause), None) => Err(cause),
        (None, name) => Ok(name),
    }
}
