//! 书摘卡片(BL-034,设计 `docs/design/2026-11-25-excerpt-cards.md`):
//! 每本书由 AI 两阶段整理约 50 条好句好段(阶段 A 逐片挑候选并逐字校验 → 阶段 B 全书精选),
//! 用户可删(软删,可撤销)、改字、在阅读器里存入;按作者归类在前端做。
//! 作业断点在 `excerpt_job`(每书一行),AI 调用全部幂等、调用期间不持事务;后台线程在壳层。
use crate::ai::{AiProvider, CompletionRequest, MAX_PROMPT_BYTES};
use crate::mapgen::{list_spine, SpineChapter};
use crate::models::BookType;
use crate::orchestrate::{run_ai_json, AiPolicy};
use crate::{CoreError, Result};
use rusqlite::{Connection, OptionalExtension, Transaction, TransactionBehavior};
use serde::{Deserialize, Serialize};
use std::collections::{HashMap, HashSet};

/// 每本书 AI 整理的目标条数:正文每 2000 字一条,夹在 [12, 50]
pub const TARGET_MIN: usize = 12;
pub const TARGET_MAX: usize = 50;
pub const CHARS_PER_CARD: usize = 2000;
/// 阶段 A 单片正文上限(字节);prompt 其余部分 < 4 KiB,合计不超过 `MAX_PROMPT_BYTES`
pub const PIECE_BYTES: usize = 80 * 1024;
/// 阶段 A 每片要的候选数下限/上限(按片在全书正文里的占比 × 2 倍目标分配)
pub const PER_PIECE_MIN: usize = 3;
pub const PER_PIECE_MAX: usize = 15;
/// AI 书摘的字数范围(按非空白字符计)
pub const AI_TEXT_MIN_CHARS: usize = 6;
pub const AI_TEXT_MAX_CHARS: usize = 400;
/// 用户存入/改字的上限
pub const USER_TEXT_MAX_CHARS: usize = 1200;
/// 阶段 B prompt 里每条候选原文最多显示的字数
pub const PICK_PROMPT_TEXT_CHARS: usize = 240;
/// 每次 AI 调用超时。沿用用户的 codex 全局配置(2026-11-25 为 xhigh:1.3 千字的片约 26 s);
/// 一片最长 80 KiB,比地图每章的 300 s 多留余量
pub const EXCERPT_TIMEOUT_SECS: u64 = 420;
/// 主题标签最多字数
pub const TAG_MAX_CHARS: usize = 8;
/// 作者名最多字数(更正作者)
pub const AUTHOR_MAX_CHARS: usize = 120;

/// 一条书摘(只在 active 时出现在书摘页)
#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Excerpt {
    pub id: i64,
    pub book_id: i64,
    /// ai | user
    pub source: String,
    /// 卡片上显示的文字(可编辑)
    pub text: String,
    /// 书中原文(定位/恢复原文用)
    pub original_text: String,
    pub tag: String,
    pub spine_href: String,
    /// 章节名;spine 标题只是文件路径时为空
    pub chapter_title: String,
    pub chapter_idx: i64,
    /// 阅读器划选的区间 CFI(AI 的为 None,查看时按原文现找)
    pub cfi: Option<String>,
    pub edited: bool,
    pub created_at: String,
    pub updated_at: String,
}

/// 整理作业(每书一行)。stage:queued → reading → selecting → done | failed
#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ExcerptJob {
    pub book_id: i64,
    pub run: i64,
    pub stage: String,
    pub next_piece: i64,
    pub total_pieces: i64,
    pub target: i64,
    /// done 时本轮新增的卡片数
    pub added: i64,
    /// 给用户看的失败原因(中文);技术细节只在 `error_detail` 列与日志
    pub error: Option<String>,
    pub queued_at: String,
    pub updated_at: String,
    pub finished_at: Option<String>,
}

impl ExcerptJob {
    pub fn is_active(&self) -> bool {
        matches!(self.stage.as_str(), "queued" | "reading" | "selecting")
    }
}

/// 书摘页每本书的统计(书名/作者/封面由前端从 `library_list_books` 合并)
#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ExcerptBookStats {
    pub book_id: i64,
    /// 已存正文(spine_item 非空)才能整理
    pub has_text: bool,
    /// 打开阅读器用的块(无知识块 = 阅读器打不开)
    pub reader_block_id: Option<i64>,
    pub ai_count: i64,
    pub user_count: i64,
    pub job: Option<ExcerptJob>,
}

#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ExcerptLibrary {
    pub books: Vec<ExcerptBookStats>,
    /// 全部 active 书摘,按 书 → 章节序 → 章内位置 → id 排好
    pub excerpts: Vec<Excerpt>,
}

/// 阅读器存入的载荷
#[derive(Debug, Clone, PartialEq)]
pub struct NewExcerpt {
    pub text: String,
    pub spine_href: String,
    pub cfi: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Added {
    pub excerpt: Excerpt,
    /// false = 这段文字本来就在书摘里(没有新建)
    pub created: bool,
    /// 这本书的作者(`book.author` 原样,前端归一后用于提示「已存入「作者」的书摘」)
    pub author: String,
}

fn now() -> String {
    chrono::Utc::now().to_rfc3339_opts(chrono::SecondsFormat::Secs, true)
}

// ---------------------------------------------------------------------------
// 归一化与逐字查找
// ---------------------------------------------------------------------------

/// 单字归一:去空白、全角 ASCII 转半角、引号/破折号/间隔号统一、省略号展开成三个点
fn push_norm(c: char, out: &mut Vec<char>) {
    if c.is_whitespace() {
        return;
    }
    match c {
        '\u{FF01}'..='\u{FF5E}' => out.push(char::from_u32(c as u32 - 0xFEE0).unwrap_or(c)),
        '“' | '”' | '„' | '‟' | '〝' | '〞' => out.push('"'),
        '‘' | '’' | '‚' | '‛' => out.push('\''),
        '…' => out.extend(['.', '.', '.']),
        '—' | '–' | '―' | '‒' => out.push('-'),
        '•' | '‧' | '・' | '･' => out.push('·'),
        _ => out.push(c),
    }
}

fn normalized(s: &str) -> Vec<char> {
    let mut out = Vec::with_capacity(s.len());
    for c in s.chars() {
        push_norm(c, &mut out);
    }
    out
}

fn is_edge_punct(c: char) -> bool {
    !c.is_alphanumeric()
}

/// 去重键:归一化后去掉首尾标点,拉丁字母小写。同一段话不同标点/空白/全半角得到同一个键
pub fn norm_key(s: &str) -> String {
    let chars = normalized(s);
    let start = chars.iter().position(|c| !is_edge_punct(*c));
    let Some(start) = start else {
        return String::new();
    };
    let end = chars
        .iter()
        .rposition(|c| !is_edge_punct(*c))
        .unwrap_or(start)
        + 1;
    chars[start..end]
        .iter()
        .flat_map(|c| c.to_lowercase())
        .collect()
}

/// 原文的归一化视图:归一化字符串 + 每个归一化字符对应的原文字符下标
struct NormText {
    orig: Vec<char>,
    norm: String,
    /// norm 中每个字符的字节起点(升序)
    starts: Vec<usize>,
    /// norm 中每个字符来自原文的第几个字符
    map: Vec<usize>,
}

impl NormText {
    fn new(s: &str) -> Self {
        let orig: Vec<char> = s.chars().collect();
        let mut norm = String::with_capacity(s.len());
        let mut starts = Vec::with_capacity(orig.len());
        let mut map = Vec::with_capacity(orig.len());
        let mut buf = Vec::with_capacity(3);
        for (i, c) in orig.iter().enumerate() {
            buf.clear();
            push_norm(*c, &mut buf);
            for n in &buf {
                starts.push(norm.len());
                map.push(i);
                norm.push(*n);
            }
        }
        Self {
            orig,
            norm,
            starts,
            map,
        }
    }

