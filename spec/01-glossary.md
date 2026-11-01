# 用語集

同じものを、画面・コード・IPC・DB で別の名前で呼んでいる箇所があります（[09-tech-debt.md](09-tech-debt.md) の TD-11・TD-12・TD-52）。仕様では「仕様での呼び方」にそろえ、コードの名前は対応表で引けるようにします。新しく名前を付けるときも、この表の英語名に合わせてください。

## 主な用語

| 仕様での呼び方 | 意味 | 画面の表記 | コード（TS / Rust） | IPC | DB |
|---|---|---|---|---|---|
| 請求書 | 利用者が作る1枚の帳票と、その明細 | 請求書 | `Invoice*`（`InvoiceDraft`・`InvoiceLine`・`InvoicePanel`・`InvoiceHistory`）、`Document*`（`DocumentApi`・`DocumentEditor`・`documents.rs`） | `documents:*` | `documents` |
| 帳票 | 請求書を出力する固定の様式（シート「請求書」の配置・書式）。形式 ID は `excel-v1` | Excelプレビュー、帳票 | `invoice-sheet.ts`・`sheet-geometry.ts`・`sheet.rs`、`templateVersion` | — | `documents.template_version` |
| 明細 | 請求書の1行（品名・型式・メーカー・数量・備考・チェック） | 明細、明細N | `line`（`InvoiceLine`・`addLine`・`LINE_ROWS`） | `documents:add-line` | `document_lines` |
| 帳票上部 | 帳票の上の入力欄。上部欄（C2）・ヘッダー欄（A4・B4・C4）・納期（E4） | 上部欄・ヘッダー欄（左・中央・右）・納期 | `header`、`HeaderKey`（`'C2' \| 'A4' \| 'B4' \| 'C4' \| 'E4'`） | `draft.header` | `documents.header`（JSON） |
| 管理用タイトル | 一覧で請求書を見分けるための名前（帳票には出さない） | 管理用タイトル、（タイトルなし） | `title` | `draft.title` | `documents.title` |
| 保存版 | 請求書を保存するたびに1増える版番号 | 保存版 N | `revision` | `revision`・`expectedRevision` | `documents.revision` |
| 編集セッション | 請求書を開いてから閉じるまでの、本体側の編集の単位（1つだけ） | — | `EditorSession`・`sessionId`・`ActiveSession` | `sessionId` | — |
| チェック | 明細の納品の状態。材料のみ／伝票のみ／材料伝票共に納品／未選択 | チェック、●・○・⦿ | `deliveryState`・`markOutput`・`lineMark`・`line_mark`・`CheckToggle` | `deliveryState`・`markOutput` | `document_lines.delivery_state`・`mark_output` |
| チェック記号 | チェックを帳票に出す記号。● ○ ⦿、未選択は空欄 | ●・○・⦿ | `LineMark`・`BOTH_MARK` | — | — |
| 記号の規則 | チェックと記号の対応の版。現在は `provisional-v1` だけ | — | `ruleVersion`・`rule_version` | `ruleVersion` | `document_lines.rule_version` |
| セルの書式 | 帳票の既定に重ねる、セルごとの配置・文字・色 | セルの書式、書式 | `CellFormat`・`formats`・`format.rs`・`cell-format.ts` | `formats` | `documents.header` の JSON の `formats` |
| 材料 | 検索して明細に入れる品目（品名・型式・メーカー・数量・備考・単価） | 材料 | `material`（`MaterialValues`・`ManagedMaterial`・`SearchRow`） | `materials:*`・`master:*` | `materials` |
| 材料台帳 | 材料の一覧と管理の画面 | 材料台帳（「材料」タブ） | `Ledger`・`MaterialManager`、`master`（`MasterApi`・`MasterService`） | `master:*` | — |
| カテゴリ | 材料の分類。初回取込ではシートごとに1つ作る | カテゴリ | `category`・`CategoryOption` | `materials:categories` | `categories` |
| 有効・無効 | 無効の材料は検索の既定の結果・明細への追加から外れる（削除ではない） | 有効・無効、「無効も表示」 | `active`・`includeInactive` | `active`・`includeInactive` | `materials.active` |
| 削除（材料） | 材料を台帳・検索から外す。行は残し削除日時を記録する | 削除 | `materials::delete` | `master:delete` | `materials.deleted_at` |
| 材料Excel | 取込元の Excel（左 A〜F・右 H〜M の2ブロックの材料表） | 材料Excel、Excel | `ParsedWorkbook`・`workbook.rs` | — | — |
| 初回取込 | 材料Excelを初めて取り込み、確認して材料を登録する | Excelから取込 → 新しいExcelを初回取込 | `imports`・`ImportWizard`（`kind: 'first'`） | `imports:*` | `import_batches.kind = 'initial'`（再確認は `'resolution'`） |
| 更新取込 | 同じ取込元の変更版 Excel から差分を確認して反映する | 変更したExcelで更新 | `reimport`（`kind: 're'`） | `reimport:*` | `import_batches.kind = 'reimport'` |
| 取込元 | 初回取込で始まり、更新取込で続く一連の Excel のまとまり | 更新する取込元 | `series`・`seriesId` | `reimport:series` | `import_batches.source_series_id` |
| 取込記録 | 1回の取込（確認中・確定済み・取消・保存失敗） | 取込履歴の1行 | `batch`・`ImportSummary` | `batchId` | `import_batches` |
| 原記録 | 取込で読んだ1行（または補足セル1つ）の元のセルの内容。変更できない | 原記録、原セル | `item`・`ImportRow`・`raw_cells` | `items`・`rows` | `import_items` |
| 判断履歴 | 原記録ごとの扱い（新規・反映・保持・保留など）。追記だけで変更できない | 確定した判断履歴 | `decision`・`DecisionView` | `decisions` | `import_decisions` |
| 再確認 | 確定・取消した取込記録の、未反映の原記録をもう一度確認すること | 未反映の候補を再確認・最初から確認し直す | `resume`・`resumeBlocked` | `imports:resume`・`reimport:resume` | — |
| 材料候補 | 取込で材料にしてよさそうな行（品名・型式があり表示を確認できた） | 材料候補 | `candidate` | `classification` | `import_items.classification` |
| 要確認 | 品名・型式が空、数式・非表示・未対応の表示形式など、確認が必要な行 | 要確認 | `held` | 同上 | 同上 |
| 補足セル | 材料表の左右のブロック外（G列や N 列以降）にある単独のセル。材料にしない | 補足保留、補足セル | `supplement` | 同上 | 同上 |
| 列見出し | 材料表の見出しと同じ内容の行 | 除外、列見出し | `header`（分類の値） | 同上 | 同上 |
| 出力 | Excel出力・PDF保存・印刷の総称 | 出力 | `export`・`print` | `documents:export-excel`・`documents:print-preview` | `ui-meta.json` の `exports` |
| 出力前の確認 | 出力を止める理由の一覧（記号未確定・47行超過・納期の形式・帳票形式） | 出力前の確認 N件 | `issues`・`ExportIssue`・`exportIssues`・`blocking_issues` | `status: 'blocked'` | — |
| バックアップ | 全データ（DB）を1つのファイル `.pombak` に保存したもの | バックアップ | `backups`・`BackupPanel` | `backups:*` | — |
| 保存場所 | アプリのデータを置くフォルダー（Electron 版の userData に当たる） | データの保存場所 | `userData`・`user_data` | `app:info` の `userDataPath` | — |
| 終了確認 | ウィンドウを閉じる前に、未保存の入力を確かめる手順 | 未保存の変更があります | `close-requested`・`close_token` | `documents:close-requested`・`documents:close` | — |

