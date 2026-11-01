; Wizard installer for the Tauri app, compiled by tools/make-installer.mjs during `pnpm make`.
; The script passes AppName, AppVersion, FileVersion, AppPublisher, AppExeName, PackagedDir and SetupIconFile with /D.
#if Ver < EncodeVer(6, 3, 0) || Ver >= EncodeVer(7, 0, 0)
  #error Inno Setup 6.3 or a later 6.x release is required
#endif
#ifndef PackagedDir
  #error Build the installer with pnpm make instead of compiling this script directly
#endif
; Must match SetCurrentProcessExplicitAppUserModelID in src-tauri/src/win.rs so the taskbar groups the window with its shortcut.
#define AppUserModelId "PartsOrderManager.App"

[Setup]
; Never change AppId: Setup and the uninstaller find the existing installation by it.
AppId={{2A828729-E846-49AD-AC60-711CE689FCC2}
AppName={#AppName}
AppVersion={#AppVersion}
AppPublisher={#AppPublisher}
VersionInfoVersion={#FileVersion}
; Installs for the current user without administrator rights by default; the first page offers an all-users install.
PrivilegesRequired=lowest
PrivilegesRequiredOverridesAllowed=dialog
DefaultDirName={autopf}\{#AppName}
; Always ask for the folder, prefilled with the previous one on reinstall.
DisableDirPage=no
DisableProgramGroupPage=yes
ArchitecturesAllowed=x64compatible
ArchitecturesInstallIn64BitMode=x64compatible
MinVersion=10.0
WizardStyle=modern
SetupIconFile={#SetupIconFile}
UninstallDisplayIcon={app}\{#AppExeName}
UninstallDisplayName={#AppName}
Compression=lzma2
SolidCompression=yes

[Languages]
Name: "japanese"; MessagesFile: "compiler:Languages\Japanese.isl"

[Tasks]
Name: "desktopicon"; Description: "{cm:CreateDesktopIcon}"; GroupDescription: "{cm:AdditionalIcons}"

[InstallDelete]
; Electron 版（0.1.0 まで）の実行時ファイル。Tauri 版は実行ファイル1つなので、上書きインストールで残らないように消す。
; 保存場所（%APPDATA%\発注書管理）のデータには触れない。
Type: filesandordirs; Name: "{app}\locales"
Type: filesandordirs; Name: "{app}\resources"
Type: files; Name: "{app}\chrome_100_percent.pak"
Type: files; Name: "{app}\chrome_200_percent.pak"
Type: files; Name: "{app}\resources.pak"
Type: files; Name: "{app}\snapshot_blob.bin"
Type: files; Name: "{app}\v8_context_snapshot.bin"
Type: files; Name: "{app}\icudtl.dat"
Type: files; Name: "{app}\d3dcompiler_47.dll"
Type: files; Name: "{app}\dxcompiler.dll"
Type: files; Name: "{app}\dxil.dll"
Type: files; Name: "{app}\ffmpeg.dll"
Type: files; Name: "{app}\libEGL.dll"
Type: files; Name: "{app}\libGLESv2.dll"
Type: files; Name: "{app}\vk_swiftshader.dll"
Type: files; Name: "{app}\vk_swiftshader_icd.json"
Type: files; Name: "{app}\vulkan-1.dll"
Type: files; Name: "{app}\LICENSE"
Type: files; Name: "{app}\LICENSES.chromium.html"
Type: files; Name: "{app}\version"

[Files]
Source: "{#PackagedDir}\*"; DestDir: "{app}"; Flags: ignoreversion recursesubdirs createallsubdirs

[Icons]
Name: "{autoprograms}\{#AppName}"; Filename: "{app}\{#AppExeName}"; AppUserModelID: "{#AppUserModelId}"
Name: "{autodesktop}\{#AppName}"; Filename: "{app}\{#AppExeName}"; AppUserModelID: "{#AppUserModelId}"; Tasks: desktopicon

[Run]
Filename: "{app}\{#AppExeName}"; Description: "{cm:LaunchProgram,{#StringChange(AppName, '&', '&&')}}"; Flags: nowait postinstall skipifsilent

[Code]
// 画面の表示に Microsoft Edge WebView2 ランタイムを使う（Windows 11 には標準で入っている）。
// 見つからない場合は、続けるかどうかを確認する（インストール後に入れても使える）。
const WebView2Client = 'SOFTWARE\Microsoft\EdgeUpdate\Clients\{F3017226-FE2A-4295-8BDF-00C3A9A7E4C5}';

function HasVersion(Root: Integer; Key: String): Boolean;
var Version: String;
begin
  Result := RegQueryStringValue(Root, Key, 'pv', Version) and (Version <> '') and (Version <> '0.0.0.0');
end;

function WebView2Installed(): Boolean;
begin
  Result := HasVersion(HKLM32, WebView2Client) or HasVersion(HKLM64, WebView2Client) or HasVersion(HKCU, WebView2Client);
end;

function InitializeSetup(): Boolean;
begin
  Result := True;
  if not WebView2Installed() then
    Result := SuppressibleMsgBox('この PC に Microsoft Edge WebView2 ランタイムが見つかりません。' + #13#10 +
      'アプリの画面表示に必要です（Windows 11 には標準で入っています）。' + #13#10#13#10 +
      'インストール後に Microsoft の配布ページ（https://developer.microsoft.com/microsoft-edge/webview2/）から「Evergreen ブートストラップ」を入れてください。' + #13#10#13#10 +
      'このままインストールを続けますか？', mbConfirmation, MB_YESNO, IDYES) = IDYES;
end;
