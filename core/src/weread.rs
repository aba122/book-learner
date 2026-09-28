//! 微信读书同步(BL-030,`docs/design/2026-09-28-weread-sync.md`):
//! 走微信读书官方 Agent API 网关(Bearer API Key),把书架 / 阅读进度 / 阅读时长单向同步到本地三张表。
//! 网络在 [`Gateway`] 后面;core 只做 计划(plan)→ 拉取(fetch)→ 落库(apply)三步,拉取阶段不持数据库锁。
//! 约定:网关的分桶时间戳按北京时间(UTC+8)转成日期;"今天"由前端本地日历日提供;所有时长单位为秒。
//! 失败原因是数据不是异常:`connect`/`sync` 把鉴权失败、网络失败写进 [`Status::last_error`] 返回,
//! 因为壳层会把异常消息替换成固定文案。

use std::collections::{HashMap, HashSet};
use std::time::Duration;

use chrono::{Datelike, FixedOffset, NaiveDate, SecondsFormat, TimeZone, Utc};
use rusqlite::{params, Connection, OptionalExtension};
use serde_json::{json, Value};

use crate::{CoreError, Result};

/// 官方网关(Tencent/WeChatReading README / OpenWeRead SDK)。
pub const GATEWAY_URL: &str = "https://i.weread.qq.com/api/agent/gateway";
/// 每次请求必须带的 skill 版本;服务端用它判断是否需要升级(回包 `upgrade_info`)。
pub const SKILL_VERSION: &str = "1.0.4";
/// 用户扫码获取 / 管理 API Key 的官方页面。
pub const KEY_PAGE_URL: &str = "https://weread.qq.com/r/weread-skills";
/// 单次同步最多拉多少本书的进度(按最近阅读时间降序)。
pub const MAX_PROGRESS_PER_SYNC: usize = 60;
/// 首次同步回补的历史月数(不含本月)。
pub const BACKFILL_MONTHS: u32 = 11;
/// 每月前几天顺带重拉上月(补服务端晚到的数据)。
pub const REFETCH_PREV_MONTH_UNTIL_DAY: u32 = 3;
const BEIJING_OFFSET_SECS: i32 = 8 * 3600;
const ERROR_SNIPPET_CHARS: usize = 160;

// ---- 网关 ----

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum GatewayError {
    /// HTTP 401/403 或回包里的鉴权类错误:Key 无效 / 已撤销
    Auth(String),
    /// 连不上 / 超时
    Network(String),
    /// 网关返回了非 0 errcode、非 2xx、或不是 JSON
    Gateway(String),
}

impl GatewayError {
    /// 给用户看的中文原因(会进 `Status::last_error`)。
    pub fn message(&self) -> String {
        match self {
            Self::Auth(detail) => format!("API Key 无效或已撤销,请到微信读书重新获取({detail})"),
            Self::Network(detail) => format!("无法连接微信读书({detail})"),
            Self::Gateway(detail) => format!("微信读书接口出错({detail})"),
        }
    }
}

/// 网关抽象:`params` 为对象,业务参数会平铺到请求顶层(官方要求,不能包在 `params` 里)。
pub trait Gateway {
    fn call(&self, api_name: &str, params: Value) -> std::result::Result<Value, GatewayError>;
}

/// 真实网关(ureq,rustls)。
pub struct HttpGateway {
    api_key: String,
    url: String,
    agent: ureq::Agent,
}

impl HttpGateway {
    pub fn new(api_key: impl Into<String>) -> Self {
        Self::with_url(api_key, GATEWAY_URL)
    }

    pub fn with_url(api_key: impl Into<String>, url: impl Into<String>) -> Self {
        let agent = ureq::AgentBuilder::new()
            .timeout_connect(Duration::from_secs(10))
            .timeout(Duration::from_secs(30))
            .build();
        Self {
            api_key: api_key.into(),
            url: url.into(),
            agent,
        }
    }
}

impl Gateway for HttpGateway {
    fn call(&self, api_name: &str, params: Value) -> std::result::Result<Value, GatewayError> {
        let body = request_body(api_name, &params);
        let response = self
            .agent
            .post(&self.url)
            .set("Authorization", &format!("Bearer {}", self.api_key))
            .set("Content-Type", "application/json")
            .send_json(body);
        let response = match response {
            Ok(response) => response,
            Err(ureq::Error::Status(code @ (401 | 403), _)) => {
                return Err(GatewayError::Auth(format!("HTTP {code}")))
            }
            Err(ureq::Error::Status(code, response)) => {
                let text = response.into_string().unwrap_or_default();
                return Err(GatewayError::Gateway(format!(
                    "HTTP {code}: {}",
                    snippet(&text)
                )));
            }
            Err(ureq::Error::Transport(transport)) => {
                return Err(GatewayError::Network(snippet(&transport.to_string())))
            }
        };
        let value: Value = response
            .into_json()
            .map_err(|error| GatewayError::Gateway(format!("回包不是 JSON:{error}")))?;
        check_errcode(value)
    }
}

/// 请求体:`api_name` + `skill_version` + 平铺的业务参数。
pub fn request_body(api_name: &str, params: &Value) -> Value {
    let mut body = json!({ "api_name": api_name, "skill_version": SKILL_VERSION });
    if let (Some(target), Some(source)) = (body.as_object_mut(), params.as_object()) {
        for (key, value) in source {
            target.insert(key.clone(), value.clone());
        }
    }
    body
}

/// 回包 `errcode` 非 0 即错误;鉴权类文案归为 `Auth`(服务端没有公开错误码表,按文案判断)。
pub fn check_errcode(value: Value) -> std::result::Result<Value, GatewayError> {
    let code = value.get("errcode").and_then(Value::as_i64).unwrap_or(0);
    if code == 0 {
        return Ok(value);
    }
    let msg = value
        .get("errmsg")
        .and_then(Value::as_str)
        .unwrap_or("")
        .to_string();
    let lower = msg.to_lowercase();
    let auth_like = ["登录", "key", "授权", "鉴权", "token", "身份", "过期"]
        .iter()
        .any(|needle| lower.contains(needle));
    let detail = format!("errcode {code}:{}", snippet(&msg));
    Err(if auth_like {
        GatewayError::Auth(detail)
    } else {
        GatewayError::Gateway(detail)
    })
}

fn snippet(text: &str) -> String {
    let trimmed = text.trim();
    let mut out: String = trimmed.chars().take(ERROR_SNIPPET_CHARS).collect();
    if trimmed.chars().count() > ERROR_SNIPPET_CHARS {
        out.push('…');
    }
    out
}

// ---- 数据类型 ----

#[derive(Debug, Clone, PartialEq, Eq, serde::Serialize, serde::Deserialize)]
pub struct Status {
    pub connected: bool,
    pub auto_sync: bool,
    pub connected_at: Option<String>,
    pub last_sync_at: Option<String>,
    /// None = 还没同步过
    pub last_sync_ok: Option<bool>,
    pub last_error: Option<String>,
    pub upgrade_message: Option<String>,
    /// 书架上的电子书数(不含已从书架移除的)
    pub book_count: i64,
    /// 已关联本地书的数量
    pub linked_count: i64,
    pub album_count: i64,
    pub mp_count: i64,
    /// overall.totalReadTime(秒)
    pub total_seconds: i64,
    pub total_read_days: i64,
}