    /// 找归一化片段,返回原文字符区间 [start, end)
    fn find_norm(&self, needle: &str) -> Option<(usize, usize)> {
        if needle.is_empty() {
            return None;
        }
        let byte = self.norm.find(needle)?;
        let first = self.starts.binary_search(&byte).ok()?;
        let count = needle.chars().count();
        let last = first + count - 1;
        Some((self.map[first], self.map[last] + 1))
    }
}

/// 逐字查找:按归一化文本找;找不到再去掉首尾标点重找(AI 常多加/漏掉句末标点)
fn find_in(hay: &NormText, needle: &str) -> Option<(usize, usize)> {
    let n: String = normalized(needle).into_iter().collect();
    if let Some(span) = hay.find_norm(&n) {
        return Some(span);
    }
    let trimmed: String = n.trim_matches(is_edge_punct).to_string();
    if trimmed.chars().count() >= 4 && trimmed != n {
        return hay.find_norm(&trimmed);
    }
    None
}

/// 在 `hay` 里逐字查找 `needle`,返回原文字符区间 [start, end)(测试与阅读器存入用)
pub fn find_verbatim(hay: &str, needle: &str) -> Option<(usize, usize)> {
    find_in(&NormText::new(hay), needle)
}

const SENTENCE_FINALS: [char; 9] = ['。', '！', '？', '!', '?', '…', '；', ';', '.'];
const PAIRS: [(char, char); 7] = [
    ('“', '”'),
    ('「', '」'),
    ('『', '』'),
    ('（', '）'),
    ('(', ')'),
    ('《', '》'),
    ('‘', '’'),
];

/// 修整命中区间:去掉开头的逗号顿号等;句末标点从原文补齐(≤ 2 个);区间里有未闭合的引号/括号就把紧跟的闭合符带上
fn polish_span(orig: &[char], mut start: usize, mut end: usize) -> (usize, usize) {
    while start < end && matches!(orig[start], '，' | '、' | '；' | '：' | ',' | ';' | ':') {
        start += 1;
    }
    let mut added = 0;
    while end < orig.len()
        && added < 2
        && SENTENCE_FINALS.contains(&orig[end])
        && (added > 0 || !SENTENCE_FINALS.contains(&orig[end - 1]))
    {
        end += 1;
        added += 1;
    }
    while end < orig.len() {
        let c = orig[end];
        let Some((open, _)) = PAIRS.iter().find(|(_, close)| *close == c) else {
            break;
        };
        let opens = orig[start..end].iter().filter(|x| **x == *open).count();
        let closes = orig[start..end].iter().filter(|x| **x == c).count();
        if opens > closes {
            end += 1;
        } else {
            break;
        }
    }
    (start, end)
}

/// 去掉多余空行(跨段时只留一个换行)、首尾空白
fn tidy(text: &str) -> String {
    text.lines()
        .map(str::trim)
        .filter(|l| !l.is_empty())
        .collect::<Vec<_>>()
        .join("\n")
}

fn visible_chars(s: &str) -> usize {
    s.chars().filter(|c| !c.is_whitespace()).count()
}

/// spine 标题只是文件路径(未命名章节)时不显示
pub fn display_chapter_title(title: &str, href: &str) -> String {
    let t = title.trim();
    let looks_like_path = t == href
        || t.contains('/')
        || t.ends_with(".html")
        || t.ends_with(".xhtml")
        || t.ends_with(".htm");
    if t.is_empty() || looks_like_path {
        String::new()
    } else {
        t.to_string()
    }
}

// ---------------------------------------------------------------------------
// 选章、切片与目标数
// ---------------------------------------------------------------------------

/// 书摘额外剔除的非正文:索引、参考文献、注释、译名对照(封面/目录/版权等由脉络图的正文判定剔除)
fn is_excerpt_source(c: &SpineChapter) -> bool {
    const JUNK: [&str; 9] = [
        "索引",
        "参考文献",
        "注释",
        "尾注",
        "译名",
        "index",
        "bibliography",
        "references",
        "endnotes",
    ];
    if !crate::lineage::is_content_chapter(c) {
        return false;
    }
    // 标题去掉空白再比(亚隆《存在主义心理治疗》的索引章叫「索 引」)
    let title: String = c
        .title
        .chars()
        .filter(|ch| !ch.is_whitespace())
        .collect::<String>()
        .to_lowercase();
    !JUNK.iter().any(|k| title.contains(k))
}

#[derive(Debug, Clone, PartialEq)]
struct Piece {
    chapter_idx: i64,
    href: String,
    title: String,
    /// 「(第 i/n 部分)」;整章一片时为空
    part: String,
    text: String,
    chars: usize,
}

fn plan_pieces(chapters: &[SpineChapter]) -> Vec<Piece> {
    let mut out = vec![];
    for ch in chapters.iter().filter(|c| is_excerpt_source(c)) {
        let parts = crate::mapgen::split_text(&ch.text, PIECE_BYTES);
        let n = parts.len();
        for (i, text) in parts.into_iter().enumerate() {
            let chars = text.chars().count();
            out.push(Piece {
                chapter_idx: ch.idx,
                href: ch.href.clone(),
                title: display_chapter_title(&ch.title, &ch.href),
                part: if n > 1 {
                    format!("(第 {}/{} 部分)", i + 1, n)
                } else {
                    String::new()
                },
                text,
                chars,
            });
        }
    }
    out
}

/// 目标条数:正文每 2000 字一条,夹在 [12, 50]
pub fn target_for(content_chars: usize) -> usize {
    (content_chars / CHARS_PER_CARD).clamp(TARGET_MIN, TARGET_MAX)
}

fn per_piece(target: usize, piece_chars: usize, total_chars: usize) -> usize {
    if total_chars == 0 {
        return PER_PIECE_MIN;
    }
    let k = (2 * target * piece_chars).div_ceil(total_chars.max(1));
    k.clamp(PER_PIECE_MIN, PER_PIECE_MAX)
}

// ---------------------------------------------------------------------------
// 候选:解析、逐字校验、去重
// ---------------------------------------------------------------------------

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
struct Candidate {
    id: String,
    chapter_idx: i64,
    href: String,
    chapter_title: String,
    /// 书中原文(已修整)
    text: String,
    /// 章节正文里的字符区间
    start: i64,
    end: i64,
    tag: String,
    why: String,
    score: f64,
}

#[derive(Debug, Clone, Default, Deserialize)]
struct RawCandidate {
    #[serde(default)]
    text: String,
    #[serde(default)]
    tag: String,
    #[serde(default)]
    why: String,
    #[serde(default)]
    score: Option<serde_json::Value>,
}

fn strip_fence(text: &str) -> &str {
    let t = text.trim();
    t.strip_prefix("```json")
        .or_else(|| t.strip_prefix("```"))
        .and_then(|x| x.strip_suffix("```"))
        .unwrap_or(t)
        .trim()
}

/// 解析 JSON;模型偶尔在 JSON 前后多说一句、或把同一段 JSON 输出两遍(2026-11-25 真机见过 `[..][..]`):
/// 先整段解析,再从第一个 `open` 起取第一个完整 JSON 值,最后退而截取第一个 `open` 到最后一个 `close`
fn parse_json_loose(text: &str, open: char, close: char) -> Result<serde_json::Value> {
    let t = strip_fence(text);
    match serde_json::from_str::<serde_json::Value>(t) {
        Ok(v) => Ok(v),
        Err(first) => {
            if let Some(a) = t.find(open) {
                let mut values =
                    serde_json::Deserializer::from_str(&t[a..]).into_iter::<serde_json::Value>();
                if let Some(Ok(v)) = values.next() {
                    return Ok(v);
                }
            }
            let (Some(a), Some(b)) = (t.find(open), t.rfind(close)) else {
                return Err(CoreError::EvalParse(format!("excerpt json: {first}")));
            };
            if b <= a {
                return Err(CoreError::EvalParse(format!("excerpt json: {first}")));
            }
            serde_json::from_str(&t[a..=b])
                .map_err(|e| CoreError::EvalParse(format!("excerpt json: {e}")))
        }
    }
}

fn parse_raw_candidates(text: &str) -> Result<Vec<RawCandidate>> {
    let value = parse_json_loose(text, '[', ']')?;
    let items = match value {
        serde_json::Value::Array(items) => items,
        serde_json::Value::Object(mut map) => match map
            .remove("candidates")
            .or_else(|| map.remove("excerpts"))
            .or_else(|| map.remove("items"))
        {
            Some(serde_json::Value::Array(items)) => items,
            _ => {
                return Err(CoreError::EvalParse(
                    "excerpt json: expected an array of candidates".into(),
                ))
            }
        },
        _ => {
            return Err(CoreError::EvalParse(
                "excerpt json: expected an array of candidates".into(),
            ))
        }
    };
    Ok(items
        .into_iter()
        .filter_map(|item| match item {
            serde_json::Value::String(text) => Some(RawCandidate {
                text,
                ..Default::default()
            }),
            other => serde_json::from_value::<RawCandidate>(other).ok(),
        })
        .collect())
}

fn score_of(v: &Option<serde_json::Value>) -> f64 {
    let s = match v {
        Some(serde_json::Value::Number(n)) => n.as_f64().unwrap_or(3.0),
        Some(serde_json::Value::String(s)) => s.trim().parse().unwrap_or(3.0),
        _ => 3.0,
    };
    s.clamp(1.0, 5.0)
}

fn clean_tag(tag: &str) -> String {
    let t = tag.trim().trim_matches(|c: char| {
        c == '#' || c == '"' || c == '“' || c == '”' || c == '「' || c == '」' || c.is_whitespace()
    });
    t.chars().take(TAG_MAX_CHARS).collect()
}

/// 一条 AI 候选对上原文:返回修整后的原文与区间;对不上/含标题/长度不合格 → None
fn match_candidate(chapter: &NormText, raw: &str) -> Option<(String, usize, usize)> {
    let (start, end) = find_in(chapter, raw)?;
    let (start, end) = polish_span(&chapter.orig, start, end);
    if end <= start {
        return None;
    }
    let text: String = chapter.orig[start..end].iter().collect();
    if text.lines().any(|l| l.trim_start().starts_with('#')) {
        return None;
    }
    let text = tidy(&text);
    let n = visible_chars(&text);
    if !(AI_TEXT_MIN_CHARS..=AI_TEXT_MAX_CHARS).contains(&n) {
        return None;
    }
    Some((text, start, end))
}

/// 阶段 A 一片的解析:JSON → 逐字校验。给了候选却一条都对不上原文 → EvalParse(触发一次纠错重试)
fn parse_piece(text: &str, piece: &Piece, chapter: &NormText) -> Result<Vec<Candidate>> {
    let raws = parse_raw_candidates(text)?;
    let mut out = vec![];
    for raw in &raws {
        if raw.text.trim().is_empty() {
            continue;
        }
        if let Some((text, start, end)) = match_candidate(chapter, &raw.text) {
            out.push(Candidate {
                id: String::new(),
                chapter_idx: piece.chapter_idx,
                href: piece.href.clone(),
                chapter_title: piece.title.clone(),
                text,
                start: start as i64,
                end: end as i64,
                tag: clean_tag(&raw.tag),
                why: raw.why.trim().chars().take(60).collect(),
                score: score_of(&raw.score),
            });
        }
    }
    let had_any = raws.iter().any(|r| !r.text.trim().is_empty());
    if had_any && out.is_empty() {
        return Err(CoreError::EvalParse(
            "没有一条与原文逐字一致:text 必须逐字照抄原文中连续的一段,不改字、不加省略号".into(),
        ));
    }
    Ok(out)
}

fn overlaps(a: &Candidate, b: &Candidate) -> bool {
    if a.chapter_idx != b.chapter_idx {
        return false;
    }
    let lo = a.start.max(b.start);
    let hi = a.end.min(b.end);
    if hi <= lo {
        return false;
    }
    let shorter = (a.end - a.start).min(b.end - b.start).max(1);
    (hi - lo) * 2 >= shorter
}

/// 并入候选池:与已有候选同键或同章区间重叠过半的跳过;新候选按池序编号 c1, c2, …
fn merge_candidates(pool: &mut Vec<Candidate>, found: Vec<Candidate>) {
    for mut c in found {
        let key = norm_key(&c.text);
        if key.is_empty() {
            continue;
        }
        if pool
            .iter()
            .any(|p| norm_key(&p.text) == key || overlaps(p, &c))
        {
            continue;
        }
        c.id = format!("c{}", pool.len() + 1);
        pool.push(c);
    }
}

// ---------------------------------------------------------------------------
// 阶段 B:精选
// ---------------------------------------------------------------------------

#[derive(Debug, Clone, PartialEq)]
struct Pick {
    id: String,
    tag: String,
}

fn truncate_chars(s: &str, n: usize) -> String {
    let flat: String = s.replace('\n', " ");
    if flat.chars().count() <= n {
        flat
    } else {
        flat.chars().take(n).collect::<String>() + "…"
    }
}

fn candidate_lines(pool: &[Candidate]) -> String {
    pool.iter()
        .map(|c| {
            let chapter = if c.chapter_title.is_empty() {
                format!("第{}篇", c.chapter_idx + 1)
            } else {
                c.chapter_title.clone()
            };
            let tag = if c.tag.is_empty() {
                String::new()
            } else {
                format!(" ({})", c.tag)
            };
            format!(
                "{} [{}]{} {}",
                c.id,
                chapter,
                tag,
                truncate_chars(&c.text, PICK_PROMPT_TEXT_CHARS)
            )
        })
        .collect::<Vec<_>>()
        .join("\n")
}

fn parse_picks(text: &str, known: &HashSet<&str>) -> Result<Vec<Pick>> {
    let value = parse_json_loose(text, '{', '}').or_else(|_| parse_json_loose(text, '[', ']'))?;
    let items = match value {
        serde_json::Value::Object(mut map) => match map.remove("picks") {
            Some(serde_json::Value::Array(items)) => items,
            _ => {
                return Err(CoreError::EvalParse(
                    "excerpt picks: expected {\"picks\":[...]}".into(),
                ))
            }
        },
        serde_json::Value::Array(items) => items,
        _ => {
            return Err(CoreError::EvalParse(
                "excerpt picks: expected {\"picks\":[...]}".into(),
            ))
        }
    };
    let mut seen = HashSet::new();
    let mut picks = vec![];
    for item in items {
        let (id, tag) = match item {
            serde_json::Value::String(id) => (id, String::new()),
            serde_json::Value::Object(map) => (
                map.get("id")
                    .and_then(|v| v.as_str())
                    .unwrap_or_default()
                    .to_string(),
                map.get("tag")
                    .and_then(|v| v.as_str())
                    .unwrap_or_default()
                    .to_string(),
            ),
            _ => continue,
        };
        let id = id.trim().to_string();
        if known.contains(id.as_str()) && seen.insert(id.clone()) {
            picks.push(Pick {
                id,
                tag: clean_tag(&tag),
            });
        }
    }
    if picks.is_empty() {
        return Err(CoreError::EvalParse(
            "picks 里没有一个有效编号:id 只能用候选里出现过的编号(如 c12)".into(),
        ));
    }
    Ok(picks)
}

/// AI 精选不可用时的兜底:各章按自评分轮流取,直到目标数
fn fallback_picks(pool: &[Candidate], target: usize) -> Vec<Pick> {
    let mut by_chapter: Vec<(i64, Vec<&Candidate>)> = vec![];
    for c in pool {
        match by_chapter.iter_mut().find(|(idx, _)| *idx == c.chapter_idx) {
            Some((_, list)) => list.push(c),
            None => by_chapter.push((c.chapter_idx, vec![c])),
        }
    }
    for (_, list) in by_chapter.iter_mut() {
        list.sort_by(|a, b| {
            b.score
                .partial_cmp(&a.score)
                .unwrap_or(std::cmp::Ordering::Equal)
        });
    }
    let mut picks = vec![];
    let mut round = 0;
    while picks.len() < target {
        let mut any = false;
        for (_, list) in &by_chapter {
            if let Some(c) = list.get(round) {
                any = true;
                if picks.len() < target {
                    picks.push(Pick {
                        id: c.id.clone(),
                        tag: String::new(),
                    });
                }
            }
        }
        if !any {
            break;
        }
        round += 1;
    }
    picks
}

/// 精选结果的上限:目标的 1.2 倍,且不超过 TARGET_MAX + 10
fn picks_cap(target: usize) -> usize {
    ((target * 6).div_ceil(5)).min(TARGET_MAX + 10)
}

// ---------------------------------------------------------------------------
// 作业:读写
// ---------------------------------------------------------------------------

const JOB_COLS: &str =
    "book_id,run,stage,next_piece,total_pieces,target,added,error,queued_at,updated_at,finished_at";

fn job_from_row(r: &rusqlite::Row<'_>) -> rusqlite::Result<ExcerptJob> {
    Ok(ExcerptJob {
        book_id: r.get(0)?,
        run: r.get(1)?,
        stage: r.get(2)?,
        next_piece: r.get(3)?,
        total_pieces: r.get(4)?,
        target: r.get(5)?,
        added: r.get(6)?,
        error: r.get(7)?,
        queued_at: r.get(8)?,
        updated_at: r.get(9)?,
        finished_at: r.get(10)?,
    })
}

pub fn get_job(conn: &Connection, book_id: i64) -> Result<Option<ExcerptJob>> {
    Ok(conn
        .query_row(
            &format!("SELECT {JOB_COLS} FROM excerpt_job WHERE book_id=?1"),
            [book_id],
            job_from_row,
        )
        .optional()?)
}

/// 全部作业(书摘页轮询)
pub fn jobs(conn: &Connection) -> Result<Vec<ExcerptJob>> {
    let mut st = conn.prepare(&format!(
        "SELECT {JOB_COLS} FROM excerpt_job ORDER BY book_id"
    ))?;
    let rows = st.query_map([], job_from_row)?;
    Ok(rows.collect::<rusqlite::Result<Vec<_>>>()?)
}

fn book_meta(conn: &Connection, book_id: i64) -> Result<(String, String, BookType)> {
    let row: Option<(String, Option<String>, String)> = conn
        .query_row(
            "SELECT title,author,type FROM book WHERE id=?1",
            [book_id],
            |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?)),
        )
        .optional()?;
    let Some((title, author, ty)) = row else {
        return Err(CoreError::NotFound(format!("book {book_id}")));
    };
    Ok((
        title,
        author.unwrap_or_default(),
        BookType::from_db_str(&ty)?,
    ))
}

