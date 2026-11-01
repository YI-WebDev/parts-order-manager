# 仕様書（spec）

発注書管理アプリの仕様をまとめたフォルダーです。今後の変更は、ここにある仕様を先に直してから実装する「仕様駆動開発」で進めます。

- 作成: 2026年10月20日（JST）
- 基準: main ブランチ `dc86892`（PR #25 をマージした時点）のコード・テスト・README から、現在の動作を書き起こした（As-Is）。
- 作業ルール（レビュー・検証・Git）は `CLAUDE.md`、利用者向けの説明は `README.md`、過去の不具合の調査記録は `audit/` を参照する。この仕様書はそれらを置き換えない。

## 構成

| ファイル | 内容 |
|---|---|
| [00-overview.md](00-overview.md) | 製品の目的・対象範囲・対象外・動作環境・主な業務の流れ |
| [01-glossary.md](01-glossary.md) | 用語集（画面の表記・コード・IPC・DB の名前の対応）と表記のルール |
| [02-architecture.md](02-architecture.md) | 構成（プロセス・ウィンドウ・層）、起動・終了、セキュリティ、保存場所 |
| [03-ipc-api.md](03-ipc-api.md) | 画面と本体の間の全チャネルの契約（引数・応答・エラー・上限） |
| [04-data-model.md](04-data-model.md) | DB（スキーマ4版）・不変条件・移行、`ui-meta.json`、バックアップ `.pombak` の形式 |
| [05-sheet-layout.md](05-sheet-layout.md) | 帳票 `excel-v1`（請求書シート）の配置・書式・記号・寸法 |
| [06-limits.md](06-limits.md) | 上限値・定数の一覧と、正とする定義場所（重複して定義している場所を含む） |
| [07-non-functional.md](07-non-functional.md) | 非機能要件（セキュリティ・信頼性・日本語入力・操作性・対応環境） |
| [features/](features/) | 機能ごとの仕様（要件・状態と遷移・受け入れ基準・メッセージ） |
| [08-traceability.md](08-traceability.md) | 要件とテストの対応表、テストの薄い所 |
| [09-tech-debt.md](09-tech-debt.md) | 2026年10月20日の全ファイル調査の結果（不要な処理・重複・命名の不一致など）と対応案 |
| [templates/](templates/) | 新機能の仕様と、仕様変更の提案のひな形 |

機能ごとの仕様:

| ID | ファイル | 機能 |
|---|---|---|
| F01 | [features/F01-material-import.md](features/F01-material-import.md) | 材料の初回取込 |
| F02 | [features/F02-material-reimport.md](features/F02-material-reimport.md) | 変更したExcelでの更新取込 |
| F03 | [features/F03-material-search.md](features/F03-material-search.md) | 材料検索（材料検索パレット・明細最終行の検索欄・カテゴリ候補） |
| F04 | [features/F04-material-ledger.md](features/F04-material-ledger.md) | 材料台帳（手動追加・編集・無効化・削除・取込履歴） |
| F05 | [features/F05-invoice-list.md](features/F05-invoice-list.md) | 請求書一覧（絞り込み・開く・複製・削除・バックアップの警告） |
| F06 | [features/F06-invoice-editor.md](features/F06-invoice-editor.md) | 請求書の編集（明細・帳票上部・チェック・自動保存） |
| F07 | [features/F07-cell-format.md](features/F07-cell-format.md) | セルの書式と、書式の元に戻す・やり直し |
| F08 | [features/F08-excel-export.md](features/F08-excel-export.md) | Excel出力 |
| F09 | [features/F09-print-pdf.md](features/F09-print-pdf.md) | 印刷プレビュー・PDF保存・印刷 |
| F10 | [features/F10-backup-restore.md](features/F10-backup-restore.md) | バックアップ・検査・復元 |
| F11 | [features/F11-app-shell.md](features/F11-app-shell.md) | 起動・画面の切り替え・ショートカット・終了確認・二重起動・異常時 |

## 書き方の決まり

### ID

| 種類 | 形式 | 例 |
|---|---|---|
| 要件 | `REQ-<領域>-<3桁>` | `REQ-IMP-001` |
| 受け入れ基準 | `AC-<領域>-<3桁>` | `AC-EDT-004` |
| 非機能要件 | `NFR-<分類>-<3桁>` | `NFR-SEC-001` |
| 技術的負債（09-tech-debt.md） | `TD-<2桁>` | `TD-07` |

領域のコードは、IMP（初回取込）、RIM（更新取込）、SRC（材料検索）、MAT（材料台帳）、LST（請求書一覧）、EDT（請求書の編集）、FMT（セルの書式）、XLS（Excel出力）、PRT（印刷・PDF）、BAK（バックアップ・復元）、APP（起動・画面全体）、API（チャネル共通）です。
`audit/` の指摘 ID（E-01・S-01 など）とは別の番号で、混ぜません。番号は欠番にしてよく、振り直しません。

### 要件の書き方

- 1つの要件に1つの決まりを書く。「〜する」「〜しない」で言い切る。
- 数値は単位と基準（文字数はコードポイント数、など）を書く。上限値は [06-limits.md](06-limits.md) にも載せる。
- 根拠になる実装の場所はファイル名で書く（行番号は変わるため書かない）。
- 決まっていないことは「未確定」と書き、決めたつもりで書かない。
- 用語は [01-glossary.md](01-glossary.md) の「仕様での呼び方」にそろえる。

### 受け入れ基準の書き方

前提・操作・結果の3つで書く（例: 「前提: 明細が47行ある／操作: 明細を1行追加する／結果: 出力前の確認に『明細が47行を1行超えています』が出る」）。状態を持つ機能は、関係する状態と遷移の表を仕様に置き、表の遷移ごとに受け入れ基準を1つ以上書く（`CLAUDE.md` 4章と同じ考え方）。

## 仕様駆動開発の進め方

1. **変更の提案**: [templates/change-request.md](templates/change-request.md) を写して、目的・変える要件 ID・新しい受け入れ基準・影響範囲・必要な検証（`CLAUDE.md` 3章の表で選ぶ）を書く。新機能は [templates/feature-spec.md](templates/feature-spec.md) から `features/` に新しいファイルを作る。
2. **仕様のレビュー**: 仕様の差分を、実装の前に独立したレビュー担当が確認する（観点: 利用者の目的との一致、既存の要件との矛盾、状態・操作・入力の抜け、受け入れ基準で確かめられるか）。
3. **テストを先に書く**: 受け入れ基準からテストを書く。不具合の修正は、修正前に失敗する再現テストを先に作る（`CLAUDE.md` 4章）。
4. **実装**: 仕様にない動きを足さない。実装中に仕様の誤り・抜けに気付いたら、先に仕様を直してレビューを通す。
5. **記録**: [08-traceability.md](08-traceability.md) の対応表、`README.md` の利用者向けの説明（変わる場合）、技術的負債を解消した場合は [09-tech-debt.md](09-tech-debt.md) の状況を更新する。

仕様とコードが食い違っていたら、どちらが正しいかを利用者に確かめるまで、どちらにも勝手に合わせない。食い違いは [09-tech-debt.md](09-tech-debt.md) に記録する。
