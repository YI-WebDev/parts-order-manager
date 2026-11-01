//! 差分テスト用の実行器。標準入力の JSON（1行1要求）で pom-core の App を操作し、結果を1行ずつ返す。
//! 旧実装（TypeScript）を同じ手順で動かした結果と比べるために使う（tests/differential）。
//!
//! 要求: init / dialog / release / trusted / invoke / start / await / close / events / shutdown
//! dialog の値に {"hold": 名前, "value": 値} を渡すと、release で同じ名前が届くまでダイアログが閉じない（処理中の競合の確認用）。

use std::collections::{HashMap, VecDeque};
use std::future::Future;
use std::io::{BufRead, Write};
use std::path::PathBuf;
use std::sync::{Arc, Condvar, Mutex};
use std::task::{Context, Poll, Wake, Waker};

use pom_core::api::{App, AppConfig, BoxFuture, FileFilter, Host, MessageBox, OpenDialog, Parent, PrintSession, SaveDialog};
use serde_json::{json, Value};

#[derive(Default)]
struct Script {
    answers: VecDeque<Value>,
    events: Vec<Value>,
    trusted: bool,
    released: Vec<String>,
}

struct ScriptHost { script: Mutex<Script>, signal: Condvar }

impl ScriptHost {
    /// 記録してから答えを返す。hold 指定なら release まで待つ。
    fn answer(&self, event: Value) -> Value {
        let mut script = self.script.lock().unwrap();
        script.events.push(event);
        let answer = script.answers.pop_front().unwrap_or(Value::Null);
        if let Some(name) = answer.get("hold").and_then(Value::as_str).map(str::to_string) {
            while !script.released.contains(&name) { script = self.signal.wait(script).unwrap(); }
            script.released.retain(|r| r != &name);
            return answer.get("value").cloned().unwrap_or(Value::Null);
        }
        answer
    }
}

fn filters(list: &[FileFilter]) -> Value { json!(list.iter().map(|f| json!({ "name": f.name, "extensions": f.extensions })).collect::<Vec<_>>()) }

impl Host for ScriptHost {
    fn open_file(&self, parent: Parent, dialog: OpenDialog) -> BoxFuture<'_, Option<PathBuf>> {
        let answer = self.answer(json!({ "type": "open", "parent": format!("{parent:?}"), "title": dialog.title, "filters": filters(&dialog.filters) }));
        Box::pin(async move { answer.as_str().map(PathBuf::from) })
    }
    fn save_file(&self, parent: Parent, dialog: SaveDialog) -> BoxFuture<'_, Option<PathBuf>> {
        let answer = self.answer(json!({ "type": "save", "parent": format!("{parent:?}"), "title": dialog.title, "defaultName": dialog.default_path.file_name().map(|n| n.to_string_lossy().into_owned()), "filters": filters(&dialog.filters) }));
        Box::pin(async move { answer.as_str().map(PathBuf::from) })
    }
    fn message_box(&self, parent: Parent, dialog: MessageBox) -> BoxFuture<'_, usize> {
        let answer = self.answer(json!({ "type": "message", "parent": format!("{parent:?}"), "kind": format!("{:?}", dialog.kind), "title": dialog.title, "message": dialog.message, "detail": dialog.detail, "buttons": dialog.buttons, "defaultId": dialog.default_id, "cancelId": dialog.cancel_id }));
        let cancel = dialog.cancel_id;
        Box::pin(async move { answer.as_u64().map(|n| n as usize).unwrap_or(cancel) })
    }
    fn sender_trusted(&self) -> bool { self.script.lock().unwrap().trusted }
    fn emit_close_requested(&self, token: &str) { self.script.lock().unwrap().events.push(json!({ "type": "close-requested", "token": token })); }
    fn close_main_window(&self) { self.script.lock().unwrap().events.push(json!({ "type": "close-window" })); }
    // 旧実装と同じく、ウィンドウを破棄した後の要求は信頼できない送信元として扱う。
    fn quit_after_restore(&self) { let mut script = self.script.lock().unwrap(); script.events.push(json!({ "type": "quit" })); script.trusted = false; }
    fn preview_url(&self, id: &str) -> String { format!("app://print/{id}") }
    fn open_print_preview(&self, _session: Arc<PrintSession>) -> BoxFuture<'_, Result<(), String>> { Box::pin(async { Err("print preview is not available in the harness".to_string()) }) }
}