fn has_text(conn: &Connection, book_id: i64) -> Result<bool> {
    Ok(conn
        .query_row(
            "SELECT 1 FROM spine_item WHERE book_id=?1 LIMIT 1",
            [book_id],
            |r| r.get::<_, i64>(0),
        )
        .optional()?
        .is_some())
}

/// 入队(语义见设计 §4 表):没有作业 → 新建;进行中 → 原样(regenerate 时 conflict);
/// failed → 同一轮续跑(regenerate 时开新一轮);done → 原样(regenerate 时开新一轮)
pub fn enqueue(conn: &Connection, book_id: i64, regenerate: bool) -> Result<ExcerptJob> {
    book_meta(conn, book_id)?;
    if !has_text(conn, book_id)? {
        return Err(CoreError::InvalidInput(
            "这本书还没抽取正文,先完成导入".into(),
        ));
    }
    let tx = Transaction::new_unchecked(conn, TransactionBehavior::Immediate)?;
    let ts = now();
    let existing = tx
        .query_row(
            &format!("SELECT {JOB_COLS} FROM excerpt_job WHERE book_id=?1"),
            [book_id],
            job_from_row,
        )
        .optional()?;
    match existing {
        None => {
            tx.execute(
                "INSERT INTO excerpt_job(book_id,run,stage,queued_at,updated_at) VALUES(?1,1,'queued',?2,?2)",
                rusqlite::params![book_id, ts],
            )?;
        }
        Some(job) if job.is_active() => {
            if regenerate {
                return Err(CoreError::Conflict("这本书正在整理书摘,请稍等".into()));
            }
            tx.commit()?;
            return Ok(job);
        }
        Some(job) if job.stage == "failed" && !regenerate => {
            tx.execute(
                "UPDATE excerpt_job SET stage='queued', error=NULL, error_detail=NULL, queued_at=?2, updated_at=?2 WHERE book_id=?1",
                rusqlite::params![book_id, ts],
            )?;
        }
        Some(job) if job.stage == "done" && !regenerate => {
            tx.commit()?;
            return Ok(job);
        }
        Some(job) => {
            tx.execute(
                "UPDATE excerpt_job SET run=?2, stage='queued', next_piece=0, total_pieces=0, target=0, \
                 candidates_json='[]', added=0, error=NULL, error_detail=NULL, queued_at=?3, updated_at=?3, finished_at=NULL \
                 WHERE book_id=?1",
                rusqlite::params![book_id, job.run + 1, ts],
            )?;
        }
    }
    tx.commit()?;
    Ok(get_job(conn, book_id)?.expect("just enqueued"))
}

