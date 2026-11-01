# IPC の契約（画面 ⇔ 本体）

画面は `window.appApi`（`src/renderer/tauri-api.ts`）を通して、本体の `ipc` コマンドに「チャネル名と引数の配列」を送ります。型は `src/shared/*-api.ts`、受付は `src-tauri/core/src/api.rs`、チャネル名の一覧とエラーの応答への変換は `src-tauri/core/src/ipc.rs`（`window:close` とドロップの受付番号だけは `src-tauri/src/host.rs`）です。

## 共通の決まり

| ID | 決まり |
|---|---|
| REQ-API-001 | 引数の数はチャネルごとに決まっている（`documents:list` だけ1つまたは2つ）。数が違えば入力エラーにする |
| REQ-API-002 | オブジェクトの引数は、決まったキー以外を含めない（未知のキーがあれば入力エラー）。省略できるキーは各チャネルに書く |
| REQ-API-003 | 文字数はコードポイント数で数える（JavaScript の `length` ではない）。ID は UUID の文字列 |
| REQ-API-004 | 要求の送り主がメインウィンドウのアプリのページでなければ処理しない（`app:info` は reject、ほかはエラーの応答） |
| REQ-API-005 | 応答は `status` を持つ JSON（下の「応答の形」）。未知のチャネルと `app:info` の拒否だけは要求を reject する（`No handler registered for '<channel>'`・`APP_INFO_REQUEST_REJECTED`） |
| REQ-API-006 | エラーの応答の `message` は利用者にそのまま見せる文言。内部の詳細（SQL・パス・スタック）は含めない。`correlationId` は応答ごとの UUID（記録・突き合わせ用） |
| REQ-API-007 | 取込・材料台帳・更新取込・請求書・出力の要求は、バックアップ・復元と排他にする（`DatabaseGate`）。バックアップの作成中・復元の確認中はこれらの要求をエラーにし、これらの要求の処理中（ダイアログの表示中を含む）はバックアップ・復元を始めない。検索（`materials:*`）は排他の対象外。エラーの文言はチャネルの系統によって異なる（`documents:delete`・`master:delete` だけ「バックアップ・復元中です。完了までお待ちください。」をそのまま返し、ほかは系統ごとの汎用の文言になる） |
| REQ-API-008 | ダイアログを出している間は DB を占有しない（ダイアログの前後で DB を使う処理を分ける） |

### 応答の形

| 系統 | 形 | `code` の値 |
|---|---|---|
| バックアップ（`backups:*`） | `{status:'ok', data}` ／ `{status:'cancelled'}` ／ `{status:'error', message}` | なし |
| 取込・材料（`imports:*`・`master:*`・`reimport:*`） | `{status:'ok', data}` ／ `{status:'cancelled'}` ／ `{status:'error', code, message, correlationId}` | `FORMAT`・`LIMIT`・`CHANGED`・`CONFLICT`・`VALIDATION`・`DB`・`IO` |
| 検索（`materials:*`） | `{status:'ok', data}` ／ `{status:'error', code, message, correlationId}` | `VALIDATION`（入力の誤り）・`DB` |
| 請求書（`documents:*`） | `{status:'ok', data}` ／ `{status:'error', code, message, correlationId}` | `VALIDATION`・`CONFLICT`・`NOT_FOUND`・`DB` |
| Excel出力 | `{status:'ok', cleanup, documentId, revision}` ／ `{status:'cancelled'}` ／ `{status:'blocked', issues}` ／ `{status:'error', code, message, correlationId, cleanup?}` | `VALIDATION`・`NOT_FOUND`・`CONFLICT`・`IO`・`BUSY` |
| 印刷プレビュー | `{status:'closed'}` ／ `{status:'blocked', issues}` ／ `{status:'error', message}` | なし |

エラーの応答は `ipc.rs` の `failure`（エラー → `code`・`message` の対応表）と `error_response`（組み立て）の1か所で作る。チャネルは `ipc::Channel`（列挙型）で、受け付ける名前は `Channel::parse` だけ。`api.rs` の `match` は網羅していて、足し忘れはコンパイルで分かる。系統ごとに形・コードの付け方が異なる点（上の表の `code` なし・汎用の失敗のコードが取込は `IO`、請求書・検索は `DB`、材料台帳が DB の `NOT_FOUND`・`CONFLICT` を `VALIDATION` にまとめる、バックアップ・復元中の文言の出方）は、利用者の判断が済むまで従来のままにしている（TD-10）。新しいチャネルは「請求書」の形（`code`・`correlationId` 付き）に合わせる。

