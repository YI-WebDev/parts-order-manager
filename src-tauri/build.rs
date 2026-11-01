// 画面から呼べるコマンドは ipc だけ（E2Eテスト用のビルドでは e2e も）。権限は capabilities/main.json で main ウィンドウに限る。
fn main() {
    let commands: &'static [&'static str] = if std::env::var_os("CARGO_FEATURE_E2E").is_some() { &["ipc", "e2e"] } else { &["ipc"] };
    tauri_build::try_build(tauri_build::Attributes::new().app_manifest(tauri_build::AppManifest::new().commands(commands))).expect("failed to run tauri-build");
}
