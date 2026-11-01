//! ファイルの同一性（Node の lstat の dev・ino・nlink・時刻）と、シンボリックリンク・ジャンクションをたどる realpath。

use std::path::{Component, Path, PathBuf};

/// lstat 相当の情報（リンク自体を調べる）。
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct FileInfo {
    pub is_file: bool,
    pub is_dir: bool,
    pub is_symlink: bool,
    pub nlink: u64,
    pub size: u64,
    pub dev: u64,
    pub ino: u64,
    /// 更新時刻・変更時刻（同じ処理の中で比べるためだけに使う）
    pub mtime: i128,
    pub ctime: i128,
}

#[cfg(unix)]
pub fn lstat(path: &Path) -> std::io::Result<FileInfo> {
    use std::os::unix::fs::MetadataExt;
    let m = std::fs::symlink_metadata(path)?;
    Ok(FileInfo {
        is_file: m.file_type().is_file(), is_dir: m.file_type().is_dir(), is_symlink: m.file_type().is_symlink(), nlink: m.nlink(), size: m.size(), dev: m.dev(), ino: m.ino(),
        mtime: m.mtime() as i128 * 1_000_000_000 + m.mtime_nsec() as i128, ctime: m.ctime() as i128 * 1_000_000_000 + m.ctime_nsec() as i128,
    })
}

#[cfg(windows)]
pub fn lstat(path: &Path) -> std::io::Result<FileInfo> {
    use std::os::windows::ffi::OsStrExt;
    use windows_sys::Win32::Foundation::{CloseHandle, INVALID_HANDLE_VALUE};
    use windows_sys::Win32::Storage::FileSystem::{
        CreateFileW, FileBasicInfo, GetFileInformationByHandle, GetFileInformationByHandleEx, BY_HANDLE_FILE_INFORMATION, FILE_ATTRIBUTE_DIRECTORY, FILE_ATTRIBUTE_REPARSE_POINT,
        FILE_BASIC_INFO, FILE_FLAG_BACKUP_SEMANTICS, FILE_FLAG_OPEN_REPARSE_POINT, FILE_READ_ATTRIBUTES, FILE_SHARE_DELETE, FILE_SHARE_READ, FILE_SHARE_WRITE, OPEN_EXISTING,
    };
    let metadata = std::fs::symlink_metadata(path)?;
    let wide: Vec<u16> = path.as_os_str().encode_wide().chain(std::iter::once(0)).collect();
    // SAFETY: wide は NUL 終端の UTF-16。ハンドルは下で必ず閉じる。
    let handle = unsafe { CreateFileW(wide.as_ptr(), FILE_READ_ATTRIBUTES, FILE_SHARE_READ | FILE_SHARE_WRITE | FILE_SHARE_DELETE, std::ptr::null(), OPEN_EXISTING, FILE_FLAG_BACKUP_SEMANTICS | FILE_FLAG_OPEN_REPARSE_POINT, std::ptr::null_mut()) };
    if handle == INVALID_HANDLE_VALUE { return Err(std::io::Error::last_os_error()); }
    let mut info: BY_HANDLE_FILE_INFORMATION = unsafe { std::mem::zeroed() };
    let mut basic: FILE_BASIC_INFO = unsafe { std::mem::zeroed() };
    // SAFETY: 有効なハンドルと十分な大きさの出力先を渡す。
    let ok = unsafe { GetFileInformationByHandle(handle, &mut info) } != 0
        && unsafe { GetFileInformationByHandleEx(handle, FileBasicInfo, &mut basic as *mut _ as *mut core::ffi::c_void, std::mem::size_of::<FILE_BASIC_INFO>() as u32) } != 0;
    let error = std::io::Error::last_os_error();
    unsafe { CloseHandle(handle) };
    if !ok { return Err(error); }
    let attributes = info.dwFileAttributes;
    let is_link = attributes & FILE_ATTRIBUTE_REPARSE_POINT != 0 && metadata.file_type().is_symlink();
    Ok(FileInfo {
        is_file: !is_link && attributes & FILE_ATTRIBUTE_DIRECTORY == 0,
        is_dir: !is_link && attributes & FILE_ATTRIBUTE_DIRECTORY != 0,
        is_symlink: is_link,
        nlink: info.nNumberOfLinks as u64,
        size: ((info.nFileSizeHigh as u64) << 32) | info.nFileSizeLow as u64,
        dev: info.dwVolumeSerialNumber as u64,
        ino: ((info.nFileIndexHigh as u64) << 32) | info.nFileIndexLow as u64,
        mtime: basic.LastWriteTime as i128,
        ctime: basic.ChangeTime as i128,
    })
}

/// 開いたファイルの情報（fstat）。
#[cfg(unix)]
pub fn fstat(file: &std::fs::File) -> std::io::Result<FileInfo> {
    use std::os::unix::fs::MetadataExt;
    let m = file.metadata()?;
    Ok(FileInfo {
        is_file: m.file_type().is_file(), is_dir: m.file_type().is_dir(), is_symlink: false, nlink: m.nlink(), size: m.size(), dev: m.dev(), ino: m.ino(),
        mtime: m.mtime() as i128 * 1_000_000_000 + m.mtime_nsec() as i128, ctime: m.ctime() as i128 * 1_000_000_000 + m.ctime_nsec() as i128,
    })
}

