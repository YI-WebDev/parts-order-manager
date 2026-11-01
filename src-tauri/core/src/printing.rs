//! 印刷・PDFの帳票HTML（src/main/printing/html.ts）。
//! 画面のExcelプレビューと同じ寸法・罫線で印刷範囲（A〜G列）を描き、Excelと同じ余白の内側へA4縦1ページに収まるよう縮小する。
//! プレビューのウィンドウはスクリプトを無効にし、CSPでスタイルを固定するため、位置はすべて下の固定CSSのクラスで指定する。

use std::collections::HashMap;
use std::sync::LazyLock;

use base64::Engine;
use sha2::{Digest, Sha256};

use crate::exports::PrintModel;
use crate::format::{color_index, Vertical, FONT_SIZES, PALETTE};
use crate::js::num;
use crate::sheet::{
    cell_key, column_name, display_text, h, height, overflow_columns, overflow_columns_left, overflow_sides, print_width, resolve, sheet_cells, side_room, w, x, y, Align, SheetValue, BORDER_PATHS, CSS_FONTS,
    FONTS, INDENT, PAD, PRINT_COLUMNS, SHEET_ROWS,
};

const PAGE_W: f64 = 210.0 / 25.4 * 96.0;
const PAGE_H: f64 = 297.0 / 25.4 * 96.0;
const MARGIN_X: f64 = 0.7 * 96.0;
const MARGIN_Y: f64 = 0.75 * 96.0;

pub static PRINT_SCALE: LazyLock<f64> = LazyLock::new(|| {
    (((PAGE_W - 2.0 * MARGIN_X) / print_width() as f64).min((PAGE_H - 2.0 * MARGIN_Y) / height() as f64) * 100.0).floor() / 100.0
});

