# 製品概要

## 目的

材料の一覧（材料Excel）から材料を探して請求書の明細を作り、見本と同じ形の Excel・PDF・印刷で出力する。これまで Excel で行っていた「材料を探して請求書へコピーする」作業を、1台の Windows PC の中で置き換える。

## 利用者と利用場面

- 利用者は1台の PC を使う事務担当者1人を想定する（同時に複数人が同じデータを使う仕組みはない）。
- 材料は取引先・自社の材料Excel（左右2ブロックの表）から取り込み、手動でも追加・編集できる。
- 請求書は、材料を検索して明細に追加し、帳票上部（宛先・ヘッダー欄・納期）を入力し、明細ごとに納品の状態（チェック）を選んで出力する。

## 対象範囲

| 機能 | 仕様 |
|---|---|
| 材料Excelの初回取込（確認してから登録） | [F01](features/F01-material-import.md) |
| 変更した材料Excelでの更新取込（差分を確認して反映） | [F02](features/F02-material-reimport.md) |
| 材料検索（部分一致・カテゴリ絞り込み） | [F03](features/F03-material-search.md) |
| 材料台帳（手動追加・編集・無効化・削除・取込履歴） | [F04](features/F04-material-ledger.md) |
| 請求書一覧（絞り込み・開く・複製・削除） | [F05](features/F05-invoice-list.md) |
| 請求書の編集と自動保存 | [F06](features/F06-invoice-editor.md) |
| セルの書式（配置・文字・色）と書式の元に戻す | [F07](features/F07-cell-format.md) |
| Excel出力 | [F08](features/F08-excel-export.md) |
| 印刷プレビュー・PDF保存・印刷 | [F09](features/F09-print-pdf.md) |
| バックアップ・検査・復元 | [F10](features/F10-backup-restore.md) |
| 起動・画面の切り替え・終了確認・二重起動の防止 | [F11](features/F11-app-shell.md) |

## 対象外（作らないもの）

- ログイン、利用者の管理、複数の PC・複数人での共有、クラウド同期、自動更新、外部への送信。
- 単価・税額・合計の計算、在庫の管理（材料の「単価」は文字として保持するだけで、帳票には出さない）。
- データの暗号化（DB・バックアップ・出力した帳票は平文。[07-non-functional.md](07-non-functional.md)）。
- 請求書・材料の削除の取り消し（ごみ箱はない。戻すにはバックアップから復元する）。
- 帳票 `excel-v1` 以外の帳票形式、48行目以降の明細の出力（業務ルールが未確定のため出力を止める）。

## 動作環境

| 項目 | 要件 |
|---|---|
| OS | Windows 11 x64（管理者権限は不要）。Windows 10 x64 は未検証 |
| 画面の表示 | Microsoft Edge WebView2 ランタイム |
| 開発 | Node.js 24.19.0 以降の 24 系、pnpm 10.34.5、Rust 1.97.0（`rust-toolchain.toml`）、Visual Studio Build Tools 2022、Inno Setup 6.3 以降（インストーラーを作る場合） |

Linux は開発・テスト用（E2E の中継 `pom-bridge`、WebKitGTK での確認）としてだけ動かす。配布の対象ではない。

## 主な業務の流れ

```text
材料Excel ──初回取込（F01）──▶ 材料台帳（F04） ◀──更新取込（F02）── 変更した材料Excel
                                  │
                         材料検索（F03）
                                  ▼
        請求書一覧（F05） ◀──▶ 請求書の編集（F06・F07）──▶ Excel出力（F08）／PDF・印刷（F09）

        すべてのデータ ──▶ バックアップ・復元（F10）
```

## 状態

- 版は v0.1.0（開発中）。正式運用・配布は未承認。版の出所は `package.json` の `version` で、`tauri.conf.json` は `../package.json` を参照し、中継は `CARGO_PKG_VERSION` を使う。2つの Cargo.toml は手で合わせ、単体テスト（`tests/unit/version-source.test.ts`）が一致を確かめる。
- 旧 Electron 版（TypeScript）から Tauri 版（Rust）へ移行済み。チャネル名・引数・応答・エラーの文言・DB の形式・バックアップの形式は、移行後に意図して変えた点（`README.md` の「技術構成」の節、[03-ipc-api.md](03-ipc-api.md) の「旧版との違い」）を除いて旧版と同じ。
