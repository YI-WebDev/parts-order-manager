//! E2Eテスト専用の操作口（`--features e2e` のビルドだけに入る。配布物には含めない）。
//!
//! 旧 Electron 版のテストが Main プロセスへ直接差し込んでいた操作（dialog の差し替え・ipcMain の保留・fs の失敗）を、
//! 名前付きの操作として受け付ける。画面からは `window.__TAURI_INTERNALS__.invoke('e2e', { op })` で呼ぶ。
//!
//! - dialog: 種類（open・save・message）ごとの答え（次に差し替えるまで同じ答え）。hold を付けると release まで閉じない
//! - intercept: チャネルごとの差し込み（応答の保留・最初の応答の喪失・置き換え・呼出しの記録）
//! - fault: 書込・新規確定・置換・削除の失敗、復元の途中でのプロセス終了
//! - count: 保留中の数と記録の数（旧テストの ipcMain.listenerCount に当たる）

use std::collections::{HashMap, VecDeque};
use std::sync::Mutex;

use serde_json::{Value, json};
use tokio::sync::oneshot;

#[derive(Clone, Debug, Default)]
struct Answer { value: Value, hold: Option<String> }

#[derive(Clone, Debug, Default)]
pub struct Rule {
    /// 応答を保留する名前（`{query}` は第1引数の query に置き換える）
    hold: Option<String>,
    /// 保留を処理の前に置くか（既定は処理の後＝応答の配達だけを遅らせる）
    hold_before: bool,
    /// 最初の1回だけ保留する
    hold_first_only: bool,
    /// 処理した後、最初の1回だけ応答を失わせる（画面には失敗が届く）
    drop_first: bool,
    /// 実際の処理を呼ばずに返す値（`{query}` ごとの値も指定できる）
    replace: Option<Value>,
    replace_by_query: HashMap<String, Value>,
    /// 実際の処理を呼ばずに拒否する（旧版でハンドラーを外した状態）
    reject: bool,
    /// 応答までの待ち時間（ミリ秒）
    delay_ms: u64,
    /// 呼出しを記録する名前（`{query}`・`{title}` を置き換える）
    record: Vec<String>,
    calls: u64,
}

#[derive(Default)]
struct State {
    answers: HashMap<String, Answer>,
    waiting: HashMap<String, Vec<oneshot::Sender<()>>>,
    marks: HashMap<String, u64>,
    faults: HashMap<String, (u32, Option<i32>)>,
    rules: HashMap<String, Rule>,
    print: Option<String>,
    events: VecDeque<Value>,
}

#[derive(Default)]
pub struct Script { state: Mutex<State> }

/// チャネルの差し込みで決まった扱い。
pub enum Plan { Call { hold: Option<String>, hold_before: bool, drop_reply: bool, delay_ms: u64 }, Replace { value: Value, hold: Option<String>, delay_ms: u64 }, Reject }

fn fill(template: &str, args: &[Value]) -> String {
    let first = args.first();
    let field = |key: &str| first.and_then(|v| v.get(key)).and_then(Value::as_str).map(str::to_string)
        .or_else(|| first.and_then(|v| v.get("draft")).and_then(|d| d.get(key)).and_then(Value::as_str).map(str::to_string)).unwrap_or_default();
    template.replace("{query}", &field("query")).replace("{title}", &field("title"))
}

impl Script {
    fn lock(&self) -> std::sync::MutexGuard<'_, State> { self.state.lock().unwrap_or_else(|e| e.into_inner()) }

    fn record(&self, event: Value) {
        let mut state = self.lock();
        state.events.push_back(event);
        while state.events.len() > 500 { state.events.pop_front(); }
    }

    /// release まで待つ（同じ名前で待っているものはまとめて再開する）。
    pub async fn wait(&self, name: &str) {
        let (sender, receiver) = oneshot::channel();
        self.lock().waiting.entry(name.to_string()).or_default().push(sender);
        let _ = receiver.await;
    }

