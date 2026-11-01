//! セルの書式（Excelプレビューのツールバーで付ける配置・文字・色）の保存・Excel出力・印刷。
//! 書式のない帳票は、保存内容（documents.header の JSON）・Excel・印刷とも書式を足す前と同じ内容になることも確かめる。

use std::collections::HashMap;

use base64::Engine;
use pom_core::db::Store;
use pom_core::documents::{DocumentEditor, EditorSession};
use pom_core::error::Error;
use pom_core::exports::{assert_generated_envelope, build_workbook, generated_styles, styles_xml, workbook_envelope, PrintModel, STYLES, TEMPLATE_VERSION};
use pom_core::format::{CellFormat, HeaderFormats, Horizontal, LineFormats, Vertical};
use pom_core::printing::{page_style, print_html, FORMATTED_STYLE, PRINT_CSP, STYLE};
use pom_core::sheet::{SheetHeader, SheetLine, StyleName};
use pom_core::xml::parse_xml;
use pom_core::zip::Archive;
use regex::Regex;
use serde_json::{json, Value};
use sha2::{Digest, Sha256};
use tempfile::TempDir;

struct Context { store: Store, editor: DocumentEditor, _root: TempDir }

fn fixture() -> Context {
    let root = tempfile::Builder::new().prefix("cell-format-").tempdir().unwrap();
    let store = Store::open_default(root.path()).unwrap();
    Context { store, editor: DocumentEditor::default(), _root: root }
}

impl Context {
    fn open(&mut self, id: Option<&str>) -> EditorSession { self.editor.open(&self.store, &json!(id), false).unwrap() }
    fn header_json(&self, id: &str) -> Value {
        let text: String = self.store.conn().query_row("SELECT header FROM documents WHERE id=?", [id], |row| row.get(0)).unwrap();
        serde_json::from_str(&text).unwrap()
    }
}

fn request(session: &EditorSession, draft: Value, number: i64) -> Value {
    json!({ "sessionId": session.session_id, "draft": draft, "requestNumber": number, "expectedRevision": session.revision + number - 1, "generation": number })
}

fn bold() -> CellFormat { CellFormat { bold: true, ..CellFormat::default() } }

