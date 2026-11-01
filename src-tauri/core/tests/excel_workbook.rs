//! tests/unit/excel-workbook.test.ts の移植（Excel出力のブック生成・帳票レイアウト・上書き確認の部品検査）。
//!
//! 旧テストとの違い:
//! - `PrintModel` は Rust の構造体で、余分なプロパティ（sourcePath・unitPrice 等）を持てない。そのため
//!   「余分なデータを出力しない」は型で保証され、テストは documentId と固定構造の検査だけを行う。
//! - 入力値の不変（structuredClone との比較）は `&PrintModel` の借用で保証されるが、同じ比較も行う。
//! - 単独のサロゲート（U+D800）は Rust の文字列で表せないため、その1件は移植しない（他の不正文字は同じ検査）。

use std::collections::HashMap;
use std::sync::LazyLock;

use pom_core::error::{Error, WorkbookCode};
use pom_core::exports::{assert_generated_envelope, build_workbook, workbook_envelope, workbook_xml, PrintModel, TEMPLATE_VERSION};
use pom_core::sheet::{line_mark, SheetHeader, SheetLine};
use pom_core::xml::{parse_xml, XmlNode};
use pom_core::zip::Archive;
use regex::Regex;

fn line() -> SheetLine {
    SheetLine { name: "架空材料".into(), model: "001-A".into(), manufacturer: "架空メーカー".into(), quantity: "0".into(), remarks: "".into(), mark: "●".into(), formats: Default::default() }
}

fn model(count: usize) -> PrintModel {
    PrintModel { document_id: "not-for-output".into(), revision: 7, template_version: TEMPLATE_VERSION.into(), header: SheetHeader::default(), lines: vec![line(); count], formats: Default::default() }
}

fn with_line(line: SheetLine) -> PrintModel { PrintModel { lines: vec![line], ..model(1) } }

fn with_e4(date: &str) -> PrintModel { PrintModel { header: SheetHeader { e4: date.into(), ..SheetHeader::default() }, ..model(1) } }

/// ZIP の全部品（名前 → UTF-8 の内容）。
fn unzip(bytes: &[u8]) -> HashMap<String, String> {
    let mut archive = Archive::open(bytes).expect("zip");
    let mut parts = HashMap::new();
    while let Some(entry) = archive.next_entry() {
        let entry = entry.expect("zip entry");
        let data = archive.read_entry_data(&entry).expect("zip data");
        parts.insert(entry.file_name.clone(), String::from_utf8_lossy(&data).into_owned());
    }
    parts
}

#[derive(Debug, Clone, PartialEq, Eq)]
struct Cell { kind: String, value: String }

fn cell(kind: &str, value: &str) -> Cell { Cell { kind: kind.into(), value: value.into() } }

static ESCAPED: LazyLock<Regex> = LazyLock::new(|| Regex::new(r"_x([0-9A-Fa-f]{4})_").unwrap());

/// `<t>` の文字列（_xHHHH_ を元の文字へ戻す）。
fn t_text(node: &XmlNode, out: &mut String) {
    if node.name == "t" { out.push_str(&node.text); }
    for child in &node.children { t_text(child, out); }
}

/// セル参照 → { 型（t 属性）, 文字列 }。
fn cells(source: &str) -> HashMap<String, Cell> {
    fn walk(node: &XmlNode, result: &mut HashMap<String, Cell>) {
        if node.name == "c" {
            let mut text = String::new();
            t_text(node, &mut text);
            let value = ESCAPED.replace_all(&text, |m: &regex::Captures| char::from_u32(u32::from_str_radix(&m[1], 16).unwrap()).expect("scalar").to_string()).into_owned();
            result.insert(node.attr("r").unwrap_or("").to_string(), Cell { kind: node.attr("t").unwrap_or("").to_string(), value });
            return;
        }
        for child in &node.children { walk(child, result); }
    }
    let root = parse_xml(source.as_bytes()).expect("sheet xml");
    let mut result = HashMap::new();
    walk(&root, &mut result);
    result
}

fn sheet(parts: &HashMap<String, String>) -> &str { parts.get("xl/worksheets/sheet1.xml").map(String::as_str).unwrap_or("") }

fn value_of(values: &HashMap<String, Cell>, reference: &str) -> Option<String> { values.get(reference).map(|c| c.value.clone()) }