/// 下一个要跑的作业:最早入队的 queued/reading/selecting(上次退出时没跑完的也在里面)
pub fn next_job(conn: &Connection) -> Result<Option<i64>> {
    Ok(conn
        .query_row(
            "SELECT book_id FROM excerpt_job WHERE stage IN ('queued','reading','selecting') \
             ORDER BY queued_at, book_id LIMIT 1",
            [],
            |r| r.get(0),
        )
        .optional()?)
}

/// 给用户看的失败原因
pub fn friendly_error(e: &CoreError) -> String {
    let text = e.to_string().to_lowercase();
    if text.contains("timeout") || text.contains("timed out") {
        return "AI 响应超时。点「重试」会从断点接着整理".into();
    }
    match e {
        CoreError::Ai(_) | CoreError::Io(_) => "AI 暂时没有回应。点「重试」会从断点接着整理".into(),
        CoreError::EvalParse(_) => "AI 的输出无法解析。点「重试」再整理一次".into(),
        CoreError::InvalidInput(m) if m.contains("prompt exceeds") => {
            "这本书的候选太多,超出了一次精选的长度上限".into()
        }
        _ => "整理时出错了。点「重试」再整理一次".into(),
    }
}

/// 标记失败(原因给用户看,细节进 error_detail);壳层在 codex 找不到等情况下直接调用
pub fn fail_job_with(conn: &Connection, book_id: i64, message: &str, detail: &str) -> Result<()> {
    conn.execute(
        "UPDATE excerpt_job SET stage='failed', error=?2, error_detail=?3, updated_at=?4 WHERE book_id=?1",
        rusqlite::params![book_id, message, detail, now()],
    )?;
    Ok(())
}

pub fn fail_job(conn: &Connection, book_id: i64, err: &CoreError) -> Result<()> {
    fail_job_with(conn, book_id, &friendly_error(err), &err.to_string())
}

fn save_progress(
    conn: &Connection,
    book_id: i64,
    stage: &str,
    next_piece: i64,
    pool: &[Candidate],
) -> Result<()> {
    let json = serde_json::to_string(pool).map_err(|e| CoreError::Other(e.to_string()))?;
    conn.execute(
        "UPDATE excerpt_job SET stage=?2, next_piece=?3, candidates_json=?4, error=NULL, error_detail=NULL, updated_at=?5 \
         WHERE book_id=?1",
        rusqlite::params![book_id, stage, next_piece, json, now()],
    )?;
    Ok(())
}

fn request(workdir: &std::path::Path, system: String) -> CompletionRequest {
    CompletionRequest {
        system,
        messages: vec![],
        workdir: workdir.to_path_buf(),
        read_only: true,
        request_id: String::new(),
        timeout_secs: EXCERPT_TIMEOUT_SECS,
    }
}

/// 跑/续跑一本书的整理作业,直到 done 或 failed(失败时返回错误,作业已标 failed)。
/// done / failed 的作业原样返回(重试要先 `enqueue`)。`on_progress` 在每片开始前与进入精选时调用。
pub fn run_job(
    conn: &Connection,
    provider: &dyn AiProvider,
    workdir: &std::path::Path,
    policy: &AiPolicy,
    book_id: i64,
    on_progress: &mut dyn FnMut(&ExcerptJob),
) -> Result<ExcerptJob> {
    if !conn.is_autocommit() {
        return Err(CoreError::Other(
            "run_job must not be called inside a transaction".into(),
        ));
    }
    let Some(mut job) = get_job(conn, book_id)? else {
        return Err(CoreError::NotFound(format!(
            "excerpt job for book {book_id}"
        )));
    };
    if !job.is_active() {
        return Ok(job);
    }
    let result = run_active(conn, provider, workdir, policy, &mut job, on_progress);
    match result {
        Ok(()) => Ok(get_job(conn, book_id)?.expect("job row exists")),
        Err(e) => {
            fail_job(conn, book_id, &e)?;
            Err(e)
        }
    }
}

fn run_active(
    conn: &Connection,
    provider: &dyn AiProvider,
    workdir: &std::path::Path,
    policy: &AiPolicy,
    job: &mut ExcerptJob,
    on_progress: &mut dyn FnMut(&ExcerptJob),
) -> Result<()> {
    let book_id = job.book_id;
    let (title, author, ty) = book_meta(conn, book_id)?;
    let chapters = list_spine(conn, book_id)?;
    let pieces = plan_pieces(&chapters);
    let content_chars: usize = pieces.iter().map(|p| p.chars).sum();
    let target = target_for(content_chars);
    let total = pieces.len() as i64;

    // 新作业记下片数与目标;片数变了(spine 重存)→ 开新一轮,旧请求 id 不再复用
    if job.total_pieces == 0 || job.total_pieces != total {
        if job.total_pieces != 0 {
            job.run += 1;
        }
        conn.execute(
            "UPDATE excerpt_job SET run=?2, stage='reading', next_piece=0, total_pieces=?3, target=?4, \
             candidates_json='[]', error=NULL, error_detail=NULL, updated_at=?5 WHERE book_id=?1",
            rusqlite::params![book_id, job.run, total, target as i64, now()],
        )?;
        job.stage = "reading".into();
        job.next_piece = 0;
        job.total_pieces = total;
        job.target = target as i64;
    } else if job.stage == "queued" {
        conn.execute(
            "UPDATE excerpt_job SET stage='reading', updated_at=?2 WHERE book_id=?1",
            rusqlite::params![book_id, now()],
        )?;
        job.stage = "reading".into();
    }
    let target = job.target.max(1) as usize;
    let candidates_json: String = conn.query_row(
        "SELECT candidates_json FROM excerpt_job WHERE book_id=?1",
        [book_id],
        |r| r.get(0),
    )?;
    let mut pool: Vec<Candidate> = serde_json::from_str(&candidates_json)
        .map_err(|e| CoreError::Other(format!("corrupt excerpt_job.candidates_json: {e}")))?;

    let by_idx: HashMap<i64, &SpineChapter> = chapters.iter().map(|c| (c.idx, c)).collect();
    if job.stage == "reading" {
        let mut norm_cache: HashMap<i64, NormText> = HashMap::new();
        let start = job.next_piece.max(0) as usize;
        for (k, piece) in pieces.iter().enumerate().skip(start) {
            job.next_piece = k as i64;
            on_progress(job);
            let chapter_text = by_idx
                .get(&piece.chapter_idx)
                .map(|c| c.text.as_str())
                .unwrap_or("");
            let chapter = norm_cache
                .entry(piece.chapter_idx)
                .or_insert_with(|| NormText::new(chapter_text));
            let max_items = per_piece(target, piece.chars, content_chars);
            let req = request(
                workdir,
                crate::prompts::excerpt_read_prompt(
                    &title,
                    &author,
                    ty,
                    &piece.title,
                    &piece.part,
                    max_items,
                    &piece.text,
                ),
            );
            let parse = |text: &str| parse_piece(text, piece, chapter);
            let found = match run_ai_json(
                conn,
                provider,
                &format!("excerpt:{book_id}:r{}:p{k}", job.run),
                "excerpt_read",
                &req,
                policy,
                &parse,
            ) {
                Ok(mut found) => {
                    found.truncate(max_items);
                    found
                }
                // 这一片纠错后仍对不上原文:跳过这一片(ai_request 里留着原因),不让整本书失败
                Err(CoreError::EvalParse(_)) => vec![],
                Err(e) => return Err(e),
            };
            merge_candidates(&mut pool, found);
            save_progress(conn, book_id, "reading", (k + 1) as i64, &pool)?;
        }
        job.next_piece = total;
        save_progress(conn, book_id, "selecting", total, &pool)?;
        job.stage = "selecting".into();
    }
    on_progress(job);

    let picks = if pool.is_empty() {
        vec![]
    } else {
        select(
            conn, provider, workdir, policy, job, &title, &author, &pool, target,
        )?
    };
    finish(conn, job, &pool, &picks)
}

#[allow(clippy::too_many_arguments)]
fn select(
    conn: &Connection,
    provider: &dyn AiProvider,
    workdir: &std::path::Path,
    policy: &AiPolicy,
    job: &ExcerptJob,
    title: &str,
    author: &str,
    pool: &[Candidate],
    target: usize,
) -> Result<Vec<Pick>> {
    // 候选太多超出 prompt 上限时,按自评分从低到高剔除(同分先剔后面的;其余保持原顺序)
    let base = crate::prompts::excerpt_pick_prompt(title, author, target, "").len();
    let line_bytes: Vec<usize> = pool
        .iter()
        .map(|c| candidate_lines(std::slice::from_ref(c)).len() + 1)
        .collect();
    let mut keep = vec![true; pool.len()];
    let mut total = base + line_bytes.iter().sum::<usize>();
    let mut order: Vec<usize> = (0..pool.len()).collect();
    order.sort_by(|a, b| {
        pool[*a]
            .score
            .partial_cmp(&pool[*b].score)
            .unwrap_or(std::cmp::Ordering::Equal)
            .then(b.cmp(a))
    });
    let mut kept = pool.len();
    for i in order {
        if total <= MAX_PROMPT_BYTES || kept <= target {
            break;
        }
        keep[i] = false;
        total -= line_bytes[i];
        kept -= 1;
    }
    let shown: Vec<&Candidate> = pool
        .iter()
        .zip(&keep)
        .filter(|(_, k)| **k)
        .map(|(c, _)| c)
        .collect();
    let owned: Vec<Candidate> = shown.iter().map(|c| (*c).clone()).collect();
    let system =
        crate::prompts::excerpt_pick_prompt(title, author, target, &candidate_lines(&owned));
    if system.len() > MAX_PROMPT_BYTES {
        return Err(CoreError::InvalidInput(format!(
            "prompt exceeds {MAX_PROMPT_BYTES} bytes: {}",
            system.len()
        )));
    }
    let known: HashSet<&str> = shown.iter().map(|c| c.id.as_str()).collect();
    let req = request(workdir, system);
    let parse = |text: &str| parse_picks(text, &known);
    match run_ai_json(
        conn,
        provider,
        &format!("excerpt:{}:r{}:pick", job.book_id, job.run),
        "excerpt_pick",
        &req,
        policy,
        &parse,
    ) {
        Ok(mut picks) => {
            picks.truncate(picks_cap(target));
            Ok(picks)
        }
        // 精选输出纠错后仍不可用(ai_request 里留着原因):各章按自评分轮流取,作业照样完成
        Err(CoreError::EvalParse(_)) => Ok(fallback_picks(&owned, target)),
        Err(e) => Err(e),
    }
}