## 表記のルール

- 画面の文言では「請求書」を使う。「帳票」は様式（配置・書式）を指すときだけ使う。「発注書」はアプリ名（発注書管理）にだけ使う。
- 材料の管理画面は「材料台帳」と呼ぶ。「材料マスター」は使わない（現在、明細の削除と請求書の削除の確認の文言にだけ残っている。[09-tech-debt.md](09-tech-debt.md) の TD-11）。
- 材料の2つ目の項目は、画面では「型式」、材料Excelの見出しでは「形式又はタイプ」と書く（材料Excelの見出しは取込の判定に使うため変えない）。コメント・エラーの文言で「形式」と略しているものは「型式」にそろえる。
- 「取込」は送り仮名なしで書く（取込・取込履歴・初回取込・更新取込）。動詞として使うときは「取り込む」。
- コード上の英語名は、IPC・DB に合わせて次のとおりにする（新しく書くコードの決まり。既存の名前は [09-tech-debt.md](09-tech-debt.md) の TD-11 の方針で直す）。

| 概念 | 使う英語名 | 使わない英語名 |
|---|---|---|
| 請求書（データ） | `document` | `invoice`（画面部品の名前 `Invoice*` は既存のまま可） |
| 明細 | `line` | `row`・`item`（`row` は帳票の行・材料Excelの行、`item` は原記録に使う） |
| 帳票上部 | `header` | `top` |
| 材料の管理 | `material`（台帳の画面は `ledger`） | `master`（IPC の `master:*` は互換のため残す） |
| 初回取込・更新取込 | `import`・`reimport` | `first`・`re`（画面の内部の区分 `kind: 'first' \| 're'` は既存のまま可） |