fn workbook_error(result: pom_core::Result<Vec<u8>>) -> WorkbookCode {
    match result {
        Err(Error::Workbook(code)) => code,
        Err(other) => panic!("expected WorkbookError, got {other}"),
        Ok(_) => panic!("expected WorkbookError, got a workbook"),
    }
}

#[test]
fn writes_all_lines_with_a_fixed_print_area_and_untouched_input() {
    for count in [0, 1, 47] {
        let input = model(count);
        let before = input.clone();
        let parts = unzip(&build_workbook(&input).unwrap());
        let values = cells(sheet(&parts));
        assert_eq!(input, before);
        assert_eq!(value_of(&values, "B6"), Some(if count > 0 { line().name } else { String::new() }), "{count}");
        assert_eq!(value_of(&values, "B52"), Some(if count == 47 { line().name } else { String::new() }), "{count}");
        assert!(sheet(&parts).contains("ref=\"A1:H56\""));
        assert!(sheet(&parts).contains("paperSize=\"9\""));
        assert!(sheet(&parts).contains("scale=\"68\""));
        // 印刷範囲は罫線のあるA〜G列（見本の空欄のH列は含めない）で、左右中央に置く。
        assert!(parts["xl/workbook.xml"].contains("$A$1:$G$56"));
    }
}

#[test]
fn refuses_48_lines_instead_of_truncating() {
    assert_eq!(workbook_error(build_workbook(&model(48))), WorkbookCode::Limit);
}