impl Status {
    pub fn disconnected(last_error: Option<String>) -> Self {
        Self {
            connected: false,
            auto_sync: true,
            connected_at: None,
            last_sync_at: None,
            last_sync_ok: None,
            last_error,
            upgrade_message: None,
            book_count: 0,
            linked_count: 0,
            album_count: 0,
            mp_count: 0,
            total_seconds: 0,
            total_read_days: 0,
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq, serde::Serialize, serde::Deserialize)]
pub struct WereadBook {
    pub weread_id: String,
    pub title: String,
    pub author: String,
    pub category: String,
    pub cover_url: String,
    pub finish_reading: bool,
    /// 最近阅读时间(秒级时间戳,0 = 未知)
    pub read_update_time: i64,
    /// 0–100
    pub progress: i64,
    /// 累计阅读秒数(getprogress.readingTime,退回 recordReadingTime)
    pub reading_seconds: i64,
    pub local_book_id: Option<i64>,
    pub local_title: Option<String>,
    /// none | auto | manual
    pub link_source: String,
    pub removed: bool,
}

#[derive(Debug, Clone, PartialEq, Eq, serde::Serialize, serde::Deserialize)]
pub struct ReadingDay {
    pub date: String,
    pub seconds: i64,
}

// ---- 划线 / 想法(第二批,只对已关联本地书的书拉)----

#[derive(Debug, Clone, PartialEq, Eq, serde::Serialize, serde::Deserialize)]
pub struct WereadMark {
    pub bookmark_id: String,
    pub weread_id: String,
    pub chapter_uid: i64,
    pub chapter_idx: i64,
    pub chapter_title: String,
    /// 微信读书章节文本内的字符偏移 "start-end"(不是 CFI)
    pub range: String,
    pub mark_text: String,
    pub color_style: i64,
    pub created_at: i64,
    pub local_mark_id: Option<i64>,
    /// pending | located | partial | missing
    pub locate_status: String,
    pub removed: bool,
}

#[derive(Debug, Clone, PartialEq, Eq, serde::Serialize, serde::Deserialize)]
pub struct WereadThought {
    pub review_id: String,
    pub weread_id: String,
    pub content: String,
    /// 想法对应的划线原文(整本/章节点评为空)
    pub abstract_text: String,
    pub range: String,
    pub chapter_uid: i64,
    pub chapter_title: String,
    pub created_at: i64,
    pub star: i64,
    pub local_mark_id: Option<i64>,
    pub locate_status: String,
    pub removed: bool,
}

#[derive(Debug, Clone, PartialEq, Eq, serde::Serialize, serde::Deserialize)]
pub struct WereadNotes {
    pub weread_id: Option<String>,
    pub marks: Vec<WereadMark>,
    pub thoughts: Vec<WereadThought>,
    /// 在架划线数 / 已定位(located+partial)/ 待定位
    pub mark_count: i64,
    pub located_count: i64,
    pub pending_count: i64,
    pub thought_count: i64,
}

pub const LOCATE_STATUSES: [&str; 4] = ["pending", "located", "partial", "missing"];
/// 想法分页每页条数 / 最多页数(防死循环)
const THOUGHT_PAGE: i64 = 100;
const THOUGHT_MAX_PAGES: usize = 20;

// ---- 账号 ----

pub fn api_key(conn: &Connection) -> Result<Option<String>> {
    Ok(conn
        .query_row("SELECT api_key FROM weread_account WHERE id = 1", [], |r| {
            r.get(0)
        })
        .optional()?)
}

fn now_iso() -> String {
    Utc::now().to_rfc3339_opts(SecondsFormat::Secs, true)
}

/// 记下已验证的 Key(重连时保留已同步的数据与开关)。
pub fn save_account(conn: &Connection, key: &str) -> Result<()> {
    let key = key.trim();
    if key.is_empty() {
        return Err(CoreError::InvalidInput("api key is empty".into()));
    }
    conn.execute(
        "INSERT INTO weread_account(id, api_key, connected_at) VALUES(1, ?1, ?2)
         ON CONFLICT(id) DO UPDATE SET api_key = excluded.api_key, connected_at = excluded.connected_at,
           last_error = NULL",
        params![key, now_iso()],
    )?;
    Ok(())
}

pub fn set_auto_sync(conn: &Connection, enabled: bool) -> Result<Status> {
    let changed = conn.execute(
        "UPDATE weread_account SET auto_sync = ?1 WHERE id = 1",
        params![enabled as i64],
    )?;
    if changed == 0 {
        return Err(CoreError::NotFound("weread account".into()));
    }
    status(conn)
}

/// 断开:删 Key;`purge` 时同时清掉已同步的书架与时长。
pub fn disconnect(conn: &Connection, purge: bool) -> Result<()> {
    conn.execute("DELETE FROM weread_account WHERE id = 1", [])?;
    if purge {
        conn.execute("DELETE FROM weread_book", [])?;
        conn.execute("DELETE FROM weread_reading_day", [])?;
    }
    Ok(())
}

pub fn status(conn: &Connection) -> Result<Status> {
    let row = conn
        .query_row(
            "SELECT auto_sync, connected_at, last_sync_at, last_sync_ok, last_error, upgrade_message,
                    album_count, mp_count, total_seconds, total_read_days
             FROM weread_account WHERE id = 1",
            [],
            |r| {
                Ok((
                    r.get::<_, i64>(0)?,
                    r.get::<_, String>(1)?,
                    r.get::<_, Option<String>>(2)?,
                    r.get::<_, Option<i64>>(3)?,
                    r.get::<_, Option<String>>(4)?,
                    r.get::<_, Option<String>>(5)?,
                    r.get::<_, i64>(6)?,
                    r.get::<_, i64>(7)?,
                    r.get::<_, i64>(8)?,
                    r.get::<_, i64>(9)?,
                ))
            },
        )
        .optional()?;
    let Some((
        auto_sync,
        connected_at,
        last_sync_at,
        last_sync_ok,
        last_error,
        upgrade_message,
        album_count,
        mp_count,
        total_seconds,
        total_read_days,
    )) = row
    else {
        return Ok(Status::disconnected(None));
    };
    let (book_count, linked_count): (i64, i64) = conn.query_row(
        "SELECT count(*), count(local_book_id) FROM weread_book WHERE removed = 0",
        [],
        |r| Ok((r.get(0)?, r.get(1)?)),
    )?;
    Ok(Status {
        connected: true,
        auto_sync: auto_sync != 0,
        connected_at: Some(connected_at),
        last_sync_at,
        last_sync_ok: last_sync_ok.map(|v| v != 0),
        last_error,
        upgrade_message,
        book_count,
        linked_count,
        album_count,
        mp_count,
        total_seconds,
        total_read_days,
    })
}

// ---- 书与时长(读) ----

const BOOK_COLUMNS: &str = "w.weread_id, w.title, w.author, w.category, w.cover_url, w.finish_reading,
    w.read_update_time, w.progress, w.reading_seconds, w.local_book_id, b.title, w.link_source, w.removed";

fn row_to_book(r: &rusqlite::Row<'_>) -> rusqlite::Result<WereadBook> {
    Ok(WereadBook {
        weread_id: r.get(0)?,
        title: r.get(1)?,
        author: r.get(2)?,
        category: r.get(3)?,
        cover_url: r.get(4)?,
        finish_reading: r.get::<_, i64>(5)? != 0,
        read_update_time: r.get(6)?,
        progress: r.get(7)?,
        reading_seconds: r.get(8)?,
        local_book_id: r.get(9)?,
        local_title: r.get(10)?,
        link_source: r.get(11)?,
        removed: r.get::<_, i64>(12)? != 0,
    })
}

/// 书架上的书(在架的在前,按最近阅读时间降序;已移除的排最后)。
pub fn books(conn: &Connection) -> Result<Vec<WereadBook>> {
    let mut stmt = conn.prepare(&format!(
        "SELECT {BOOK_COLUMNS} FROM weread_book w LEFT JOIN book b ON b.id = w.local_book_id
         ORDER BY w.removed, w.read_update_time DESC, w.title"
    ))?;
    let rows = stmt.query_map([], row_to_book)?;
    Ok(rows.collect::<rusqlite::Result<Vec<_>>>()?)
}

fn book_by_id(conn: &Connection, weread_id: &str) -> Result<WereadBook> {
    conn.query_row(
        &format!(
            "SELECT {BOOK_COLUMNS} FROM weread_book w LEFT JOIN book b ON b.id = w.local_book_id
             WHERE w.weread_id = ?1"
        ),
        params![weread_id],
        row_to_book,
    )
    .optional()?
    .ok_or_else(|| CoreError::NotFound(format!("weread book {weread_id}")))
}

/// 手动关联 / 取消关联(都记为 manual,自动匹配不再碰它)。
pub fn link(conn: &Connection, weread_id: &str, local_book_id: Option<i64>) -> Result<WereadBook> {
    if let Some(id) = local_book_id {
        let exists: i64 = conn.query_row(
            "SELECT count(*) FROM book WHERE id = ?1",
            params![id],
            |r| r.get(0),
        )?;
        if exists == 0 {
            return Err(CoreError::NotFound(format!("book {id}")));
        }
    }
    let changed = conn.execute(
        "UPDATE weread_book SET local_book_id = ?2, link_source = 'manual' WHERE weread_id = ?1",
        params![weread_id, local_book_id],
    )?;
    if changed == 0 {
        return Err(CoreError::NotFound(format!("weread book {weread_id}")));
    }
    book_by_id(conn, weread_id)
}

/// 某本本地书关联到的微信读书记录(书架卡片用)。
pub fn book_for_local(conn: &Connection, local_book_id: i64) -> Result<Option<WereadBook>> {
    Ok(conn
        .query_row(
            &format!(
                "SELECT {BOOK_COLUMNS} FROM weread_book w LEFT JOIN book b ON b.id = w.local_book_id
                 WHERE w.local_book_id = ?1 ORDER BY w.removed, w.read_update_time DESC LIMIT 1"
            ),
            params![local_book_id],
            row_to_book,
        )
        .optional()?)
}

fn parse_date(value: &str) -> Result<NaiveDate> {
    NaiveDate::parse_from_str(value, "%Y-%m-%d")
        .map_err(|_| CoreError::InvalidInput(format!("bad date {value}")))
}

/// `[from, to]` 闭区间内的每日时长(只返回有记录的日子,按日期升序)。
pub fn reading_days(conn: &Connection, from: &str, to: &str) -> Result<Vec<ReadingDay>> {
    let from_date = parse_date(from)?;
    let to_date = parse_date(to)?;
    if from_date > to_date {
        return Err(CoreError::InvalidInput("from after to".into()));
    }
    let mut stmt = conn.prepare(
        "SELECT date, seconds FROM weread_reading_day WHERE date >= ?1 AND date <= ?2 ORDER BY date",
    )?;
    let rows = stmt.query_map(params![from, to], |r| {
        Ok(ReadingDay {
            date: r.get(0)?,
            seconds: r.get(1)?,
        })
    })?;
    Ok(rows.collect::<rusqlite::Result<Vec<_>>>()?)
}

// ---- 同步:plan → fetch → apply ----

#[derive(Debug, Clone)]
pub struct SyncPlan {
    /// 上次拉进度时每本书的 read_update_time(变了才重拉)
    pub progress_fetched_for: HashMap<String, i64>,
    /// 已关联本地书、仍在架的 weread_id(拉划线/想法)
    pub linked: Vec<String>,
    /// 本次要拉的月份(`baseTime` 参数;0 = 本月)
    pub month_base_times: Vec<i64>,
    /// 两次网络调用之间的间隔(测试置 0)
    pub pause_ms: u64,
    pub max_progress: usize,
}

#[derive(Debug, Default)]
pub struct SyncFetched {
    pub shelf: Option<Value>,
    /// 书架都拉不到:整次同步失败
    pub fatal: Option<GatewayError>,
    /// (weread_id, getprogress 回包)
    pub progress: Vec<(String, Value)>,
    pub overall: Option<Value>,
    /// monthly 回包
    pub months: Vec<Value>,
    /// (weread_id, bookmarklist 回包)
    pub marks: Vec<(String, Value)>,
    /// (weread_id, 合并后的 reviews[] 数组)
    pub thoughts: Vec<(String, Vec<Value>)>,
    /// 非致命错误(中文)
    pub errors: Vec<String>,
    pub upgrade_message: Option<String>,
}

/// 读库定计划(快,持锁);`today` 为前端本地日历日。
pub fn plan(conn: &Connection, today: &str) -> Result<SyncPlan> {
    let today = parse_date(today)?;
    let mut progress_fetched_for = HashMap::new();
    let mut stmt = conn.prepare("SELECT weread_id, progress_fetched_for FROM weread_book")?;
    for row in stmt.query_map([], |r| Ok((r.get::<_, String>(0)?, r.get::<_, i64>(1)?)))? {
        let (id, fetched) = row?;
        progress_fetched_for.insert(id, fetched);
    }
    let mut linked = Vec::new();
    let mut stmt = conn.prepare(
        "SELECT weread_id FROM weread_book WHERE removed = 0 AND local_book_id IS NOT NULL ORDER BY read_update_time DESC",
    )?;
    for row in stmt.query_map([], |r| r.get::<_, String>(0))? {
        linked.push(row?);
    }
    let synced_before: i64 = conn.query_row(
        "SELECT count(*) FROM weread_account WHERE id = 1 AND last_sync_ok IS NOT NULL",
        [],
        |r| r.get(0),
    )?;
    let mut month_base_times = vec![0];
    let extra_months = if synced_before == 0 {
        BACKFILL_MONTHS
    } else if today.day() <= REFETCH_PREV_MONTH_UNTIL_DAY {
        1
    } else {
        0
    };
    for back in 1..=extra_months {
        month_base_times.push(month_base_time(today, back));
    }
    Ok(SyncPlan {
        progress_fetched_for,
        linked,
        month_base_times,
        pause_ms: 100,
        max_progress: MAX_PROGRESS_PER_SYNC,
    })
}

/// 往前 `back` 个月的那个月里的一个时间戳(该月 15 日 00:00 UTC,任何时区都落在该月内);服务端会归一到月初。
fn month_base_time(today: NaiveDate, back: u32) -> i64 {
    let total = today.year() * 12 + today.month0() as i32 - back as i32;
    let year = total.div_euclid(12);
    let month0 = total.rem_euclid(12) as u32;
    let date = NaiveDate::from_ymd_opt(year, month0 + 1, 15).expect("valid day 15");
    Utc.from_utc_datetime(&date.and_hms_opt(0, 0, 0).expect("midnight"))
        .timestamp()
}

fn shelf_book_id(book: &Value) -> Option<String> {
    match book.get("bookId")? {
        Value::String(s) if !s.is_empty() => Some(s.clone()),
        Value::Number(n) => Some(n.to_string()),
        _ => None,
    }
}

fn i64_at(value: &Value, key: &str) -> i64 {
    match value.get(key) {
        Some(Value::Number(n)) => n.as_i64().unwrap_or(0),
        Some(Value::String(s)) => s.parse().unwrap_or(0),
        Some(Value::Bool(b)) => *b as i64,
        _ => 0,
    }
}

fn str_at(value: &Value, key: &str) -> String {
    decode_entities(value.get(key).and_then(Value::as_str).unwrap_or(""))
}

/// 网关的书名/作者带 HTML 实体(真网关实测 2026-09-28:`阿兰&#183;德波顿`);解码数字实体与常见命名实体。
pub fn decode_entities(text: &str) -> String {
    if !text.contains('&') {
        return text.to_string();
    }
    let mut out = String::with_capacity(text.len());
    let mut rest = text;
    while let Some(start) = rest.find('&') {
        out.push_str(&rest[..start]);
        let tail = &rest[start..];
        let Some(end) = tail.find(';').filter(|&e| e <= 10) else {
            out.push('&');
            rest = &tail[1..];
            continue;
        };
        let entity = &tail[1..end];
        let decoded = match entity {
            "amp" => Some('&'),
            "lt" => Some('<'),
            "gt" => Some('>'),
            "quot" => Some('"'),
            "apos" => Some('\''),
            "nbsp" => Some(' '),
            _ => entity
                .strip_prefix('#')
                .and_then(|num| {
                    if let Some(hex) = num.strip_prefix('x').or_else(|| num.strip_prefix('X')) {
                        u32::from_str_radix(hex, 16).ok()
                    } else {
                        num.parse::<u32>().ok()
                    }
                })
                .and_then(char::from_u32),
        };
        match decoded {
            Some(c) => {
                out.push(c);
                rest = &tail[end + 1..];
            }
            None => {
                out.push('&');
                rest = &tail[1..];
            }
        }
    }
    out.push_str(rest);
    out
}

fn note_upgrade(fetched: &mut SyncFetched, value: &Value) {
    if fetched.upgrade_message.is_some() {
        return;
    }
    if let Some(message) = value
        .get("upgrade_info")
        .and_then(|u| u.get("message"))
        .and_then(Value::as_str)
    {
        fetched.upgrade_message = Some(message.to_string());
    }
}

/// 只做网络(不持锁):书架 → 变化了的进度 → 总计 + 各月时长。书架失败即 `fatal`,其余失败记进 `errors` 继续。
pub fn fetch(gateway: &dyn Gateway, plan: &SyncPlan) -> SyncFetched {
    let mut fetched = SyncFetched::default();
    let pause = || {
        if plan.pause_ms > 0 {
            std::thread::sleep(Duration::from_millis(plan.pause_ms));
        }
    };
    let shelf = match gateway.call("/shelf/sync", json!({})) {
        Ok(value) => value,
        Err(error) => {
            fetched.fatal = Some(error);
            return fetched;
        }
    };
    note_upgrade(&mut fetched, &shelf);

    // 进度:read_update_time 变了(或从没拉过)的书,按最近阅读降序,最多 max_progress 本
    let mut targets: Vec<(i64, String)> = shelf
        .get("books")
        .and_then(Value::as_array)
        .map(|books| {
            books
                .iter()
                .filter_map(|book| {
                    let id = shelf_book_id(book)?;
                    let read_update = i64_at(book, "readUpdateTime");
                    (plan.progress_fetched_for.get(&id) != Some(&read_update))
                        .then_some((read_update, id))
                })
                .collect()
        })
        .unwrap_or_default();
    targets.sort_by(|a, z| z.0.cmp(&a.0).then_with(|| a.1.cmp(&z.1)));
    for (_, id) in targets.into_iter().take(plan.max_progress) {
        pause();
        match gateway.call("/book/getprogress", json!({ "bookId": id })) {
            Ok(value) => {
                note_upgrade(&mut fetched, &value);
                fetched.progress.push((id, value));
            }
            Err(GatewayError::Auth(detail)) => {
                fetched.fatal = Some(GatewayError::Auth(detail));
                break;
            }
            Err(error) => fetched
                .errors
                .push(format!("《{id}》进度:{}", error.message())),
        }
    }
    fetched.shelf = Some(shelf);
    if fetched.fatal.is_some() {
        return fetched;
    }

    pause();
    match gateway.call(
        "/readdata/detail",
        json!({ "mode": "overall", "baseTime": 0 }),
    ) {
        Ok(value) => {
            note_upgrade(&mut fetched, &value);
            fetched.overall = Some(value);
        }
        Err(error) => fetched
            .errors
            .push(format!("总阅读时长:{}", error.message())),
    }
    for base_time in &plan.month_base_times {
        pause();
        match gateway.call(
            "/readdata/detail",
            json!({ "mode": "monthly", "baseTime": base_time }),
        ) {
            Ok(value) => {
                note_upgrade(&mut fetched, &value);
                fetched.months.push(value);
            }
            Err(error) => fetched
                .errors
                .push(format!("月度阅读时长:{}", error.message())),
        }
    }
    // 划线 / 想法:只对已关联本地书的书(每本 1 + 分页次调用)
    for id in &plan.linked {
        pause();
        match gateway.call("/book/bookmarklist", json!({ "bookId": id })) {
            Ok(value) => {
                note_upgrade(&mut fetched, &value);
                fetched.marks.push((id.clone(), value));
            }
            Err(error) => fetched
                .errors
                .push(format!("《{id}》划线:{}", error.message())),
        }
        let mut reviews = Vec::new();
        let mut synckey = 0i64;
        let mut ok = true;
        for _ in 0..THOUGHT_MAX_PAGES {
            pause();
            match gateway.call(
                "/review/list/mine",
                json!({ "bookid": id, "synckey": synckey, "count": THOUGHT_PAGE }),
            ) {
                Ok(value) => {
                    note_upgrade(&mut fetched, &value);
                    if let Some(items) = value.get("reviews").and_then(Value::as_array) {
                        reviews.extend(items.iter().cloned());
                    }
                    let has_more = i64_at(&value, "hasMore") == 1;
                    let next = i64_at(&value, "synckey");
                    if !has_more || next == 0 || next == synckey {
                        break;
                    }
                    synckey = next;
                }
                Err(error) => {
                    fetched
                        .errors
                        .push(format!("《{id}》想法:{}", error.message()));
                    ok = false;
                    break;
                }
            }
        }
        if ok {
            fetched.thoughts.push((id.clone(), reviews));
        }
    }
    fetched
}

/// 分桶起始时间戳 → 北京时间日期。
pub fn bucket_date(timestamp: i64) -> Option<String> {
    let offset = FixedOffset::east_opt(BEIJING_OFFSET_SECS)?;
    let time = offset.timestamp_opt(timestamp, 0).single()?;
    Some(time.date_naive().format("%Y-%m-%d").to_string())
}

/// 落库(持锁,一个事务)。`fatal` 时只记失败原因,不动数据。
pub fn apply(conn: &Connection, fetched: SyncFetched) -> Result<Status> {
    let now = now_iso();
    let tx = rusqlite::Transaction::new_unchecked(conn, rusqlite::TransactionBehavior::Immediate)?;
    if let Some(fatal) = &fetched.fatal {
        tx.execute(
            "UPDATE weread_account SET last_sync_at = ?1, last_sync_ok = 0, last_error = ?2,
               upgrade_message = COALESCE(?3, upgrade_message) WHERE id = 1",
            params![now, fatal.message(), fetched.upgrade_message],
        )?;
        tx.commit()?;
        return status(conn);
    }
    let shelf = fetched.shelf.unwrap_or(Value::Null);

    // 书架:先全标移除,出现的再落回来(字段覆盖,关联不动)
    tx.execute("UPDATE weread_book SET removed = 1", [])?;
    let mut seen = HashSet::new();
    if let Some(books) = shelf.get("books").and_then(Value::as_array) {
        for book in books {
            let Some(id) = shelf_book_id(book) else {
                continue;
            };
            if !seen.insert(id.clone()) {
                continue;
            }
            tx.execute(
                "INSERT INTO weread_book(weread_id, title, author, cover_url, category, finish_reading,
                   read_update_time, update_time, is_top, secret, removed, first_seen_at, last_seen_at)
                 VALUES(?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, 0, ?11, ?11)
                 ON CONFLICT(weread_id) DO UPDATE SET title = excluded.title, author = excluded.author,
                   cover_url = excluded.cover_url, category = excluded.category,
                   finish_reading = excluded.finish_reading, read_update_time = excluded.read_update_time,
                   update_time = excluded.update_time, is_top = excluded.is_top, secret = excluded.secret,
                   removed = 0, last_seen_at = excluded.last_seen_at",
                params![
                    id,
                    str_at(book, "title"),
                    str_at(book, "author"),
                    str_at(book, "cover"),
                    str_at(book, "category"),
                    i64_at(book, "finishReading"),
                    i64_at(book, "readUpdateTime"),
                    i64_at(book, "updateTime"),
                    i64_at(book, "isTop"),
                    i64_at(book, "secret"),
                    now,
                ],
            )?;
        }
    }
    let album_count = shelf
        .get("albums")
        .and_then(Value::as_array)
        .map(|a| a.len() as i64)
        .unwrap_or(0);
    let mp_count = match shelf.get("mp") {
        None | Some(Value::Null) => 0,
        Some(Value::Object(map)) if map.is_empty() => 0,
        Some(Value::Array(items)) if items.is_empty() => 0,
        Some(_) => 1,
    };