pub static STYLE: LazyLock<String> = LazyLock::new(|| {
    let rows: String = (1..=SHEET_ROWS).map(|row| format!(".r{row}{{top:{}px;height:{}px}}", y(row), h(row) - 1)).collect();
    let columns: String = (0..PRINT_COLUMNS).map(|column| {
        let mut out = format!(".c{column}{{left:{}px}}", x(column));
        for span in 0..PRINT_COLUMNS - column { out += &format!(".s{column}-{}{{width:{}px}}", span + 1, x(column + span + 1) - x(column) - 1); }
        out
    }).collect();
    // 中央揃えの文字が左右に続く空欄へ同じ幅だけはみ出すときの位置と幅（列 column、左に続く空欄 left 個、右に続く空欄 right 個。幅は短い側まで）。
    let centered: String = (0..PRINT_COLUMNS).flat_map(|column| (1..=column).flat_map(move |left| (1..PRINT_COLUMNS - column).map(move |right| {
        let room = side_room(column, (left, right));
        format!(".m{column}-{left}-{right}{{left:{}px;width:{}px}}", x(column) - room, w(column) + 2 * room - 1)
    }))).collect();
    let fonts: String = CSS_FONTS.iter().enumerate().map(|(index, font)| format!(".f{index}{{font-family:{};font-size:{}}}", font.family, font.size)).collect();
    let scale = num(*PRINT_SCALE);
    let (print_width, height) = (print_width(), height());
    format!("@page {{ size: A4 portrait; margin: 0.75in 0.7in; }}
* {{ box-sizing: border-box; }} body {{ margin: 0; color: #000; background: #fff; }}
nav {{ position: sticky; top: 0; z-index: 1; display: flex; align-items: center; gap: 8px 16px; flex-wrap: wrap; background: #fff; border-bottom: 1px solid #d8d9d7; padding: 10px 24px; color: #2f3437; font: 14px/1.6 \"Yu Gothic UI\", Meiryo, sans-serif; }}
nav a {{ display: inline-flex; align-items: center; justify-content: center; white-space: nowrap; min-height: 44px; padding: 0 16px; border-radius: 4px; border: 1px solid #8b908d; background: #fff; color: #254f46; font-weight: 700; text-decoration: none; }}
nav a:hover {{ background: #edf3ec; }} nav a:focus-visible {{ outline: 3px solid #245fc4; outline-offset: 1px; }}
nav a.close {{ border-color: transparent; min-height: 40px; padding: 0 12px; }} nav a.primary {{ background: #254f46; border-color: #254f46; color: #fff; padding: 0 20px; }} nav a.primary:hover {{ background: #193e36; }}
nav .title {{ display: flex; flex-direction: column; line-height: 1.4; }} nav .title strong {{ font-weight: 700; }} nav .note, nav details {{ color: #595b5d; font-size: 12px; }}
nav .actions {{ margin-left: auto; display: flex; gap: 8px; flex-wrap: wrap; }} nav details {{ flex-basis: 100%; }} nav summary {{ cursor: pointer; color: #254f46; font-weight: 700; }} nav details p {{ margin: 4px 0; }}
nav p[role=\"status\"] {{ flex-basis: 100%; margin: 0; }} nav p[role=\"status\"]:empty {{ display: none; }}
nav p[role=\"status\"]:not(:empty) {{ padding: 8px 16px; border-radius: 4px; background: #edf3ec; border: 1px solid #254f46; color: #254f46; }}
.paper {{ width: 210mm; min-height: 297mm; margin: 32px auto; padding: 0.75in 0.7in; background: #fff; border: 1px solid #d8d9d7; box-shadow: 0 4px 16px rgb(47 52 55 / 12%); }}
.sheet {{ position: relative; width: {print_width}px; height: {height}px; margin: 0 auto; zoom: {scale}; }}
.sheet svg {{ position: absolute; left: 0; top: 0; overflow: visible; }} .sheet path {{ fill: none; stroke: #000; stroke-width: 1; }}
.t {{ position: absolute; display: flex; align-items: flex-end; overflow: hidden; white-space: pre; padding: 0 {PAD}px 1px; line-height: 1.25; }}
.t.center {{ justify-content: center; }} .t.indent {{ padding-left: {}px; }}
{rows}{columns}{centered}{fonts}
@media screen {{ body {{ background: #edece8; }} }}
@media screen and (max-width: 860px) {{ .paper {{ zoom: 0.85; }} }}
@media screen and (max-width: 720px) {{ .paper {{ zoom: 0.6; }} }}
@media screen and (max-width: 520px) {{ .paper {{ zoom: 0.4; }} }}
@media print {{ nav {{ display: none; }} .paper {{ width: auto; min-height: 0; margin: 0; padding: 0; border: 0; box-shadow: none; }} }}", PAD + INDENT)
});

/// セルの書式（配置・文字・色・塗りつぶし）のクラス。書式を付けたセルがある帳票だけ STYLE の後ろに足す。
/// 塗りつぶしはセルの枠（グリッド線の位置）まで覆い、罫線はその上に描く。
pub static FORMAT_STYLE: LazyLock<String> = LazyLock::new(|| {
    let rows: String = (1..=SHEET_ROWS).map(|row| format!(".y{row}{{top:{}px;height:{}px}}", y(row) - 1, h(row) + 1)).collect();
    let columns: String = (0..PRINT_COLUMNS).map(|column| format!(".x{column}{{left:{}px;width:{}px}}", x(column) - 1, w(column) + 1)).collect();
    let sizes: String = FONT_SIZES.iter().map(|size| format!(".z{size}{{font-size:{size}pt}}")).collect();
    let colors: String = PALETTE.iter().enumerate().map(|(index, color)| format!(".k{index}{{color:#{}}}.g{index}{{background:#{}}}", color.code, color.code)).collect();
    format!("
.fill {{ position: absolute; -webkit-print-color-adjust: exact; print-color-adjust: exact; }}
.t.right {{ justify-content: flex-end; }} .t.top {{ align-items: flex-start; }} .t.middle {{ align-items: center; }}
.t.b {{ font-weight: 700; }} .t.i {{ font-style: italic; }} .t.u > span {{ text-decoration: underline; }}
{rows}{columns}{sizes}{colors}")
});

/// 書式を付けたセルがある帳票のスタイル。
pub static FORMATTED_STYLE: LazyLock<String> = LazyLock::new(|| format!("{}{}", *STYLE, *FORMAT_STYLE));

fn csp(style: &str) -> String {
    let digest = base64::engine::general_purpose::STANDARD.encode(Sha256::digest(style.as_bytes()));
    format!("default-src 'none'; style-src 'sha256-{digest}'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'")
}

/// プレビューのCSP（固定スタイルのハッシュだけを許可する）。
pub static PRINT_CSP: LazyLock<String> = LazyLock::new(|| csp(&STYLE));
static FORMATTED_CSP: LazyLock<String> = LazyLock::new(|| csp(&FORMATTED_STYLE));

fn formatted(model: &PrintModel) -> bool { !model.formats.is_empty() || model.lines.iter().any(|line| !line.formats.is_empty()) }

/// 帳票に使うスタイルと、そのCSP（書式のない帳票は従来と同じ STYLE・PRINT_CSP）。
pub fn page_style(model: &PrintModel) -> (&'static str, &'static str) {
    if formatted(model) { (FORMATTED_STYLE.as_str(), FORMATTED_CSP.as_str()) } else { (STYLE.as_str(), PRINT_CSP.as_str()) }
}

pub fn escape(value: &str) -> String {
    value.replace('&', "&amp;").replace('<', "&lt;").replace('>', "&gt;").replace('"', "&quot;").replace('\'', "&#39;")
}

/// Excel出力と同じ帳票定義のセルを、固定CSSのクラスで配置する。
fn sheet_html(model: &PrintModel) -> String {
    let cells = sheet_cells(&model.header, &model.formats, &model.lines);
    let shown: HashMap<usize, String> = cells.iter().map(|cell| (cell_key(cell.row, cell.column), display_text(cell.value.as_ref()))).collect();
    let empty = |row: usize, column: usize| shown.get(&cell_key(row, column)).map(|t| t.is_empty()).unwrap_or(true);
    let fills: String = cells.iter().filter(|cell| cell.column < PRINT_COLUMNS).filter_map(|cell| {
        let index = cell.format.as_ref()?.fill.as_deref().and_then(color_index)?;
        Some(format!("<div class=\"fill x{} y{} g{index}\"></div>", cell.column, cell.row))
    }).collect();
    let texts: String = cells.iter().map(|cell| {
        let text = shown.get(&cell_key(cell.row, cell.column)).cloned().unwrap_or_default();
        if text.is_empty() { return String::new(); }
        let format = resolve(cell.style, cell.format.as_ref());
        // 左寄せの文字は右に続く空欄へ、右揃えの文字は左に続く空欄へ、中央揃えの文字は左右に続く空欄へ同じ幅だけ、Excelと同じくはみ出して表示する。
        let text_value = matches!(cell.value, Some(SheetValue::Text(_)));
        let placement = match format.align {
            Align::Center => match if text_value { overflow_sides(cell.row, cell.column, empty, PRINT_COLUMNS) } else { (0, 0) } {
                (left, right) if left > 0 && right > 0 => format!("m{}-{left}-{right}", cell.column),
                _ => format!("c{0} s{0}-1", cell.column),
            },
            Align::Right => { let span = if text_value { overflow_columns_left(cell.row, cell.column, empty) } else { 1 }; let start = cell.column + 1 - span; format!("c{start} s{start}-{span}") }
            _ => { let span = if text_value { overflow_columns(cell.row, cell.column, empty, PRINT_COLUMNS) } else { 1 }; format!("c{0} s{0}-{span}", cell.column) }
        };
        let mut classes = String::new();
        if format.align == Align::Center { classes += " center"; }
        if format.align == Align::Right { classes += " right"; }
        if format.indent.is_some_and(|i| i != 0) { classes += " indent"; }
        match format.vertical { Some(Vertical::Top) => classes += " top", Some(Vertical::Center) => classes += " middle", None => {} }
        if format.bold { classes += " b"; }
        if format.italic { classes += " i"; }
        if format.underline { classes += " u"; }
        if format.size != FONTS[format.base.font].size { classes += &format!(" z{}", format.size); }
        if let Some(index) = format.color.as_deref().and_then(color_index) { classes += &format!(" k{index}"); }
        format!("<div class=\"t r{} {placement} f{}{classes}\"><span>{}</span></div>", cell.row, format.base.font, escape(&text))
    }).collect();
    format!("<div class=\"sheet\">{fills}<svg width=\"{}\" height=\"{}\" aria-hidden=\"true\"><path d=\"{}\"/><path d=\"{}\"/></svg>{texts}</div>", print_width(), height(), BORDER_PATHS.thin, BORDER_PATHS.double)
}

pub fn print_html(model: &PrintModel, url: &str, status: &str) -> String {
    format!(
        "<!doctype html><html lang=\"ja\"><head><meta charset=\"utf-8\"><title>印刷プレビュー</title><style>{}</style></head><body><nav aria-label=\"出力操作\"><a class=\"close\" href=\"{url}/close\" aria-label=\"閉じる\">← 閉じる</a><div class=\"title\"><strong>印刷プレビュー ・ 保存版 {}</strong><span class=\"note\">A4縦1ページ ・ Excelへの出力と同じ配置・罫線（印刷範囲 A1:{}{} を用紙の左右中央に置き、{}%に縮小）</span></div><div class=\"actions\"><a href=\"{url}/print\">プリンターを選んで印刷</a><a class=\"primary\" href=\"{url}/save\">PDFとして保存</a></div><details><summary>出力の注意</summary><p>保存済みの帳票内容を表示しています。セルに入りきらない文字は、Excelと同じく途中で切れて表示されません。印刷先の用紙設定でも変わります。</p><p>ネットワーク・クラウドプリンターを選ぶと、その宛先へ内容が送られます。</p><p>PDF保存はローカルNTFSを推奨します。ドライブ文字だけではネットワーク・同期先を判定できません。</p></details><p role=\"status\">{}</p></nav><main class=\"paper\">{}</main></body></html>",
        page_style(model).0, model.revision, column_name(PRINT_COLUMNS - 1), SHEET_ROWS, (*PRINT_SCALE * 100.0).round() as i64, escape(status), sheet_html(model),
    )
}

/// PDF に付ける目印（このアプリが作ったPDFだけを上書きできるようにする）。
pub const PDF_MARKER: &[u8] = b"\n%parts-order-manager:pdf-v1\n";

pub fn pdf_recovery(name: &str) -> String {
    format!("保存先フォルダーの隠しファイルを表示し、一時ファイル「{name}」だけを削除してから再試行してください。完成PDFや他の一時ファイルは削除しないでください。")
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::sheet::{SheetHeader, SheetLine};

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
    fn prints_escaped_saved_fields_in_the_sheet_form() {
        let html = print_html(&model(), "app://print/123", "");
        assert!(html.contains("&lt;script&gt;hidden&lt;/script&gt;") && !html.contains("<script>"));
        for value in ["001-A", "=1+1", "02本", "前半後半", "●", "⦿", "品　　　名", "備　考", "チェック欄記入　　", "材料伝票共に納品⦿", "9月25日"] { assert!(html.contains(&format!(">{value}</span>")), "{value}"); }
        assert!(!html.contains("PRIVATE-ID"));
        // 2行目の宛先は中央揃えで、左の A・B と右の D〜G（印刷範囲まで）の空欄へ同じ幅だけはみ出す。
        assert!(html.contains("<div class=\"t r2 m2-2-4 f1 center\">") && !html.contains(".c7{"));
        let room = side_room(2, (2, 4));
        assert!(room > 0 && html.contains(&format!(".m2-2-4{{left:{}px;width:{}px}}", x(2) - room, w(2) + 2 * room - 1)));
        // 明細の品名（B列）は左の A 列に記号があるため、はみ出さずにセルの幅のまま中央に置く。
        assert!(html.contains("<div class=\"t r6 c1 s1-1 f1 center\"><span>=1+1</span></div>"));
    }

    #[test]
    fn fits_one_a4_page_with_a_matching_csp_hash() {
        let html = print_html(&model(), "app://print/123", "状態");
        assert!(html.contains("@page { size: A4 portrait; margin: 0.75in 0.7in; }"));
        assert!(*PRINT_SCALE > 0.6 && *PRINT_SCALE < 0.68);
        assert!(html.contains(&format!("margin: 0 auto; zoom: {};", num(*PRINT_SCALE))) && html.contains("印刷範囲 A1:G56 を用紙の左右中央に置き"));
        let digest = base64::engine::general_purpose::STANDARD.encode(Sha256::digest(STYLE.as_bytes()));
        assert!(PRINT_CSP.contains(&format!("'sha256-{digest}'")));
        assert!(!html.contains(" style=\""));
    }
}