    /// ダイアログの答え（設定がなければ取消）。呼ばれたことは記録する。
    pub async fn dialog(&self, kind: &str, detail: Value) -> Value {
        self.record(json!({ "type": "dialog", "kind": kind, "detail": detail }));
        let answer = self.lock().answers.get(kind).cloned();
        let Some(answer) = answer else { return Value::Null };
        if let Some(name) = &answer.hold { self.wait(name).await; }
        answer.value
    }

    pub fn error_box(&self, title: &str, message: &str) { self.record(json!({ "type": "error-box", "title": title, "message": message })); }

    pub fn print_outcome(&self) -> Option<String> {
        let outcome = self.lock().print.clone();
        self.record(json!({ "type": "print", "silent": false, "outcome": outcome }));
        outcome
    }

    /// 障害を起こす箇所なら true（回数を使い切ると元に戻る）。exit 指定ならその場でプロセスを終える。
    pub fn fault(&self, point: &str) -> bool {
        let mut state = self.lock();
        let Some((remaining, exit)) = state.faults.get_mut(point) else { return false };
        if *remaining == 0 { return false; }
        *remaining -= 1;
        let exit = *exit;
        drop(state);
        if let Some(code) = exit { std::process::exit(code); }
        self.record(json!({ "type": "fault", "point": point }));
        true
    }

    /// チャネルの呼出しに差し込みがあるか。
    pub fn plan(&self, channel: &str, args: &[Value]) -> Option<Plan> {
        let mut state = self.lock();
        let rule = state.rules.get_mut(channel)?;
        rule.calls += 1;
        let first = rule.calls == 1;
        let hold = rule.hold.as_deref().filter(|_| first || !rule.hold_first_only).map(|t| fill(t, args));
        let records: Vec<String> = rule.record.iter().map(|t| fill(t, args)).collect();
        let plan = if rule.reject { Plan::Reject } else if rule.replace.is_some() || !rule.replace_by_query.is_empty() {
            let query = fill("{query}", args);
            let value = rule.replace_by_query.get(&query).cloned().or_else(|| rule.replace.clone()).unwrap_or(Value::Null);
            Plan::Replace { value, hold, delay_ms: rule.delay_ms }
        } else {
            Plan::Call { hold, hold_before: rule.hold_before, drop_reply: rule.drop_first && first, delay_ms: rule.delay_ms }
        };
        for name in records { *state.marks.entry(name).or_default() += 1; }
        drop(state);
        self.record(json!({ "type": "call", "channel": channel, "args": args }));
        Some(plan)
    }