    // 进度
    for (id, value) in &fetched.progress {
        // 真网关实测:累计阅读秒数在 `readingTime`(文档写的 `recordReadingTime` 是朗读/记录类,常为 0)
        let book = value.get("book").unwrap_or(value);
        let mut seconds = i64_at(book, "readingTime");
        if seconds == 0 {
            seconds = i64_at(book, "recordReadingTime");
        }
        let progress = i64_at(book, "progress").clamp(0, 100);
        tx.execute(
            "UPDATE weread_book SET progress = ?2, reading_seconds = ?3,
               progress_fetched_for = read_update_time WHERE weread_id = ?1",
            params![id, progress, seconds],
        )?;
    }

    // 时长
    let (mut total_seconds, mut total_read_days) = (None, None);
    if let Some(overall) = &fetched.overall {
        total_seconds = Some(i64_at(overall, "totalReadTime"));
        total_read_days = Some(i64_at(overall, "readDays"));
    }
    for month in &fetched.months {
        let Some(buckets) = month.get("readTimes").and_then(Value::as_object) else {
            continue;
        };
        for (key, seconds) in buckets {
            let Ok(timestamp) = key.parse::<i64>() else {
                continue;
            };
            let Some(date) = bucket_date(timestamp) else {
                continue;
            };
            let seconds = seconds.as_i64().unwrap_or(0).max(0);
            tx.execute(
                "INSERT INTO weread_reading_day(date, seconds, fetched_at) VALUES(?1, ?2, ?3)
                 ON CONFLICT(date) DO UPDATE SET seconds = excluded.seconds, fetched_at = excluded.fetched_at",
                params![date, seconds, now],
            )?;
        }
    }

