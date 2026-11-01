# 要件とテストの対応

2026年10月20日時点のテストを、機能ごとに対応づけたもの。テストを足したら、この表を更新する。要件 ID ごとの対応は、変更のたびに対象の要件から足していく（今は機能の単位）。

## テストの種類

| 種類 | 場所 | コマンド | 確かめるもの |
|---|---|---|---|
| 画面の単体 | `tests/unit/*.test.ts` | `pnpm test:web` | 画面だけの規則（自動保存・書式の履歴・検索語・ページ・空の表示など） |
| 業務処理 | `src-tauri/core/tests/*.rs`、各 `src/*.rs` の `#[cfg(test)]` | `pnpm test:rust`（`pnpm test` は単体と両方） | IPC の受付から DB・ファイルまで |
| E2E | `tests/e2e/*.spec.ts` | `pnpm build:e2e` → `pnpm test:e2e` | 画面の操作。Windows は本物の exe（WebView2）、Linux は中継（`pom-bridge`）と Chromium |
| 差分 | `tests/differential/` | `pnpm test:differential` | 旧 Electron 版（コミット `ad7f05a`）と Rust 版の結果の突き合わせ。今の `src/shared` は対象外 |
| Office | `tests/office/` | `pnpm test:office` | 出力した xlsx を LibreOffice・Excel で開く・印刷する、保存し直した材料表を取り込む（入っているアプリだけ） |
| 実アプリ（Linux） | `tests/tauri/` | `pnpm test:tauri` | Tauri＋WebKitGTK の本物のアプリを WebDriver で操作 |

## 機能ごとの対応

| 機能 | 画面の単体 | 業務処理 | E2E | 差分・Office・実アプリ | 薄い所 |
|---|---|---|---|---|---|
| F01 初回取込 | — | `import_reader`・`import_repository`・`import_review_regressions`・`import_batch_migration`・`security` | `import`・`import-review`・`ui-review`・`release-workflow` | 差分（乱数の Excel の解析）、Office（保存し直した材料表）、実アプリ（ドロップ） | Windows のドラッグ＆ドロップの E2E がない |
| F02 更新取込 | — | `reimport`・`material_deletion`（古い確認） | `master-reimport`・`reimport-resume`・`master-comparison` | 差分（2本） | E2E の確定・再確認の多くを画面を通さず IPC で呼んでいる |
| F03 材料検索 | `search-query`・`category-page`・`empty-messages` | `material_search`・`ui_redesign_data` | `material-search`・`material-search-ime`・`search-ime`・`release-offline` | 差分（正規化） | — |
| F04 材料台帳 | — | `master`・`material_deletion`・`material_receipt_migration`・`database_repositories` | `material-delete`・`master-retry`・`master-comparison` | 差分（`master:save`） | 画面の単体テストがない |
| F05 請求書一覧 | — | `document_editor`（一覧・削除） | `invoice-card`・`invoice-delete` | — | — |
| F06 請求書の編集・自動保存 | `editor-save`・`line-mark` | `document_editor`・`database_repositories` | `invoice-editor`・`invoice-discard`・`invoice-boundary`・`invoice-ime`・`optional-check`・`backup-session` | 差分 | 入力から一定時間後の自動保存を E2E で直接見ているのは1つだけ（ほかは時計を止めて Ctrl+S） |
| F07 セルの書式 | `cell-format`・`format-history`・`sheet-geometry` | `cell_format` | `cell-format`・`sheet-defaults` | Office（書式付きの帳票） | 差分は対象外。今の TS と Rust の帳票定義の一致は一部だけ（TD-01） |
| F08 Excel出力 | `line-mark` | `excel_workbook`・`excel_export`・`cell_format` | `excel-export`・`excel-cleanup`・`optional-check`・`release-workflow` | 差分（styles.xml 以外）、Office、実アプリ | Windows の置換なしの移動による確定は Windows でだけ動くテスト |
| F09 印刷・PDF | `sheet-geometry` | `print_html`・`print_pdf` | `print-pdf`・`optional-check` | 実アプリ（プレビュー・PDF・印刷） | 実プリンターでの印刷は結果を差し替えている（`audit/` の O-03） |
| F10 バックアップ・復元 | — | `backup_archive`・`backup_recovery`・`backup_gate` | `backup-crash`・`backup-restore`・`backup-session`・`backup-visual` | 差分 | 起動時の回復の通知を画面で見ていない（`audit/` の B-03） |
| F11 起動・終了・二重起動 | `make-installer` | `database_migrations`・各モジュールの単体（`host.rs`・`paths.rs`） | `shell`・`close-recovery`・`native`・`native-upgrade`・`dev`（Windows だけ）・`release-*` | 実アプリ（二重起動・終了確認） | Windows の二重起動と前面表示、インストーラーの導入・更新・削除は自動テストがない |
| 非機能（セキュリティ） | `make-installer` | `security`・`import_reader`・`excel_export`・`backup_archive`・`print_html` | `shell`・`release-offline`・各機能の境界のテスト | 実アプリ（移動の制限・コマンドの拒否） | CSP・権限の設定そのものは動作で間接的に見ているだけ |

## 注意

- `pnpm test:office`・`pnpm test:tauri`・`tests/e2e/dev.spec.ts` は、必要なアプリ・環境がないとすべて飛ばして合格になる（何も確かめていない）。報告では、飛ばしたかどうかを必ず書く（[09-tech-debt.md](09-tech-debt.md) の TD-17）。
- SQLite のビルド設定はリポジトリ直下の `.cargo/config.toml` にあり、テスト・E2E・配布用のどのビルドにも効く（`src-tauri/core/tests/sqlite_options.rs` で確認）。
- テストの重複・補助関数の重複は [09-tech-debt.md](09-tech-debt.md) の「テスト」の節。
