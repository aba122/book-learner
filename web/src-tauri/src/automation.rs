//! 调试自动化桥(门禁用):**仅 debug 构建**且仅当环境变量 `BOOK_LEARNER_AUTOMATION_SOCK` 指向一个
//! unix socket 路径时启用。协议为一行一个 JSON 请求、一行一个 JSON 响应:
//! - `{"js": "<函数体,可 return/await>", "timeout_ms": 60000}` → 在主 WebView 里执行,结果经
//!   `automation_report` 命令回传 → `{"id": ..., "result": <JSON>}`;
//! - `{"tray_title": true}` → `{"title": "<最近一次写入托盘的标题>"}`;
//! - `{"quit": true}` → `app.exit(0)`(与 Cmd+Q 同走 `RunEvent::ExitRequested`)。
//!
//! 用途:经 SSH 在真实 bundle 上驱动门禁(无屏幕录制/辅助功能权限时的替代),不进契约、不给前端调用。
//! release 构建里 `maybe_spawn` 恒为 no-op,`automation_report` 恒返回 invalid_request。
use std::collections::HashMap;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Condvar, Mutex, OnceLock};
use std::time::{Duration, Instant};

pub const ENV_SOCK: &str = "BOOK_LEARNER_AUTOMATION_SOCK";

struct Results {
    map: Mutex<HashMap<String, String>>,
    cv: Condvar,
}

fn results() -> &'static Results {
    static RESULTS: OnceLock<Results> = OnceLock::new();
    RESULTS.get_or_init(|| Results {
        map: Mutex::new(HashMap::new()),
        cv: Condvar::new(),
    })
}

static TRAY_TITLE: Mutex<Option<String>> = Mutex::new(None);
static SEQ: AtomicU64 = AtomicU64::new(1);

/// 番茄钟 ticker 每次写托盘标题时同步记录,供桥读取(托盘本身无法经 SSH 观察)。
pub fn record_tray_title(title: Option<&str>) {
    if let Ok(mut slot) = TRAY_TITLE.lock() {
        *slot = title.map(str::to_string);
    }
}

pub fn last_tray_title() -> Option<String> {
    TRAY_TITLE.lock().ok().and_then(|slot| slot.clone())
}

/// `automation_report` 命令的落点:把 WebView 里算出的结果交给等待中的请求。
pub fn report(id: String, result: String) {
    let store = results();
    if let Ok(mut map) = store.map.lock() {
        map.insert(id, result);
    }
    store.cv.notify_all();
}

#[allow(dead_code)]
fn wait_result(id: &str, timeout: Duration) -> Option<String> {
    let store = results();
    let deadline = Instant::now() + timeout;
    let mut map = store.map.lock().ok()?;
    loop {
        if let Some(value) = map.remove(id) {
            return Some(value);
        }
        let now = Instant::now();
        if now >= deadline {
            return None;
        }
        let (guard, _) = store.cv.wait_timeout(map, deadline - now).ok()?;
        map = guard;
    }
}

#[cfg(all(debug_assertions, unix))]
pub fn maybe_spawn<R: tauri::Runtime>(app: tauri::AppHandle<R>) {
    use std::os::unix::net::UnixListener;
    let Ok(path) = std::env::var(ENV_SOCK) else {
        return;
    };
    let _ = std::fs::remove_file(&path);
    let listener = match UnixListener::bind(&path) {
        Ok(listener) => listener,
        Err(error) => {
            tracing::warn!(%error, path, "自动化桥 socket 绑定失败");
            return;
        }
    };
    tracing::warn!(path, "调试自动化桥已启用(仅 debug 构建)");
    std::thread::Builder::new()
        .name("automation-bridge".into())
        .spawn(move || {
            for stream in listener.incoming() {
                let Ok(stream) = stream else { continue };
                let app = app.clone();
                std::thread::spawn(move || handle_client(stream, app));
            }
        })
        .ok();
}

#[cfg(not(all(debug_assertions, unix)))]
pub fn maybe_spawn<R: tauri::Runtime>(_app: tauri::AppHandle<R>) {}

#[cfg(all(debug_assertions, unix))]
fn handle_client<R: tauri::Runtime>(
    stream: std::os::unix::net::UnixStream,
    app: tauri::AppHandle<R>,
) {
    use std::io::{BufRead, BufReader, Write};
    let mut writer = match stream.try_clone() {
        Ok(writer) => writer,
        Err(_) => return,
    };
    let reader = BufReader::new(stream);
    for line in reader.lines() {
        let Ok(line) = line else { break };
        if line.trim().is_empty() {
            continue;
        }
        let response = match serde_json::from_str::<serde_json::Value>(&line) {
            Ok(request) => handle_request(&app, &request),
            Err(error) => serde_json::json!({ "error": format!("bad request: {error}") }),
        };
        if writeln!(writer, "{response}").is_err() {
            break;
        }
    }
}

#[cfg(all(debug_assertions, unix))]
fn handle_request<R: tauri::Runtime>(
    app: &tauri::AppHandle<R>,
    request: &serde_json::Value,
) -> serde_json::Value {
    use tauri::Manager;
    if request.get("quit").and_then(|v| v.as_bool()) == Some(true) {
        let app = app.clone();
        std::thread::spawn(move || {
            std::thread::sleep(Duration::from_millis(200));
            app.exit(0);
        });
        return serde_json::json!({ "ok": true });
    }
    if request.get("tray_title").and_then(|v| v.as_bool()) == Some(true) {
        return serde_json::json!({ "title": last_tray_title() });
    }
    let Some(js) = request.get("js").and_then(|v| v.as_str()) else {
        return serde_json::json!({ "error": "expected js | tray_title | quit" });
    };
    let timeout_ms = request
        .get("timeout_ms")
        .and_then(|v| v.as_u64())
        .unwrap_or(60_000);
    let id = format!(
        "a{}-{}",
        SEQ.fetch_add(1, Ordering::Relaxed),
        chrono::Utc::now().timestamp_millis()
    );
    let wrapped = format!(
        "(async () => {{ let __r; try {{ __r = await (async () => {{ {js} }})(); }} \
         catch (e) {{ __r = {{ __error: String((e && e.stack) || e) }}; }} \
         try {{ await window.__TAURI_INTERNALS__.invoke('automation_report', \
         {{ id: '{id}', result: JSON.stringify(__r === undefined ? null : __r) }}); }} \
         catch (e) {{ console.error('automation_report failed', e); }} }})();"
    );
    let Some(window) = app.get_webview_window("main") else {
        return serde_json::json!({ "error": "main window missing" });
    };
    if let Err(error) = window.eval(&wrapped) {
        return serde_json::json!({ "error": format!("eval failed: {error}") });
    }
    match wait_result(&id, Duration::from_millis(timeout_ms)) {
        Some(raw) => {
            let result = serde_json::from_str::<serde_json::Value>(&raw)
                .unwrap_or(serde_json::Value::String(raw));
            serde_json::json!({ "id": id, "result": result })
        }
        None => serde_json::json!({ "id": id, "error": "timeout" }),
    }
}