    // 划线 / 想法(第二批):按书 upsert,本次没出现的标 removed;已定位的保留 local_mark_id
    for (weread_id, value) in &fetched.marks {
        apply_marks(&tx, weread_id, value, &now)?;
    }
    for (weread_id, reviews) in &fetched.thoughts {
        apply_thoughts(&tx, weread_id, reviews, &now)?;
    }

    // 自动匹配本地书(唯一候选才关联;manual 永不覆盖)
    auto_link(&tx)?;

    // 记忆库镜像 `_weread.md`(op_id 带内容哈希:同内容不重投)
    for weread_id in fetched
        .marks
        .iter()
        .map(|(id, _)| id)
        .chain(fetched.thoughts.iter().map(|(id, _)| id))
    {
        enqueue_notes_projection(&tx, weread_id)?;
    }

    let last_error = if fetched.errors.is_empty() {
        None
    } else {
        let shown: Vec<&str> = fetched.errors.iter().take(3).map(String::as_str).collect();
        Some(format!(
            "{} 项未完成:{}",
            fetched.errors.len(),
            shown.join(";")
        ))
    };
    tx.execute(
        "UPDATE weread_account SET last_sync_at = ?1, last_sync_ok = 1, last_error = ?2,
           upgrade_message = ?3, album_count = ?4, mp_count = ?5,
           total_seconds = COALESCE(?6, total_seconds), total_read_days = COALESCE(?7, total_read_days)
         WHERE id = 1",
        params![
            now,
            last_error,
            fetched.upgrade_message,
            album_count,
            mp_count,
            total_seconds,
            total_read_days
        ],
    )?;
    tx.commit()?;
    status(conn)
}

fn chapter_titles(value: &Value) -> HashMap<i64, (i64, String)> {
    let mut out = HashMap::new();
    if let Some(chapters) = value.get("chapters").and_then(Value::as_array) {
        for c in chapters {
            out.insert(
                i64_at(c, "chapterUid"),
                (i64_at(c, "chapterIdx"), str_at(c, "title")),
            );
        }
    }
    out
}

fn apply_marks(conn: &Connection, weread_id: &str, value: &Value, now: &str) -> Result<()> {
    let titles = chapter_titles(value);
    conn.execute(
        "UPDATE weread_mark SET removed = 1 WHERE weread_id = ?1",
        params![weread_id],
    )?;
    let Some(items) = value.get("updated").and_then(Value::as_array) else {
        return Ok(());
    };
    for item in items {
        // 官方已过滤书签(type=0),这里再兜一次
        if item.get("type").is_some() && i64_at(item, "type") == 0 {
            continue;
        }
        let bookmark_id = str_at(item, "bookmarkId");
        let mark_text = str_at(item, "markText");
        if bookmark_id.is_empty() || mark_text.trim().is_empty() {
            continue;
        }
        let uid = i64_at(item, "chapterUid");
        let (idx, title) = titles
            .get(&uid)
            .cloned()
            .unwrap_or((i64_at(item, "chapterIdx"), String::new()));
        conn.execute(
            "INSERT INTO weread_mark(bookmark_id, weread_id, chapter_uid, chapter_idx, chapter_title, range, mark_text,
               color_style, created_at, removed, fetched_at)
             VALUES(?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, 0, ?10)
             ON CONFLICT(bookmark_id) DO UPDATE SET chapter_uid = excluded.chapter_uid, chapter_idx = excluded.chapter_idx,
               chapter_title = excluded.chapter_title, range = excluded.range, mark_text = excluded.mark_text,
               color_style = excluded.color_style, created_at = excluded.created_at, removed = 0,
               fetched_at = excluded.fetched_at",
            params![
                bookmark_id,
                weread_id,
                uid,
                idx,
                title,
                str_at(item, "range"),
                mark_text,
                i64_at(item, "colorStyle"),
                i64_at(item, "createTime"),
                now
            ],
        )?;
    }
    Ok(())
}

fn apply_thoughts(conn: &Connection, weread_id: &str, reviews: &[Value], now: &str) -> Result<()> {
    conn.execute(
        "UPDATE weread_thought SET removed = 1 WHERE weread_id = ?1",
        params![weread_id],
    )?;
    for item in reviews {
        let review = item.get("review").unwrap_or(item);
        let review_id = {
            let inner = str_at(review, "reviewId");
            if inner.is_empty() {
                str_at(item, "reviewId")
            } else {
                inner
            }
        };
        let content = str_at(review, "content");
        if review_id.is_empty() || content.trim().is_empty() {
            continue;
        }
        let mut chapter_title = str_at(review, "chapterName");
        if chapter_title.is_empty() {
            chapter_title = str_at(review, "chapterTitle");
        }
        let star = match review.get("star") {
            Some(Value::Number(n)) => n.as_i64().unwrap_or(-1),
            _ => -1,
        };
        conn.execute(
            "INSERT INTO weread_thought(review_id, weread_id, content, abstract, range, chapter_uid, chapter_title,
               created_at, star, removed, fetched_at)
             VALUES(?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, 0, ?10)
             ON CONFLICT(review_id) DO UPDATE SET content = excluded.content, abstract = excluded.abstract,
               range = excluded.range, chapter_uid = excluded.chapter_uid, chapter_title = excluded.chapter_title,
               created_at = excluded.created_at, star = excluded.star, removed = 0, fetched_at = excluded.fetched_at",
            params![
                review_id,
                weread_id,
                content,
                str_at(review, "abstract"),
                str_at(review, "range"),
                i64_at(review, "chapterUid"),
                chapter_title,
                i64_at(review, "createTime"),
                star,
                now
            ],
        )?;
    }
    Ok(())
}

fn fnv(s: &str) -> u64 {
    let mut h: u64 = 0xcbf2_9ce4_8422_2325;
    for b in s.bytes() {
        h ^= b as u64;
        h = h.wrapping_mul(0x0100_0000_01b3);
    }
    h
}

/// 已关联本地书的划线/想法有变化 → 入队 `sync_weread`(op_id 带内容哈希,同内容 INSERT OR IGNORE)。
fn enqueue_notes_projection(conn: &Connection, weread_id: &str) -> Result<()> {
    let local: Option<i64> = conn
        .query_row(
            "SELECT local_book_id FROM weread_book WHERE weread_id = ?1",
            params![weread_id],
            |r| r.get(0),
        )
        .optional()?
        .flatten();
    let Some(local_book_id) = local else {
        return Ok(());
    };
    let notes = notes_for_weread(conn, weread_id)?;
    if notes.marks.is_empty() && notes.thoughts.is_empty() {
        return Ok(());
    }
    let title: String = conn
        .query_row(
            "SELECT title FROM book WHERE id = ?1",
            params![local_book_id],
            |r| r.get(0),
        )
        .optional()?
        .unwrap_or_default();
    let content = render_markdown(&title, &notes);
    crate::projection::enqueue(
        conn,
        &format!("weread:{local_book_id}:h{:x}:sync_weread", fnv(&content)),
        "sync_weread",
        &json!({ "book_id": local_book_id }),
    )
}

fn mark_row(r: &rusqlite::Row<'_>) -> rusqlite::Result<WereadMark> {
    Ok(WereadMark {
        bookmark_id: r.get(0)?,
        weread_id: r.get(1)?,
        chapter_uid: r.get(2)?,
        chapter_idx: r.get(3)?,
        chapter_title: r.get(4)?,
        range: r.get(5)?,
        mark_text: r.get(6)?,
        color_style: r.get(7)?,
        created_at: r.get(8)?,
        local_mark_id: r.get(9)?,
        locate_status: r.get(10)?,
        removed: r.get::<_, i64>(11)? != 0,
    })
}

fn thought_row(r: &rusqlite::Row<'_>) -> rusqlite::Result<WereadThought> {
    Ok(WereadThought {
        review_id: r.get(0)?,
        weread_id: r.get(1)?,
        content: r.get(2)?,
        abstract_text: r.get(3)?,
        range: r.get(4)?,
        chapter_uid: r.get(5)?,
        chapter_title: r.get(6)?,
        created_at: r.get(7)?,
        star: r.get(8)?,
        local_mark_id: r.get(9)?,
        locate_status: r.get(10)?,
        removed: r.get::<_, i64>(11)? != 0,
    })
}

const MARK_COLUMNS: &str =
    "bookmark_id, weread_id, chapter_uid, chapter_idx, chapter_title, range, mark_text,
    color_style, created_at, local_mark_id, locate_status, removed";
const THOUGHT_COLUMNS: &str =
    "review_id, weread_id, content, abstract, range, chapter_uid, chapter_title,
    created_at, star, local_mark_id, locate_status, removed";