struct ThreadWaker(std::thread::Thread);
impl Wake for ThreadWaker { fn wake(self: Arc<Self>) { self.0.unpark(); } }

fn block_on<F: Future>(future: F) -> F::Output {
    let mut future = std::pin::pin!(future);
    let waker = Waker::from(Arc::new(ThreadWaker(std::thread::current())));
    let mut context = Context::from_waker(&waker);
    loop {
        if let Poll::Ready(value) = future.as_mut().poll(&mut context) { return value; }
        std::thread::park();
    }
}

fn invoke(app: &Arc<App>, request: &Value) -> Value {
    let args = request["args"].as_array().cloned().unwrap_or_default();
    match block_on(app.invoke(request["channel"].as_str().unwrap_or(""), args)) {
        Ok(value) => json!({ "ok": true, "value": value }),
        Err(error) => json!({ "ok": false, "error": error }),
    }
}

fn error_json(error: pom_core::Error) -> Value {
    match error {
        pom_core::Error::Import(code, message) => json!({ "error": "import", "code": code.as_str(), "message": message }),
        pom_core::Error::Workbook(code) => json!({ "error": "workbook", "code": format!("{code:?}").to_uppercase() }),
        other => json!({ "error": "other", "message": other.to_string() }),
    }
}

fn model(value: &Value) -> pom_core::exports::PrintModel {
    let header = &value["header"];
    let text = |v: &Value| v.as_str().unwrap_or("").to_string();
    pom_core::exports::PrintModel {
        document_id: text(&value["documentId"]), revision: value["revision"].as_i64().unwrap_or(1), template_version: text(&value["templateVersion"]),
        header: pom_core::sheet::SheetHeader { c2: text(&header["C2"]), a4: text(&header["A4"]), b4: text(&header["B4"]), c4: text(&header["C4"]), e4: text(&header["E4"]) },
        lines: value["lines"].as_array().map(|lines| lines.iter().map(|l| pom_core::sheet::SheetLine {
            name: text(&l["name"]), model: text(&l["model"]), manufacturer: text(&l["manufacturer"]), quantity: text(&l["quantity"]), remarks: text(&l["remarks"]), mark: text(&l["mark"]),
            formats: l.get("formats").and_then(|f| pom_core::format::parse_line_formats(f).ok()).unwrap_or_default(),
        }).collect()).unwrap_or_default(),
        // セルの書式（移行後に追加。旧実装との突き合わせでは渡さない）。
        formats: value.get("formats").and_then(|f| pom_core::format::parse_header_formats(f).ok()).unwrap_or_default(),
    }
}

