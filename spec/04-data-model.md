# データモデル

## DB（SQLite）

- ファイル: 保存場所の `database/app.sqlite`。`PRAGMA application_id = 0x504F4D31`（"POM1"）、`user_version` = スキーマの版（現在 4）。
- 接続の設定: `foreign_keys=ON`、`journal_mode=WAL`、`synchronous=FULL`。同梱の SQLite のビルド設定（`SQLITE_DQS=0` など、旧版の better-sqlite3 の既定値にそろえる。`LIBSQLITE3_FLAGS`）はリポジトリ直下の `.cargo/config.toml` にあり、リポジトリ直下・`src-tauri` のどちらから cargo を呼んでも効く。`PRAGMA compile_options` で期待するオプションがあることを Rust のテスト（`src-tauri/core/tests/sqlite_options.rs`）が確かめる。
- 定義: `src-tauri/core/migrations/0001.sql`〜`0004.sql`、移行の手順は `src-tauri/core/src/db.rs`。

### 移行

| 版 | 内容 |
|---|---|
| 1 | 全テーブルの作成、原記録・判断履歴を変更・削除させないトリガー |
| 2 | `import_batches.status` に `failed` を追加（テーブルを作り直す） |
| 3 | 材料の作成の受領記録 `material_create_receipts`（同じ作成要求の再送を同じ結果にする） |
| 4 | `materials.deleted_at`（材料の削除） |

| ID | 決まり |
|---|---|
| REQ-API-101 | 起動時に、`user_version` が0で表が1つもない DB だけを新しく作る。`application_id` が違う・表があるのに版が0・版が今のアプリより新しい・移行の履歴（`schema_migrations` の版とチェックサム）が一致しない DB は、変更せずに起動を止める |
| REQ-API-102 | 移行する前に、DB を `database/migration-backups/v<旧版>-XXXXXX/before.sqlite` に複製し、整合性・版・`application_id` を確かめる。確かめられなければ移行しない |
| REQ-API-103 | 移行は1つのトランザクションで行い、移行後の参照整合性が崩れていれば取り消す。チェックサムは移行 SQL の改行コード（CRLF/LF）の違いを無視する |
| REQ-API-104 | 移行 SQL のファイルは一度リリースしたら変更しない（チェックサムが変わると既存の DB・バックアップを開けなくなる）。変更は新しい版の移行として足す |

### テーブル

| テーブル | 内容 | 主な列と制約 |
|---|---|---|
| `categories` | カテゴリ | `name`（1〜1,000文字）、`sort_order`（0以上。初回取込ではシートの順番、手動の新規は0）、`active`（常に1。使っていない） |
| `materials` | 材料 | 6項目（`name`・`model`・`manufacturer`・`quantity`・`remarks`・`unit_price`。各10,000文字まで、前後の空白を除いて保存）、`search_text`、`active`、`revision`（1以上）、`last_source_item_id`（最後に反映した原記録）、`deleted_at`（削除した日時。削除していなければ NULL） |
| `documents` | 請求書 | `title`、`header`（帳票上部の5欄と書式の JSON）、`revision`（1以上）、`template_version`（`excel-v1`）、`duplicated_from_id`（複製元）、`archived`（常に0。使っていない） |
| `document_lines` | 明細 | `position`（0から。請求書の中で一意）、`material_id`・`source_item_id`（出典）、5項目（品名・型式・メーカー・数量・備考）、`delivery_state`、`mark_output`、`observed_mark`（常に NULL）、`rule_version` |
| `import_batches` | 取込記録 | `source_series_id`（取込元）、`previous_batch_id`、`kind`（`initial`・`reimport`・`resolution`）、`file_sha256`、`display_name`（ファイル名）、`rule_version`（`initial-ooxml-v1`・`initial-ooxml-v1/reimport-v1`）、`status`（`preview`・`applied`・`cancelled`・`failed`）、`target_item_ids`・`counts`・`target_revisions`（JSON） |
| `import_items` | 原記録 | `kind`（`row`・`supplement`）、`sheet_name`・`sheet_order`・`row_index`・`block`（`left`・`right`・`supplement`）、`cell_address`（補足セル）、`raw_cells`（元のセルの JSON）、`classification`、`fingerprint` |
| `import_decisions` | 判断履歴 | `item_id`、`material_id`、`decision`（`new`・`apply`・`keep`・`hold`・`non_material`・`link_supplement`）、`selected_fields`（JSON）、`reason`、`applied_batch_id` |
| `material_create_receipts` | 材料の作成の受領記録 | `request_id`、`request_hash`、`material_id`、`result_json`（500,000 バイトまで） |
| `settings` | 設定 | `key` は `last_category_id` だけを許す。使っていない |
| `schema_migrations` | 移行の履歴 | `version`、`hash`（移行 SQL の SHA-256） |

外部キーはすべて `ON DELETE RESTRICT`。

### 不変条件