/// 某本微信读书书的在架划线与想法(按章节序、创建时间)。
pub fn notes_for_weread(conn: &Connection, weread_id: &str) -> Result<WereadNotes> {
    let mut stmt = conn.prepare(&format!(
        "SELECT {MARK_COLUMNS} FROM weread_mark WHERE weread_id = ?1 AND removed = 0
         ORDER BY chapter_idx, chapter_uid, created_at, bookmark_id"
    ))?;
    let marks = stmt
        .query_map(params![weread_id], mark_row)?
        .collect::<rusqlite::Result<Vec<_>>>()?;
    let mut stmt = conn.prepare(&format!(
        "SELECT {THOUGHT_COLUMNS} FROM weread_thought WHERE weread_id = ?1 AND removed = 0
         ORDER BY chapter_uid, created_at, review_id"
    ))?;
    let thoughts = stmt
        .query_map(params![weread_id], thought_row)?
        .collect::<rusqlite::Result<Vec<_>>>()?;
    let located = marks
        .iter()
        .filter(|m| m.locate_status == "located" || m.locate_status == "partial")
        .count() as i64;
    let pending = marks
        .iter()
        .filter(|m| m.locate_status == "pending")
        .count() as i64;
    Ok(WereadNotes {
        weread_id: Some(weread_id.to_string()),
        mark_count: marks.len() as i64,
        located_count: located,
        pending_count: pending,
        thought_count: thoughts.len() as i64,
        marks,
        thoughts,
    })
}

/// 某本本地书关联的微信读书划线与想法(没关联 → 空)。
pub fn notes_for_local(conn: &Connection, local_book_id: i64) -> Result<WereadNotes> {
    let weread_id: Option<String> = conn
        .query_row(
            "SELECT weread_id FROM weread_book WHERE local_book_id = ?1 AND removed = 0
             ORDER BY read_update_time DESC LIMIT 1",
            params![local_book_id],
            |r| r.get(0),
        )
        .optional()?;
    match weread_id {
        Some(id) => notes_for_weread(conn, &id),
        None => Ok(WereadNotes {
            weread_id: None,
            marks: vec![],
            thoughts: vec![],
            mark_count: 0,
            located_count: 0,
            pending_count: 0,
            thought_count: 0,
        }),
    }
}

/// 定位结果落库(一个事务):`mark` 给了就先建本地高亮(source=weread,external_id=id,幂等),
/// 否则可挂到既有高亮 `attach_to`(想法当作该高亮的批注);`status` 记到划线/想法行。
pub fn locate(
    conn: &Connection,
    kind: &str,
    id: &str,
    status: &str,
    local_book_id: i64,
    mark: Option<&crate::reader_marks::NewMark>,
    attach_to: Option<i64>,
) -> Result<Option<crate::reader_marks::ReaderMark>> {
    if !LOCATE_STATUSES.contains(&status) {
        return Err(CoreError::InvalidInput(format!(
            "bad locate status {status:?}"
        )));
    }
    let table = match kind {
        "mark" => "weread_mark",
        "thought" => "weread_thought",
        _ => return Err(CoreError::InvalidInput(format!("bad locate kind {kind:?}"))),
    };
    let key = if kind == "mark" {
        "bookmark_id"
    } else {
        "review_id"
    };
    let tx = rusqlite::Transaction::new_unchecked(conn, rusqlite::TransactionBehavior::Immediate)?;
    let exists: Option<i64> = tx
        .query_row(
            &format!("SELECT 1 FROM {table} WHERE {key} = ?1"),
            params![id],
            |r| r.get(0),
        )
        .optional()?;
    if exists.is_none() {
        return Err(CoreError::NotFound(format!("weread {kind} {id}")));
    }
    let mut created = None;
    let mut mark_id = attach_to;
    if let Some(new_mark) = mark {
        let mut new_mark = new_mark.clone();
        new_mark.source = "weread".into();
        new_mark.external_id = Some(id.to_string());
        let saved = crate::reader_marks::add(&tx, local_book_id, &new_mark)?;
        mark_id = Some(saved.id);
        created = Some(saved);
    } else if kind == "thought" {
        if let Some(target) = attach_to {
            // 想法挂到既有高亮:补进批注(已有批注则换行追加,不重复)
            let content: String = tx.query_row(
                "SELECT content FROM weread_thought WHERE review_id = ?1",
                params![id],
                |r| r.get(0),
            )?;
            let existing = crate::reader_marks::get(&tx, target)?;
            if existing.book_id != local_book_id {
                return Err(CoreError::InvalidInput(
                    "mark belongs to another book".into(),
                ));
            }
            if !existing.note.contains(content.trim()) {
                let note = if existing.note.trim().is_empty() {
                    content.trim().to_string()
                } else {
                    format!("{}\n{}", existing.note.trim_end(), content.trim())
                };
                crate::reader_marks::update(&tx, target, Some(&note), None)?;
            }
        }
    }
    tx.execute(
        &format!(
            "UPDATE {table} SET locate_status = ?2, local_mark_id = COALESCE(?3, local_mark_id) WHERE {key} = ?1"
        ),
        params![id, status, mark_id],
    )?;
    tx.commit()?;
    Ok(created)
}

/// `_weread.md` / Obsidian 导出正文:按章节分组的划线(引用)+ 挂在其下的想法;无原文的点评单列。
pub fn render_markdown(book_title: &str, notes: &WereadNotes) -> String {
    let mut out = format!(
        "# 《{book_title}》微信读书划线与想法\n\n划线 {} 条 · 想法 {} 条(来自微信读书,单向同步)\n",
        notes.marks.len(),
        notes.thoughts.len()
    );
    let mut used = HashSet::new();
    let mut chapter: Option<(i64, String)> = None;
    for m in &notes.marks {
        let key = (m.chapter_uid, m.chapter_title.clone());
        if chapter.as_ref() != Some(&key) {
            let title = if m.chapter_title.trim().is_empty() {
                format!("第 {} 节", m.chapter_idx.max(1))
            } else {
                m.chapter_title.trim().to_string()
            };
            out.push_str(&format!("\n## {title}\n\n"));
            chapter = Some(key);
        }
        out.push_str(&format!("> {}\n", m.mark_text.trim().replace('\n', " ")));
        for t in notes
            .thoughts
            .iter()
            .filter(|t| !t.range.is_empty() && t.range == m.range && t.chapter_uid == m.chapter_uid)
        {
            used.insert(t.review_id.clone());
            out.push_str(&format!(
                "> \n> 💬 {}\n",
                t.content.trim().replace('\n', " ")
            ));
        }
        out.push('\n');
    }
    let rest: Vec<&WereadThought> = notes
        .thoughts
        .iter()
        .filter(|t| !used.contains(&t.review_id))
        .collect();
    if !rest.is_empty() {
        out.push_str("\n## 想法与点评\n\n");
        for t in rest {
            let place = if !t.chapter_title.trim().is_empty() {
                format!("[{}] ", t.chapter_title.trim())
            } else {
                String::new()
            };
            if !t.abstract_text.trim().is_empty() {
                out.push_str(&format!(
                    "- {place}「{}」—— {}\n",
                    t.abstract_text.trim(),
                    t.content.trim().replace('\n', " ")
                ));
            } else {
                let star = if t.star >= 0 {
                    format!("(评分 {})", t.star)
                } else {
                    String::new()
                };
                out.push_str(&format!(
                    "- {place}{}{star}\n",
                    t.content.trim().replace('\n', " ")
                ));
            }
        }
    }
    out
}

/// 反哺费曼/评估:该块所在章节里已定位的微信读书划线(带批注),最多 max 行。
pub fn notes_for_block(
    conn: &Connection,
    book_id: i64,
    block_id: i64,
    max: usize,
) -> Result<Vec<String>> {
    let hrefs: Vec<String> = crate::map::list_anchors(conn, block_id)?
        .into_iter()
        .map(|a| a.spine_href)
        .collect();
    if hrefs.is_empty() || max == 0 {
        return Ok(vec![]);
    }
    let mut stmt = conn.prepare(
        "SELECT text, note FROM reader_mark WHERE book_id = ?1 AND source = 'weread' AND kind = 'highlight'
           AND spine_href = ?2 ORDER BY created_at, id",
    )?;
    let mut lines = Vec::new();
    for href in hrefs {
        let rows = stmt.query_map(params![book_id, href], |r| {
            Ok((r.get::<_, String>(0)?, r.get::<_, String>(1)?))
        })?;
        for row in rows {
            let (text, note) = row?;
            let text: String = text.chars().take(120).collect();
            if note.trim().is_empty() {
                lines.push(format!("- 微信读书划线:「{}」", text.trim()));
            } else {
                lines.push(format!(
                    "- 微信读书划线:「{}」(想法:{})",
                    text.trim(),
                    note.trim().replace('\n', " ")
                ));
            }
            if lines.len() >= max {
                return Ok(lines);
            }
        }
    }
    Ok(lines)
}

/// 标题/作者归一:去空白与标点、小写(中文标点在 `is_alphanumeric` 之外,一并去掉)。
pub fn normalize(text: &str) -> String {
    text.chars()
        .filter(|c| c.is_alphanumeric())
        .flat_map(char::to_lowercase)
        .collect()
}

fn titles_match(weread: &(String, String), local: &(String, String)) -> bool {
    let (wt, wa) = weread;
    let (lt, la) = local;
    if wt.is_empty() || lt.is_empty() {
        return false;
    }
    if wt == lt {
        return true;
    }
    let (short, long) = if wt.chars().count() <= lt.chars().count() {
        (wt, lt)
    } else {
        (lt, wt)
    };
    if short.chars().count() < 2 || !long.contains(short.as_str()) {
        return false;
    }
    !wa.is_empty()
        && !la.is_empty()
        && (wa == la || wa.contains(la.as_str()) || la.contains(wa.as_str()))
}

fn auto_link(conn: &Connection) -> Result<()> {
    let mut locals = Vec::new();
    {
        let mut stmt = conn.prepare("SELECT id, title, author FROM book")?;
        for row in stmt.query_map([], |r| {
            Ok((
                r.get::<_, i64>(0)?,
                r.get::<_, String>(1)?,
                r.get::<_, String>(2)?,
            ))
        })? {
            let (id, title, author) = row?;
            locals.push((id, (normalize(&title), normalize(&author))));
        }
    }
    if locals.is_empty() {
        return Ok(());
    }
    let mut candidates = Vec::new();
    {
        let mut stmt = conn.prepare(
            "SELECT weread_id, title, author FROM weread_book
             WHERE removed = 0 AND (link_source = 'none' OR (link_source = 'auto' AND local_book_id IS NULL))",
        )?;
        for row in stmt.query_map([], |r| {
            Ok((
                r.get::<_, String>(0)?,
                r.get::<_, String>(1)?,
                r.get::<_, String>(2)?,
            ))
        })? {
            let (id, title, author) = row?;
            candidates.push((id, (normalize(&title), normalize(&author))));
        }
    }
    for (weread_id, key) in candidates {
        let matches: Vec<i64> = locals
            .iter()
            .filter(|(_, local)| titles_match(&key, local))
            .map(|(id, _)| *id)
            .collect();
        if matches.len() == 1 {
            conn.execute(
                "UPDATE weread_book SET local_book_id = ?2, link_source = 'auto' WHERE weread_id = ?1",
                params![weread_id, matches[0]],
            )?;
        }
    }
    Ok(())
}

