# 上限値・定数

「正」は本体（Rust）の検査に使う定義で、約束事の値は `src-tauri/core/src/limits.rs` にまとめています。画面の値は事前表示・入力欄の制限のための写しで、`src/shared/limits.ts` に置き、正と同じ値にします（`tests/unit/limits.test.ts` が2つの値の一致を確かめます）。ここに無い値で、数字のまま書いている場所は表に注記しています。文字数はすべてコードポイント数（UTF-16 と書いたものを除く）。

## 入力の文字数

| 項目 | 値 | 正 | 写し |
|---|---|---|---|
| 材料の6項目・明細の5項目・帳票上部の欄・管理用タイトル | 10,000文字 | `limits.rs` `TEXT_MAX`（`documents.rs`・`materials.rs` が使う）、`imports::limits::TEXT`（取込のセルの文字だけは UTF-16 の長さで数える） | `limits.ts` `TEXT_MAX_LENGTH`（入力欄の `maxLength`） |
| カテゴリ名 | 1〜1,000文字 | `materials.rs` `create_category`、`reimport.rs`（`newCategoryName`） | `limits.ts` `CATEGORY_NAME_MAX_LENGTH`（`MaterialManager.tsx` の `maxLength`） |
| 検索語（材料・カテゴリ・請求書の絞り込み） | 256文字、NUL 不可 | `limits.rs` `QUERY_MAX`（`search.rs`、`documents.rs` `list`、検索のエラーの文言） | `limits.ts` `QUERY_MAX_LENGTH`（`search-query.ts` も再公開。入力欄の `maxLength`） |
| 取込のファイル名（表示名） | 1〜1,000文字 | `imports/repository.rs`・`reimport.rs` `stage` | — |
| 取込のシート名 | 1〜1,000（UTF-16 の長さ） | `imports/workbook.rs` | — |
| 記号の規則・帳票形式の名前 | 1〜100文字 | `documents.rs` `parse_line`・`parse_draft` | — |
| アプリの版（バックアップの目録） | 32文字 | `backups.rs` | — |

## 件数・ページ

| 項目 | 値 | 正 | 写し |
|---|---|---|---|
| 材料検索の1ページ | 25件 | `limits.rs` `SEARCH_PAGE_SIZE`（`search.rs` が再公開） | `limits.ts` `SEARCH_PAGE_SIZE`（`material-search-api.ts` も再公開）。文言「前の25件」「次の25件」は定数から組み立てる |
| カテゴリ候補の1ページ | 100件 | `limits.rs` `CATEGORY_PAGE_SIZE`（`search.rs` が再公開） | `limits.ts` `CATEGORY_PAGE_SIZE`。文言「前の100件」「次の100件」は定数から組み立てる |
| 材料検索の応答に含めるカテゴリ | 1,000件 | `search.rs` `SEARCH_CATEGORY_LIMIT` | — |
| 材料の画面のカテゴリ | 100件 | `reimport.rs` `MasterService::get`（`CATEGORY_PAGE_SIZE` を使う） | — |
| 請求書一覧の1ページ | 20件 | `limits.rs` `LIST_PAGE_SIZE`（`documents.rs` `list`） | `limits.ts` `INVOICE_LIST_PAGE_SIZE`。文言「前の20件」「次の20件」（`InvoiceHistory.tsx`）は定数から組み立てる |
| 請求書一覧のページ番号 | 0〜100,000 | `documents.rs` `list` | — |
| 材料検索の開始位置 | 0〜1,000,000 | `search.rs` | — |
| 一度に削除できる請求書・材料 | 1〜100件、重複なし | `limits.rs` `DELETE_MAX`（`documents.rs`・`materials.rs` が使う） | — |
| 取込履歴・更新取込の履歴 | 新しい順に100件 | `imports/repository.rs` `list`、`reimport.rs` `list` | — |
| 更新取込の候補の材料（行ごと） | 20件 | `reimport.rs` `review` | — |
| 更新取込の「既存材料を探す」の候補 | 50件 | `ImportWizard.tsx` | — |
| 明細最終行の検索欄の候補 | 8件 | `InvoicePanel.tsx` `SUGGEST_LIMIT` | — |
| 取込の確認の1ページ | 初回取込25件、更新取込10件、判断履歴25件 | `ImportWizard.tsx`（数字で書いている） | — |

## 請求書