| ID | 決まり |
|---|---|
| REQ-API-111 | 原記録（`import_items`）と判断履歴（`import_decisions`）・作成の受領記録は、作った後に変更・削除しない（トリガーで拒否する） |
| REQ-API-112 | 材料は削除しても行を消さない。`deleted_at` を入れ、`revision` を1上げ、`updated_at` を削除した日時にする。削除した材料は検索・件数・材料台帳・明細への追加・更新取込の確認・バックアップの件数から外す |
| REQ-API-113 | 請求書の保存は楽観ロックで行う（`revision` が期待値と同じときだけ更新し、1上げる）。材料の更新も同じ |
| REQ-API-114 | 請求書の明細は保存のたびに全行を書き直す（位置は0からの連番）。明細の ID は編集セッションで発行したものだけを受け付ける |
| REQ-API-115 | 請求書を削除するときは、その請求書から複製した請求書の `duplicated_from_id` を NULL にしてから、明細・請求書を1つのトランザクションで削除する |
| REQ-API-116 | セルの書式は `documents.header` の JSON の `formats`（`header`: 帳票上部の欄、`lines`: 明細 ID ごと）に置き、書式がなければ `formats` ごと省く（書式を知らない版でも同じ DB を開ける） |
| REQ-API-117 | 日時は ISO 8601 の UTC（`2026-10-20T02:37:00.000Z` の形）で保存する |

### 書式を含む `documents.header` の例

```json
{"C2":"株式会社○○ 御中","A4":"","B4":"","C4":"","E4":"2026/10/31",
 "formats":{"header":{"C2":{"bold":true,"size":14}},"lines":{"<明細ID>":{"name":{"horizontal":"left"}}}}}
```

## `ui-meta.json`（表示用の補助情報）

保存場所の直下。業務データではないため、DB の版を変えずに置く。読めない・壊れている・未知のキーがある場合は空として扱い、書込の失敗は業務処理の結果に影響させない。バックアップには含めない。

```json
{ "lastBackupAt": "2026-10-20T02:37:00.000Z" | null,
  "exports": { "<請求書ID>": { "revision": 3, "at": "2026-10-20T02:40:00.000Z" } } }
```

- `lastBackupAt`: この端末でバックアップを保存した最後の日時。
- `exports`: 請求書ごとの最後の Excel出力（保存版と日時）。新しい順に5,000件まで。削除した請求書の分は消す。PDF保存・印刷は記録しない。

## バックアップファイル `.pombak`

```text
"POMBAK01"（8バイト） + 目録の長さ（u32 リトルエンディアン） + 目録（JSON、64 KiB まで） + SQLite の DB ファイル（128 MiB まで）
```

目録:

```json
{ "format": 1, "appVersion": "0.1.0", "schemaVersion": 4, "createdAt": "<ISO 8601>",
  "migrationHashes": ["<版1のSHA-256>", "...", "<版4>"],
  "layout": { "version": "sample-layout-v2", "columnWidths": [7, 27.33203125, 24.44140625, 9.88671875, 11.109375, 23.77734375, 9, 9], "styles": "<既定の styles.xml>" },
  "entries": [ { "path": "database/app.sqlite", "size": 123456, "sha256": "<DBのSHA-256>" } ] }
```

| ID | 決まり |
|---|---|
| REQ-BAK-101 | 検査・復元は、`format` が1、`appVersion` が今のアプリと同じ、`schemaVersion` が3〜今の版、`migrationHashes` がその版までの移行のチェックサムと一致、`layout` が今の帳票（`styles` は今の既定か、2026年10月15日より前の既定）と一致、DB の長さと SHA-256 が一致するものだけを受け付ける |
| REQ-BAK-102 | DB は、`application_id`・版・表の定義（`sqlite_master`）・移行の履歴・整合性・参照整合性がその版のものと一致することを確かめる。DB ファイルは通常のファイルでリンクがなく、論理容量（ページ数×ページサイズ）も128 MiB までに限る |
| REQ-BAK-103 | 3版の DB を復元したときは、次の起動で今の版へ移行する。今の版（4版）の DB・バックアップは、材料の削除を足す前の版と旧 Electron 版では開けない |

## 保存場所の作業ファイル

| パス | 作る時 | 消す時 |
|---|---|---|
| `backup-staging/backup-XXXXXX/app.sqlite` | バックアップの作成 | 消さない（`audit/` の B-02） |
| `backup-staging/restore-stage-XXXXXX/` | バックアップの検査 | 復元すると `database/` になる。復元しなければ残る |
| `restore-journal.json` | 復元の開始 | 復元の確定・取り消しの後に `restore-finished-<id>.json`・`restore-rolled-back-<id>.json` へ名前を変える |
| `database-before-<id>/` | 復元で、今の DB を退避 | 消さない（復元前のデータ） |
| `restore-committed-<id>.json` | 復元の確定 | 消さない |
| `database-interrupted-<id>/` | 中断した復元を取り消すとき、途中の DB を退避 | 消さない |
| `database/migration-backups/v<版>-XXXXXX/` | DB の移行の前 | 消さない |