/// 落库(单事务):重新整理时先删 AI 整理且没改过的 active 卡片;按 norm_key 跳过已有的(含墓碑)
fn finish(conn: &Connection, job: &ExcerptJob, pool: &[Candidate], picks: &[Pick]) -> Result<()> {
    let book_id = job.book_id;
    let tx = Transaction::new_unchecked(conn, TransactionBehavior::Immediate)?;
    if job.run > 1 {
        tx.execute(
            "DELETE FROM excerpt WHERE book_id=?1 AND source='ai' AND status='active' AND edited=0",
            [book_id],
        )?;
    }
    let mut existing: HashSet<String> = {
        let mut st = tx.prepare("SELECT norm_key FROM excerpt WHERE book_id=?1")?;
        let rows = st.query_map([book_id], |r| r.get::<_, String>(0))?;
        rows.collect::<rusqlite::Result<HashSet<_>>>()?
    };
    let by_id: HashMap<&str, &Candidate> = pool.iter().map(|c| (c.id.as_str(), c)).collect();
    let ts = now();
    let mut added = 0i64;
    for pick in picks {
        let Some(c) = by_id.get(pick.id.as_str()) else {
            continue;
        };
        let key = norm_key(&c.text);
        if key.is_empty() || !existing.insert(key.clone()) {
            continue;
        }
        let tag = if pick.tag.is_empty() {
            c.tag.clone()
        } else {
            pick.tag.clone()
        };
        tx.execute(
            "INSERT INTO excerpt(book_id,source,status,text,original_text,norm_key,tag,spine_href,chapter_title,\
             chapter_idx,char_offset,cfi,edited,run,created_at,updated_at) \
             VALUES(?1,'ai','active',?2,?2,?3,?4,?5,?6,?7,?8,NULL,0,?9,?10,?10)",
            rusqlite::params![
                book_id,
                c.text,
                key,
                tag,
                c.href,
                c.chapter_title,
                c.chapter_idx,
                c.start,
                job.run,
                ts
            ],
        )?;
        added += 1;
    }
    tx.execute(
        "UPDATE excerpt_job SET stage='done', added=?2, candidates_json='[]', error=NULL, error_detail=NULL, \
         finished_at=?3, updated_at=?3 WHERE book_id=?1",
        rusqlite::params![book_id, added, ts],
    )?;
    tx.commit()?;
    Ok(())
}

// ---------------------------------------------------------------------------
// 卡片:列表、存入、改字、删除、撤销
// ---------------------------------------------------------------------------

const EXCERPT_COLS: &str = "id,book_id,source,text,original_text,tag,spine_href,chapter_title,chapter_idx,cfi,edited,created_at,updated_at";

fn excerpt_from_row(r: &rusqlite::Row<'_>) -> rusqlite::Result<Excerpt> {
    Ok(Excerpt {
        id: r.get(0)?,
        book_id: r.get(1)?,
        source: r.get(2)?,
        text: r.get(3)?,
        original_text: r.get(4)?,
        tag: r.get(5)?,
        spine_href: r.get(6)?,
        chapter_title: r.get(7)?,
        chapter_idx: r.get(8)?,
        cfi: r.get(9)?,
        edited: r.get::<_, i64>(10)? != 0,
        created_at: r.get(11)?,
        updated_at: r.get(12)?,
    })
}

fn get_excerpt(conn: &Connection, id: i64) -> Result<Excerpt> {
    conn.query_row(
        &format!("SELECT {EXCERPT_COLS} FROM excerpt WHERE id=?1"),
        [id],
        excerpt_from_row,
    )
    .optional()?
    .ok_or_else(|| CoreError::NotFound(format!("excerpt {id}")))
}

/// 书摘页数据:每本书的统计 + 全部 active 卡片(已排序)
pub fn library(conn: &Connection) -> Result<ExcerptLibrary> {
    let jobs: HashMap<i64, ExcerptJob> = jobs(conn)?.into_iter().map(|j| (j.book_id, j)).collect();
    let mut st = conn.prepare(
        "SELECT b.id, \
           EXISTS(SELECT 1 FROM spine_item s WHERE s.book_id=b.id), \
           (SELECT k.id FROM knowledge_block k WHERE k.book_id=b.id ORDER BY k.seq, k.id LIMIT 1), \
           (SELECT count(*) FROM excerpt e WHERE e.book_id=b.id AND e.status='active' AND e.source='ai'), \
           (SELECT count(*) FROM excerpt e WHERE e.book_id=b.id AND e.status='active' AND e.source='user') \
         FROM book b ORDER BY b.id",
    )?;
    let rows = st.query_map([], |r| {
        Ok((
            r.get::<_, i64>(0)?,
            r.get::<_, i64>(1)? != 0,
            r.get::<_, Option<i64>>(2)?,
            r.get::<_, i64>(3)?,
            r.get::<_, i64>(4)?,
        ))
    })?;
    let mut books = vec![];
    for row in rows {
        let (book_id, has_text, reader_block_id, ai_count, user_count) = row?;
        books.push(ExcerptBookStats {
            book_id,
            has_text,
            reader_block_id,
            ai_count,
            user_count,
            job: jobs.get(&book_id).cloned(),
        });
    }
    let mut st = conn.prepare(&format!(
        "SELECT {EXCERPT_COLS} FROM excerpt WHERE status='active' \
         ORDER BY book_id, chapter_idx < 0, chapter_idx, char_offset < 0, char_offset, id"
    ))?;
    let excerpts = st
        .query_map([], excerpt_from_row)?
        .collect::<rusqlite::Result<Vec<_>>>()?;
    Ok(ExcerptLibrary { books, excerpts })
}

/// 用户文字的清理:统一换行、每行去首尾空白与连续空格、去空行
fn clean_user_text(text: &str) -> String {
    let unified = text.replace("\r\n", "\n").replace('\r', "\n");
    let lines: Vec<String> = unified
        .lines()
        .map(|l| l.split_whitespace().collect::<Vec<_>>().join(" "))
        .filter(|l| !l.is_empty())
        .collect();
    lines.join("\n")
}

fn validate_user_text(text: &str) -> Result<()> {
    let n = visible_chars(text);
    if n < 2 {
        return Err(CoreError::InvalidInput("书摘至少要两个字".into()));
    }
    if text.chars().count() > USER_TEXT_MAX_CHARS {
        return Err(CoreError::InvalidInput(format!(
            "书摘最多 {USER_TEXT_MAX_CHARS} 字,选短一些再存"
        )));
    }
    Ok(())
}

/// 阅读器 href 对上 spine:先精确,再去掉 #片段,再按路径后缀
fn find_spine<'a>(chapters: &'a [SpineChapter], href: &str) -> Option<&'a SpineChapter> {
    let bare = href.split('#').next().unwrap_or(href);
    chapters
        .iter()
        .find(|c| c.href == href)
        .or_else(|| chapters.iter().find(|c| c.href == bare))
        .or_else(|| {
            chapters.iter().find(|c| {
                !bare.is_empty()
                    && (c.href.ends_with(&format!("/{bare}"))
                        || bare.ends_with(&format!("/{}", c.href)))
            })
        })
}

/// 阅读器存入:同一段文字已在书摘里 → 原样返回(created=false);删过的 → 恢复;否则新建 source=user
pub fn add(conn: &Connection, book_id: i64, input: &NewExcerpt) -> Result<Added> {
    let (_, author, _) = book_meta(conn, book_id)?;
    let text = clean_user_text(&input.text);
    validate_user_text(&text)?;
    let key = norm_key(&text);
    if key.is_empty() {
        return Err(CoreError::InvalidInput("书摘至少要两个字".into()));
    }
    let cfi = input
        .cfi
        .as_deref()
        .map(str::trim)
        .filter(|c| !c.is_empty())
        .map(str::to_string);
    if cfi.as_deref().is_some_and(|c| c.len() > 4000) {
        return Err(CoreError::InvalidInput("cfi too long".into()));
    }
    let chapters = list_spine(conn, book_id)?;
    let tx = Transaction::new_unchecked(conn, TransactionBehavior::Immediate)?;
    let existing: Option<(i64, String)> = tx
        .query_row(
            "SELECT id,status FROM excerpt WHERE book_id=?1 AND norm_key=?2 \
             ORDER BY status='active' DESC, id LIMIT 1",
            rusqlite::params![book_id, key],
            |r| Ok((r.get(0)?, r.get(1)?)),
        )
        .optional()?;
    let ts = now();
    let (id, created) = match existing {
        Some((id, status)) if status == "active" => (id, false),
        Some((id, _)) => {
            tx.execute(
                "UPDATE excerpt SET status='active', cfi=COALESCE(cfi, ?2), updated_at=?3 WHERE id=?1",
                rusqlite::params![id, cfi, ts],
            )?;
            (id, true)
        }
        None => {
            let chapter = find_spine(&chapters, &input.spine_href);
            let (href, title, idx, offset) = match chapter {
                Some(c) => (
                    c.href.clone(),
                    display_chapter_title(&c.title, &c.href),
                    c.idx,
                    find_verbatim(&c.text, &text)
                        .map(|(s, _)| s as i64)
                        .unwrap_or(-1),
                ),
                None => (input.spine_href.clone(), String::new(), -1, -1),
            };
            tx.execute(
                "INSERT INTO excerpt(book_id,source,status,text,original_text,norm_key,tag,spine_href,chapter_title,\
                 chapter_idx,char_offset,cfi,edited,run,created_at,updated_at) \
                 VALUES(?1,'user','active',?2,?2,?3,'',?4,?5,?6,?7,?8,0,0,?9,?9)",
                rusqlite::params![book_id, text, key, href, title, idx, offset, cfi, ts],
            )?;
            (tx.last_insert_rowid(), true)
        }
    };
    tx.commit()?;
    Ok(Added {
        excerpt: get_excerpt(conn, id)?,
        created,
        author,
    })
}

