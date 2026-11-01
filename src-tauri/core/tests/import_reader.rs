//! tests/unit/import-reader.test.ts の移植（材料Excelの解析）。

mod import_support;

use std::future::Future;
use std::path::PathBuf;
use std::sync::Arc;
use std::task::{Context, Poll, Waker};

use import_support::{actual_zip64, number_cell, synthetic_workbook, text_cell, with_local_extra_length, with_zip64, workbook_parts, zip_parts, Zip64, NS};
use pom_core::api::{App, AppConfig, BoxFuture, Host, MessageBox, OpenDialog, Parent, PrintSession, SaveDialog};
use pom_core::db::Store;
use pom_core::error::{Error, ImportCode};
use pom_core::imports::workbook::parse_workbook;
use pom_core::imports::{ImportCounts, OriginalCell, ParsedItem, ParsedWorkbook};
use pom_core::xml::parse_xml;
use serde_json::{json, Value};

fn row<'a>(parsed: &'a ParsedWorkbook, row_index: i64, block: &str) -> &'a ParsedItem {
    parsed.items.iter().find(|item| item.row_index == row_index && item.block == block).expect("row")
}

fn cell<'a>(item: &'a ParsedItem, column: &str) -> &'a OriginalCell { item.raw_cells.get(column).expect("cell") }

#[test]
fn keeps_duplicate_candidates_and_ambiguous_source_positions_across_blank_rows() {
    // Given a workbook with two independent blocks, duplicate rows, an empty row and a supplement.
    let bytes = synthetic_workbook();
    // When parsing the initial import.
    let parsed = parse_workbook(&bytes).unwrap();
    // Then every nonempty source is classified without deduplication or guessed repair.
    assert_eq!(parsed.counts, ImportCounts { candidates: 4, held: 1, supplements: 1, excluded: 2, empty: 3, applied: 0 });
    let candidates: Vec<(i64, &str)> = parsed.items.iter().filter(|item| item.classification == "candidate").map(|item| (item.row_index, item.block.as_str())).collect();
    assert_eq!(candidates, vec![(2, "left"), (2, "right"), (5, "left"), (5, "right")]);
}

#[test]
fn retains_numeric_lexemes_whitespace_empty_versus_zero_and_separate_formatted_text() {
    let rows = format!(
        r#"<row r="2">{}{}{}<c r="E2"/>{}{}{}{}{}</row>"#,
        text_cell("A2", " 名称 "), text_cell("B2", "001"), number_cell("D2", "-1234", 2), number_cell("F2", "00012", 1),
        text_cell("H2", "右"), text_cell("I2", "002"), text_cell("K2", "02 本"), number_cell("M2", "0", 0),
    );
    let parsed = parse_workbook(&zip_parts(&workbook_parts(&rows, &[]), false)).unwrap();
    let left = row(&parsed, 2, "left");
    // 行の値（登録される形）は前後の空白を除く。原セルの表示文字列はそのまま残す。
    assert_eq!(left.values, ["名称", "001", "", "1,234", "", "00012"]);
    assert_eq!(cell(left, "A").display_text, " 名称 ");
    let d = cell(left, "D");
    assert_eq!((d.raw_value.as_deref(), d.display_text.as_str(), d.format_code.as_deref()), (Some("-1234"), "1,234", Some("#,##0;[Red]#,##0")));
    let e = cell(left, "E");
    assert_eq!((e.presence.as_str(), e.kind.as_str(), e.raw_value.as_deref()), ("present", "blank", None));
    let c = cell(left, "C");
    assert_eq!((c.presence.as_str(), c.kind.as_str(), c.raw_value.as_deref()), ("missing", "blank", None));
    assert_eq!(row(&parsed, 2, "right").values, ["右", "002", "", "02 本", "", "0"]);
}

