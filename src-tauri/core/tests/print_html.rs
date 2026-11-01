//! tests/unit/print-html.test.ts の移植（印刷・PDFの帳票HTMLとCSP）。

use base64::Engine;
use pom_core::exports::PrintModel;
use pom_core::js::num;
use pom_core::printing::{print_html, PRINT_CSP, PRINT_SCALE};
use pom_core::sheet::{SheetHeader, SheetLine};
use regex::Regex;
use sha2::{Digest, Sha256};

fn model() -> PrintModel {
    PrintModel {
        document_id: "PRIVATE-ID".into(), revision: 1, template_version: "excel-v1".into(),
        header: SheetHeader { c2: "<script>hidden</script>".into(), a4: "001".into(), b4: "架空".into(), c4: "".into(), e4: "2026/9/25".into() },
        lines: vec![
            SheetLine { name: "=1+1".into(), model: "001-A".into(), manufacturer: "架空メーカー".into(), quantity: "02本".into(), remarks: "前半\n後半".into(), mark: "●".into(), formats: Default::default() },
            SheetLine { name: "架空両方".into(), model: "".into(), manufacturer: "".into(), quantity: "1".into(), remarks: "".into(), mark: "⦿".into(), formats: Default::default() },
        ],
        formats: Default::default(),
    }
}

#[test]
fn prints_only_escaped_saved_fields_in_the_sheet_form_with_no_executable_business_text() {
    // 旧実装の printHtml(model, url) は状態の文言を省略すると空文字列。
    let html = print_html(&model(), "app://print/123", "");
    assert!(html.contains("&lt;script&gt;hidden&lt;/script&gt;"));
    assert!(!html.contains("<script>"));
    // 折り返しなしのExcelと同じく、改行は表示しない。
    for value in ["001-A", "=1+1", "02本", "前半後半", "●", "⦿"] { assert!(html.contains(&format!(">{value}</span>")), "{value}"); }
    assert!(!html.contains("PRIVATE-ID"));
    // 2行目の宛名（既定の中央揃え）は、左の A・B と右の D〜G の空欄へ同じ幅だけはみ出す。右へはみ出せるのは印刷範囲のG列まで（空欄のH列は印刷しない）。
    assert!(html.contains("<div class=\"t r2 m2-2-4 f1 center\">"));
    assert!(!html.contains("m2-2-5") && !html.contains(".c7{"));
    // 見本帳票と同じ見出し・凡例、納期は Excel と同じ m月d日 表示。
    for value in ["品　　　名", "備　考", "チェック欄記入　　", "材料伝票共に納品⦿", "9月25日"] { assert!(html.contains(&format!(">{value}</span>")), "{value}"); }
}

#[test]
fn fits_the_print_area_on_one_a4_page_with_excel_margins_and_a_csp_hash_matching_the_fixed_style() {
    let html = print_html(&model(), "app://print/123", "状態");
    assert!(html.contains("@page { size: A4 portrait; margin: 0.75in 0.7in; }"));
    assert!(*PRINT_SCALE > 0.6);
    assert!(*PRINT_SCALE < 0.68);
    // 縮小倍率は縦で決まるため、余る横幅を左右に振り分ける（Excel出力のページ中央・水平と同じ）。
    assert!(html.contains(&format!("margin: 0 auto; zoom: {};", num(*PRINT_SCALE))));
    assert!(html.contains("印刷範囲 A1:G56 を用紙の左右中央に置き"));
    let style = Regex::new(r"<style>([\s\S]*)</style>").unwrap().captures(&html).map(|c| c[1].to_string()).unwrap_or_default();
    let digest = base64::engine::general_purpose::STANDARD.encode(Sha256::digest(style.as_bytes()));
    assert!(PRINT_CSP.contains(&format!("'sha256-{digest}'")));
    assert!(!Regex::new(r#" style=""#).unwrap().is_match(&html));
    let other = PrintModel { header: SheetHeader { c2: "x".into(), ..model().header }, ..model() };
    assert!(print_html(&other, "app://print/1", "").contains(&format!("<style>{style}</style>")));
}