/// 改字:`None` = 恢复原文;改成与原文相同也视为未改
pub fn update_text(conn: &Connection, id: i64, text: Option<&str>) -> Result<Excerpt> {
    let current = get_excerpt(conn, id)?;
    let next = match text {
        None => current.original_text.clone(),
        Some(t) => {
            let cleaned = clean_user_text(t);
            validate_user_text(&cleaned)?;
            cleaned
        }
    };
    let edited = next != current.original_text;
    conn.execute(
        "UPDATE excerpt SET text=?2, edited=?3, updated_at=?4 WHERE id=?1",
        rusqlite::params![id, next, edited as i64, now()],
    )?;
    get_excerpt(conn, id)
}

/// 删除(软删;删过的文字不会被重新整理或存入再建出来,除非用户在阅读器里再次存入)
pub fn remove(conn: &Connection, id: i64) -> Result<()> {
    let changed = conn.execute(
        "UPDATE excerpt SET status='removed', updated_at=?2 WHERE id=?1",
        rusqlite::params![id, now()],
    )?;
    if changed == 0 {
        return Err(CoreError::NotFound(format!("excerpt {id}")));
    }
    Ok(())
}

/// 撤销删除
pub fn restore(conn: &Connection, id: i64) -> Result<Excerpt> {
    let changed = conn.execute(
        "UPDATE excerpt SET status='active', updated_at=?2 WHERE id=?1",
        rusqlite::params![id, now()],
    )?;
    if changed == 0 {
        return Err(CoreError::NotFound(format!("excerpt {id}")));
    }
    get_excerpt(conn, id)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::ai::{AiProvider, CompletionRequest};
    use crate::mapgen::store_spine;
    use std::sync::Mutex;

    const CH1: &str = "# 第一章 工作的意义\n\n驱使人们去工作,是现代社会最早的难题之一。\n\n工作伦理告诉人们:工作本身就是一种美德,不工作则是一种恶。这个信条在工厂的围墙内被一遍遍重复。\n\n其实地上本没有路,走的人多了,也便成了路。\n\n";
    const CH2: &str = "# 第二章 消费美学\n\n消费者社会用诱惑代替了规训。人们不再被要求劳动,而是被邀请去欲望。\n\n穷人不再是“后备劳动力”,而是有缺陷的消费者。\n\n";

    fn padded(text: &str) -> String {
        // 正文须 ≥ 200 字才算正文章(脉络图同一判定)
        format!("{text}{}", "补白。".repeat(80))
    }

    fn setup() -> (Connection, i64) {
        let conn = crate::db::open_in_memory().unwrap();
        let book = crate::models::insert_book(
            &conn,
            "工作、消费主义和新穷人",
            "(英)齐格蒙特·鲍曼",
            BookType::Humanities,
            "poor",
        )
        .unwrap();
        store_spine(
            &conn,
            book,
            &[
                SpineChapter {
                    idx: 0,
                    href: "Text/cover.xhtml".into(),
                    title: "封面".into(),
                    text: "封面".into(),
                },
                SpineChapter {
                    idx: 1,
                    href: "Text/ch1.xhtml".into(),
                    title: "第一章 工作的意义".into(),
                    text: padded(CH1),
                },
                SpineChapter {
                    idx: 2,
                    href: "Text/ch2.xhtml".into(),
                    title: "Text/ch2.xhtml".into(),
                    text: padded(CH2),
                },
            ],
        )
        .unwrap();
        (conn, book)
    }

    /// 按请求 id 后缀应答;记下每次调用的请求 id
    type Reply = Box<dyn Fn(&CompletionRequest, usize) -> crate::Result<String> + Send + Sync>;
    struct Scripted {
        calls: Mutex<Vec<String>>,
        reply: Reply,
    }
    impl Scripted {
        fn new(
            reply: impl Fn(&CompletionRequest, usize) -> crate::Result<String> + Send + Sync + 'static,
        ) -> Self {
            Self {
                calls: Mutex::new(vec![]),
                reply: Box::new(reply),
            }
        }
        fn calls(&self) -> Vec<String> {
            self.calls.lock().unwrap().clone()
        }
    }
    impl AiProvider for Scripted {
        fn complete(&self, req: &CompletionRequest) -> crate::Result<String> {
            let n = {
                let mut calls = self.calls.lock().unwrap();
                calls.push(req.request_id.clone());
                calls.len()
            };
            (self.reply)(req, n)
        }
    }

    fn policy() -> AiPolicy {
        AiPolicy {
            max_transport_retries: 0,
            json_corrective_retries: 1,
            retry_backoff_ms: 0,
        }
    }

    fn good_reply(req: &CompletionRequest, _: usize) -> crate::Result<String> {
        if req.request_id.ends_with(":pick") {
            assert!(req.system.contains("=== 候选 ==="));
            return Ok(
                r#"{"picks":[{"id":"c1","tag":"工作伦理"},{"id":"c2"},{"id":"c3","tag":"消费"}]}"#
                    .into(),
            );
        }
        assert!(req.system.contains("逐字照抄"));
        if req.system.contains("第一章") {
            // 半角逗号/冒号、漏掉句末标点、多一条对不上原文的、一条标题
            Ok(r##"```json
[{"text":"工作伦理告诉人们:工作本身就是一种美德,不工作则是一种恶","tag":"美德","why":"","score":5},
 {"text":"其实地上本没有路,走的人多了,也便成了路。","tag":"路","score":"4"},
 {"text":"这句话书里根本没有,是模型编的。","tag":"编造"},
 {"text":"# 第一章 工作的意义","tag":"标题"}]
```"##
                .into())
        } else {
            Ok(r#"[{"text":"穷人不再是“后备劳动力”,而是有缺陷的消费者","tag":"新穷人","score":4}]"#.into())
        }
    }

    fn run(conn: &Connection, provider: &dyn AiProvider, book: i64) -> crate::Result<ExcerptJob> {
        let dir = std::env::temp_dir();
        run_job(conn, provider, &dir, &policy(), book, &mut |_| {})
    }

    #[test]
    fn loose_json_takes_first_value_when_output_is_duplicated_or_wrapped() {
        let dup = r#"[{"text":"其实地上本没有路"}][{"text":"其实地上本没有路"}]"#;
        let v = parse_json_loose(dup, '[', ']').unwrap();
        assert_eq!(v.as_array().unwrap().len(), 1);
        let wrapped = "好的,下面是结果:\n[{\"text\":\"一句\"}]\n希望有帮助";
        assert_eq!(
            parse_json_loose(wrapped, '[', ']').unwrap()[0]["text"],
            "一句"
        );
        let picks = parse_picks(
            r#"{"picks":["c1"]}{"picks":["c1"]}"#,
            &HashSet::from(["c1"]),
        )
        .unwrap();
        assert_eq!(picks.len(), 1);
        assert!(parse_json_loose("没有 JSON", '[', ']').is_err());
    }

    #[test]
    fn norm_key_ignores_spacing_width_quotes_and_edge_punct() {
        assert_eq!(
            norm_key(" 其实地上本没有路，走的人多了。"),
            norm_key("其实地上本没有路,走的人多了")
        );
        assert_eq!(norm_key("“自由”是什么?"), norm_key("\"自由\"是什么"));
        assert_eq!(norm_key("Hello World."), "helloworld");
        assert_eq!(norm_key("。。"), "");
    }

    #[test]
    fn find_verbatim_maps_back_to_original_and_tolerates_edge_punct() {
        let hay = "前文。工作伦理告诉人们：工作本身就是一种美德。后文";
        let (s, e) = find_verbatim(hay, "工作伦理告诉人们:工作本身就是一种美德").unwrap();
        let got: String = hay.chars().skip(s).take(e - s).collect();
        assert_eq!(got, "工作伦理告诉人们：工作本身就是一种美德");
        // 多了原文没有的句末标点也能找到
        assert!(find_verbatim(hay, "工作本身就是一种美德!").is_some());
        assert!(find_verbatim(hay, "工作本身就是一种恶").is_none());
    }

    #[test]
    fn polish_span_adds_sentence_final_and_closing_quote() {
        let orig: Vec<char> = "他说:“工作是美德。”然后走了。".chars().collect();
        let text: String = orig.iter().collect();
        let (s, e) = find_verbatim(&text, "“工作是美德").unwrap();
        let (s, e) = polish_span(&orig, s, e);
        assert_eq!(orig[s..e].iter().collect::<String>(), "“工作是美德。”");
        // 没有开引号就不带闭引号
        let (s, e) = find_verbatim(&text, "工作是美德").unwrap();
        let (s, e) = polish_span(&orig, s, e);
        assert_eq!(orig[s..e].iter().collect::<String>(), "工作是美德。");
    }

    #[test]
    fn targets_scale_with_text_and_clamp() {
        assert_eq!(target_for(10_000), TARGET_MIN);
        assert_eq!(target_for(60_000), 30);
        assert_eq!(target_for(500_000), TARGET_MAX);
        assert_eq!(per_piece(50, 27_000, 500_000), 6);
        assert_eq!(per_piece(50, 100_000, 100_000), PER_PIECE_MAX);
        assert_eq!(per_piece(12, 1_000, 500_000), PER_PIECE_MIN);
    }

    #[test]
    fn plan_pieces_skips_junk_chapters_and_hides_path_titles() {
        let (conn, book) = setup();
        let chapters = list_spine(&conn, book).unwrap();
        let pieces = plan_pieces(&chapters);
        assert_eq!(pieces.len(), 2, "封面被剔除");
        assert_eq!(pieces[0].title, "第一章 工作的意义");
        assert_eq!(pieces[1].title, "", "路径式标题不显示");
        let index = SpineChapter {
            idx: 9,
            href: "x.xhtml".into(),
            title: "索 引".into(),
            text: "词条".repeat(200),
        };
        assert!(!is_excerpt_source(&index), "「索 引」去空白后命中");
        let refs = SpineChapter {
            title: "References".into(),
            ..index.clone()
        };
        assert!(!is_excerpt_source(&refs));
        let body = SpineChapter {
            title: "第三章 死亡".into(),
            ..index
        };
        assert!(is_excerpt_source(&body));
    }

    #[test]
    fn job_reads_pieces_checks_verbatim_selects_and_stores_original_text() {
        let (conn, book) = setup();
        enqueue(&conn, book, false).unwrap();
        assert_eq!(next_job(&conn).unwrap(), Some(book));
        let provider = Scripted::new(good_reply);
        let mut seen = vec![];
        let dir = std::env::temp_dir();
        let job = run_job(&conn, &provider, &dir, &policy(), book, &mut |j| {
            seen.push((j.stage.clone(), j.next_piece))
        })
        .unwrap();
        assert_eq!(job.stage, "done");
        assert_eq!(job.added, 3);
        assert_eq!(job.total_pieces, 2);
        assert_eq!(seen.last().unwrap().0, "selecting");
        assert_eq!(
            provider.calls(),
            vec![
                format!("excerpt:{book}:r1:p0"),
                format!("excerpt:{book}:r1:p1"),
                format!("excerpt:{book}:r1:pick"),
            ]
        );
        let lib = library(&conn).unwrap();
        let texts: Vec<&str> = lib.excerpts.iter().map(|e| e.text.as_str()).collect();
        // 书中原文(全角标点、补齐句号),按章节与位置排序
        assert_eq!(
            texts,
            vec![
                "工作伦理告诉人们:工作本身就是一种美德,不工作则是一种恶。",
                "其实地上本没有路,走的人多了,也便成了路。",
                "穷人不再是“后备劳动力”,而是有缺陷的消费者。",
            ]
        );
        assert_eq!(lib.excerpts[0].tag, "工作伦理", "精选可改写标签");
        assert_eq!(lib.excerpts[1].tag, "路", "精选没给标签时用候选的");
        assert_eq!(lib.excerpts[0].chapter_title, "第一章 工作的意义");
        assert_eq!(lib.excerpts[2].chapter_title, "");
        assert!(lib
            .excerpts
            .iter()
            .all(|e| e.source == "ai" && !e.edited && e.cfi.is_none()));
        assert_eq!(lib.books[0].ai_count, 3);
        assert_eq!(next_job(&conn).unwrap(), None);
    }

    #[test]
    fn failure_marks_job_and_retry_resumes_without_recalling_done_pieces() {
        let (conn, book) = setup();
        enqueue(&conn, book, false).unwrap();
        let flaky = Scripted::new(|req, _| {
            if req.request_id.ends_with(":p1") {
                Err(CoreError::Ai("timeout after 300s".into()))
            } else {
                good_reply(req, 0)
            }
        });
        assert!(run(&conn, &flaky, book).is_err());
        let job = get_job(&conn, book).unwrap().unwrap();
        assert_eq!(job.stage, "failed");
        assert_eq!(job.next_piece, 1);
        assert!(
            job.error.as_deref().unwrap().contains("超时"),
            "{:?}",
            job.error
        );
        assert_eq!(next_job(&conn).unwrap(), None, "失败的作业不自动重跑");

        let job = enqueue(&conn, book, false).unwrap();
        assert_eq!((job.stage.as_str(), job.run), ("queued", 1));
        let healthy = Scripted::new(good_reply);
        let job = run(&conn, &healthy, book).unwrap();
        assert_eq!(job.stage, "done");
        assert_eq!(
            healthy.calls(),
            vec![
                format!("excerpt:{book}:r1:p1"),
                format!("excerpt:{book}:r1:pick")
            ],
            "第 0 片已完成,不再调用"
        );
        assert_eq!(library(&conn).unwrap().excerpts.len(), 3);
    }

    #[test]
    fn unmatched_piece_gets_one_correction_then_is_skipped() {
        let (conn, book) = setup();
        enqueue(&conn, book, false).unwrap();
        let provider = Scripted::new(|req, _| {
            if req.request_id.ends_with(":pick") {
                Ok(r#"{"picks":["c1"]}"#.into())
            } else if req.system.contains("第一章") {
                Ok(r#"[{"text":"模型凭空写的一句话,书里没有。"}]"#.into())
            } else {
                good_reply(req, 0)
            }
        });
        let job = run(&conn, &provider, book).unwrap();
        assert_eq!(job.stage, "done");
        assert_eq!(job.added, 1);
        let p0 = provider
            .calls()
            .iter()
            .filter(|id| id.ends_with(":p0"))
            .count();
        assert_eq!(p0, 2, "纠错重试一次");
    }

    #[test]
    fn unusable_pick_output_falls_back_to_round_robin_by_score() {
        let (conn, book) = setup();
        enqueue(&conn, book, false).unwrap();
        let provider = Scripted::new(|req, _| {
            if req.request_id.ends_with(":pick") {
                Ok(r#"{"picks":[{"id":"c99"}]}"#.into())
            } else {
                good_reply(req, 0)
            }
        });
        let job = run(&conn, &provider, book).unwrap();
        assert_eq!(job.stage, "done");
        assert_eq!(job.added, 3, "候选不足目标数时兜底全部收下");
    }

    #[test]
    fn regenerate_replaces_untouched_ai_cards_and_never_revives_removed_ones() {
        let (conn, book) = setup();
        enqueue(&conn, book, false).unwrap();
        run(&conn, &Scripted::new(good_reply), book).unwrap();
        let lib = library(&conn).unwrap();
        let (a, b, c) = (lib.excerpts[0].id, lib.excerpts[1].id, lib.excerpts[2].id);
        update_text(&conn, a, Some("工作本身就是一种美德。")).unwrap();
        remove(&conn, b).unwrap();
        let mine = add(
            &conn,
            book,
            &NewExcerpt {
                text: "消费者社会用诱惑代替了规训。".into(),
                spine_href: "Text/ch2.xhtml".into(),
                cfi: Some("epubcfi(/6/6!/4/2,/1:0,/1:14)".into()),
            },
        )
        .unwrap();

        // 正在整理时不能重新整理
        let job = enqueue(&conn, book, true).unwrap();
        assert_eq!((job.run, job.stage.as_str()), (2, "queued"));
        assert!(matches!(
            enqueue(&conn, book, true),
            Err(CoreError::Conflict(_))
        ));
        assert_eq!(
            enqueue(&conn, book, false).unwrap().run,
            2,
            "进行中再入队原样返回"
        );

        run(&conn, &Scripted::new(good_reply), book).unwrap();
        let lib = library(&conn).unwrap();
        let ids: Vec<i64> = lib.excerpts.iter().map(|e| e.id).collect();
        assert!(ids.contains(&a), "改过的保留");
        assert!(ids.contains(&mine.excerpt.id), "手动存的保留");
        assert!(!ids.contains(&c), "没改过的 AI 卡片被替换");
        assert!(
            !lib.excerpts.iter().any(|e| e.text.contains("地上本没有路")),
            "删过的不再出现"
        );
        let fresh: Vec<&Excerpt> = lib
            .excerpts
            .iter()
            .filter(|e| e.source == "ai" && !e.edited)
            .collect();
        assert_eq!(
            fresh.len(),
            1,
            "c3(新穷人)重新插入;c1 与改过的卡片原文相同被跳过"
        );
        assert!(fresh[0].text.contains("有缺陷的消费者"));
    }

    #[test]
    fn spine_change_starts_a_new_run_instead_of_replaying_old_pieces() {
        let (conn, book) = setup();
        enqueue(&conn, book, false).unwrap();
        let fail_pick = Scripted::new(|req, _| {
            if req.request_id.ends_with(":pick") {
                Err(CoreError::Ai("down".into()))
            } else {
                good_reply(req, 0)
            }
        });
        assert!(run(&conn, &fail_pick, book).is_err());
        // 重存 spine:多一章 → 片数变了
        let mut chapters = list_spine(&conn, book).unwrap();
        chapters.push(SpineChapter {
            idx: 3,
            href: "Text/ch3.xhtml".into(),
            title: "第三章".into(),
            text: padded("福利国家的兴衰。"),
        });
        store_spine(&conn, book, &chapters).unwrap();
        enqueue(&conn, book, false).unwrap();
        let provider = Scripted::new(|req, _| {
            if req.system.contains("第三章") {
                Ok("[]".into())
            } else {
                good_reply(req, 0)
            }
        });
        let job = run(&conn, &provider, book).unwrap();
        assert_eq!((job.run, job.total_pieces), (2, 3));
        assert!(provider.calls().iter().all(|id| id.contains(":r2:")));
    }

    #[test]
    fn enqueue_requires_text_and_existing_book() {
        let conn = crate::db::open_in_memory().unwrap();
        let book =
            crate::models::insert_book(&conn, "空书", "", BookType::Textbook, "empty").unwrap();
        assert!(matches!(
            enqueue(&conn, book, false),
            Err(CoreError::InvalidInput(_))
        ));
        assert!(matches!(
            enqueue(&conn, 999, false),
            Err(CoreError::NotFound(_))
        ));
    }

    #[test]
    fn book_without_content_chapters_finishes_with_zero_cards_and_no_ai_call() {
        let conn = crate::db::open_in_memory().unwrap();
        let book =
            crate::models::insert_book(&conn, "薄书", "", BookType::Textbook, "thin").unwrap();
        store_spine(
            &conn,
            book,
            &[SpineChapter {
                idx: 0,
                href: "a.xhtml".into(),
                title: "目录".into(),
                text: "第一章".into(),
            }],
        )
        .unwrap();
        enqueue(&conn, book, false).unwrap();
        let provider = Scripted::new(|_, _| panic!("不应调用 AI"));
        let job = run(&conn, &provider, book).unwrap();
        assert_eq!((job.stage.as_str(), job.added), ("done", 0));
    }

    #[test]
    fn add_from_reader_fills_chapter_dedupes_and_revives_tombstones() {
        let (conn, book) = setup();
        let input = NewExcerpt {
            text: "  其实地上本没有路,\n走的人多了,也便成了路。 ".into(),
            spine_href: "ch1.xhtml#p3".into(),
            cfi: Some("epubcfi(/6/4!/4/8,/1:0,/1:20)".into()),
        };
        let first = add(&conn, book, &input).unwrap();
        assert!(first.created);
        assert_eq!(first.author, "(英)齐格蒙特·鲍曼");
        let e = &first.excerpt;
        assert_eq!(e.source, "user");
        assert_eq!(e.text, "其实地上本没有路,\n走的人多了,也便成了路。");
        assert_eq!(e.spine_href, "Text/ch1.xhtml", "按路径后缀对上 spine");
        assert_eq!(e.chapter_title, "第一章 工作的意义");
        assert_eq!(e.chapter_idx, 1);
        assert_eq!(e.cfi.as_deref(), Some("epubcfi(/6/4!/4/8,/1:0,/1:20)"));

        let again = add(
            &conn,
            book,
            &NewExcerpt {
                cfi: None,
                ..input.clone()
            },
        )
        .unwrap();
        assert!(!again.created, "同一段文字不重复建卡");
        assert_eq!(again.excerpt.id, e.id);

        remove(&conn, e.id).unwrap();
        assert!(library(&conn).unwrap().excerpts.is_empty());
        let revived = add(&conn, book, &input).unwrap();
        assert!(revived.created);
        assert_eq!(revived.excerpt.id, e.id, "删过的恢复,不新建");

        assert!(matches!(
            add(
                &conn,
                book,
                &NewExcerpt {
                    text: "路".into(),
                    ..input.clone()
                }
            ),
            Err(CoreError::InvalidInput(_))
        ));
        assert!(matches!(
            add(
                &conn,
                book,
                &NewExcerpt {
                    text: "长".repeat(USER_TEXT_MAX_CHARS + 1),
                    ..input.clone()
                }
            ),
            Err(CoreError::InvalidInput(_))
        ));
        assert!(matches!(
            add(&conn, 999, &input),
            Err(CoreError::NotFound(_))
        ));
    }

    #[test]
    fn update_text_marks_edited_and_null_restores_original() {
        let (conn, book) = setup();
        let added = add(
            &conn,
            book,
            &NewExcerpt {
                text: "工作伦理告诉人们:工作本身就是一种美德,不工作则是一种恶。".into(),
                spine_href: "Text/ch1.xhtml".into(),
                cfi: None,
            },
        )
        .unwrap();
        let id = added.excerpt.id;
        let edited = update_text(&conn, id, Some("工作本身就是一种美德。")).unwrap();
        assert!(edited.edited);
        assert_eq!(edited.text, "工作本身就是一种美德。");
        assert_eq!(edited.original_text, added.excerpt.original_text);
        let back = update_text(&conn, id, None).unwrap();
        assert!(!back.edited);
        assert_eq!(back.text, added.excerpt.original_text);
        let same = update_text(&conn, id, Some(&added.excerpt.original_text)).unwrap();
        assert!(!same.edited, "改回原文等于没改");
        assert!(matches!(
            update_text(&conn, id, Some(" ")),
            Err(CoreError::InvalidInput(_))
        ));
        assert!(matches!(
            update_text(&conn, 999, None),
            Err(CoreError::NotFound(_))
        ));
    }

    #[test]
    fn remove_and_restore_round_trip() {
        let (conn, book) = setup();
        let id = add(
            &conn,
            book,
            &NewExcerpt {
                text: "消费者社会用诱惑代替了规训。".into(),
                spine_href: "Text/ch2.xhtml".into(),
                cfi: None,
            },
        )
        .unwrap()
        .excerpt
        .id;
        remove(&conn, id).unwrap();
        let lib = library(&conn).unwrap();
        assert!(lib.excerpts.is_empty());
        assert_eq!(lib.books[0].user_count, 0);
        let back = restore(&conn, id).unwrap();
        assert_eq!(back.id, id);
        assert_eq!(library(&conn).unwrap().books[0].user_count, 1);
        assert!(matches!(remove(&conn, 999), Err(CoreError::NotFound(_))));
        assert!(matches!(restore(&conn, 999), Err(CoreError::NotFound(_))));
    }

    #[test]
    fn library_reports_text_reader_block_and_job_per_book() {
        let (conn, book) = setup();
        let other =
            crate::models::insert_book(&conn, "未抽取", "", BookType::Textbook, "staged").unwrap();
        let lib = library(&conn).unwrap();
        let stats: HashMap<i64, &ExcerptBookStats> =
            lib.books.iter().map(|b| (b.book_id, b)).collect();
        assert!(stats[&book].has_text);
        assert!(!stats[&other].has_text);
        assert_eq!(stats[&book].reader_block_id, None, "没有知识块");
        assert!(stats[&book].job.is_none());
        conn.execute(
            "INSERT INTO knowledge_block(book_id,module_name,seq,title,slug) VALUES(?1,'M',2,'b','b'),(?1,'M',1,'a','a')",
            [book],
        )
        .unwrap();
        enqueue(&conn, book, false).unwrap();
        let lib = library(&conn).unwrap();
        let first_block: i64 = conn
            .query_row(
                "SELECT id FROM knowledge_block WHERE book_id=?1 AND seq=1",
                [book],
                |r| r.get(0),
            )
            .unwrap();
        assert_eq!(
            lib.books[0].reader_block_id,
            Some(first_block),
            "按 seq 取首块"
        );
        assert_eq!(lib.books[0].job.as_ref().unwrap().stage, "queued");
        assert_eq!(jobs(&conn).unwrap().len(), 1);
    }

    #[test]
    fn deleting_book_cascades_excerpts_and_job() {
        let (conn, book) = setup();
        enqueue(&conn, book, false).unwrap();
        add(
            &conn,
            book,
            &NewExcerpt {
                text: "消费者社会用诱惑代替了规训。".into(),
                spine_href: "Text/ch2.xhtml".into(),
                cfi: None,
            },
        )
        .unwrap();
        crate::library::delete_book(&conn, book).unwrap();
        let n: i64 = conn
            .query_row(
                "SELECT (SELECT count(*) FROM excerpt)+(SELECT count(*) FROM excerpt_job)",
                [],
                |r| r.get(0),
            )
            .unwrap();
        assert_eq!(n, 0);
    }

    #[test]
    fn pick_prompt_drops_lowest_scores_when_too_long() {
        let pool: Vec<Candidate> = (0..400)
            .map(|i| Candidate {
                id: format!("c{}", i + 1),
                chapter_idx: i,
                href: format!("c{i}.xhtml"),
                chapter_title: format!("第{i}章"),
                text: "长".repeat(PICK_PROMPT_TEXT_CHARS),
                start: 0,
                end: 10,
                tag: "主题".into(),
                why: String::new(),
                score: if i == 7 { 1.0 } else { 4.0 },
            })
            .collect();
        let full = crate::prompts::excerpt_pick_prompt("书", "", 50, &candidate_lines(&pool));
        assert!(full.len() > MAX_PROMPT_BYTES, "构造的候选必须超长");
        let (conn, book) = setup();
        enqueue(&conn, book, false).unwrap();
        let job = get_job(&conn, book).unwrap().unwrap();
        let seen: Mutex<Option<String>> = Mutex::new(None);
        struct Capture<'a>(&'a Mutex<Option<String>>);
        impl AiProvider for Capture<'_> {
            fn complete(&self, req: &CompletionRequest) -> crate::Result<String> {
                *self.0.lock().unwrap() = Some(req.system.clone());
                Ok(r#"{"picks":["c1"]}"#.into())
            }
        }
        let dir = std::env::temp_dir();
        let picks = select(
            &conn,
            &Capture(&seen),
            &dir,
            &policy(),
            &job,
            "书",
            "",
            &pool,
            50,
        )
        .unwrap();
        assert_eq!(
            picks,
            vec![Pick {
                id: "c1".into(),
                tag: String::new()
            }]
        );
        let system = seen.lock().unwrap().clone().unwrap();
        assert!(system.len() <= MAX_PROMPT_BYTES);
        assert!(!system.contains("\nc8 ["), "自评分最低的先被剔除");
    }
}