#[test]
fn includes_only_allowlisted_parts_and_text_values_without_hidden_data_or_metadata() {
    let parts = unzip(&build_workbook(&model(1)).unwrap());
    let mut names: Vec<&str> = parts.keys().map(String::as_str).collect();
    names.sort();
    let mut expected = vec!["[Content_Types].xml", "_rels/.rels", "xl/_rels/workbook.xml.rels", "xl/styles.xml", "xl/workbook.xml", "xl/worksheets/sheet1.xml"];
    expected.sort();
    assert_eq!(names, expected);
    let hidden = Regex::new(r#"PHANTOM_|not-for-output|<f[ >]|<hyperlinks|TargetMode=|<mergeCells|state="hidden""#).unwrap();
    for (name, xml) in &parts {
        assert!(!hidden.is_match(xml), "{name}");
        assert!(parse_xml(xml.as_bytes()).is_ok(), "{name}");
    }
    // 値は文字列だけ。空欄は値を持たない書式だけのセル。
    assert!(cells(sheet(&parts)).values().all(|c| c.kind == "inlineStr" || (c.kind.is_empty() && c.value.is_empty())));
    assert!(!sheet(&parts).contains("<v>"));
}

#[test]
fn preserves_literal_display_text() {
    let long = "長".repeat(32767);
    for value in ["=1+1", "+001", "-0", "@SUM(A1)", "https://example.invalid/", "001 -A", "0", "", "日本語😀", "a\r\nb\rc\td", long.as_str()] {
        let input = with_line(SheetLine { name: value.into(), quantity: value.into(), remarks: value.into(), ..line() });
        let values = cells(sheet(&unzip(&build_workbook(&input).unwrap())));
        assert_eq!(values.get("B6"), Some(&if value.is_empty() { cell("", "") } else { cell("inlineStr", value) }), "{value:?}");
        assert_eq!(value_of(&values, "E6").as_deref(), Some(value), "{value:?}");
        assert_eq!(value_of(&values, "F6").as_deref(), Some(value), "{value:?}");
    }
}

#[test]
fn encodes_carriage_returns_as_required_by_excel_xstring() {
    let parts = unzip(&build_workbook(&with_line(SheetLine { name: "a\rb".into(), ..line() })).unwrap());
    assert!(sheet(&parts).contains("a_x000D_b"));
}

#[test]
fn escapes_ooxml_escape_like_literals_once_without_losing_original_spelling() {
    let parts = unzip(&build_workbook(&with_line(SheetLine { model: "_x000D_ _x005F_ _X0041_".into(), ..line() })).unwrap());
    assert_eq!(value_of(&cells(sheet(&parts)), "C6").as_deref(), Some("_x000D_ _x005F_ _X0041_"));
}

#[test]
fn maps_fixed_headers_and_the_three_legend_marks_without_inferring_blank() {
    let input = PrintModel {
        header: SheetHeader { c2: "宛名文字列".into(), a4: "A".into(), b4: "B".into(), c4: "C".into(), e4: "".into() },
        lines: vec![line(), SheetLine { mark: "○".into(), ..line() }, SheetLine { mark: "⦿".into(), ..line() }],
        ..model(1)
    };
    let values = cells(sheet(&unzip(&build_workbook(&input).unwrap())));
    assert_eq!(value_of(&values, "C2").as_deref(), Some("宛名文字列"));
    assert_eq!(value_of(&values, "A6").as_deref(), Some("●"));
    assert_eq!(value_of(&values, "A7").as_deref(), Some("○"));
    assert_eq!(value_of(&values, "A8").as_deref(), Some("⦿"));
    assert_eq!(value_of(&values, "C55").as_deref(), Some("材料伝票共に納品⦿"));
}

/// チェックは任意の項目（利用者の指示、2026年10月16日）。未選択の明細のチェック欄は、値を持たない書式だけのセルにする。
#[test]
fn writes_an_unselected_check_as_a_blank_mark_cell() {
    let values = cells(sheet(&unzip(&build_workbook(&PrintModel { lines: vec![SheetLine { mark: "".into(), ..line() }, line()], ..model(1) }).unwrap())));
    assert_eq!(values.get("A6"), Some(&cell("", "")));
    assert_eq!(value_of(&values, "B6").as_deref(), Some("架空材料"));
    assert_eq!(value_of(&values, "A7").as_deref(), Some("●"));
}

#[test]
fn rejects_unrepresentable_or_excessive_text() {
    // String.fromCharCode(0xd800)（単独のサロゲート）は Rust の文字列で表せないため除く。
    for (value, code) in [("x".repeat(32768), WorkbookCode::Limit), ("\u{0}".to_string(), WorkbookCode::Text), ("\u{FFFF}".to_string(), WorkbookCode::Text)] {
        assert_eq!(workbook_error(build_workbook(&with_line(SheetLine { name: value.clone(), ..line() }))), code, "{:?}", value.chars().next());
    }
}

#[test]
fn rejects_more_line_feeds_than_excel_supports_while_retaining_the_boundary() {
    // 前後の空白（改行を含む）は帳票に置く前に除かれるため、改行は文字ではさむ。
    let value = format!("x{}x", "\n".repeat(253));
    let parts = unzip(&build_workbook(&with_line(SheetLine { remarks: value.clone(), ..line() })).unwrap());
    assert_eq!(value_of(&cells(sheet(&parts)), "F6"), Some(value.clone()));
    assert_eq!(workbook_error(build_workbook(&with_line(SheetLine { remarks: format!("x{}x", "\n".repeat(254)), ..line() }))), WorkbookCode::Limit);
}

#[test]
fn bounds_accumulated_serialized_output_before_zip_compression() {
    let large = SheetLine { name: "&".repeat(32767), model: "<".repeat(32767), remarks: ">".repeat(32767), ..line() };
    assert_eq!(workbook_error(build_workbook(&PrintModel { lines: vec![large; 47], ..model(1) })), WorkbookCode::Limit);
}

#[test]
fn follows_the_sample_form_labels_fonts_borders_and_print_setup() {
    let parts = unzip(&build_workbook(&model(1)).unwrap());
    let values = cells(sheet(&parts));
    let styles = parts.get("xl/styles.xml").cloned().unwrap_or_default();
    let at = |refs: &[&str]| refs.iter().map(|r| value_of(&values, r).unwrap_or_default()).collect::<Vec<_>>();
    assert_eq!(at(&["A5", "B5", "C5", "D5", "E5", "F5"]), ["チェック", "品　　　名", "形式又はタイプ", "メーカー", "数量", "備　考"]);
    assert_eq!(at(&["D4", "B53", "C53", "C54"]), ["納期", "チェック欄記入　　", "材料のみ　●", "伝票のみ　○"]);
    assert!(styles.contains("<name val=\"ＭＳ Ｐゴシック\"/>"));
    assert!(styles.contains("<name val=\"ＭＳ Ｐ明朝\"/>"));
    assert!(styles.contains("<sz val=\"9\"/>"));
    assert!(styles.contains("<border><left style=\"thin\"><color indexed=\"64\"/></left><right style=\"thin\"><color indexed=\"64\"/></right><top style=\"double\"><color indexed=\"64\"/></top><bottom style=\"double\"><color indexed=\"64\"/></bottom><diagonal/></border>"));
    assert!(sheet(&parts).contains("<row r=\"2\" ht=\"27\" customHeight=\"1\">"));
    assert!(sheet(&parts).contains("<row r=\"52\" ht=\"21.15\" customHeight=\"1\">"));
    assert!(sheet(&parts).contains("<col min=\"2\" max=\"2\" width=\"27.33203125\" customWidth=\"1\" bestFit=\"1\"/>"));
    assert!(sheet(&parts).contains("<printOptions horizontalCentered=\"1\"/><pageMargins left=\"0.7\" right=\"0.7\" top=\"0.75\" bottom=\"0.75\" header=\"0.3\" footer=\"0.3\"/><pageSetup paperSize=\"9\" scale=\"68\" fitToWidth=\"1\" fitToHeight=\"1\" orientation=\"portrait\"/>"));
    // Excel・LibreOfficeとも印刷範囲を1ページに収め、計算方法は指定しない（利用者の他のブックを手動計算にしない）。
    assert!(Regex::new(r#"^<worksheet [^>]*><sheetPr><pageSetUpPr fitToPage="1"/></sheetPr><dimension "#).unwrap().is_match(sheet(&parts)));
    assert!(!parts["xl/workbook.xml"].contains("calcPr"));
    assert!(sheet(&parts).contains("numberStoredAsText=\"1\""));
    for xml in [styles.as_str(), sheet(&parts)] { assert!(parse_xml(xml.as_bytes()).is_ok()); }
}

#[test]
fn writes_a_real_delivery_date_as_a_date_serial_shown_as_month_day() {
    for (date, serial) in [("2026/6/22", 46195), ("2026-10-01", 46296), ("1900-03-01", 61)] {
        let parts = unzip(&build_workbook(&with_e4(date)).unwrap());
        assert!(Regex::new(&format!(r#"<c r="E4" s="(\d+)"><v>{serial}</v></c>"#)).unwrap().is_match(sheet(&parts)), "{date}");
        assert!(parts["xl/styles.xml"].contains("formatCode=\"m&quot;月&quot;d&quot;日&quot;\""));
    }
}

#[test]
fn keeps_a_date_that_excel_cannot_represent_as_literal_text() {
    for date in ["0001-01-01", "1900/2/28"] {
        let values = cells(sheet(&unzip(&build_workbook(&with_e4(date)).unwrap())));
        assert_eq!(values.get("E4"), Some(&cell("inlineStr", date)), "{date}");
    }
}

#[test]
fn maps_check_state_and_mark_to_the_legend_mark() {
    let cases = [
        ("material_only", "filled_circle", Some("●")), ("slip_only", "open_circle", Some("○")), ("both", "both_mark", Some("⦿")),
        // チェックは任意の項目で、未選択は空欄で出力する（利用者の指示、2026年10月16日）。
        ("unknown", "unresolved", Some("")),
        ("both", "unresolved", None), ("unknown", "blank", None), ("unknown", "filled_circle", None), ("material_only", "unresolved", None), ("material_only", "both_mark", None), ("both", "filled_circle", None),
    ];
    for (delivery_state, mark_output, mark) in cases {
        assert_eq!(line_mark(delivery_state, mark_output, "provisional-v1"), mark, "{delivery_state} {mark_output}");
        assert_eq!(line_mark(delivery_state, mark_output, "other"), None, "{delivery_state} {mark_output}");
    }
}

#[test]
fn accepts_overwriting_output_from_earlier_builds_but_no_other_changed_workbook_part() {
    let expected = workbook_envelope(&build_workbook(&model(1)).unwrap()).unwrap();
    let with_workbook = |xml: String| {
        let mut parts = expected.clone();
        parts.insert("xl/workbook.xml".into(), xml.into_bytes());
        parts
    };
    let unknown = |result: pom_core::Result<()>| matches!(result, Err(Error::ExportFile(message)) if message == "既存ファイルの出力形式を確認できません。別の名前で保存してください。");
    assert!(assert_generated_envelope(&with_workbook(workbook_xml(true, true)), &expected).is_ok());
    assert!(assert_generated_envelope(&with_workbook(workbook_xml(false, true)), &expected).is_ok());
    assert!(unknown(assert_generated_envelope(&with_workbook(workbook_xml(true, false)), &expected)));
    assert!(unknown(assert_generated_envelope(&with_workbook(workbook_xml(false, false).replace("</workbook>", "<calcPr calcMode=\"auto\"/></workbook>")), &expected)));
}

#[test]
fn rejects_unsupported_layout_versions() {
    assert_eq!(workbook_error(build_workbook(&PrintModel { template_version: "other".into(), ..model(1) })), WorkbookCode::Layout);
}