#[cfg(windows)]
pub fn fstat(file: &std::fs::File) -> std::io::Result<FileInfo> {
    use std::os::windows::io::AsRawHandle;
    use windows_sys::Win32::Storage::FileSystem::{FileBasicInfo, GetFileInformationByHandle, GetFileInformationByHandleEx, BY_HANDLE_FILE_INFORMATION, FILE_ATTRIBUTE_DIRECTORY, FILE_BASIC_INFO};
    let handle = file.as_raw_handle();
    let mut info: BY_HANDLE_FILE_INFORMATION = unsafe { std::mem::zeroed() };
    let mut basic: FILE_BASIC_INFO = unsafe { std::mem::zeroed() };
    // SAFETY: 開いているファイルのハンドルと十分な大きさの出力先を渡す。
    let ok = unsafe { GetFileInformationByHandle(handle as _, &mut info) } != 0
        && unsafe { GetFileInformationByHandleEx(handle as _, FileBasicInfo, &mut basic as *mut _ as *mut core::ffi::c_void, std::mem::size_of::<FILE_BASIC_INFO>() as u32) } != 0;
    if !ok { return Err(std::io::Error::last_os_error()); }
    Ok(FileInfo {
        is_file: info.dwFileAttributes & FILE_ATTRIBUTE_DIRECTORY == 0, is_dir: info.dwFileAttributes & FILE_ATTRIBUTE_DIRECTORY != 0, is_symlink: false,
        nlink: info.nNumberOfLinks as u64, size: ((info.nFileSizeHigh as u64) << 32) | info.nFileSizeLow as u64, dev: info.dwVolumeSerialNumber as u64,
        ino: ((info.nFileIndexHigh as u64) << 32) | info.nFileIndexLow as u64, mtime: basic.LastWriteTime as i128, ctime: basic.ChangeTime as i128,
    })
}

/// 存在の確認（リンク先をたどる。壊れたリンクは存在しない扱い）。
pub fn exists(path: &Path) -> bool { std::fs::metadata(path).is_ok() }

/// Node の fs.realpathSync（JavaScript 実装）と同じく、パスの各部分のリンクを順にたどる。
pub fn realpath(path: &Path) -> std::io::Result<PathBuf> {
    let absolute = std::path::absolute(path)?;
    let mut depth = 0;
    resolve(&absolute, &mut depth)
}

fn resolve(path: &Path, depth: &mut u32) -> std::io::Result<PathBuf> {
    let mut current = PathBuf::new();
    for component in path.components() {
        match component {
            Component::Prefix(_) | Component::RootDir => current.push(component.as_os_str()),
            Component::CurDir => {}
            Component::ParentDir => { current.pop(); }
            Component::Normal(name) => {
                let next = current.join(name);
                let metadata = std::fs::symlink_metadata(&next)?;
                if metadata.file_type().is_symlink() {
                    *depth += 1;
                    if *depth > 40 { return Err(std::io::Error::other("too many symbolic links")); }
                    let target = std::fs::read_link(&next)?;
                    let target = if target.is_absolute() { target } else { current.join(target) };
                    current = resolve(&strip_verbatim(&target), depth)?;
                } else {
                    current = next;
                }
            }
        }
    }
    Ok(current)
}

/// \\?\C:\ と \\?\UNC\ の接頭辞を通常の形に戻す。
pub fn strip_verbatim(path: &Path) -> PathBuf {
    let text = path.to_string_lossy();
    if let Some(rest) = text.strip_prefix(r"\\?\UNC\") { return PathBuf::from(format!(r"\\{rest}")); }
    if let Some(rest) = text.strip_prefix(r"\\?\") { return PathBuf::from(rest); }
    if let Some(rest) = text.strip_prefix(r"\??\") { return PathBuf::from(rest); }
    path.to_path_buf()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn lstat_reports_links_and_identity() {
        let dir = tempfile::tempdir().unwrap();
        let file = dir.path().join("a.txt");
        std::fs::write(&file, b"abc").unwrap();
        let info = lstat(&file).unwrap();
        assert!(info.is_file && !info.is_symlink && info.nlink == 1 && info.size == 3);
        std::fs::hard_link(&file, dir.path().join("b.txt")).unwrap();
        assert_eq!(lstat(&file).unwrap().nlink, 2);
        #[cfg(unix)]
        {
            std::os::unix::fs::symlink(&file, dir.path().join("link.txt")).unwrap();
            assert!(lstat(&dir.path().join("link.txt")).unwrap().is_symlink);
            std::os::unix::fs::symlink(dir.path(), dir.path().join("loop")).unwrap();
            assert_eq!(realpath(&dir.path().join("loop").join("a.txt")).unwrap(), std::fs::canonicalize(&file).unwrap());
        }
    }
}