## チャネル一覧

### アプリ

| チャネル | 引数 | 成功時の `data` | 備考 |
|---|---|---|---|
| `app:info` | なし | `{recoveryNotice: string\|null, version, userDataPath, availableFeatures: string[]}` | 応答はラップしない（`status` なし）。拒否は reject。`availableFeatures` は固定の8項目で、画面は使っていない |
| `window:close` | なし | `null` | 本体（host.rs）が処理する。ウィンドウの「閉じる」と同じく終了確認へ進む |

### バックアップ（[F10](features/F10-backup-restore.md)）

| チャネル | 引数 | 成功時の `data` | 主なエラー・取消 |
|---|---|---|---|
| `backups:create` | なし | 結果の文言（string） | 保存ダイアログの取消 → `cancelled`。既存ファイルの選択 → 上書きしないエラー |
| `backups:inspect` | なし | `{id, createdAt, materials, documents}` | ファイル選択の取消 → `cancelled`。形式・版・チェックサムの不一致 → エラー |
| `backups:restore` | `[id]`（直前の `inspect` の `id`） | `null`（その後アプリは終了する） | `id` が直前の検査と違う → エラー。確認ダイアログで「戻る」→ `cancelled` |
| `backups:status` | なし | `{lastCreatedAt: string\|null}` | 拒否時は「最終バックアップ日時を確認できませんでした。」 |

バックアップ・復元の処理中に別の `backups:*` を呼ぶと「バックアップ・復元の処理が終わるまでお待ちください。」になる。

### 初回取込（[F01](features/F01-material-import.md)）

| チャネル | 引数 | 成功時の `data` | 備考 |
|---|---|---|---|
| `imports:choose` | なし | `ImportReview` | ファイル選択の取消 → `cancelled`。解析中に別の選択 → `CONFLICT` |
| `imports:choose-from-path` | `[受付番号]` | `ImportReview` | 本体が受付番号をドロップしたファイルの場所へ置き換える。置き換えられなければ「ファイルの場所を確認できません」 |
| `imports:list` | なし | `ImportSummary[]`（新しい順に100件まで） | |
| `imports:review` | `[batchId]` | `ImportReview` | 開いた記録を「開いた記録」として覚える |
| `imports:apply` | `[{batchId, acceptedIds}]`（`acceptedIds` は10,000件まで） | `ImportReview` | `batchId` が開いた記録でなければ `VALIDATION`「履歴から取込内容を開いてください。」 |
| `imports:cancel` | `[batchId]` | `ImportReview` | 開いた記録だけ |
| `imports:resume` | `[batchId]` | `ImportReview` | 開いた記録だけ |

`ImportReview` は `{batch: ImportSummary, items: ImportRow[], resumeBlocked: string|null}`。`ImportSummary` は `{id, displayName, createdAt, status: 'preview'|'applied'|'cancelled'|'failed', counts}`、`counts` は `{candidates, held, supplements, excluded, empty, applied}`。`ImportRow` は `src/shared/import-api.ts` を参照。

### 材料台帳・更新取込（[F02](features/F02-material-reimport.md)・[F04](features/F04-material-ledger.md)）

| チャネル | 引数 | 成功時の `data` | 備考 |
|---|---|---|---|
| `master:get` | `[id\|null]` | `MaterialForm`（`null` は新規。`createRequestId` を発行する） | カテゴリは並び順の先頭100件と総数 `categoryTotal` |
| `master:save` | `[MaterialSave]` | `ManagedMaterial` | 新規は `createRequestId` 必須（同じ要求の再送は同じ結果を返す）。品名が空（空白だけを含む）→ `VALIDATION`（「品名を入力してください。」）。版の不一致 → `VALIDATION`（DB の競合を `VALIDATION` として返す） |
| `master:delete` | `[ids]`（1〜100件・重複なし） | `{deleted}`（今回削除した数） | 削除済み・存在しない ID は削除済みとして扱う |
| `reimport:series` | なし | `{id, label}[]`（更新できる取込元） | |
| `reimport:choose` | `[seriesId]` | `ReimportReview` | 取込元が更新できなければエラー |
| `reimport:choose-from-path` | `[seriesId, 受付番号]` | `ReimportReview` | |
| `reimport:list` | なし | `ImportSummary[]`（新しい順に100件まで） | |
| `reimport:review` | `[batchId]` | `ReimportReview` | 開いた記録として覚える |
| `reimport:apply` | `[{batchId, choices, inactiveIds, confirmed: true}]` | `ReimportReview` | 開いた記録だけ。`choices` は確認中の全行を1件ずつ |
| `reimport:cancel` | `[batchId]` | `ReimportReview` | 開いた記録だけ |
| `reimport:resume` | `[batchId]` | `ReimportReview` | 開いた記録だけ |