    /// テストからの操作。画面のプロセスやウィンドウに関わる操作は呼び出し側（shell）が先に処理する。
    pub fn control(&self, request: &Value) -> Result<Value, String> {
        let op = request["op"].as_str().unwrap_or("");
        let mut state = self.lock();
        match op {
            "dialog" => {
                let kind = request["kind"].as_str().ok_or("kind")?.to_string();
                if request.get("value").is_none() && request.get("hold").is_none() { state.answers.remove(&kind); }
                else { state.answers.insert(kind, Answer { value: request["value"].clone(), hold: request["hold"].as_str().map(str::to_string) }); }
                Ok(Value::Null)
            }
            "release" => {
                let name = request["name"].as_str().ok_or("name")?;
                let waiting = state.waiting.remove(name).unwrap_or_default();
                let released = waiting.len();
                for sender in waiting { let _ = sender.send(()); }
                Ok(json!(released))
            }
            "count" => {
                let name = request["name"].as_str().ok_or("name")?;
                let waiting = state.waiting.get(name).map(|w| w.iter().filter(|s| !s.is_closed()).count()).unwrap_or(0) as u64;
                Ok(json!(waiting + state.marks.get(name).copied().unwrap_or(0)))
            }
            "fault" => {
                let point = request["point"].as_str().ok_or("point")?.to_string();
                let times = request["times"].as_u64().unwrap_or(1) as u32;
                state.faults.insert(point, (times, request["exit"].as_i64().map(|c| c as i32)));
                Ok(Value::Null)
            }
            "intercept" => {
                let channel = request["channel"].as_str().ok_or("channel")?.to_string();
                if request.get("rule").is_none_or(Value::is_null) { state.rules.remove(&channel); return Ok(Value::Null); }
                let r = &request["rule"];
                let text = |key: &str| r[key].as_str().map(str::to_string);
                let rule = Rule {
                    hold: text("hold"), hold_before: r["holdBefore"].as_bool().unwrap_or(false), hold_first_only: r["holdFirstOnly"].as_bool().unwrap_or(false),
                    drop_first: r["dropFirst"].as_bool().unwrap_or(false), replace: r.get("replace").cloned(), reject: r["reject"].as_bool().unwrap_or(false),
                    replace_by_query: r["replaceByQuery"].as_object().map(|m| m.iter().map(|(k, v)| (k.clone(), v.clone())).collect()).unwrap_or_default(),
                    delay_ms: r["delayMs"].as_u64().unwrap_or(0),
                    record: r["record"].as_array().map(|a| a.iter().filter_map(|v| v.as_str().map(str::to_string)).collect()).unwrap_or_default(),
                    calls: 0,
                };
                state.rules.insert(channel, rule);
                Ok(Value::Null)
            }
            "print" => { state.print = request["outcome"].as_str().map(str::to_string); Ok(Value::Null) }
            "events" => Ok(json!(state.events.iter().cloned().collect::<Vec<_>>())),
            "clear-events" => { state.events.clear(); Ok(Value::Null) }
            other => Err(format!("unknown e2e op {other}")),
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn block_on<F: std::future::Future>(future: F) -> F::Output { tauri::async_runtime::block_on(future) }

    #[test]
    fn dialogs_keep_their_answer_until_replaced_and_holds_release_together() {
        let script = std::sync::Arc::new(Script::default());
        assert_eq!(block_on(script.dialog("save", Value::Null)), Value::Null);
        script.control(&json!({ "op": "dialog", "kind": "save", "value": "/tmp/a.xlsx" })).unwrap();
        assert_eq!(block_on(script.dialog("save", Value::Null)), json!("/tmp/a.xlsx"));
        assert_eq!(block_on(script.dialog("save", Value::Null)), json!("/tmp/a.xlsx"));
        script.control(&json!({ "op": "dialog", "kind": "open", "value": null, "hold": "x" })).unwrap();
        let waiting = script.clone();
        let handle = std::thread::spawn(move || block_on(waiting.dialog("open", Value::Null)));
        while script.control(&json!({ "op": "count", "name": "x" })).unwrap() != json!(1) { std::thread::yield_now(); }
        assert_eq!(script.control(&json!({ "op": "release", "name": "x" })).unwrap(), json!(1));
        assert_eq!(handle.join().unwrap(), Value::Null);
    }

    #[test]
    fn faults_are_used_up_and_rules_fill_templates() {
        let script = Script::default();
        script.control(&json!({ "op": "fault", "point": "write" })).unwrap();
        assert!(script.fault("write"));
        assert!(!script.fault("write"));
        script.control(&json!({ "op": "intercept", "channel": "materials:search", "rule": { "hold": "test:search:{query}", "replace": { "status": "ok" }, "record": ["test:ime:sent"] } })).unwrap();
        let Some(Plan::Replace { hold, .. }) = script.plan("materials:search", &[json!({ "query": "old" })]) else { panic!("plan") };
        assert_eq!(hold.as_deref(), Some("test:search:old"));
        assert_eq!(script.control(&json!({ "op": "count", "name": "test:ime:sent" })).unwrap(), json!(1));
    }
}