/// 用 Key 调一次书架验证;成功返回回包。
pub fn validate_key(gateway: &dyn Gateway) -> std::result::Result<Value, GatewayError> {
    gateway.call("/shelf/sync", json!({}))
}

/// 一步到位的同步(持锁贯穿网络;壳层用三步版,这里给测试与简单调用)。
pub fn sync(
    conn: &Connection,
    gateway: &dyn Gateway,
    today: &str,
    pause_ms: u64,
) -> Result<Status> {
    if api_key(conn)?.is_none() {
        return Err(CoreError::NotFound("weread account".into()));
    }
    let mut plan = plan(conn, today)?;
    plan.pause_ms = pause_ms;
    let fetched = fetch(gateway, &plan);
    apply(conn, fetched)
}

/// 连接:先验 Key(失败不落库,原因放 `last_error`),再存 Key、跑首次同步。
pub fn connect(
    conn: &Connection,
    gateway: &dyn Gateway,
    key: &str,
    today: &str,
    pause_ms: u64,
) -> Result<Status> {
    if key.trim().is_empty() {
        return Ok(Status::disconnected(Some("请先填入 API Key".into())));
    }
    if let Err(error) = validate_key(gateway) {
        return Ok(Status::disconnected(Some(error.message())));
    }
    save_account(conn, key)?;
    sync(conn, gateway, today, pause_ms)
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::cell::RefCell;
    use std::io::{Read, Write};

    type Handler = Box<dyn Fn(&str, &Value) -> std::result::Result<Value, GatewayError>>;

    struct FakeGateway {
        calls: RefCell<Vec<(String, Value)>>,
        handler: Handler,
    }

    impl FakeGateway {
        fn new(
            handler: impl Fn(&str, &Value) -> std::result::Result<Value, GatewayError> + 'static,
        ) -> Self {
            Self {
                calls: RefCell::new(Vec::new()),
                handler: Box::new(handler),
            }
        }
        fn count(&self, api_name: &str) -> usize {
            self.calls
                .borrow()
                .iter()
                .filter(|(name, _)| name == api_name)
                .count()
        }
        fn monthly_calls(&self) -> usize {
            self.calls
                .borrow()
                .iter()
                .filter(|(name, params)| {
                    name == "/readdata/detail" && params.get("mode") == Some(&json!("monthly"))
                })
                .count()
        }
    }

    impl Gateway for FakeGateway {
        fn call(&self, api_name: &str, params: Value) -> std::result::Result<Value, GatewayError> {
            self.calls
                .borrow_mut()
                .push((api_name.to_string(), params.clone()));
            (self.handler)(api_name, &params)
        }
    }

    fn seed(conn: &Connection, title: &str, author: &str, slug: &str) -> i64 {
        crate::models::insert_book(
            conn,
            title,
            author,
            crate::models::BookType::Humanities,
            slug,
        )
        .unwrap()
    }

    fn shelf(books: &[(&str, &str, &str, i64)]) -> Value {
        json!({
            "books": books.iter().map(|(id, title, author, read)| json!({
                "bookId": id, "title": title, "author": author, "cover": "https://x/c.jpg",
                "category": "文学", "readUpdateTime": read, "finishReading": 0, "updateTime": 1, "isTop": 0, "secret": 0,
            })).collect::<Vec<_>>(),
            "albums": [{"albumInfo": {"albumId": "a1"}}],
            "mp": {"id": 1},
            "bookCount": books.len(),
        })
    }

    /// 2026-09-20 00:00 北京时间 = 2026-09-19T16:00Z
    const SEP_20_BJ: i64 = 1789833600;
    const SEP_21_BJ: i64 = SEP_20_BJ + 86_400;

    fn happy_gateway(read_update: i64) -> FakeGateway {
        FakeGateway::new(move |api, params| {
            Ok(match api {
                "/shelf/sync" => shelf(&[
                    ("w1", "活着", "余华", read_update),
                    ("w2", "百年孤独（全译本）", "加西亚&#183;马尔克斯", 10),
                    ("w3", "未知的书", "无名", 5),
                ]),
                "/book/getprogress" => json!({
                    "bookId": params["bookId"],
                    "book": {"progress": if params["bookId"] == "w1" { 65 } else { 3 }, "readingTime": 11_520, "recordReadingTime": 0, "updateTime": 1}
                }),
                "/readdata/detail" if params["mode"] == "overall" => {
                    json!({"totalReadTime": 360_000, "readDays": 88})
                }
                "/readdata/detail" => {
                    json!({"readTimes": {SEP_20_BJ.to_string(): 1800, SEP_21_BJ.to_string(): 600}, "totalReadTime": 2400})
                }
                _ => json!({}),
            })
        })
    }

    #[test]
    fn bucket_timestamps_convert_with_beijing_offset() {
        assert_eq!(bucket_date(SEP_20_BJ).unwrap(), "2026-09-20");
        // 北京 00:00 前一秒还是 19 日
        assert_eq!(bucket_date(SEP_20_BJ - 1).unwrap(), "2026-09-19");
    }

    #[test]
    fn decode_entities_handles_numeric_named_and_malformed() {
        assert_eq!(decode_entities("阿兰&#183;德波顿"), "阿兰·德波顿");
        assert_eq!(
            decode_entities("A &amp; B &lt;c&gt; &#x4e2d;"),
            "A & B <c> 中"
        );
        assert_eq!(decode_entities("no entities"), "no entities");
        assert_eq!(
            decode_entities("&bogus; & &#zz; tail"),
            "&bogus; & &#zz; tail"
        );
        assert_eq!(decode_entities("&#183"), "&#183");
    }

    #[test]
    fn normalize_strips_punctuation_and_case() {
        assert_eq!(normalize("百年孤独（全译本）"), "百年孤独全译本");
        assert_eq!(
            normalize(" Sapiens: A Brief History "),
            "sapiensabriefhistory"
        );
    }

    #[test]
    fn request_body_flattens_params_with_version() {
        let body = request_body("/book/getprogress", &json!({"bookId": "w1"}));
        assert_eq!(body["api_name"], "/book/getprogress");
        assert_eq!(body["skill_version"], SKILL_VERSION);
        assert_eq!(body["bookId"], "w1");
        assert!(body.get("params").is_none());
    }

    #[test]
    fn errcode_nonzero_is_error_and_auth_like_text_is_auth() {
        assert!(check_errcode(json!({"errcode": 0, "books": []})).is_ok());
        assert!(matches!(
            check_errcode(json!({"errcode": -2012, "errmsg": "登录超时"})),
            Err(GatewayError::Auth(_))
        ));
        assert!(matches!(
            check_errcode(json!({"errcode": 500, "errmsg": "系统繁忙"})),
            Err(GatewayError::Gateway(_))
        ));
    }

    #[test]
    fn connect_rejects_bad_key_without_persisting() {
        let conn = crate::db::open_in_memory().unwrap();
        let gateway = FakeGateway::new(|_, _| Err(GatewayError::Auth("HTTP 401".into())));
        let status = connect(&conn, &gateway, "wrk-bad", "2026-09-28", 0).unwrap();
        assert!(!status.connected);
        assert!(status.last_error.as_deref().unwrap().contains("API Key"));
        assert_eq!(api_key(&conn).unwrap(), None);
        assert!(!super::status(&conn).unwrap().connected);
        let blank = connect(&conn, &gateway, "  ", "2026-09-28", 0).unwrap();
        assert!(!blank.connected);
        assert_eq!(gateway.count("/shelf/sync"), 1);
    }

    #[test]
    fn sync_upserts_shelf_progress_reading_days_and_auto_links() {
        let conn = crate::db::open_in_memory().unwrap();
        let huozhe = seed(&conn, "活着", "余华", "huozhe");
        seed(&conn, "百年孤独", "马尔克斯", "bainian");
        let gateway = happy_gateway(100);
        let status = connect(&conn, &gateway, " wrk-good ", "2026-09-28", 0).unwrap();
        assert!(status.connected);
        assert_eq!(status.last_sync_ok, Some(true));
        assert_eq!(status.last_error, None);
        assert_eq!(status.book_count, 3);
        assert_eq!(status.linked_count, 2);
        assert_eq!(status.album_count, 1);
        assert_eq!(status.mp_count, 1);
        assert_eq!(status.total_seconds, 360_000);
        assert_eq!(status.total_read_days, 88);
        assert_eq!(api_key(&conn).unwrap().as_deref(), Some("wrk-good"));

        let books = books(&conn).unwrap();
        assert_eq!(books.len(), 3);
        let w1 = books.iter().find(|b| b.weread_id == "w1").unwrap();
        assert_eq!(w1.progress, 65);
        assert_eq!(w1.reading_seconds, 11_520);
        assert_eq!(w1.local_book_id, Some(huozhe));
        assert_eq!(w1.local_title.as_deref(), Some("活着"));
        assert_eq!(w1.link_source, "auto");
        let w2 = books.iter().find(|b| b.weread_id == "w2").unwrap();
        assert_eq!(w2.author, "加西亚·马尔克斯", "HTML 实体已解码");
        assert_eq!(w2.link_source, "auto", "包含关系 + 作者包含 → 匹配");
        let w3 = books.iter().find(|b| b.weread_id == "w3").unwrap();
        assert_eq!(w3.link_source, "none");
        assert_eq!(w3.local_book_id, None);
        assert_eq!(
            book_for_local(&conn, huozhe).unwrap().unwrap().weread_id,
            "w1"
        );

        let days = reading_days(&conn, "2026-09-01", "2026-09-30").unwrap();
        assert_eq!(
            days,
            vec![
                ReadingDay {
                    date: "2026-09-20".into(),
                    seconds: 1800
                },
                ReadingDay {
                    date: "2026-09-21".into(),
                    seconds: 600
                }
            ]
        );
        // 首次:本月 + 11 个历史月
        assert_eq!(gateway.monthly_calls(), 12);
        assert_eq!(gateway.count("/book/getprogress"), 3);

        // 第二次:readUpdateTime 没变 → 不再拉进度;月度只拉本月
        let status = sync(&conn, &gateway, "2026-09-28", 0).unwrap();
        assert_eq!(status.last_sync_ok, Some(true));
        assert_eq!(gateway.count("/book/getprogress"), 3);
        assert_eq!(gateway.monthly_calls(), 13);

        // w1 读了新内容 → 只重拉它;w3 从书架消失 → removed
        let gateway2 = FakeGateway::new(|api, params| {
            Ok(match api {
                "/shelf/sync" => shelf(&[
                    ("w1", "活着", "余华", 200),
                    ("w2", "百年孤独（全译本）", "加西亚·马尔克斯", 10),
                ]),
                "/book/getprogress" => {
                    json!({"book": {"progress": 70, "recordReadingTime": 12_000}})
                }
                _ => json!({"readTimes": {}, "totalReadTime": 0, "readDays": 0}),
            })
            .clone()
            .pipe(|v| {
                if api == "/book/getprogress" {
                    assert_eq!(params["bookId"], "w1");
                    v
                } else {
                    v
                }
            })
        });
        let status = sync(&conn, &gateway2, "2026-10-02", 0).unwrap();
        assert_eq!(status.book_count, 2);
        assert_eq!(gateway2.count("/book/getprogress"), 1);
        // 10 月 2 日 ≤ 3 → 本月 + 上月
        assert_eq!(gateway2.monthly_calls(), 2);
        let books = super::books(&conn).unwrap();
        let w1 = books.iter().find(|b| b.weread_id == "w1").unwrap();
        assert_eq!(w1.progress, 70);
        let w3 = books.iter().find(|b| b.weread_id == "w3").unwrap();
        assert!(w3.removed);
        assert_eq!(books.last().unwrap().weread_id, "w3", "已移除排最后");
        // 时长表不因空回包被清
        assert_eq!(
            reading_days(&conn, "2026-09-01", "2026-09-30")
                .unwrap()
                .len(),
            2
        );
    }

    trait Pipe: Sized {
        fn pipe<T>(self, f: impl FnOnce(Self) -> T) -> T {
            f(self)
        }
    }
    impl<T> Pipe for T {}

    #[test]
    fn single_progress_failure_does_not_abort_and_is_reported() {
        let conn = crate::db::open_in_memory().unwrap();
        let gateway = FakeGateway::new(|api, params| match api {
            "/shelf/sync" => Ok(shelf(&[("w1", "A", "a", 2), ("w2", "B", "b", 1)])),
            "/book/getprogress" if params["bookId"] == "w2" => {
                Err(GatewayError::Gateway("HTTP 499: 下架".into()))
            }
            "/book/getprogress" => Ok(json!({"book": {"progress": 50, "recordReadingTime": 60}})),
            _ => Ok(json!({"readTimes": {}, "totalReadTime": 0, "readDays": 0})),
        });
        let status = connect(&conn, &gateway, "wrk-x", "2026-09-28", 0).unwrap();
        assert_eq!(status.last_sync_ok, Some(true));
        let error = status.last_error.unwrap();
        assert!(error.starts_with("1 项未完成"), "{error}");
        assert!(error.contains("w2"));
        let books = books(&conn).unwrap();
        assert_eq!(
            books.iter().find(|b| b.weread_id == "w1").unwrap().progress,
            50
        );
        assert_eq!(
            books.iter().find(|b| b.weread_id == "w2").unwrap().progress,
            0
        );
        // 下次同步 w2 仍会重试(progress_fetched_for 没记)
        let plan = plan(&conn, "2026-09-28").unwrap();
        assert_eq!(plan.progress_fetched_for.get("w2"), Some(&-1));
        assert_eq!(plan.progress_fetched_for.get("w1"), Some(&2));
    }

    #[test]
    fn shelf_failure_marks_sync_failed_and_keeps_data() {
        let conn = crate::db::open_in_memory().unwrap();
        connect(&conn, &happy_gateway(1), "wrk-x", "2026-09-28", 0).unwrap();
        let down = FakeGateway::new(|_, _| Err(GatewayError::Network("timeout".into())));
        let status = sync(&conn, &down, "2026-09-28", 0).unwrap();
        assert!(status.connected);
        assert_eq!(status.last_sync_ok, Some(false));
        assert!(status.last_error.unwrap().contains("无法连接"));
        assert_eq!(status.book_count, 3, "旧数据保留");
        // Key 失效 → 同样只记原因,不删账号
        let revoked = FakeGateway::new(|_, _| Err(GatewayError::Auth("HTTP 401".into())));
        let status = sync(&conn, &revoked, "2026-09-28", 0).unwrap();
        assert!(status.connected);
        assert!(status.last_error.unwrap().contains("API Key"));
    }

    #[test]
    fn manual_link_and_unlink_are_never_overwritten_by_auto_match() {
        let conn = crate::db::open_in_memory().unwrap();
        let huozhe = seed(&conn, "活着", "余华", "huozhe");
        let other = seed(&conn, "别的书", "别人", "other");
        let gateway = happy_gateway(1);
        connect(&conn, &gateway, "wrk-x", "2026-09-28", 0).unwrap();
        // w3 本来没匹配 → 手动关联到 other
        let w3 = link(&conn, "w3", Some(other)).unwrap();
        assert_eq!(w3.link_source, "manual");
        assert_eq!(w3.local_title.as_deref(), Some("别的书"));
        // w1 自动匹配了 huozhe → 手动取消
        let w1 = link(&conn, "w1", None).unwrap();
        assert_eq!(w1.local_book_id, None);
        assert_eq!(w1.link_source, "manual");
        sync(&conn, &gateway, "2026-09-28", 0).unwrap();
        let books = books(&conn).unwrap();
        assert_eq!(
            books
                .iter()
                .find(|b| b.weread_id == "w1")
                .unwrap()
                .local_book_id,
            None
        );
        assert_eq!(
            books
                .iter()
                .find(|b| b.weread_id == "w3")
                .unwrap()
                .local_book_id,
            Some(other)
        );
        assert_eq!(super::status(&conn).unwrap().linked_count, 1);
        // 本地书被删 → 关联自动置空(ON DELETE SET NULL),auto 的下次同步会再匹配
        assert!(matches!(
            link(&conn, "w2", Some(9_999)),
            Err(CoreError::NotFound(_))
        ));
        assert!(matches!(
            link(&conn, "nope", None),
            Err(CoreError::NotFound(_))
        ));
        let _ = huozhe;
    }

    #[test]
    fn upgrade_message_auto_sync_and_disconnect() {
        let conn = crate::db::open_in_memory().unwrap();
        let gateway = FakeGateway::new(|api, _| match api {
            "/shelf/sync" => Ok(json!({"books": [], "upgrade_info": {"message": "请升级到 1.1"}})),
            _ => Ok(json!({})),
        });
        let status = connect(&conn, &gateway, "wrk-x", "2026-09-28", 0).unwrap();
        assert_eq!(status.upgrade_message.as_deref(), Some("请升级到 1.1"));
        assert!(status.auto_sync);
        assert!(!set_auto_sync(&conn, false).unwrap().auto_sync);
        assert!(matches!(
            sync(&conn, &gateway, "2026-13-01", 0),
            Err(CoreError::InvalidInput(_))
        ));
        disconnect(&conn, false).unwrap();
        assert!(!super::status(&conn).unwrap().connected);
        assert!(matches!(
            sync(&conn, &gateway, "2026-09-28", 0),
            Err(CoreError::NotFound(_))
        ));
        assert!(matches!(
            set_auto_sync(&conn, true),
            Err(CoreError::NotFound(_))
        ));
        // 重连保留数据;purge 才清
        connect(&conn, &happy_gateway(1), "wrk-y", "2026-09-28", 0).unwrap();
        assert_eq!(books(&conn).unwrap().len(), 3);
        disconnect(&conn, true).unwrap();
        assert!(books(&conn).unwrap().is_empty());
        assert!(reading_days(&conn, "2026-01-01", "2026-12-31")
            .unwrap()
            .is_empty());
        assert!(matches!(
            reading_days(&conn, "2026-02-01", "2026-01-01"),
            Err(CoreError::InvalidInput(_))
        ));
    }

    #[test]
    fn month_base_times_land_inside_the_month() {
        let today = NaiveDate::from_ymd_opt(2026, 1, 31).unwrap();
        let ts = month_base_time(today, 1);
        assert_eq!(bucket_date(ts).unwrap(), "2025-12-15");
        let ts = month_base_time(today, 13);
        assert_eq!(bucket_date(ts).unwrap(), "2024-12-15");
    }

    fn notes_gateway() -> FakeGateway {
        FakeGateway::new(|api, params| {
            Ok(match api {
                "/shelf/sync" => shelf(&[("w1", "活着", "余华", 100), ("w2", "别的", "某", 5)]),
                "/book/getprogress" => json!({"book": {"progress": 10, "readingTime": 60}}),
                "/readdata/detail" => json!({"readTimes": {}, "totalReadTime": 0, "readDays": 0}),
                "/book/bookmarklist" => {
                    assert_eq!(params["bookId"], "w1", "只拉已关联的书");
                    json!({
                        "chapters": [{"chapterUid": 3, "chapterIdx": 1, "title": "第一章"}, {"chapterUid": 5, "chapterIdx": 2, "title": "第二章"}],
                        "updated": [
                            {"bookmarkId": "bm-a", "chapterUid": 3, "range": "10-20", "markText": "活着本身", "colorStyle": 2, "type": 1, "createTime": 100},
                            {"bookmarkId": "bm-b", "chapterUid": 5, "range": "30-40", "markText": "第二章的话", "colorStyle": 0, "type": 1, "createTime": 200},
                            {"bookmarkId": "bk-x", "chapterUid": 5, "range": "50-50", "markText": "", "type": 0}
                        ]
                    })
                }
                "/review/list/mine" => {
                    assert_eq!(params["bookid"], "w1");
                    if params["synckey"] == 0 {
                        json!({"reviews": [{"reviewId": "r-1", "review": {"reviewId": "r-1", "content": "这就是命", "abstract": "活着本身", "range": "10-20", "chapterUid": 3, "createTime": 150, "star": -1}}], "hasMore": 1, "synckey": 77})
                    } else {
                        json!({"reviews": [{"review": {"reviewId": "r-2", "content": "整本书评", "chapterUid": 0, "createTime": 300, "star": 5}}], "hasMore": 0, "synckey": 78})
                    }
                }
                _ => json!({}),
            })
        })
    }

    #[test]
    fn linked_books_get_marks_and_thoughts_and_projection_enqueued() {
        let conn = crate::db::open_in_memory().unwrap();
        let huozhe = seed(&conn, "活着", "余华", "huozhe");
        let gateway = notes_gateway();
        let status = connect(&conn, &gateway, "wrk-x", "2026-09-28", 0).unwrap();
        assert_eq!(status.last_error, None, "书签 type=0 的空文本行不算错误");
        // 首次同步时 w1 还没关联 → 第一次不拉划线;auto_link 后第二次同步才拉
        assert_eq!(gateway.count("/book/bookmarklist"), 0);
        sync(&conn, &gateway, "2026-09-28", 0).unwrap();
        assert_eq!(gateway.count("/book/bookmarklist"), 1);
        assert_eq!(
            gateway.count("/review/list/mine"),
            2,
            "想法分页到 hasMore=0"
        );
        let notes = notes_for_local(&conn, huozhe).unwrap();
        assert_eq!(notes.weread_id.as_deref(), Some("w1"));
        assert_eq!(notes.mark_count, 2, "type=0 与空文本被过滤");
        assert_eq!(notes.pending_count, 2);
        assert_eq!(notes.thought_count, 2);
        assert_eq!(notes.marks[0].chapter_title, "第一章");
        assert_eq!(notes.marks[1].chapter_idx, 2);
        let r1 = notes
            .thoughts
            .iter()
            .find(|t| t.review_id == "r-1")
            .unwrap();
        assert_eq!(r1.abstract_text, "活着本身");
        assert_eq!(
            notes
                .thoughts
                .iter()
                .find(|t| t.review_id == "r-2")
                .unwrap()
                .star,
            5
        );
        // 投影入队(同内容只一条)
        let pending: i64 = conn
            .query_row(
                "SELECT count(*) FROM projection_outbox WHERE kind = 'sync_weread'",
                [],
                |r| r.get(0),
            )
            .unwrap();
        assert_eq!(pending, 1);
        sync(&conn, &gateway, "2026-09-28", 0).unwrap();
        let again: i64 = conn
            .query_row(
                "SELECT count(*) FROM projection_outbox WHERE kind = 'sync_weread'",
                [],
                |r| r.get(0),
            )
            .unwrap();
        assert_eq!(again, 1, "内容没变 → op_id 相同 → 不重复入队");
        // 未关联的书没有划线
        assert_eq!(notes_for_weread(&conn, "w2").unwrap().mark_count, 0);
        assert!(notes_for_local(&conn, 9_999).unwrap().weread_id.is_none());

        // 渲染
        let md = render_markdown("活着", &notes);
        assert!(md.contains("# 《活着》微信读书划线与想法"), "{md}");
        assert!(
            md.contains("## 第一章\n\n> 活着本身\n> \n> 💬 这就是命"),
            "{md}"
        );
        assert!(md.contains("## 第二章\n\n> 第二章的话"), "{md}");
        assert!(md.contains("## 想法与点评\n\n- 整本书评(评分 5)"), "{md}");

        // 定位:bm-a → 新高亮;r-1 挂到它成批注;bm-b missing
        let mark = crate::reader_marks::NewMark {
            kind: "highlight".into(),
            spine_href: "chap1.xhtml".into(),
            cfi_start: "epubcfi(/6/2!/4/2/1:0)".into(),
            cfi_end: Some("epubcfi(/6/2!/4/2/1:4)".into()),
            text: "活着本身".into(),
            color: "blue".into(),
            note: String::new(),
            source: String::new(),
            external_id: None,
        };
        let created = locate(&conn, "mark", "bm-a", "located", huozhe, Some(&mark), None)
            .unwrap()
            .expect("created");
        assert_eq!(created.source, "weread");
        assert_eq!(created.external_id.as_deref(), Some("bm-a"));
        // 幂等:再定位一次不重复建高亮
        let again = locate(&conn, "mark", "bm-a", "located", huozhe, Some(&mark), None)
            .unwrap()
            .unwrap();
        assert_eq!(again.id, created.id);
        locate(
            &conn,
            "thought",
            "r-1",
            "located",
            huozhe,
            None,
            Some(created.id),
        )
        .unwrap();
        locate(
            &conn,
            "thought",
            "r-1",
            "located",
            huozhe,
            None,
            Some(created.id),
        )
        .unwrap();
        let hl = crate::reader_marks::get(&conn, created.id).unwrap();
        assert_eq!(hl.note, "这就是命", "想法挂成批注,不重复追加");
        locate(&conn, "mark", "bm-b", "missing", huozhe, None, None).unwrap();
        let notes = notes_for_local(&conn, huozhe).unwrap();
        assert_eq!(notes.located_count, 1);
        assert_eq!(notes.pending_count, 0);
        assert_eq!(notes.marks[0].local_mark_id, Some(created.id));
        assert_eq!(notes.marks[1].locate_status, "missing");
        assert_eq!(
            notes
                .thoughts
                .iter()
                .find(|t| t.review_id == "r-1")
                .unwrap()
                .local_mark_id,
            Some(created.id)
        );
        assert!(matches!(
            locate(&conn, "mark", "nope", "located", huozhe, None, None),
            Err(CoreError::NotFound(_))
        ));
        assert!(matches!(
            locate(&conn, "mark", "bm-b", "weird", huozhe, None, None),
            Err(CoreError::InvalidInput(_))
        ));
        // 再同步:已定位的划线保留 local_mark_id;本次消失的划线标 removed
        let gateway2 = FakeGateway::new(|api, _| {
            Ok(match api {
                "/shelf/sync" => shelf(&[("w1", "活着", "余华", 100)]),
                "/book/bookmarklist" => {
                    json!({"chapters": [], "updated": [{"bookmarkId": "bm-a", "chapterUid": 3, "range": "10-20", "markText": "活着本身", "type": 1}]})
                }
                "/review/list/mine" => json!({"reviews": [], "hasMore": 0}),
                _ => json!({"readTimes": {}, "totalReadTime": 0, "readDays": 0}),
            })
        });
        sync(&conn, &gateway2, "2026-09-28", 0).unwrap();
        let notes = notes_for_local(&conn, huozhe).unwrap();
        assert_eq!(notes.mark_count, 1);
        assert_eq!(notes.marks[0].local_mark_id, Some(created.id));
        assert_eq!(notes.thought_count, 0);
        // 费曼上下文:块锚点章节里的微信读书划线
        let block =
            crate::models::insert_block(&conn, huozhe, "模块", 1, "块", "blk", &[]).unwrap();
        conn.execute(
            "INSERT INTO block_anchor(block_id, seq, spine_href, cfi_start, cfi_end, precision, hint) VALUES(?1, 0, 'chap1.xhtml', 'epubcfi(/6/2!/4/2)', 'epubcfi(/6/2!/4/8)', 'exact', '')",
            [block],
        )
        .unwrap();
        let lines = notes_for_block(&conn, huozhe, block, 5).unwrap();
        assert_eq!(lines, vec!["- 微信读书划线:「活着本身」(想法:这就是命)"]);
        assert!(notes_for_block(&conn, huozhe, block, 0).unwrap().is_empty());
    }

    /// 本地假网关:验证真实 HTTP 请求的头与体,以及 401 / errcode 的归类。
    fn serve_once(
        status_line: &'static str,
        body: &'static str,
    ) -> (String, std::thread::JoinHandle<String>) {
        let listener = std::net::TcpListener::bind("127.0.0.1:0").unwrap();
        let url = format!("http://{}/gateway", listener.local_addr().unwrap());
        let handle = std::thread::spawn(move || {
            let (mut stream, _) = listener.accept().unwrap();
            let mut buffer = Vec::new();
            let mut chunk = [0u8; 4096];
            loop {
                let n = stream.read(&mut chunk).unwrap();
                buffer.extend_from_slice(&chunk[..n]);
                let text = String::from_utf8_lossy(&buffer).to_string();
                if let Some(split) = text.find("\r\n\r\n") {
                    let head = &text[..split];
                    let length: usize = head
                        .lines()
                        .find_map(|line| {
                            line.to_lowercase()
                                .strip_prefix("content-length:")
                                .map(|v| v.trim().parse().unwrap())
                        })
                        .unwrap_or(0);
                    if buffer.len() >= split + 4 + length {
                        break;
                    }
                }
                if n == 0 {
                    break;
                }
            }
            let response = format!(
                "HTTP/1.1 {status_line}\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{body}",
                body.len()
            );
            stream.write_all(response.as_bytes()).unwrap();
            String::from_utf8_lossy(&buffer).to_string()
        });
        (url, handle)
    }

    #[test]
    fn http_gateway_posts_bearer_json_and_maps_errors() {
        let (url, handle) = serve_once("200 OK", r#"{"errcode":0,"books":[{"bookId":"1"}]}"#);
        let gateway = HttpGateway::with_url("wrk-abc", url);
        let value = gateway.call("/shelf/sync", json!({"count": 3})).unwrap();
        assert_eq!(value["books"][0]["bookId"], "1");
        let request = handle.join().unwrap();
        assert!(request.starts_with("POST /gateway HTTP/1.1"), "{request}");
        assert!(
            request.contains("Authorization: Bearer wrk-abc"),
            "{request}"
        );
        assert!(
            request
                .to_lowercase()
                .contains("content-type: application/json"),
            "{request}"
        );
        let body_start = request.find("\r\n\r\n").unwrap() + 4;
        let body: Value = serde_json::from_str(&request[body_start..]).unwrap();
        assert_eq!(
            body,
            json!({"api_name": "/shelf/sync", "skill_version": SKILL_VERSION, "count": 3})
        );

        let (url, handle) = serve_once("401 Unauthorized", r#"{"errcode":401}"#);
        let gateway = HttpGateway::with_url("wrk-abc", url);
        assert!(matches!(
            gateway.call("/shelf/sync", json!({})),
            Err(GatewayError::Auth(_))
        ));
        handle.join().unwrap();

        let (url, handle) = serve_once("200 OK", r#"{"errcode":-1,"errmsg":"系统繁忙"}"#);
        let gateway = HttpGateway::with_url("wrk-abc", url);
        let error = gateway.call("/shelf/sync", json!({})).unwrap_err();
        assert!(
            matches!(&error, GatewayError::Gateway(detail) if detail.contains("系统繁忙")),
            "{error:?}"
        );
        handle.join().unwrap();

        let (url, handle) = serve_once("500 Internal Server Error", "boom");
        let gateway = HttpGateway::with_url("wrk-abc", url);
        assert!(
            matches!(gateway.call("/shelf/sync", json!({})), Err(GatewayError::Gateway(detail)) if detail.contains("HTTP 500"))
        );
        handle.join().unwrap();

        // 连不上 → Network
        let gateway = HttpGateway::with_url("wrk-abc", "http://127.0.0.1:1/gateway");
        assert!(matches!(
            gateway.call("/shelf/sync", json!({})),
            Err(GatewayError::Network(_))
        ));
    }
}