型は `src/shared/master-api.ts`。`master:delete` の失敗は、入力の誤りなら `VALIDATION`「削除する材料を選び直してください。」、それ以外は `DB`（1件も削除していない）。

### 材料検索（[F03](features/F03-material-search.md)）

| チャネル | 引数 | 成功時の `data` |
|---|---|---|
| `materials:search` | `[{query, categoryId\|null, includeInactive, offset}]`（`query` は256文字まで・NUL 不可、`offset` は0〜1,000,000） | `{rows: SearchRow[]（25件まで）, total, categories（先頭1,000件まで）, categoryTotal}` |
| `materials:categories` | `[{query, includeInactive, offset}]` | `{rows（100件まで）, total, categoryTotal, materialCount}` |

入力の誤りは `VALIDATION`「検索条件を確認してください。検索語は256文字以内です。」（カテゴリは「カテゴリの検索条件を…」）。

### 請求書（[F05](features/F05-invoice-list.md)・[F06](features/F06-invoice-editor.md)）

| チャネル | 引数 | 成功時の `data` | 備考 |
|---|---|---|---|
| `documents:open` | `[id\|null]` | `EditorSession` | `null` は新規（保存版0）。開くと編集セッションを作り直す |
| `documents:duplicate` | `[id]` | `EditorSession`（保存版0・明細の ID を振り直す） | 保存したときに複製元を記録する |
| `documents:list` | `[page]` または `[page, query]`（`page` は0〜100,000、`query` は256文字まで） | `{items（20件まで）, page, hasMore}` | 更新日時の新しい順。`query` は管理用タイトルと上部欄の部分一致 |
| `documents:delete` | `[ids]`（1〜100件・重複なし） | `{deleted}` | 1つのトランザクションで削除。開いている請求書なら編集セッションも閉じる |
| `documents:add-line` | `[{sessionId, materialId\|null}]` | `InvoiceLine` | 材料が見つからない・無効・削除済みなら `NOT_FOUND` |
| `documents:save` | `[{sessionId, requestNumber, generation, expectedRevision, draft}]` | `{sessionId, documentId, requestNumber, generation, revision}` | 1 MiB まで・明細500行まで。順序・版の不一致は `CONFLICT` |
| `documents:close` | `[token]` | `null` | 終了確認のトークンが一致したときだけメインウィンドウを閉じる |

本体から画面へのイベント `documents:close-requested` の値は、終了確認のトークン（UUID）。

### 出力（[F08](features/F08-excel-export.md)・[F09](features/F09-print-pdf.md)）

| チャネル | 引数 | 応答 |
|---|---|---|
| `documents:export-excel` | `[{documentId, revision}]`（`revision` は1以上） | 上の「Excel出力」の形。`issues` は `{field, message}[]`（`field` は `templateVersion`・`E4`・`lines`・`lines.<番号>.mark`。画面の型は `ExportIssueField`） |
| `documents:print-preview` | `[{documentId, revision}]` | 印刷プレビューを閉じるまで待ち、`closed` を返す。止めたときは `blocked`。開けなければ `error` |

## 旧版（Electron）との違い

移行のときに意図して変えた点。旧版との差分テスト（`pnpm test:differential`）はこれらを突き合わせから外している。

| 項目 | 内容 |
|---|---|
| `imports:apply` | 品名のある要確認行・列見出しの行も選んで登録できる（旧版は材料候補だけ） |
| `reimport:apply` | 品名のある要確認行を「新規」「反映」にできる（旧版は保留だけ） |
| `reimport:*` の応答 | `missingIds`（新しい Excel のどの行にも当たらない有効な材料）を追加 |
| 取込の確認応答 | `resumeBlocked`（再確認できない理由。できるときは `null`）を追加 |
| `master:get`・`materials:search` | カテゴリを先頭の100件・1,000件に限り、総数 `categoryTotal` を追加。残りは新しいチャネル `materials:categories` で取る |
| `documents:open`・`documents:duplicate`・`documents:save` | 書式 `formats` を追加（省略可） |
| `documents:delete`・`master:delete` | 新しいチャネル |
| `documents:list` の `issueCount`、出力の `blocked` | チェックを選んでいない明細を数えない・止めない（2026年10月16日） |
| 登録・保存する値 | 材料の6項目・明細の文字の欄・帳票上部の欄の前後の空白を除く（2026年10月15日） |