/// 帳票定義と判定結果の一覧（tests/unit/sheet-parity.test.ts が今の src/shared と突き合わせる）。
fn sheet_definitions() -> Value {
    use pom_core::sheet;
    use sheet::{Edge, StyleName};
    let camel = |name: StyleName| { let text = format!("{name:?}"); let mut chars = text.chars(); chars.next().map(|c| c.to_lowercase().collect::<String>() + chars.as_str()).unwrap_or_default() };
    let edge = |value: Option<Edge>| value.map(|e| json!(e.as_str())).unwrap_or(Value::Null);
    let styles: Vec<Value> = sheet::STYLE_NAMES.iter().map(|name| {
        let s = sheet::cell_style(*name);
        json!({ "name": camel(*name), "font": s.font, "numFmt": s.num_fmt, "align": s.align.as_str(), "indent": s.indent,
            "border": { "left": edge(s.border.left), "right": edge(s.border.right), "top": edge(s.border.top), "bottom": edge(s.border.bottom) } })
    }).collect();
    let marks: Vec<Value> = ["unknown", "material_only", "slip_only", "both", "other"].iter().flat_map(|state| {
        ["unresolved", "filled_circle", "open_circle", "both_mark", "other"].iter().flat_map(move |output| {
            ["provisional-v1", "v0"].iter().map(move |rule| json!({ "state": state, "output": output, "rule": rule, "mark": sheet::line_mark(state, output, rule) }))
        })
    }).collect();
    let dates: Vec<Value> = ["", "2026-09-13", "2026/9/13", "2026-01-31", "2026-04-30", "2026-04-31", "2026-02-28", "2026-02-29", "2024-02-29", "2023-02-29", "2024-02/29", "24-02-29", "2024-13-01", "2024-00-10", "2024-1-0", "0000-01-01", "0001-01-01", "1900-02-28", "1900-03-01", "1900-1-1", "1970-01-01", "9999/12/31", "翌週", "２０２４-01-01", " 2024-01-01", "2024-001-01"].iter().map(|input| {
        let value = match sheet::date_value(input) { Some(sheet::SheetValue::Date { serial, month, day }) => json!({ "kind": "date", "serial": serial, "month": month, "day": day }), Some(sheet::SheetValue::Text(t)) => json!({ "kind": "text", "text": t }), None => Value::Null };
        json!({ "input": input, "valid": sheet::valid_date_text(input), "value": value })
    }).collect();
    // 埋まっている列の組合せごとの、はみ出せる列数と幅。
    let fills: [&[usize]; 6] = [&[], &[0], &[1], &[0, 1, 2], &[2, 5], &[7]];
    let mut overflow = Vec::new();
    for filled in fills {
        for column in 0..sheet::COLUMNS {
            for columns in [sheet::PRINT_COLUMNS, sheet::COLUMNS] {
                let empty = |_row: usize, c: usize| !filled.contains(&c);
                let (left, right) = sheet::overflow_sides(6, column, empty, columns);
                overflow.push(json!({ "filled": filled, "column": column, "columns": columns, "right": sheet::overflow_columns(6, column, empty, columns), "left": sheet::overflow_columns_left(6, column, empty),
                    "sides": [left, right], "room": sheet::side_room(column, (left, right)) }));
            }
        }
    }
    let header = sheet::SheetHeader { c2: "宛先".into(), a4: "オーダー".into(), b4: "案件".into(), c4: "備考".into(), e4: "2026-09-13".into() };
    let lines = vec![
        sheet::SheetLine { name: "品A".into(), model: "M-1".into(), manufacturer: "社A".into(), quantity: "12".into(), remarks: "前

後".into(), mark: "●".into(), ..Default::default() },
        sheet::SheetLine { name: "品B".into(), mark: "⦿".into(), ..Default::default() },
    ];
    let cells: Vec<Value> = sheet::sheet_cells(&header, &pom_core::format::HeaderFormats::default(), &lines).iter().map(|cell| json!({
        "ref": cell.reference, "row": cell.row, "column": cell.column, "style": camel(cell.style), "display": sheet::display_text(cell.value.as_ref()),
        "dateValue": match &cell.value { Some(sheet::SheetValue::Date { serial, .. }) => json!(serial), _ => Value::Null },
    })).collect();
    let resolved: Vec<Value> = [
        ("lineText", "{}"), ("lineText", r#"{"horizontal":"left","bold":true}"#), ("lineText", r#"{"horizontal":"right"}"#), ("mark", r#"{"size":12,"color":"FF0000"}"#),
        ("mark", "{}"), ("text", r#"{"horizontal":"center","vertical":"top","italic":true,"underline":true,"fill":"FFF2CC"}"#), ("normal", r#"{"horizontal":"left"}"#),
    ].iter().map(|(name, format)| {
        let style = *sheet::STYLE_NAMES.iter().find(|n| camel(**n) == *name).expect("style name");
        let input: Value = serde_json::from_str(format).unwrap();
        let format = pom_core::format::parse_format(&input).unwrap();
        let r = sheet::resolve(style, Some(&format));
        json!({ "style": name, "format": input, "size": r.size, "bold": r.bold, "italic": r.italic, "underline": r.underline,
            "color": r.color, "fill": r.fill, "align": r.align.as_str(), "vertical": r.vertical.map(|v| v.as_str()), "indent": r.indent, "fontChanged": r.font_changed() })
    }).collect();
    json!({
        "sheetName": sheet::SHEET_NAME, "columnWidths": sheet::COLUMN_WIDTHS, "printColumns": sheet::PRINT_COLUMNS, "sheetRows": sheet::SHEET_ROWS, "lineFirstRow": sheet::LINE_FIRST_ROW,
        "lineRows": sheet::LINE_ROWS, "defaultRowHeight": sheet::DEFAULT_ROW_HEIGHT, "bothMark": sheet::BOTH_MARK,
        "rowHeights": (1..=sheet::SHEET_ROWS).map(sheet::row_height).collect::<Vec<_>>(),
        "fonts": sheet::FONTS.iter().map(|f| json!({ "name": f.name, "size": f.size, "family": f.family })).collect::<Vec<_>>(),
        "numberFormats": sheet::NUMBER_FORMATS.iter().map(|f| json!({ "id": f.id, "code": f.code })).collect::<Vec<_>>(),
        "cssFonts": sheet::CSS_FONTS.iter().map(|f| json!({ "fontFamily": f.family, "fontSize": f.size })).collect::<Vec<_>>(),
        "pad": sheet::PAD, "indent": sheet::INDENT, "columns": sheet::COLUMNS,
        "px": { "w": (0..sheet::COLUMNS).map(sheet::w).collect::<Vec<_>>(), "x": (0..=sheet::COLUMNS).map(sheet::x).collect::<Vec<_>>(),
            "h": (1..=sheet::SHEET_ROWS).map(sheet::h).collect::<Vec<_>>(), "y": (1..=sheet::SHEET_ROWS + 1).map(sheet::y).collect::<Vec<_>>(),
            "width": sheet::width(), "height": sheet::height(), "printWidth": sheet::print_width() },
        "borderPaths": { "thin": sheet::BORDER_PATHS.thin, "double": sheet::BORDER_PATHS.double },
        "styles": styles, "marks": marks, "dates": dates, "overflow": overflow, "cells": cells, "resolved": resolved,
    })
}

/// 関数単位の比較（取込の解析・出力の生成・表示文字列など）。
fn pure(request: &Value) -> Value {
    use base64::Engine;
    let input = &request["input"];
    let text = |key: &str| input[key].as_str().unwrap_or("").to_string();
    let result = match request["fn"].as_str().unwrap_or("") {
        "parseWorkbook" => {
            let bytes = base64::engine::general_purpose::STANDARD.decode(input["bytes"].as_str().unwrap_or("")).unwrap_or_default();
            match pom_core::imports::workbook::parse_workbook(&bytes) {
                Ok(parsed) => json!({ "items": parsed.items, "counts": parsed.counts }),
                Err(error) => error_json(error),
            }
        }
        "buildWorkbook" => match pom_core::exports::workbook_parts(&model(input)) {
            Ok(parts) => json!(parts.into_iter().map(|(name, xml)| (name.to_string(), Value::String(xml))).collect::<serde_json::Map<_, _>>()),
            Err(error) => error_json(error),
        },
        "buildWorkbookBytes" => match pom_core::exports::build_workbook(&model(input)) {
            Ok(bytes) => json!({ "bytes": base64::engine::general_purpose::STANDARD.encode(bytes) }),
            Err(error) => error_json(error),
        },
        "printHtml" => { let model = model(&input["model"]); json!({ "html": pom_core::printing::print_html(&model, &text("url"), &text("status")), "csp": pom_core::printing::page_style(&model).1, "scale": *pom_core::printing::PRINT_SCALE }) }
        "styles" => json!({ "styles": *pom_core::exports::STYLES, "thin": pom_core::sheet::BORDER_PATHS.thin, "double": pom_core::sheet::BORDER_PATHS.double, "workbook": pom_core::exports::workbook_xml(false, false), "legacy": [pom_core::exports::workbook_xml(true, true), pom_core::exports::workbook_xml(false, true)] }),
        "numericDisplay" => { let (display, verified) = pom_core::imports::cells::numeric_display(&text("raw"), &text("format")); json!({ "text": display, "verified": verified }) }
        "text" => {
            let value = text("value");
            let values = pom_core::materials::MaterialValues { name: value.clone(), model: value.clone(), manufacturer: String::new(), quantity: String::new(), remarks: value.clone(), unit_price: String::new() };
            let date = match pom_core::sheet::date_value(&value) { Some(pom_core::sheet::SheetValue::Date { serial, month, day }) => json!({ "kind": "date", "serial": serial, "month": month, "day": day }), Some(pom_core::sheet::SheetValue::Text(t)) => json!({ "kind": "text", "text": t }), None => Value::Null };
            json!({ "normalize": pom_core::search::normalize(&value), "searchText": pom_core::materials::search_text(&values), "heading": pom_core::imports::workbook::heading(&value), "validDate": pom_core::sheet::valid_date_text(&value), "dateValue": date, "trim": pom_core::js::trim(&value) })
        }
        "sheetDefinitions" => sheet_definitions(),
        other => json!({ "error": format!("unknown fn {other}") }),
    };
    json!({ "ok": true, "value": result })
}

fn main() {
    let host = Arc::new(ScriptHost { script: Mutex::new(Script { trusted: true, ..Script::default() }), signal: Condvar::new() });
    let mut app: Option<Arc<App>> = None;
    let mut running: HashMap<String, std::thread::JoinHandle<Value>> = HashMap::new();
    let stdin = std::io::stdin();
    let mut stdout = std::io::stdout();
    for line in stdin.lock().lines() {
        let Ok(line) = line else { break };
        if line.trim().is_empty() { continue; }
        let request: Value = serde_json::from_str(&line).expect("request JSON");
        let response = match request["op"].as_str().unwrap_or("") {
            "init" => {
                let user_data = PathBuf::from(request["userData"].as_str().unwrap());
                match pom_core::api::start(&user_data) {
                    Ok((notice, store)) => {
                        let config = AppConfig {
                            user_data: user_data.clone(), documents_dir: PathBuf::from(request["documents"].as_str().unwrap_or("/")), version: request["version"].as_str().unwrap_or("0.1.0").into(),
                            protected_roots: request["protected"].as_array().map(|a| a.iter().filter_map(|v| v.as_str().map(PathBuf::from)).collect()).unwrap_or_default(), recovery_notice: notice.clone(),
                        };
                        host.script.lock().unwrap().trusted = true;
                        app = Some(App::new(config, store, host.clone()));
                        json!({ "ok": true, "recoveryNotice": notice })
                    }
                    Err(error) => json!({ "ok": false, "error": error.to_string() }),
                }
            }
            "dialog" => { host.script.lock().unwrap().answers.push_back(request["value"].clone()); json!({ "ok": true }) }
            "release" => { host.script.lock().unwrap().released.push(request["name"].as_str().unwrap_or("").to_string()); host.signal.notify_all(); json!({ "ok": true }) }
            "trusted" => { host.script.lock().unwrap().trusted = request["value"].as_bool().unwrap_or(true); json!({ "ok": true }) }
            "events" => { let events = std::mem::take(&mut host.script.lock().unwrap().events); json!({ "ok": true, "events": events }) }
            "invoke" => invoke(app.as_ref().expect("init first"), &request),
            "start" => {
                let app = app.clone().expect("init first");
                let id = request["id"].as_str().unwrap_or("").to_string();
                let request = request.clone();
                running.insert(id, std::thread::spawn(move || invoke(&app, &request)));
                // 処理がダイアログ待ちに入るのを待つ。
                std::thread::sleep(std::time::Duration::from_millis(200));
                json!({ "ok": true })
            }
            "await" => match running.remove(request["id"].as_str().unwrap_or("")) { Some(handle) => handle.join().unwrap_or(json!({ "ok": false, "error": "panicked" })), None => json!({ "ok": false, "error": "unknown id" }) },
            "close" => { let app = app.as_ref().expect("init first"); json!({ "ok": true, "allowed": app.request_close() }) }
            "shutdown" => { if let Some(app) = app.take() { app.shutdown(); } json!({ "ok": true }) }
            "pure" => pure(&request),
            other => json!({ "ok": false, "error": format!("unknown op {other}") }),
        };
        writeln!(stdout, "{response}").unwrap();
        stdout.flush().unwrap();
    }
}
