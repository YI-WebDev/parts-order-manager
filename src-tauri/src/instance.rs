//! 同じ保存場所でアプリを二重に起動させない（旧 Electron の requestSingleInstanceLock と同じく保存場所ごと）。
//! 2つ目に起動した場合は、起動中のウィンドウを前面に出して終了する。

use std::path::Path;

/// 起動中は保持する（プロセス終了で解放される）。
pub struct Guard {
    #[cfg(windows)]
    _mutex: windows::Win32::Foundation::HANDLE,
    #[cfg(not(windows))]
    _file: std::fs::File,
}

// 保持するだけで操作しない。
unsafe impl Send for Guard {}
unsafe impl Sync for Guard {}

fn key(user_data: &Path) -> String {
    let text = user_data.to_string_lossy().to_lowercase();
    format!("PartsOrderManager-{}", &pom_core::js::sha256_hex(text.as_bytes())[..32])
}

#[cfg(windows)]
mod platform {
    use super::*;
    use std::sync::OnceLock;
    use windows::Win32::Foundation::{ERROR_ALREADY_EXISTS, GetLastError, HWND, LPARAM, LRESULT, WPARAM};
    use windows::Win32::System::LibraryLoader::GetModuleHandleW;
    use windows::Win32::System::Threading::CreateMutexW;
    use windows::Win32::UI::WindowsAndMessaging::{
        AllowSetForegroundWindow, CreateWindowExW, DefWindowProcW, FindWindowW, GetWindowThreadProcessId, RegisterClassW, SMTO_ABORTIFHUNG,
        SendMessageTimeoutW, WINDOW_EX_STYLE, WINDOW_STYLE, WM_APP, WNDCLASSW,
    };
    use windows::core::{HSTRING, PCWSTR};

    const ACTIVATE: u32 = WM_APP + 0x2a;
    static ON_ACTIVATE: OnceLock<Box<dyn Fn() + Send + Sync>> = OnceLock::new();

    unsafe extern "system" fn procedure(hwnd: HWND, message: u32, wparam: WPARAM, lparam: LPARAM) -> LRESULT {
        if message == ACTIVATE {
            if let Some(callback) = ON_ACTIVATE.get() { callback(); }
            return LRESULT(1);
        }
        unsafe { DefWindowProcW(hwnd, message, wparam, lparam) }
    }

    pub fn acquire(user_data: &Path) -> Option<Guard> {
        let key = key(user_data);
        let mutex = unsafe { CreateMutexW(None, true, &HSTRING::from(format!("Local\\{key}"))) }.ok()?;
        if unsafe { GetLastError() } != ERROR_ALREADY_EXISTS { return Some(Guard { _mutex: mutex }); }
        // 起動中のアプリへ前面表示を頼む（起動直後で受け口がまだなければ少し待つ）。どちらにしても、この起動は終える。
        let class = HSTRING::from(format!("{key}-activate"));
        for _ in 0..50 {
            if let Ok(hwnd) = unsafe { FindWindowW(&class, PCWSTR::null()) } {
                let mut pid = 0u32;
                unsafe { GetWindowThreadProcessId(hwnd, Some(&mut pid)) };
                if pid != 0 { let _ = unsafe { AllowSetForegroundWindow(pid) }; }
                unsafe { SendMessageTimeoutW(hwnd, ACTIVATE, WPARAM(0), LPARAM(0), SMTO_ABORTIFHUNG, 5_000, None) };
                break;
            }
            std::thread::sleep(std::time::Duration::from_millis(100));
        }
        None
    }

    /// 2つ目の起動からの前面表示の依頼を受ける見えないウィンドウを作る（UIスレッドで呼ぶ）。
    pub fn listen(user_data: &Path, on_activate: impl Fn() + Send + Sync + 'static) {
        let _ = ON_ACTIVATE.set(Box::new(on_activate));
        let class = HSTRING::from(format!("{}-activate", key(user_data)));
        unsafe {
            let instance = GetModuleHandleW(None).unwrap_or_default();
            let definition = WNDCLASSW { lpfnWndProc: Some(procedure), hInstance: instance.into(), lpszClassName: PCWSTR(class.as_ptr()), ..Default::default() };
            RegisterClassW(&definition);
            let _ = CreateWindowExW(WINDOW_EX_STYLE(0), &class, &class, WINDOW_STYLE(0), 0, 0, 0, 0, None, None, Some(instance.into()), None);
        }
    }
}

#[cfg(not(windows))]
mod platform {
    use super::*;

    pub fn acquire(user_data: &Path) -> Option<Guard> {
        std::fs::create_dir_all(user_data).ok()?;
        let file = std::fs::OpenOptions::new().create(true).truncate(false).write(true).open(user_data.join("lockfile")).ok()?;
        match file.try_lock() { Ok(()) => Some(Guard { _file: file }), Err(_) => { let _ = key(user_data); None } }
    }

    /// Linux（開発・テスト用）では前面表示の依頼を受けない。
    pub fn listen(_user_data: &Path, _on_activate: impl Fn() + Send + Sync + 'static) {}
}

pub use platform::{acquire, listen};