#[test]
fn saves_formats_with_the_header_json_reopens_and_duplicates_them() {
    let mut c = fixture();
    let session = c.open(None);
    let lines: Vec<Value> = (0..2).map(|_| serde_json::to_value(c.editor.add_line(&c.store, &json!({ "sessionId": session.session_id, "materialId": null })).unwrap()).unwrap()).collect();
    // 書式のない帳票の header は従来と同じ JSON。
    let plain = json!({ "title": "架空", "header": { "C2": "宛先", "A4": "", "B4": "", "C4": "", "E4": "" }, "templateVersion": "excel-v1", "lines": lines });
    let receipt = c.editor.save(&c.store, &request(&session, plain.clone(), 1)).unwrap();
    let text: String = c.store.conn().query_row("SELECT header FROM documents WHERE id=?", [&receipt.document_id], |row| row.get(0)).unwrap();
    assert_eq!(text, r#"{"C2":"宛先","A4":"","B4":"","C4":"","E4":""}"#);
    let reopened = c.open(Some(&receipt.document_id));
    assert!(reopened.draft.formats.is_empty() && reopened.draft.lines.iter().all(|line| line.formats.is_empty()));
    assert!(serde_json::to_value(&reopened.draft).unwrap().get("formats").is_none());
    assert!(serde_json::to_value(&reopened.draft.lines[0]).unwrap().get("formats").is_none());

    let mut formatted = plain.clone();
    formatted["formats"] = json!({ "C2": { "bold": true, "color": "FF0000" }, "E4": {} });
    formatted["lines"][0]["formats"] = json!({ "name": { "horizontal": "center", "vertical": "top", "size": 14, "fill": "FFF2CC" }, "quantity": {} });
    let session = reopened;
    c.editor.save(&c.store, &request(&session, formatted, 1)).unwrap();
    let first = session.draft.lines[0].id.clone();
    // 空の書式（{}）は保存しない。
    let stored = c.header_json(&receipt.document_id)["formats"].clone();
    assert_eq!(stored["header"], json!({ "C2": { "bold": true, "color": "FF0000" } }));
    assert_eq!(stored["lines"].as_object().map(|o| o.len()), Some(1));
    assert_eq!(stored["lines"][&first], json!({ "name": { "horizontal": "center", "vertical": "top", "size": 14, "fill": "FFF2CC" } }));
    let reopened = c.open(Some(&receipt.document_id));
    assert_eq!(reopened.draft.formats.c2, Some(CellFormat { bold: true, color: Some("FF0000".into()), ..CellFormat::default() }));
    assert_eq!(reopened.draft.lines[0].formats.name, Some(CellFormat { horizontal: Some(Horizontal::Center), vertical: Some(Vertical::Top), size: Some(14), fill: Some("FFF2CC".into()), ..CellFormat::default() }));
    assert!(reopened.draft.lines[1].formats.is_empty());
    // 明細の書式は明細といっしょに並べ替わり、削除した明細の書式は残らない。
    let mut moved = serde_json::to_value(&reopened.draft).unwrap();
    let kept = moved["lines"][0].clone();
    moved["lines"] = json!([moved["lines"][1].clone(), kept]);
    moved["lines"][0]["formats"] = json!({ "mark": { "horizontal": "center" } });
    c.editor.save(&c.store, &request(&reopened, moved.clone(), 1)).unwrap();
    let after = c.open(Some(&receipt.document_id));
    assert_eq!((after.draft.lines[1].id.clone(), after.draft.lines[1].formats.name.as_ref().map(|f| f.size)), (first.clone(), Some(Some(14))));
    assert_eq!(after.draft.lines[0].formats.mark.as_ref().and_then(|f| f.horizontal), Some(Horizontal::Center));
    let mut removed = serde_json::to_value(&after.draft).unwrap();
    removed["lines"] = json!([removed["lines"][0].clone()]);
    c.editor.save(&c.store, &request(&after, removed, 1)).unwrap();
    let lines = c.header_json(&receipt.document_id)["formats"]["lines"].clone();
    assert_eq!(lines.as_object().map(|o| o.keys().cloned().collect::<Vec<_>>()), Some(vec![after.draft.lines[0].id.clone()]));
    // 複製は新しい明細IDに書式を引き継ぐ。
    let duplicate = c.editor.duplicate(&c.store, &json!(receipt.document_id)).unwrap();
    assert_eq!(duplicate.draft.formats.c2, Some(CellFormat { bold: true, color: Some("FF0000".into()), ..CellFormat::default() }));
    let copy = c.editor.save(&c.store, &request(&duplicate, serde_json::to_value(&duplicate.draft).unwrap(), 1)).unwrap();
    let copied = c.header_json(&copy.document_id)["formats"]["lines"].clone();
    assert_eq!(copied.as_object().map(|o| o.keys().cloned().collect::<Vec<_>>()), Some(vec![duplicate.draft.lines[0].id.clone()]));
    assert_ne!(duplicate.draft.lines[0].id, after.draft.lines[0].id);
}

#[test]
fn rejects_unknown_format_values_and_ignores_unreadable_stored_formats() {
    let mut c = fixture();
    let session = c.open(None);
    let line = serde_json::to_value(c.editor.add_line(&c.store, &json!({ "sessionId": session.session_id, "materialId": null })).unwrap()).unwrap();
    let base = json!({ "title": "", "header": { "C2": "", "A4": "", "B4": "", "C4": "", "E4": "" }, "templateVersion": "excel-v1", "lines": [line] });
    for (path, value) in [
        ("formats", json!({ "D4": { "bold": true } })), ("formats", json!({ "C2": { "color": "123456" } })), ("formats", json!({ "C2": { "size": 72 } })),
        ("formats", json!({ "C2": { "bold": false } })), ("formats", json!({ "C2": { "horizontal": "fill" } })), ("formats", json!([])),
        ("line", json!({ "unitPrice": { "bold": true } })), ("line", json!({ "name": { "font": "x" } })),
    ] {
        let mut draft = base.clone();
        if path == "line" { draft["lines"][0]["formats"] = value; } else { draft["formats"] = value; }
        assert!(matches!(c.editor.save(&c.store, &request(&session, draft, 1)), Err(Error::Validation(_))));
    }
    let receipt = c.editor.save(&c.store, &request(&session, base, 1)).unwrap();
    // 壊れた書式が保存されていても帳票は開ける（書式は無視する）。
    c.store.conn().execute("UPDATE documents SET header = json_set(header, '$.formats', json('{\"header\":{\"C2\":{\"bold\":\"yes\"}},\"lines\":7}')) WHERE id = ?", [&receipt.document_id]).unwrap();
    let reopened = c.open(Some(&receipt.document_id));
    assert!(reopened.draft.formats.is_empty());
    assert_eq!(reopened.draft.header.c2, "");
}

fn line(name: &str, formats: LineFormats) -> SheetLine {
    SheetLine { name: name.into(), model: "001-A".into(), manufacturer: "架空メーカー".into(), quantity: "3".into(), remarks: "".into(), mark: "●".into(), formats }
}

fn model() -> PrintModel {
    PrintModel {
        document_id: "x".into(), revision: 2, template_version: TEMPLATE_VERSION.into(),
        header: SheetHeader { c2: "架空宛先".into(), a4: "A".into(), b4: "".into(), c4: "".into(), e4: "".into() },
        lines: vec![
            line("中央太字", LineFormats { name: Some(CellFormat { horizontal: Some(Horizontal::Center), bold: true, ..CellFormat::default() }), quantity: Some(CellFormat { horizontal: Some(Horizontal::Right), ..CellFormat::default() }), ..LineFormats::default() }),
            line("右寄せの長い架空材料名がはみ出す", LineFormats { remarks: Some(bold()), model: Some(CellFormat { horizontal: Some(Horizontal::Right), ..CellFormat::default() }), ..LineFormats::default() }),
        ],
        formats: HeaderFormats { c2: Some(CellFormat { size: Some(14), color: Some("FF0000".into()), fill: Some("FFF2CC".into()), italic: true, underline: true, vertical: Some(Vertical::Center), ..CellFormat::default() }), ..HeaderFormats::default() },
    }
}

fn unzip(bytes: &[u8]) -> HashMap<String, Vec<u8>> {
    let mut archive = Archive::open(bytes).unwrap();
    let mut parts = HashMap::new();
    while let Some(entry) = archive.next_entry() { let entry = entry.unwrap(); parts.insert(entry.file_name.clone(), archive.read_entry_data(&entry).unwrap()); }
    parts
}

fn style_of(sheet: &str, reference: &str) -> usize {
    Regex::new(&format!(r#"<c r="{reference}" s="(\d+)""#)).unwrap().captures(sheet).and_then(|m| m[1].parse().ok()).unwrap_or(usize::MAX)
}

#[test]
fn writes_one_extra_cell_format_per_combination_after_the_fixed_styles() {
    let parts = unzip(&build_workbook(&model()).unwrap());
    let styles = String::from_utf8(parts["xl/styles.xml"].clone()).unwrap();
    let sheet = String::from_utf8(parts["xl/worksheets/sheet1.xml"].clone()).unwrap();
    assert!(parse_xml(styles.as_bytes()).is_ok());
    // 書式を付けた C2・B6・E6・C7・F7 に、行優先の順で xf を足す。
    assert!(styles.contains("<cellXfs count=\"22\">"));
    assert_eq!(["C2", "B6", "E6", "C7", "F7"].map(|r| style_of(&sheet, r)), [17, 18, 19, 20, 21]);
    assert!(["A4", "D6", "B7", "E7", "B8", "A6"].iter().all(|r| style_of(&sheet, r) < 17));
    assert!(styles.contains("<fonts count=\"5\">"));
    assert!(styles.contains("<font><i/><u/><sz val=\"14\"/><color rgb=\"FFFF0000\"/><name val=\"ＭＳ Ｐ明朝\"/><family val=\"1\"/><charset val=\"128\"/></font>"));
    assert!(styles.contains("<font><b/><sz val=\"11\"/><name val=\"ＭＳ Ｐ明朝\"/><family val=\"1\"/><charset val=\"128\"/></font>"));
    assert!(styles.contains("<fills count=\"3\">") && styles.contains("<fill><patternFill patternType=\"solid\"><fgColor rgb=\"FFFFF2CC\"/><bgColor indexed=\"64\"/></patternFill></fill>"));
    // C2（既定の中央揃え）に縦位置だけ付けた xf は、横位置の既定も書く（既定の xf と同じ値）。
    assert!(styles.contains("<xf numFmtId=\"0\" fontId=\"3\" fillId=\"2\" borderId=\"0\" xfId=\"0\" applyFont=\"1\" applyFill=\"1\" applyBorder=\"1\" applyAlignment=\"1\"><alignment horizontal=\"center\" vertical=\"center\"/></xf>"));
    // 既定の中央揃えのまま太字にした B6・F7 は同じフォントを使い、配置は既定と同じ中央のまま。数量の数値書式は変えない。
    assert!(styles.contains("<xf numFmtId=\"0\" fontId=\"4\" fillId=\"0\" borderId=\"8\" xfId=\"0\" applyFont=\"1\" applyBorder=\"1\" applyAlignment=\"1\"><alignment horizontal=\"center\"/></xf>"));
    assert!(styles.contains("<xf numFmtId=\"176\" fontId=\"1\" fillId=\"0\" borderId=\"8\" xfId=\"0\" applyNumberFormat=\"1\" applyFont=\"1\" applyBorder=\"1\" applyAlignment=\"1\"><alignment horizontal=\"right\"/></xf>"));
    assert!(styles.contains("<xf numFmtId=\"0\" fontId=\"1\" fillId=\"0\" borderId=\"8\" xfId=\"0\" applyFont=\"1\" applyBorder=\"1\" applyAlignment=\"1\"><alignment horizontal=\"right\"/></xf>"));
    assert!(styles.contains("<xf numFmtId=\"0\" fontId=\"4\" fillId=\"0\" borderId=\"7\" xfId=\"0\" applyFont=\"1\" applyBorder=\"1\" applyAlignment=\"1\"><alignment horizontal=\"center\"/></xf></cellXfs>"));
    assert!(!styles.contains("indent="));
    assert!(generated_styles(styles.as_bytes()));
}

#[test]
fn keeps_unformatted_output_identical_and_recognizes_only_regenerable_styles() {
    let plain = PrintModel { lines: model().lines.into_iter().map(|line| SheetLine { formats: LineFormats::default(), ..line }).collect(), formats: HeaderFormats::default(), ..model() };
    let parts = unzip(&build_workbook(&plain).unwrap());
    assert_eq!(parts["xl/styles.xml"], STYLES.as_bytes());
    assert_eq!(*STYLES, styles_xml(&[]));
    assert!(generated_styles(STYLES.as_bytes()));
    // 帳票の既定（17個の xf）: 標準スタイル以外は、すべて横位置が中央揃えで字下げはない（縦位置は Excel の既定の下揃えのため指定しない）。
    assert!(STYLES.contains("<cellXfs count=\"17\">"));
    assert_eq!(STYLES.matches("<alignment horizontal=\"center\"/>").count(), 16);
    assert!(!STYLES.contains("indent=") && !STYLES.contains("horizontal=\"left\"") && !STYLES.contains("vertical="));
    let formatted = styles_xml(&[(StyleName::LineText, bold())]);
    assert!(generated_styles(formatted.as_bytes()));
    // 記録の改ざん: 12（明細の品名・形式）を 14（数量）にすると数値書式の違う xf になる（13 のメーカー列は品名と同じ既定のため区別がつかない）。
    for tampered in [
        formatted.replace("<b/>", "<b/><i/>"), formatted.replace("[[12,", "[[14,"), formatted.replace(r#"{"bold":true}"#, r#"{"bold":true,"x":1}"#),
        formatted.replace("<!-- parts-order-manager:formats ", "<!-- other "), formatted.replace(r#"[[12,{"bold":true}]]"#, "[]"), format!("{formatted} "),
    ] {
        assert!(!generated_styles(tampered.as_bytes()), "{tampered}");
    }
    // 書式を変えた帳票で、以前に出力したファイル（書式なし・別の書式）へ上書きできる。それ以外の styles.xml は拒否する。
    let expected = workbook_envelope(&build_workbook(&model()).unwrap()).unwrap();
    for earlier in [build_workbook(&plain).unwrap(), build_workbook(&PrintModel { formats: HeaderFormats::default(), ..model() }).unwrap()] {
        assert!(assert_generated_envelope(&workbook_envelope(&earlier).unwrap(), &expected).is_ok());
    }
    let mut foreign = workbook_envelope(&build_workbook(&plain).unwrap()).unwrap();
    foreign.insert("xl/styles.xml".into(), formatted.replace("<b/>", "<b/><i/>").into_bytes());
    assert!(matches!(assert_generated_envelope(&foreign, &expected), Err(Error::ExportFile(_))));
}

#[test]
fn prints_formats_with_fixed_classes_and_a_matching_csp() {
    let html = print_html(&model(), "app://print/1", "");
    let (style, csp) = page_style(&model());
    assert_eq!(style, FORMATTED_STYLE.as_str());
    assert!(html.contains(&format!("<style>{style}</style>")) && !html.contains(" style=\""));
    let digest = base64::engine::general_purpose::STANDARD.encode(Sha256::digest(style.as_bytes()));
    assert!(csp.contains(&format!("'sha256-{digest}'")));
    assert!(html.contains("<div class=\"fill x2 y2 g3\"></div><svg"));
    // 既定の中央揃えの宛先は、左右の空欄（A・B と D〜G）へ同じ幅だけはみ出す位置のクラスになる。
    assert!(html.contains("<div class=\"t r2 m2-2-4 f1 center middle i u z14 k9\"><span>架空宛先</span></div>"));
    assert!(html.contains("<div class=\"t r6 c1 s1-1 f1 center b\"><span>中央太字</span></div>"));
    assert!(html.contains("<div class=\"t r6 c4 s4-1 f1 right\"><span>3</span></div>"));
    // 右揃えの文字は左隣が空欄でなければはみ出さない（B7 に品名がある）。
    assert!(html.contains("<div class=\"t r7 c2 s2-1 f1 right\"><span>001-A</span></div>"));
    for class in [".t.right", ".t.top", ".t.middle", ".t.b", ".t.i", ".t.u > span", ".z14{font-size:14pt}", ".k9{color:#FF0000}", ".g3{background:#FFF2CC}", ".x2{left:", ".y2{top:"] { assert!(style.contains(class), "{class}"); }
    // 書式のない帳票は従来と同じスタイルとCSP。
    let plain = PrintModel { lines: model().lines.into_iter().map(|line| SheetLine { formats: LineFormats::default(), ..line }).collect(), formats: HeaderFormats::default(), ..model() };
    assert_eq!(page_style(&plain), (STYLE.as_str(), PRINT_CSP.as_str()));
}

#[test]
fn right_aligned_text_spills_left_into_empty_cells_like_excel() {
    let mut header = model();
    header.formats = HeaderFormats { c2: Some(CellFormat { horizontal: Some(Horizontal::Right), ..CellFormat::default() }), ..HeaderFormats::default() };
    let html = print_html(&header, "app://print/1", "");
    assert!(html.contains("<div class=\"t r2 c0 s0-3 f1 right\"><span>架空宛先</span></div>"));
}