#[test]
fn reads_the_red_negative_format_saved_with_color_name_like_excel_red() {
    for code in ["#,##0;[RED]#,##0", "#,##0;[red]#,##0"] {
        let styles = format!(r#"<styleSheet xmlns="{NS}"><numFmts count="1"><numFmt numFmtId="165" formatCode="{code}"/></numFmts><cellXfs count="2"><xf numFmtId="0"/><xf numFmtId="165"/></cellXfs></styleSheet>"#);
        let rows = format!(r#"<row r="2">{}{}{}</row>"#, text_cell("A2", "架空"), text_cell("B2", "型"), number_cell("F2", "-1200", 1));
        let parsed = parse_workbook(&zip_parts(&workbook_parts(&rows, &[("xl/styles.xml", &styles)]), false)).unwrap();
        let item = row(&parsed, 2, "left");
        assert_eq!(item.classification, "candidate", "{code}");
        let f = cell(item, "F");
        assert_eq!((f.raw_value.as_deref(), f.display_text.as_str(), f.format_code.as_deref(), f.display_verified), (Some("-1200"), "1,200", Some(code), true), "{code}");
    }
}

#[test]
fn joins_rich_runs_but_retains_phonetics_separately_for_shared_and_inline_strings() {
    let rich = "<r><t>架空</t></r><r><t>部品</t></r><rPh sb=\"0\" eb=\"2\"><t>カクウ</t></rPh>";
    let rows = format!(r#"<row r="2"><c r="A2" t="s"><v>0</v></c><c r="B2" t="inlineStr"><is>{rich}</is></c></row>"#);
    let shared = format!(r#"<sst xmlns="{NS}"><si>{rich}</si></sst>"#);
    let parsed = parse_workbook(&zip_parts(&workbook_parts(&rows, &[("xl/sharedStrings.xml", &shared)]), false)).unwrap();
    let item = row(&parsed, 2, "left");
    assert_eq!(item.values[..2], ["架空部品", "架空部品"]);
    for column in ["A", "B"] {
        let c = cell(item, column);
        assert_eq!(c.rich_text, Some(vec!["架空".to_string(), "部品".to_string()]), "{column}");
        assert_eq!(c.phonetic, Some(vec!["カクウ".to_string()]), "{column}");
    }
}

#[test]
fn holds_formulas_unknown_formats_whitespace_only_names_and_unassigned_cells() {
    let rows = format!(
        r#"<row r="2">{}{}<c r="D2"><f>1+1</f><v>2</v></c>{}{}{}</row><row r="3">{}{}{}</row>"#,
        text_cell("A2", "架空"), text_cell("B2", "形式"), text_cell("H2", "右"), text_cell("I2", "型"), number_cell("K2", "45200", 3),
        text_cell("A3", "  "), text_cell("B3", "型"), text_cell("N3", "未対応列"),
    );
    let parsed = parse_workbook(&zip_parts(&workbook_parts(&rows, &[]), false)).unwrap();
    assert_eq!((parsed.counts.candidates, parsed.counts.held, parsed.counts.supplements), (0, 3, 1));
    let d = cell(row(&parsed, 2, "left"), "D");
    assert_eq!((d.kind.as_str(), d.formula.as_deref(), d.raw_value.as_deref(), d.display_verified), ("formula", Some("1+1"), Some("2"), false));
}

#[test]
fn keeps_hidden_rows_out_of_automatic_candidates_and_never_follows_hyperlinks() {
    let rows = format!(r#"<row r="2" hidden="1">{}{}</row>"#, text_cell("A2", "架空"), text_cell("B2", "型"));
    let rels = r#"<Relationships><Relationship TargetMode="External" Target="https://invalid.example.test/never-request"/></Relationships>"#;
    let parsed = parse_workbook(&zip_parts(&workbook_parts(&rows, &[("xl/worksheets/_rels/sheet1.xml.rels", rels)]), false)).unwrap();
    assert_eq!((parsed.counts.candidates, parsed.counts.held), (0, 1));
}

#[test]
fn rejects_unexpected_structure_traversal_targets_macros_and_malformed_xml() {
    let parts = workbook_parts("", &[]);
    let with = |name: &str, value: &str| { let mut changed = parts.clone(); changed.insert(name.to_string(), value.to_string()); zip_parts(&changed, false) };
    assert!(parse_workbook(&with("xl/worksheets/sheet1.xml", "<worksheet/>")).is_err());
    assert!(parse_workbook(&with("xl/_rels/workbook.xml.rels", r#"<Relationships><Relationship Id="rId1" Type="x/worksheet" Target="../../outside.xml"/></Relationships>"#)).is_err());
    assert!(parse_workbook(&with("xl/vbaProject.bin", "synthetic")).is_err());
    assert!(parse_xml(br#"<!DOCTYPE a [<!ENTITY x "secret">]><a>&x;</a>"#).is_err());
}

#[test]
fn rejects_bad_crc_and_inflated_entries_before_parsing() {
    let mut damaged = synthetic_workbook();
    damaged[14] ^= 255;
    let central = damaged.windows(4).position(|w| w == [0x50, 0x4b, 0x01, 0x02]).expect("central directory");
    damaged[central + 16] ^= 255;
    assert!(parse_workbook(&damaged).is_err());
    let mut parts = import_support::Parts::new();
    parts.insert("xl/workbook.xml".into(), "x".repeat(8 * 1024 * 1024 + 1));
    import_support::assert_throws(parse_workbook(&zip_parts(&parts, true)), "展開量");
}

#[test]
fn recognizes_width_and_spacing_variants_in_headings_while_keeping_the_original_cells() {
    let mut parts = workbook_parts(&format!(r#"<row r="2">{}{}</row>"#, text_cell("A2", "　架空　"), text_cell("B2", "００１")), &[]);
    let sheet = parts.get_mut("xl/worksheets/sheet1.xml").expect("sheet");
    *sheet = sheet.replace("形式又はタイプ", "形式又はﾀｲﾌﾟ ");
    let parsed = parse_workbook(&zip_parts(&parts, false)).unwrap();
    assert_eq!(parsed.counts.candidates, 1);
    // 行の値は前後の空白（全角・半角）を除き、全角・半角はそのまま。原セルは表示文字列のまま。
    let header = parsed.items.iter().find(|item| item.classification == "header").expect("header");
    assert_eq!((header.values[1].as_str(), header.raw_cells.get("B").expect("B1").display_text.as_str()), ("形式又はﾀｲﾌﾟ", "形式又はﾀｲﾌﾟ "));
    let candidate = parsed.items.iter().find(|item| item.classification == "candidate").expect("candidate");
    assert_eq!(candidate.values[..2], ["架空", "００１"]);
    assert_eq!(candidate.raw_cells.get("A").expect("A2").display_text, "　架空　");
}

#[test]
fn holds_rows_whose_name_or_model_is_only_spaces() {
    // 空白だけの品名・形式は、前後の空白を除くと空欄なので要確認にする（空の品名の材料を登録しない）。
    let rows = format!(r#"<row r="2">{}{}</row><row r="3">{}{}</row>"#, text_cell("A2", "\u{3000}\u{3000}"), text_cell("B2", "001"), text_cell("A3", "架空"), text_cell("B3", " \t"));
    let parsed = parse_workbook(&zip_parts(&workbook_parts(&rows, &[]), false)).unwrap();
    assert_eq!((parsed.counts.candidates, parsed.counts.held), (0, 2));
    for (index, reason) in [(2, "品名または形式が未記入"), (3, "品名または形式が未記入")] {
        let item = row(&parsed, index, "left");
        assert_eq!((item.classification.as_str(), item.reason.as_str()), ("held", reason));
    }
    assert_eq!(row(&parsed, 2, "left").values[0], "");
}

// ---- 異常なZIP64（配布版は panic=abort のため、panic はアプリの終了になる。形式エラーとして返す） ----

const ZIP_FAILURE: &str = "ExcelのZIPを正常に読み取れません。";

/// panic せずに結果を返すこと。
fn parse_without_panic(label: &str, bytes: &[u8]) -> pom_core::Result<ParsedWorkbook> {
    std::panic::catch_unwind(|| parse_workbook(bytes)).unwrap_or_else(|_| panic!("{label}: parse_workbook panicked instead of returning an error"))
}

#[track_caller]
fn assert_import_error(label: &str, result: pom_core::Result<ParsedWorkbook>, code: ImportCode, text: &str) {
    match result {
        Err(Error::Import(actual, message)) if actual == code && message == text => {}
        other => panic!("{label}: expected ImportError {code:?} {text:?}, got {:?}", other.map(|parsed| parsed.counts)),
    }
}

#[test]
fn rejects_zip64_sizes_and_offsets_that_overflow_or_leave_the_file_without_panicking() {
    // 必須部品（xl/workbook.xml）の deflate 項目を書き換えるため、読み飛ばされて「必要な部品がない」で失敗する偽陽性にはならない。
    let base = synthetic_workbook();
    let target = "xl/workbook.xml";
    let length = base.len() as u64;
    let offset = actual_zip64(&base, target).offset.expect("offset");
    let only = |values: Zip64| with_zip64(&base, target, values);
    let cases = [
        // 圧縮方式8・非暗号化・小さな展開後サイズ・圧縮後サイズ u64::MAX（旧実装は開始位置 + サイズが桁あふれして panic した）。
        ("compressed size u64::MAX", only(Zip64 { compressed: Some(u64::MAX), ..Zip64::default() })),
        ("compressed size wrapping the data end below its start", only(Zip64 { compressed: Some(u64::MAX - offset), ..Zip64::default() })),
        ("compressed size past the end of the file", only(Zip64 { compressed: Some(length), ..Zip64::default() })),
        ("local header offset u64::MAX", only(Zip64 { offset: Some(u64::MAX), ..Zip64::default() })),
        ("local header offset overflowing the fixed header", only(Zip64 { offset: Some(u64::MAX - 29), ..Zip64::default() })),
        ("local header offset at the end of the file", only(Zip64 { offset: Some(length), ..Zip64::default() })),
        ("local header extra field length u16::MAX", with_local_extra_length(&base, target, u16::MAX)),
    ];
    for (label, bytes) in cases {
        assert_import_error(label, parse_without_panic(label, &bytes), ImportCode::Format, ZIP_FAILURE);
    }
}

#[test]
fn rejects_zip64_sizes_whose_sums_overflow_before_reading_any_entry_data() {
    // 展開量の合計: 2番目の部品の展開後サイズが u64::MAX でも、合計の加算で panic せず展開量の上限で止める。
    let base = synthetic_workbook();
    let huge = with_zip64(&base, "xl/workbook.xml", Zip64 { uncompressed: Some(u64::MAX), ..Zip64::default() });
    assert_import_error("uncompressed size u64::MAX", parse_without_panic("uncompressed size u64::MAX", &huge), ImportCode::Limit, "ZIPの展開量が上限を超えています。");
    // 無圧縮・暗号化の項目: 展開後サイズ + 12 が桁あふれしても、ちょうど一致したように見せず大きさの不一致にする。
    let stored = zip_parts(&workbook_parts("", &[]), false);
    let wrapped = with_zip64(&stored, "xl/workbook.xml", Zip64 { uncompressed: Some(u64::MAX - 5), compressed: Some(6), encrypted: true, ..Zip64::default() });
    assert_import_error("stored size + 12 wrapping", parse_without_panic("stored size + 12 wrapping", &wrapped), ImportCode::Format, ZIP_FAILURE);
}

#[test]
fn reads_zero_length_data_exactly_at_the_end_of_the_file_but_not_one_byte_past_it() {
    let name = "docProps/empty.xml";
    let mut parts = workbook_parts("", &[]);
    parts.insert(name.into(), String::new());
    let stored = zip_parts(&parts, false);
    let header = actual_zip64(&stored, name).offset.expect("offset") as usize;
    // ローカルヘッダーの追加フィールド長で、0バイトのデータの開始位置をファイルの末尾ちょうど・1バイト先にする。
    let fill = u16::try_from(stored.len() - header - 30 - name.len()).expect("fits");
    let expected = parse_workbook(&stored).unwrap();
    assert_eq!(parse_without_panic("data at the end", &with_local_extra_length(&stored, name, fill)).unwrap(), expected);
    assert_import_error("data one byte past the end", parse_without_panic("data one byte past the end", &with_local_extra_length(&stored, name, fill + 1)), ImportCode::Format, ZIP_FAILURE);
}

#[test]
fn reads_a_well_formed_small_zip64_workbook_like_the_plain_one() {
    for compress in [true, false] {
        let base = zip_parts(&workbook_parts(&format!(r#"<row r="2">{}{}</row>"#, text_cell("A2", "架空ZIP64"), text_cell("B2", "Z64-1")), &[]), compress);
        let expected = parse_workbook(&base).unwrap();
        let mut zip64 = base.clone();
        for name in ["xl/workbook.xml", "xl/worksheets/sheet1.xml", "xl/styles.xml"] { zip64 = with_zip64(&zip64, name, actual_zip64(&base, name)); }
        assert_eq!(parse_without_panic("well-formed zip64", &zip64).unwrap(), expected, "compress={compress}");
    }
}

/// ダイアログを使わない最小の Host（ドロップしたファイルの取込だけを使う）。
struct ImportHost;

impl Host for ImportHost {
    fn open_file(&self, _parent: Parent, _dialog: OpenDialog) -> BoxFuture<'_, Option<PathBuf>> { Box::pin(async { None }) }
    fn save_file(&self, _parent: Parent, _dialog: SaveDialog) -> BoxFuture<'_, Option<PathBuf>> { Box::pin(async { None }) }
    fn message_box(&self, _parent: Parent, dialog: MessageBox) -> BoxFuture<'_, usize> { Box::pin(async move { dialog.cancel_id }) }
    fn sender_trusted(&self) -> bool { true }
    fn emit_close_requested(&self, _token: &str) {}
    fn close_main_window(&self) {}
    fn quit_after_restore(&self) {}
    fn preview_url(&self, id: &str) -> String { format!("app://print/{id}") }
    fn open_print_preview(&self, _session: Arc<PrintSession>) -> BoxFuture<'_, Result<(), String>> { Box::pin(async { Err("not used".to_string()) }) }
}

fn block_on<F: Future>(future: F) -> F::Output {
    let mut future = std::pin::pin!(future);
    let mut context = Context::from_waker(Waker::noop());
    loop {
        if let Poll::Ready(value) = future.as_mut().poll(&mut context) { return value; }
        std::thread::yield_now();
    }
}

#[test]
fn app_reports_abnormal_zip64_as_a_format_error_then_imports_a_normal_workbook_without_touching_either_file() {
    let root = import_support::temp_root("zip64-app-");
    let user_data = root.path().join("user");
    let store = Store::open_default(&user_data.join("database")).unwrap();
    let config = AppConfig { user_data: user_data.clone(), documents_dir: root.path().to_path_buf(), protected_roots: vec![user_data.clone()], version: "0.1.0".into(), recovery_notice: None };
    let app = App::new(config, store, Arc::new(ImportHost));
    let base = synthetic_workbook();
    let abnormal = root.path().join("異常ZIP64.xlsx");
    let normal = root.path().join("架空材料.xlsx");
    let abnormal_bytes = with_zip64(&base, "xl/workbook.xml", Zip64 { compressed: Some(u64::MAX), ..Zip64::default() });
    std::fs::write(&abnormal, &abnormal_bytes).unwrap();
    std::fs::write(&normal, &base).unwrap();
    let choose = |file: &PathBuf| -> Value { block_on(app.invoke("imports:choose-from-path", vec![json!(file.to_string_lossy())])).expect("handler") };
    let failed = choose(&abnormal);
    assert_eq!((failed["status"].as_str(), failed["code"].as_str(), failed["message"].as_str()), (Some("error"), Some("FORMAT"), Some(ZIP_FAILURE)), "{failed}");
    // 同じアプリで続けて正常なExcelを取り込める（解析中の状態が残らない）。
    let staged = choose(&normal);
    assert_eq!(staged["status"], "ok", "{staged}");
    assert_eq!(staged["data"]["batch"]["counts"]["candidates"], 4, "{staged}");
    assert_eq!(std::fs::read(&abnormal).unwrap(), abnormal_bytes);
    assert_eq!(std::fs::read(&normal).unwrap(), base);
    app.shutdown();
}
