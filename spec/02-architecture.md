# 構成

## 全体

```text
┌──────────────── Windows（1プロセス・2ウィンドウ） ─────────────────┐
│ メインウィンドウ "main"（WebView2）                                 │
│   画面: React（src/renderer） ── window.appApi（tauri-api.ts）       │
│        │ invoke('ipc', { channel, args })  ▲ イベント documents:close-requested
│        ▼                                    │                       │
│ Tauri 本体（src-tauri/src）: host.rs の Shell                       │
│   ・ipc の受付、ドロップしたファイルの場所の置き換え、window:close   │
│   ・ダイアログ（dialogs.rs / win.rs）、終了確認、二重起動（instance.rs）│
│   ・印刷プレビュー（preview.rs、print:// スキーム）                 │
│        │ App::invoke(channel, args)                                 │
│        ▼                                                            │
│ 業務処理 pom-core（src-tauri/core）: api.rs の App                  │
│   ・入力検査（validate.rs）、DB（db.rs、SQLite）、取込・更新取込、    │
│     請求書、検索、Excel出力・印刷HTML、バックアップ                 │
│                                                                     │
│ 印刷プレビューウィンドウ "preview"（スクリプト無効・InPrivate）      │
└─────────────────────────────────────────────────────────────────────┘
```

| 層 | 場所 | 役割 | 依存してよいもの |
|---|---|---|---|
| 画面 | `src/renderer/` | 表示・入力・画面だけの状態（選択・検索語・書式の履歴など）・自動保存の制御 | `src/shared/`、`window.appApi` |
| 共有定義 | `src/shared/` | チャネル名・応答の型、帳票の定義（プレビュー用）、書式・納期の判定 | なし（画面からだけ使う） |
| 本体 | `src-tauri/src/` | ウィンドウ・ダイアログ・OS の機能・終了確認・二重起動・印刷プレビュー | `pom-core`、Tauri、Windows API |
| 業務処理 | `src-tauri/core/` | 業務の規則・入力検査・DB・ファイル入出力 | OS・画面に依存しない（`Host` トレイトだけを通す） |

- `pom-core` は画面にも Tauri にも依存しない。ダイアログ・メッセージ・ウィンドウ操作・E2E の障害注入は `Host` トレイト（`api.rs`）を通して本体に頼む。
- 業務の規則（検査・判定）は本体側（Rust）を正とする。画面は同じ規則を事前表示のために持つことがあるが、最終の判定は本体の応答に従う（重複は [09-tech-debt.md](09-tech-debt.md) の TD-03・TD-23）。
- 帳票の定義は TypeScript（`invoice-sheet.ts`・`sheet-geometry.ts`・`cell-format.ts`・`date-text.ts`）と Rust（`sheet.rs`・`format.rs`）の両方にある。2つが一致することを自動で確かめているのは一部だけ（[05-sheet-layout.md](05-sheet-layout.md)、[09-tech-debt.md](09-tech-debt.md) の TD-01）。

## 画面からの要求（IPC）

- 画面が呼べる Tauri のコマンドは `ipc` 1つだけ（E2E 用のビルドでは `e2e` も）。引数は `{ channel: string, args: unknown[] }`。権限は `src-tauri/capabilities/main.json` でメインウィンドウのアプリのページに限る。
- 本体は、`window:close`（引数なし）だけを自分で処理し、`imports:choose-from-path`・`reimport:choose-from-path` のドロップの受付番号をファイルの場所に置き換えてから、残りを `pom-core` の `App::invoke` に渡す。
- 業務処理は、要求の送り主がメインウィンドウのアプリのページであることを確かめる（`Host::sender_trusted`）。
- 応答はチャネルごとの JSON（[03-ipc-api.md](03-ipc-api.md)）。未知のチャネルと `app:info` の拒否だけは、要求そのものを失敗（Promise の reject）にする。
- 本体から画面へのイベントは `documents:close-requested`（終了確認の依頼。値は確認用のトークン）だけ。

## 起動の順序