| 項目 | 値 | 正 | 写し |
|---|---|---|---|
| 帳票に置く明細 | 47行 | `limits.rs` `LINE_ROWS`（`sheet.rs` が再公開） | `limits.ts` `LINE_ROWS`（`invoice-sheet.ts` も再公開）、`InvoicePanel.tsx` `SHEET_LINES`。出力前の確認の規則にある `documents.rs` `list` の `> 47`、文言「47行」（`exports/mod.rs`・`InvoicePanel.tsx`）は数字のまま（出力前の確認の規則の見直し（TD-03）で扱う） |
| 1つの請求書の明細（編集画面） | 500行 | `limits.rs` `MAX_LINES`（`documents.rs` `open`・`save`） | `limits.ts` `MAX_LINES`（`useInvoiceWorkspace.ts` も再公開）。文言「500行」は定数から組み立てる。本体のエラーの文言「…（500行・1MiB）…」は数字のまま |
| 保存の要求・開いた請求書の大きさ | 1 MiB（JSON のバイト数） | `documents.rs` `open`・`save` | — |
| 1つの編集セッションで追加できる明細 | 2,000行 | `documents.rs` `add_line` | — |
| 書式の元に戻す | 100回 | `format-history.ts` `HISTORY_LIMIT` | 文言「100回まで」（README） |
| 文字の入力の記録（書式との前後の判定用） | 500件 | `useFormatHistory.ts` `TEXT_LIMIT` | — |
| 文字の大きさ | 8・9・10・11・12・14・16 pt | `format.rs` `FONT_SIZES` | `cell-format.ts` `FONT_SIZES` |
| 色 | 決まった18色 | `format.rs` `PALETTE` | `cell-format.ts` `PALETTE` |

## 取込（`imports::limits`）

| 項目 | 値 |
|---|---|
| ファイルの大きさ | 16 MiB |
| 展開後の合計・1部品 | 32 MiB・8 MiB |
| ZIP のエントリ数 | 2,048 |
| シート数 | 32 |
| セル数・行番号 | 100,000セル・10,000行 |
| 取込項目（行・補足セル） | 10,000件（`acceptedIds`・`choices`・`inactiveIds` の上限も同じ） |
| 解析結果・応答のデータ量 | 16 MiB |
| 判断履歴の表示 | 20,000件・16 MiB |

## 出力・バックアップ

| 項目 | 値 | 正 |
|---|---|---|
| Excel の XML の合計 | 2 MiB | `exports/mod.rs` `XML_LIMIT` |
| Excel の1セルの文字 | 32,767（UTF-16）・改行253個まで。制御文字（タブ・改行・復帰を除く）・U+FFFE・U+FFFF は不可 | `exports/mod.rs` `text_xml` |
| 上書きする既存 xlsx の検証 | 8 MiB（8,388,608 バイト） | `limits.rs` `XLSX_VERIFY_MAX`（`exports/mod.rs` `workbook_envelope`、`exports/files.rs`） |
| PDF | 8,000,000 バイト | `limits.rs` `PDF_MAX`（`api.rs` `save_pdf`） |
| バックアップの DB | 128 MiB | `backups.rs` `BACKUP_DB_LIMIT` |
| バックアップの目録 | 64 KiB | `backups.rs` `HEADER_LIMIT` |
| 復元できるスキーマの版 | 3〜4 | `backups.rs` `OLDEST_RESTORABLE_SCHEMA` |
| 出力の記録（`ui-meta.json`） | 5,000件 | `ui_meta.rs` `MAX_EXPORTS` |
| 材料の作成の受領記録 | 500,000 バイト、発行した作成要求は直近128件 | `0003.sql`、`reimport.rs` `MasterService` |

## 時間

| 項目 | 値 | 正 |
|---|---|---|
| 自動保存 | 最後の編集から0.5秒後。ただし未保存の最初の編集から2秒以内 | `editor-store.ts` `schedule` |
| 材料・カテゴリの検索の待ち | 180ミリ秒 | `limits.ts` `SEARCH_DEBOUNCE_MS`（`useMaterialSearch.ts`・`useCategoryPage.ts`） |
| 請求書一覧の絞り込みの待ち | 250ミリ秒 | `InvoiceHistory.tsx` |
| 通知（トースト）の表示 | 8秒（「…」で終わる処理中の通知は消さない） | `App.tsx` |
| バックアップの警告 | 最後のバックアップから7日以上、または記録なし | `InvoiceHistory.tsx` `BACKUP_STALE_DAYS`、`BackupPanel.tsx`（数字で書いている） |
| ドロップしたファイルの場所の待ち | 最大2秒（100ミリ秒×20回）、受付番号は最新16件 | `host.rs` |
| 二重起動のときの前面表示の依頼 | 最大5秒（100ミリ秒×50回） | `instance.rs` |
| 続けて押した（ダブルクリック）の無視 | 1秒 | `InvoiceHistory.tsx` `ignoreRepeatedClicks` |
