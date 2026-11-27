# 開発ガイド

発注書管理を開発・ビルドするための手順です。アプリの使い方は [README.md](README.md) を参照してください。

## 必要なもの

Windows 11 x64 に加えて、次のものが必要です。

| 項目 | 要件 |
| --- | --- |
| Node.js | 24.19.0 以降の 24 系 |
| pnpm | 10.34.5 |
| Rust | `rust-toolchain.toml` の版（1.97.0）。[rustup](https://rustup.rs/) を入れておけば初回のビルド時に自動で用意されます |
| Visual Studio Build Tools 2022 | 「C++ によるデスクトップ開発」（MSVC のリンカーと Windows SDK。Rust のビルドに必要） |
| Inno Setup | 6.3 以降の 6 系（`pnpm make` でインストーラーを作る場合のみ） |

## セットアップと起動

PowerShellでプロジェクトのフォルダーに移動して実行します。

```powershell
pnpm install --frozen-lockfile
pnpm dev
```

- 既定のNodeが24系でない場合は、下の「Node 24を一時的に使う」の手順で起動してください。
- 依存パッケージ（npm・Rust のクレート）の初回取得にはネット接続が必要です。開発サーバーはループバックのポート5173を使います。
- 初回の `pnpm dev`・`pnpm build` は Rust のコンパイルに数分かかります（2回目以降は差分だけ）。

<details>
<summary><b>Rust と Build Tools を入れる（初回だけ）</b></summary>

```powershell
# Visual Studio Build Tools 2022（C++ によるデスクトップ開発）
winget install --id Microsoft.VisualStudio.2022.BuildTools -e --override "--quiet --wait --add Microsoft.VisualStudio.Workload.VCTools --includeRecommended"
# Rust（rustup）
winget install --id Rustlang.Rustup -e
```

Build Tools の導入には管理者権限の確認が出ることがあります。導入後は PowerShell を開き直してください。

</details>

<details>
<summary><b>Node 24を一時的に使う（端末全体の設定は変更しません）</b></summary>

1. [Node 24.19.0](https://nodejs.org/download/release/v24.19.0/) の `node-v24.19.0-win-x64.zip` を取得し、`SHASUMS256.txt` とハッシュを照合してから `%LOCALAPPDATA%\PartsOrderDev` に展開します。
2. 初回だけ、専用フォルダーにpnpmを導入します。

```powershell
$nodeDir = Join-Path $env:LOCALAPPDATA 'PartsOrderDev\node-v24.19.0-win-x64'
$pnpmDir = Join-Path $env:LOCALAPPDATA 'PartsOrderDev\pnpm-10.34.5'
& "$nodeDir\node.exe" "$nodeDir\node_modules\npm\bin\npm-cli.js" install --prefix $pnpmDir --ignore-scripts --no-audit --no-fund pnpm@10.34.5
```

3. 以降は次を貼り付けて実行します。`$task` を下の[コマンド](#コマンド)の表の `pnpm` に続く名前（例: `build`）に変えると、他の操作も同じ方法で実行できます。PATHの変更はこの処理中だけで、終了時に元へ戻ります。

```powershell
$nodeDir = Join-Path $env:LOCALAPPDATA 'PartsOrderDev\node-v24.19.0-win-x64'
$pnpmCli = Join-Path $env:LOCALAPPDATA 'PartsOrderDev\pnpm-10.34.5\node_modules\pnpm\bin\pnpm.cjs'
$task = 'dev'
$savedPath = $env:PATH
try {
    $env:PATH = "$nodeDir;$savedPath"
    & "$nodeDir\node.exe" $pnpmCli install --frozen-lockfile
    if ($LASTEXITCODE -ne 0) { throw '依存の導入に失敗しました' }
    & "$nodeDir\node.exe" $pnpmCli run $task
} finally {
    $env:PATH = $savedPath
}
```

</details>

## コマンド

**開発**

| コマンド | 内容 |
| --- | --- |
| `pnpm dev` | 開発版を起動（Vite の開発サーバー＋Tauri） |
| `pnpm lint` / `pnpm typecheck` | ESLint / TypeScript の型チェック |

**テスト**

| コマンド | 内容 |
| --- | --- |
| `pnpm test` | 単体テスト（画面側の Vitest と、アプリ本体の Rust のテスト） |
| `pnpm test:web` / `pnpm test:rust` | 単体テストを画面側（Vitest）・本体側（Rust）のどちらかだけ実行 |
| `pnpm build:e2e` / `pnpm test:e2e` | E2Eテスト用の実行ファイルを作り（`src-tauri/target/e2e/`）、画面を操作するテストを実行 |
| `pnpm test:differential` | 移行前の TypeScript 実装と Rust 実装に同じ操作・乱数で作った入力を与え、結果を突き合わせる |
| `pnpm test:office` | 実際のLibreOffice・Excelで、出力した請求書の表示・印刷と、保存し直した材料表の取込を確認（入っているアプリだけ。ExcelはWindowsのみ） |
| `pnpm test:tauri` | ビルド済みのアプリを WebDriver で操作して確認（Linux 向け。環境がなければ飛ばす） |

> [!WARNING]
> E2E 用の実行ファイルにはテスト用の操作口（ダイアログの代役・障害の注入）が入っているため、配布しないでください（`pnpm build`・`pnpm make` の実行ファイルには入りません）。

<details>
<summary><b>テストの補足（環境変数・E2E の仕組み）</b></summary>

- テストは架空データだけを使います。E2Eテストの証跡の出力先は、環境変数 `POM_E2E_EVIDENCE` で指定できます。
- `pnpm test:office`・`pnpm test:tauri` は、必要なアプリ・環境がないと該当の確認を飛ばします。環境変数 `POM_REQUIRE_OFFICE=1`（LibreOffice。Windows では Excel も）・`POM_REQUIRE_TAURI=1`（Linux・DISPLAY・ビルド済みアプリ・WebKitWebDriver）を付けると、飛ばさず失敗にします。
- `tests/unit/sheet-parity.test.ts`（`pnpm test:web` に含む）は帳票定義の TS と Rust の一致を確かめるため、Rust のハーネスを `cargo build` で作ります（cargo が必要。作り済みなら `POM_HARNESS` にパスを渡す）。
- E2Eテストは、Windows では実際のアプリ（`pnpm build:e2e` で作る E2E 用の実行ファイル）を WebView2 の DevTools 接続で操作します。WebView2 のない環境（Linux など）では、同じ画面とアプリ本体を中継（`pom-bridge`）で動かし、Chromium で操作します（`POM_E2E_TARGET=bridge|webview2` で切り替え）。
- Windows の E2E 用の実行ファイルは、ウィンドウを画面の外に置き、フォーカスを取りません（開発起動を確かめる `tests/e2e/dev.spec.ts` は E2E 用の実行ファイルを使わないため対象外）。テストの様子を画面で見るときは、環境変数 `POM_E2E_SHOW=1` を設定して実行します。

</details>

**ビルド・配布**

| コマンド | 内容 |
| --- | --- |
| `pnpm build` | Windows x64 の実行ファイルを生成（`src-tauri/target/release/parts-order-manager.exe`） |
| `pnpm make` | 実行ファイルとインストーラー（未署名）を生成（インストーラーは `out/make/inno-setup/x64/`） |

**メンテナンス**

| コマンド | 内容 |
| --- | --- |
| `pnpm notices` | 第三者ライセンス表記（THIRD-PARTY-NOTICES.txt）を作り直す（依存を更新したとき） |
| `pnpm icons` | `assets/icon` の SVG からアイコンを作り直す |

### インストーラーの作成

インストーラーの作成には [Inno Setup 6](https://jrsoftware.org/isinfo.php) が必要です。次のコマンドで導入できます（管理者権限は不要）。

```powershell
winget install --id JRSoftware.InnoSetup -e --scope user
```

- 標準以外の場所に入れた場合は、環境変数 `PARTS_ORDER_ISCC` に `ISCC.exe` の絶対パスを指定してください。
- Inno Setup は無料で使えますが、営利目的で使う場合は有償ライセンスの購入が求められています（必須ではありません。条件は[公式サイト](https://jrsoftware.org/isorder.php)を参照）。

## データの保存場所

| 環境 | 保存先 |
| --- | --- |
| 本番 | アプリの「設定」画面に表示される場所の `database/app.sqlite` |
| 開発 | `%APPDATA%\parts-order-manager-development\database\app.sqlite` |
| 起動時に `--user-data-dir=<フォルダー>` を指定した場合 | そのフォルダー（検証用） |

画面（WebView2）のキャッシュなどは保存場所の `EBWebView` フォルダーに置きます。Electron 版が保存場所に作った `Cache`・`GPUCache`・`Local Storage` などのフォルダーは使わなくなりますが、自動では削除しません（不要なら手動で削除できます。`database` フォルダーとバックアップは削除しないでください）。

## 技術構成

| 領域 | 技術 |
| --- | --- |
| アプリの土台 | Tauri 2（Microsoft Edge WebView2） |
| アプリ本体 | Rust |
| 画面 | React 19 / TypeScript / Vite / Tailwind CSS 4 |
| データ | SQLite（rusqlite。SQLite を同梱） |

### フォルダー構成

```text
src/
  renderer/  画面（React）。tauri-api.ts が window.appApi（旧 preload と同じ形）を用意する
  shared/    画面と本体の間の型とチャネル定義
src-tauri/
  core/      業務処理・DB・Excel入出力・印刷用HTML・バックアップ（pom-core。画面やOSに依存しない）
  src/       ウィンドウ・ダイアログ・終了確認・印刷プレビュー・PDF・二重起動防止（Tauri の本体）
tests/       unit（Vitest） / e2e（Playwright） / differential（旧実装との突き合わせ） / office（LibreOffice・Excel）
```

### セキュリティ

- 画面からアプリ本体へは、`ipc` コマンド1つ（チャネル名と引数）だけを呼べます。権限設定（`src-tauri/capabilities/main.json`）でメインウィンドウのアプリ内ページに限り、ほかの Tauri の機能（ファイル・ウィンドウ操作など）は許可していません。
- CSP でスクリプト・通信先をアプリ自身に限り、アプリのページ以外への移動・新しいウィンドウ・ダウンロード・権限要求（位置情報など）は拒否します。印刷プレビューはスクリプトを無効にした別ウィンドウです。
- ドロップしたファイルの場所は WebView2 から本体が直接受け取り、画面からは任意のパスを指定できません。