1. パニック時の表示を設定する（配布版はエラーのダイアログ、E2E 用は標準エラー）。
2. 保存場所を決める（下の「保存場所」）。決められなければエラーを出して終わる。
3. 二重起動を確かめる。同じ保存場所で起動中なら、起動中のウィンドウを前面に出すよう頼んで終わる（Windows は名前付きミューテックスと見えないウィンドウ、Linux はロックファイル）。
4. 保存場所を作り、中断した復元を回復し（回復の結果は設定画面に「復元の回復結果」として出す）、DB を開いて移行する（`api::start`）。失敗したらエラーを出して終わる。
5. メインウィンドウを非表示で作り、最初のページの読み込みが終わってから表示して前面に出す。WebView2 のデータは保存場所に置く。
6. Windows では WebView2 の設定（右クリックメニュー・ブラウザーのショートカット・自動入力を無効）、画面の停止・応答なしの検知、ドロップの受け口、最小化中のメモリ削減を設定する。

## 終了の順序

| 状況 | 動き |
|---|---|
| ウィンドウの「閉じる」・画面の `window.close()` | 本体が終了確認のトークンを作り、`documents:close-requested` を画面へ送る。画面は未保存の入力を確かめ（[F11](features/F11-app-shell.md)）、`documents:close`（同じトークン）を返したときだけ閉じる |
| 画面が応答しない | 「待つ／強制終了」を確かめ、強制終了なら保存前の入力を捨てて閉じる |
| 画面のプロセスが止まった | 「画面が停止しました」を出してから、すべてのウィンドウを閉じる |
| 復元の後 | 復元の結果を出してから、すべてのウィンドウを閉じて終わる |
| アプリの終了 | DB を閉じる（`App::shutdown`） |

## 保存場所

| 起動のしかた | 保存場所 |
|---|---|
| 配布版 | `%APPDATA%\発注書管理`（Electron 版と同じ） |
| 開発版（デバッグビルド） | `%APPDATA%\parts-order-manager-development` |
| `--user-data-dir=<フォルダー>` を付けた場合 | そのフォルダー（最後に指定した空でない値。検証用） |
| E2E 用のビルド（`e2e` 機能）で `--user-data-dir=` を付けない場合 | 起動しない（エラーを表示して終了。本番の保存場所を使わせない） |

保存場所の中身:

| パス | 内容 |
|---|---|
| `database/app.sqlite`（`-wal`・`-shm`） | 業務データ（[04-data-model.md](04-data-model.md)） |
| `database/migration-backups/v<版>-XXXXXX/before.sqlite` | 移行の前の DB の複製（移行するたびに作る） |
| `ui-meta.json` | 最終バックアップ日時・請求書ごとの最終出力（表示用。バックアップに含めない） |
| `backup-staging/` | バックアップの作成・検査の作業用 |
| 復元の切替記録・退避フォルダー | 復元の途中で作る（[F10](features/F10-backup-restore.md)） |
| `EBWebView/` | WebView2 のキャッシュなど |
| `lockfile` | Linux の二重起動の防止 |

## セキュリティの仕組み

- CSP（`tauri.conf.json`）でスクリプト・スタイル・画像・フォントを自分自身に限り、通信先を `ipc:`・`http://ipc.localhost` に限る。
- メインウィンドウは最初に読み込んだアプリのページ以外へ移動しない。新しいウィンドウ・ダウンロード・権限の要求（位置情報など）は拒否する。
- ドロップしたファイルの場所は、画面に渡さない。画面は WebView2 にファイルを渡して受付番号だけを送り、本体が WebView2 から受け取った場所に置き換える（受付番号は最新16件まで保持）。
- 印刷プレビューはスクリプトを無効にした別ウィンドウ（InPrivate のプロファイル）で、保存版の帳票の HTML だけを `print://` スキームで表示する。ページ内のリンク（`/save`・`/print`・`/close`）は移動させずに操作として受け取る。
- 出力先には、保存場所・アプリのフォルダーの中、元の材料Excelと同じ名前の特定のファイル（[09-tech-debt.md](09-tech-debt.md) の TD-54）、Windows の予約名・使えない文字を選べない。

## ビルドと配布

| コマンド | 生成物 |
|---|---|
| `pnpm build` | `src-tauri/target/release/parts-order-manager.exe`（画面を埋め込んだ実行ファイル） |
| `pnpm make` | 上記と、未署名のインストーラー（`out/make/inno-setup/x64/`、Inno Setup） |
| `pnpm build:e2e` | E2E 用の実行ファイル（`src-tauri/target/e2e/`。`e2e` 機能入り。配布しない） |

`e2e` 機能を入れたビルドには、ダイアログの代役・障害の注入・応答の差し替えなどのテスト用の操作口（`e2e.rs`）が入る。配布用のビルドには入らない（`build.rs` がコマンドの一覧を切り替える）。
