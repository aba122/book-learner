//! 脉络图(阅读进度合成图,plan 2026-09-19):按"读到的最新进度",让 AI 把已读内容梳理成
//! 节点-连线图(每书一张);用户可手改并保留。生成用"章/块标题骨架"喂 AI,控 token。
use crate::ai::{AiProvider, CompletionRequest, Role};
use crate::orchestrate::{run_ai_json, AiPolicy};
use crate::{CoreError, Result};
use rusqlite::{Connection, OptionalExtension};
use serde::{Deserialize, Serialize};

pub const LINEAGE_NODES_MAX: usize = 40;
pub const LINEAGE_TIMEOUT_SECS: u64 = 180;

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct LineageNode {
    pub id: String,
    pub title: String,
    #[serde(default)]
    pub summary: String,
    /// 详情(1-3 句,给节点详情框;卡片只放 summary)
    #[serde(default)]
    pub detail: String,
    /// 节点性质(阶段/主题/概念/转折/事件),前端按此配色,可空
    #[serde(default)]
    pub kind: String,
    #[serde(default)]
    pub block_ids: Vec<i64>,
    #[serde(default)]
    pub spine_hrefs: Vec<String>,
    #[serde(default)]
    pub x: Option<f64>,
    #[serde(default)]
    pub y: Option<f64>,
    /// 用户手改过(增量更新时保留,AI 不覆盖)
    #[serde(default)]
    pub user_edited: bool,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct LineageEdge {
    pub from: String,
    pub to: String,
    #[serde(default)]
    pub label: String,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct LineageGraphData {
    #[serde(default)]
    pub nodes: Vec<LineageNode>,
    #[serde(default)]
    pub edges: Vec<LineageEdge>,
}

#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct LineageGraph {
    pub book_id: i64,
    /// 图覆盖到的章节序(spine idx)
    pub up_to_seq: i64,
    /// 当前阅读进度序(> up_to_seq 时前端提示"更新到最新进度")
    pub current_seq: i64,
    /// 对应章节标题(spine_item.title,可空);spine 序号含封面/目录,直接显示序号会误导
    pub up_to_title: String,
    pub current_title: String,
    pub graph: LineageGraphData,
    pub generated_at: Option<String>,
    pub updated_at: String,
}

/// 「看原文」:节点对应的章节与知识块,附首个章节的开头节选
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct NodeSource {
    pub hrefs: Vec<SourceRef>,
    pub blocks: Vec<SourceBlock>,
    pub excerpt: String,
}
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SourceRef {
    pub href: String,
    pub title: String,
}
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SourceBlock {
    pub id: i64,
    pub title: String,
}

pub const LINEAGE_INSTRUCTION_MAX: usize = 2000;

fn fnv(s: &str) -> u64 {
    let mut h: u64 = 0xcbf2_9ce4_8422_2325;
    for b in s.bytes() {
        h ^= b as u64;
        h = h.wrapping_mul(0x0100_0000_01b3);
    }
    h
}

/// 同前缀已有的 ai_request 行数,作请求 id 的尝试号(同 id 已 done 会被重放)
fn attempt(conn: &Connection, prefix: &str) -> Result<i64> {
    Ok(conn.query_row(
        "SELECT count(*) FROM ai_request WHERE request_id LIKE ?1",
        [format!("{prefix}%")],
        |r| r.get(0),
    )?)
}

/// (after, up_to] 范围内的正文章节
fn content_chapters(
    conn: &Connection,
    book_id: i64,
    after: i64,
    up_to: i64,
) -> Result<Vec<crate::mapgen::SpineChapter>> {
    Ok(crate::mapgen::list_spine(conn, book_id)?
        .into_iter()
        .filter(|c| c.idx > after && c.idx <= up_to && is_content_chapter(c))
        .collect())
}

/// 喂 AI 的骨架:章节列表 + 落在这些章节里的知识块
fn skeleton_text(
    conn: &Connection,
    book_id: i64,
    chapters: &[crate::mapgen::SpineChapter],
) -> Result<(String, String)> {
    let hrefs: std::collections::HashSet<&str> = chapters.iter().map(|c| c.href.as_str()).collect();
    let chapters_txt = chapters
        .iter()
        .map(|c| {
            format!(
                "- [{}] {}",
                c.href,
                if c.title.is_empty() {
                    "(无标题章)"
                } else {
                    &c.title
                }
            )
        })
        .collect::<Vec<_>>()
        .join("\n");
    let mut blocks_txt = String::new();
    let blocks = crate::models::list_blocks(conn, book_id)?;
    let mut st = conn.prepare("SELECT DISTINCT spine_href FROM block_anchor WHERE block_id=?1")?;
    for b in &blocks {
        let bh: Vec<String> = st
            .query_map([b.id], |r| r.get(0))?
            .collect::<rusqlite::Result<_>>()?;
        if bh.iter().any(|h| hrefs.contains(h.as_str())) {
            blocks_txt.push_str(&format!("- #{} [{}] {}\n", b.id, b.module_name, b.title));
        }
    }
    Ok((chapters_txt, blocks_txt))
}

fn now() -> String {
    chrono::Utc::now().to_rfc3339_opts(chrono::SecondsFormat::Secs, true)
}

/// 当前阅读进度对应的章节序:position 标记的 spine_href → spine_item.idx(取最大,同 href 可重复);无进度为 0
pub fn progress_seq(conn: &Connection, book_id: i64) -> Result<i64> {
    let href: Option<String> = conn
        .query_row(
            "SELECT spine_href FROM reader_mark WHERE book_id=?1 AND kind='position'",
            [book_id],
            |r| r.get(0),
        )
        .optional()?;
    let Some(href) = href else { return Ok(0) };
    let idx: Option<i64> = conn
        .query_row(
            "SELECT max(idx) FROM spine_item WHERE book_id=?1 AND href=?2",
            rusqlite::params![book_id, href],
            |r| r.get(0),
        )
        .optional()?
        .flatten();
    Ok(idx.unwrap_or(0))
}

fn spine_title(conn: &Connection, book_id: i64, idx: i64) -> Result<String> {
    Ok(conn
        .query_row(
            "SELECT title FROM spine_item WHERE book_id=?1 AND idx=?2",
            rusqlite::params![book_id, idx],
            |r| r.get::<_, String>(0),
        )
        .optional()?
        .unwrap_or_default())
}

/// 封面/书名页/版权页/目录/分部页不是正文:标题命中关键字或正文太短的都不喂给 AI
fn is_content_chapter(c: &crate::mapgen::SpineChapter) -> bool {
    const JUNK: [&str; 8] = [
        "封面",
        "书名页",
        "版权",
        "目录",
        "cover",
        "copyright",
        "contents",
        "toc",
    ];
    let title = c.title.trim().to_lowercase();
    let short = c.text.chars().count() < 200;
    !short && !JUNK.iter().any(|k| title.contains(k))
}

/// 清洗 graph:去空标题节点、id 去重、边只保留两端都存在且非自环的、截到上限;
/// `chain_if_no_edges`:AI 一条边都没给时按节点顺序串成链(手改保存不做)
pub fn clean_graph(mut g: LineageGraphData, chain_if_no_edges: bool) -> LineageGraphData {
    let mut seen = std::collections::HashSet::new();
    let mut i = 0;
    g.nodes.retain_mut(|n| {
        if n.id.trim().is_empty() {
            n.id = format!("n{i}");
        }
        i += 1;
        n.title = n.title.trim().to_string();
        !n.title.is_empty() && seen.insert(n.id.clone())
    });
    if g.nodes.len() > LINEAGE_NODES_MAX {
        g.nodes.truncate(LINEAGE_NODES_MAX);
    }
    let ids: std::collections::HashSet<&str> = g.nodes.iter().map(|n| n.id.as_str()).collect();
    g.edges
        .retain(|e| e.from != e.to && ids.contains(e.from.as_str()) && ids.contains(e.to.as_str()));
    if chain_if_no_edges && g.edges.is_empty() && g.nodes.len() > 1 {
        g.edges = g
            .nodes
            .windows(2)
            .map(|w| LineageEdge {
                from: w[0].id.clone(),
                to: w[1].id.clone(),
                label: String::new(),
            })
            .collect();
    }
    g
}

/// 去围栏、解析并清洗 AI 输出
pub fn parse_graph(text: &str) -> Result<LineageGraphData> {
    let t = text.trim();
    let json = t
        .strip_prefix("```json")
        .or_else(|| t.strip_prefix("```"))
        .and_then(|x| x.strip_suffix("```"))
        .unwrap_or(t)
        .trim();
    let g: LineageGraphData =
        serde_json::from_str(json).map_err(|e| CoreError::Ai(format!("lineage json: {e}")))?;
    Ok(clean_graph(g, true))
}

/// (up_to_seq, graph_json, generated_at, updated_at)
type Row = (i64, String, Option<String>, String);

fn read_row(conn: &Connection, book_id: i64) -> Result<Option<Row>> {
    conn.query_row(
        "SELECT up_to_seq, graph_json, generated_at, updated_at FROM lineage_graph WHERE book_id=?1",
        [book_id],
        |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?, r.get(3)?)),
    )
    .optional()
    .map_err(Into::into)
}

/// 取当前脉络图(无则 None);current_seq 为最新阅读进度
pub fn get(conn: &Connection, book_id: i64) -> Result<Option<LineageGraph>> {
    let current_seq = progress_seq(conn, book_id)?;
    let Some((up_to_seq, json, generated_at, updated_at)) = read_row(conn, book_id)? else {
        return Ok(None);
    };
    let graph = serde_json::from_str(&json).unwrap_or_default();
    Ok(Some(LineageGraph {
        book_id,
        up_to_seq,
        current_seq,
        up_to_title: spine_title(conn, book_id, up_to_seq)?,
        current_title: spine_title(conn, book_id, current_seq)?,
        graph,
        generated_at,
        updated_at,
    }))
}

fn upsert(
    conn: &Connection,
    book_id: i64,
    up_to_seq: i64,
    graph: &LineageGraphData,
    set_generated: bool,
) -> Result<()> {
    let json =
        serde_json::to_string(graph).unwrap_or_else(|_| "{\"nodes\":[],\"edges\":[]}".into());
    let ts = now();
    let existing: Option<i64> = conn
        .query_row(
            "SELECT id FROM lineage_graph WHERE book_id=?1",
            [book_id],
            |r| r.get(0),
        )
        .optional()?;
    match existing {
        Some(_) if set_generated => {
            conn.execute(
                "UPDATE lineage_graph SET up_to_seq=?2, graph_json=?3, generated_at=?4, updated_at=?4 WHERE book_id=?1",
                rusqlite::params![book_id, up_to_seq, json, ts],
            )?;
        }
        Some(_) => {
            conn.execute(
                "UPDATE lineage_graph SET up_to_seq=?2, graph_json=?3, updated_at=?4 WHERE book_id=?1",
                rusqlite::params![book_id, up_to_seq, json, ts],
            )?;
        }
        None => {
            conn.execute(
                "INSERT INTO lineage_graph(book_id,up_to_seq,graph_json,generated_at,updated_at) VALUES(?1,?2,?3,?4,?4)",
                rusqlite::params![book_id, up_to_seq, json, ts],
            )?;
        }
    }
    // 投影到 _lineage.md:op_id 带内容哈希——同内容幂等,不同内容不被 INSERT OR IGNORE 吞
    crate::projection::enqueue(
        conn,
        &format!("lineage:{book_id}:h{:x}:sync_lineage", fnv(&json)),
        "sync_lineage",
        &serde_json::json!({ "book_id": book_id }),
    )?;
    Ok(())
}

/// 用户手改保存:原样持久化前端传来的 graph(节点 x/y、改名、增删、连线;前端给改过的节点置 userEdited)
pub fn save(conn: &Connection, book_id: i64, graph: &LineageGraphData) -> Result<LineageGraph> {
    crate::models::get_book_slug_type(conn, book_id)?;
    let up_to_seq = read_row(conn, book_id)?.map(|r| r.0).unwrap_or(0);
    let graph = clean_graph(graph.clone(), false);
    upsert(conn, book_id, up_to_seq, &graph, false)?;
    Ok(get(conn, book_id)?.expect("just saved"))
}

/// 生成到当前进度:用已读章节标题 + 该范围知识块标题作骨架喂 AI,得到 graph
pub fn generate(
    conn: &Connection,
    provider: &dyn AiProvider,
    workdir: &std::path::Path,
    policy: &AiPolicy,
    book_id: i64,
) -> Result<LineageGraph> {
    if !conn.is_autocommit() {
        return Err(CoreError::Other(
            "generate must not run inside a transaction".into(),
        ));
    }
    let (_, book_type) = crate::models::get_book_slug_type(conn, book_id)?;
    let title: String = conn.query_row("SELECT title FROM book WHERE id=?1", [book_id], |r| {
        r.get(0)
    })?;
    let up_to = progress_seq(conn, book_id)?;
    let read = content_chapters(conn, book_id, -1, up_to)?;
    if read.is_empty() {
        return Err(CoreError::InvalidInput("先阅读一部分再生成脉络图".into()));
    }
    let (chapters_txt, blocks_txt) = skeleton_text(conn, book_id, &read)?;
    let system =
        crate::prompts::lineage_generate_prompt(&title, book_type, &chapters_txt, &blocks_txt);
    let req = CompletionRequest {
        system,
        messages: vec![(Role::User, "请生成脉络图 JSON。".into())],
        workdir: workdir.to_path_buf(),
        read_only: true,
        request_id: String::new(),
        timeout_secs: LINEAGE_TIMEOUT_SECS,
    };
    // 请求 id 按尝试次数递增:ai_request 以 request_id 为主键,同 id 已 done 会直接重放旧结果,
    // 「重新生成」在同一进度下就永远拿不到新图(Mac 实测发现)
    let attempt = attempt(conn, &format!("lineage:{book_id}:s{up_to}"))?;
    let graph = run_ai_json(
        conn,
        provider,
        &format!("lineage:{book_id}:s{up_to}:r{attempt}"),
        "lineage",
        &req,
        policy,
        &parse_graph,
    )?;
    upsert(conn, book_id, up_to, &graph, true)?;
    Ok(get(conn, book_id)?.expect("just generated"))
}

/// 增量更新到最新进度(第二批):旧图 + 新读章节喂 AI,合并时 **userEdited 节点原样保留**
/// (AI 删了也补回,触及它们的旧边也保留)。进度没前进 → InvalidInput;新进度里没有正文章 → 只推进 up_to_seq。
pub fn update(
    conn: &Connection,
    provider: &dyn AiProvider,
    workdir: &std::path::Path,
    policy: &AiPolicy,
    book_id: i64,
) -> Result<LineageGraph> {
    if !conn.is_autocommit() {
        return Err(CoreError::Other(
            "update must not run inside a transaction".into(),
        ));
    }
    let (_, book_type) = crate::models::get_book_slug_type(conn, book_id)?;
    let title: String = conn.query_row("SELECT title FROM book WHERE id=?1", [book_id], |r| {
        r.get(0)
    })?;
    let Some((old_up_to, old_json, _, _)) = read_row(conn, book_id)? else {
        return Err(CoreError::InvalidInput("先生成脉络图".into()));
    };
    let old: LineageGraphData = serde_json::from_str(&old_json).unwrap_or_default();
    let new_up_to = progress_seq(conn, book_id)?;
    if new_up_to <= old_up_to {
        return Err(CoreError::InvalidInput("脉络图已是最新进度".into()));
    }
    let fresh = content_chapters(conn, book_id, old_up_to, new_up_to)?;
    if fresh.is_empty() {
        upsert(conn, book_id, new_up_to, &old, false)?;
        return Ok(get(conn, book_id)?.expect("just updated"));
    }
    let (chapters_txt, blocks_txt) = skeleton_text(conn, book_id, &fresh)?;
    let system = crate::prompts::lineage_update_prompt(
        &title,
        book_type,
        &serde_json::to_string(&old).unwrap_or_default(),
        &chapters_txt,
        &blocks_txt,
    );
    let req = CompletionRequest {
        system,
        messages: vec![(Role::User, "请输出更新后的完整脉络图 JSON。".into())],
        workdir: workdir.to_path_buf(),
        read_only: true,
        request_id: String::new(),
        timeout_secs: LINEAGE_TIMEOUT_SECS,
    };
    let attempt = attempt(conn, &format!("lineage_update:{book_id}:s{new_up_to}"))?;
    let fresh_graph = run_ai_json(
        conn,
        provider,
        &format!("lineage_update:{book_id}:s{new_up_to}:r{attempt}"),
        "lineage",
        &req,
        policy,
        &parse_graph,
    )?;
    let merged = merge_preserving(&old, fresh_graph);
    upsert(conn, book_id, new_up_to, &merged, true)?;
    Ok(get(conn, book_id)?.expect("just updated"))
}

/// 合并:旧图里 userEdited 的节点整体覆盖新图同 id 节点;被 AI 删掉的补回原位;
/// 触及这些节点的旧边(两端仍存在)也保留。
pub fn merge_preserving(old: &LineageGraphData, fresh: LineageGraphData) -> LineageGraphData {
    let mut out = fresh;
    for (i, on) in old.nodes.iter().enumerate() {
        if !on.user_edited {
            continue;
        }
        match out.nodes.iter().position(|n| n.id == on.id) {
            Some(p) => out.nodes[p] = on.clone(),
            None => out.nodes.insert(i.min(out.nodes.len()), on.clone()),
        }
    }
    let ids: std::collections::HashSet<&str> = out.nodes.iter().map(|n| n.id.as_str()).collect();
    for e in &old.edges {
        let touches = old
            .nodes
            .iter()
            .any(|n| n.user_edited && (n.id == e.from || n.id == e.to));
        if touches
            && ids.contains(e.from.as_str())
            && ids.contains(e.to.as_str())
            && !out.edges.iter().any(|x| x.from == e.from && x.to == e.to)
        {
            out.edges.push(e.clone());
        }
    }
    clean_graph(out, false)
}

/// AI 按读者的理解修正(第二批):现图 + 指令(可聚焦某节点)→ 完整新图;
/// 内容有变或新增的节点标 userEdited(读者要求的修正,增量更新时保留),其余节点沿用旧标记与坐标。
pub fn revise(
    conn: &Connection,
    provider: &dyn AiProvider,
    workdir: &std::path::Path,
    policy: &AiPolicy,
    book_id: i64,
    node_id: Option<&str>,
    instruction: &str,
) -> Result<LineageGraph> {
    if !conn.is_autocommit() {
        return Err(CoreError::Other(
            "revise must not run inside a transaction".into(),
        ));
    }
    let instruction = instruction.trim();
    if instruction.is_empty() || instruction.chars().count() > LINEAGE_INSTRUCTION_MAX {
        return Err(CoreError::InvalidInput("修正要求为空或过长".into()));
    }
    crate::models::get_book_slug_type(conn, book_id)?;
    let title: String = conn.query_row("SELECT title FROM book WHERE id=?1", [book_id], |r| {
        r.get(0)
    })?;
    let Some((up_to, old_json, _, _)) = read_row(conn, book_id)? else {
        return Err(CoreError::InvalidInput("先生成脉络图".into()));
    };
    let old: LineageGraphData = serde_json::from_str(&old_json).unwrap_or_default();
    let focus = match node_id {
        Some(id) => Some(
            old.nodes
                .iter()
                .find(|n| n.id == id)
                .map(|n| n.title.clone())
                .ok_or_else(|| CoreError::NotFound(format!("lineage node {id}")))?,
        ),
        None => None,
    };
    let system = crate::prompts::lineage_revise_prompt(
        &title,
        &serde_json::to_string(&old).unwrap_or_default(),
        focus.as_deref(),
        instruction,
    );
    let req = CompletionRequest {
        system,
        messages: vec![(Role::User, "请输出修正后的完整脉络图 JSON。".into())],
        workdir: workdir.to_path_buf(),
        read_only: true,
        request_id: String::new(),
        timeout_secs: LINEAGE_TIMEOUT_SECS,
    };
    let attempt = attempt(conn, &format!("lineage_revise:{book_id}"))?;
    let mut fresh = run_ai_json(
        conn,
        provider,
        &format!("lineage_revise:{book_id}:r{attempt}"),
        "lineage",
        &req,
        policy,
        &parse_graph,
    )?;
    for n in &mut fresh.nodes {
        let same = old.nodes.iter().find(|o| {
            o.id == n.id
                && o.title == n.title
                && o.summary == n.summary
                && o.detail == n.detail
                && o.kind == n.kind
        });
        match same {
            Some(o) => {
                n.user_edited = o.user_edited;
                n.x = o.x;
                n.y = o.y;
            }
            None => n.user_edited = true,
        }
    }
    upsert(conn, book_id, up_to, &fresh, false)?;
    Ok(get(conn, book_id)?.expect("just revised"))
}

/// 「看原文」:节点的章节(带标题)与知识块(带标题),附首章开头 600 字节选
pub fn node_source(conn: &Connection, book_id: i64, node_id: &str) -> Result<NodeSource> {
    let Some(g) = get(conn, book_id)? else {
        return Err(CoreError::InvalidInput("先生成脉络图".into()));
    };
    let node = g
        .graph
        .nodes
        .iter()
        .find(|n| n.id == node_id)
        .ok_or_else(|| CoreError::NotFound(format!("lineage node {node_id}")))?;
    let spine = crate::mapgen::list_spine(conn, book_id)?;
    let hrefs: Vec<SourceRef> = node
        .spine_hrefs
        .iter()
        .filter_map(|h| spine.iter().find(|c| &c.href == h))
        .map(|c| SourceRef {
            href: c.href.clone(),
            title: c.title.clone(),
        })
        .collect();
    let blocks: Vec<SourceBlock> = node
        .block_ids
        .iter()
        .filter_map(|id| crate::models::get_block(conn, *id).ok())
        .map(|b| SourceBlock {
            id: b.id,
            title: b.title,
        })
        .collect();
    let excerpt = hrefs
        .first()
        .and_then(|r| spine.iter().find(|c| c.href == r.href))
        .map(|c| {
            let t = c.text.split_whitespace().collect::<Vec<_>>().join(" ");
            let cut: String = t.chars().take(600).collect();
            if cut.chars().count() < t.chars().count() {
                format!("{cut}…")
            } else {
                cut
            }
        })
        .unwrap_or_default();
    Ok(NodeSource {
        hrefs,
        blocks,
        excerpt,
    })
}

/// 脉络图的 Markdown 视图(`_lineage.md` 与导出共用):按阅读顺序列节点,再列关系
pub fn render_markdown(book_title: &str, up_to_title: &str, g: &LineageGraphData) -> String {
    let title_of = |id: &str| -> String {
        g.nodes
            .iter()
            .find(|n| n.id == id)
            .map(|n| n.title.clone())
            .unwrap_or_else(|| id.to_string())
    };
    let covered = if up_to_title.trim().is_empty() {
        "(未知章节)"
    } else {
        up_to_title
    };
    let mut out =
        format!("# 《{book_title}》阅读脉络图\n\n覆盖到:{covered}\n\n## 脉络(按阅读顺序)\n\n");
    for (i, n) in g.nodes.iter().enumerate() {
        let kind = if n.kind.is_empty() {
            String::new()
        } else {
            format!("({})", n.kind)
        };
        let edited = if n.user_edited { " ✎" } else { "" };
        out.push_str(&format!("{}. **{}**{kind}{edited}", i + 1, n.title));
        if !n.summary.is_empty() {
            out.push_str(&format!(" — {}", n.summary));
        }
        out.push('\n');
        if !n.detail.is_empty() {
            out.push_str(&format!("   {}\n", n.detail));
        }
    }
    out.push_str("\n## 关系\n\n");
    for e in &g.edges {
        let label = if e.label.is_empty() {
            "→".to_string()
        } else {
            format!("→({})", e.label)
        };
        out.push_str(&format!(
            "- {} {label} {}\n",
            title_of(&e.from),
            title_of(&e.to)
        ));
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::ai::{AiProvider, CompletionRequest};
    use crate::mapgen::{store_spine, SpineChapter};
    use std::sync::Mutex;

    struct Script(Mutex<Vec<crate::Result<String>>>);
    impl AiProvider for Script {
        fn complete(&self, req: &CompletionRequest) -> crate::Result<String> {
            assert!(req.system.contains("脉络图"), "system 应为脉络图 prompt");
            self.0.lock().unwrap().remove(0)
        }
    }
    fn policy() -> AiPolicy {
        AiPolicy {
            max_transport_retries: 0,
            json_corrective_retries: 0,
            retry_backoff_ms: 0,
        }
    }
    fn setup() -> (Connection, i64) {
        let conn = crate::db::open_in_memory().unwrap();
        let book = crate::models::insert_book(
            &conn,
            "工作与新穷人",
            "",
            crate::models::BookType::Humanities,
            "poor",
        )
        .unwrap();
        let chapters: Vec<SpineChapter> = (0..4)
            .map(|i| SpineChapter {
                idx: i,
                href: format!("ch{i}.xhtml"),
                title: format!("第{i}章"),
                text: "正文".repeat(120),
            })
            .collect();
        store_spine(&conn, book, &chapters).unwrap();
        (conn, book)
    }
    const GRAPH: &str = r#"{"nodes":[{"id":"a","title":"生产者社会","summary":"以工作定义身份","spineHrefs":["ch0.xhtml"]},{"id":"b","title":"消费者社会","summary":"以消费定义身份"},{"id":"x","title":""}],"edges":[{"from":"a","to":"b","label":"转向"},{"from":"a","to":"zzz","label":"悬空"}]}"#;

    #[test]
    fn progress_seq_from_position() {
        let (conn, book) = setup();
        assert_eq!(progress_seq(&conn, book).unwrap(), 0, "无位置为0");
        crate::reader_marks::set_position(&conn, book, "ch2.xhtml", "epubcfi(/6/6!/4/2)").unwrap();
        assert_eq!(progress_seq(&conn, book).unwrap(), 2);
    }

    #[test]
    fn parse_graph_cleans_empty_nodes_and_dangling_edges() {
        let g = parse_graph(&format!("```json\n{GRAPH}\n```")).unwrap();
        assert_eq!(
            g.nodes.iter().map(|n| n.id.as_str()).collect::<Vec<_>>(),
            vec!["a", "b"],
            "空标题节点被删"
        );
        assert_eq!(g.edges.len(), 1, "悬空边被删");
        assert_eq!(g.edges[0].label, "转向");
    }

    #[test]
    fn generate_stores_graph_and_get_reports_progress() {
        let (conn, book) = setup();
        crate::reader_marks::set_position(&conn, book, "ch1.xhtml", "epubcfi(/6/4!/4/2)").unwrap();
        let p = Script(Mutex::new(vec![Ok(GRAPH.into())]));
        let g = generate(&conn, &p, std::path::Path::new("."), &policy(), book).unwrap();
        assert_eq!(g.up_to_seq, 1);
        assert_eq!(g.graph.nodes.len(), 2);
        assert!(g.generated_at.is_some());
        // 读到更后面 → get 的 current_seq 大于 up_to_seq(前端据此提示更新)
        crate::reader_marks::set_position(&conn, book, "ch3.xhtml", "epubcfi(/6/8!/4/2)").unwrap();
        let got = get(&conn, book).unwrap().unwrap();
        assert_eq!(got.up_to_seq, 1);
        assert_eq!(got.current_seq, 3);
    }

    #[test]
    fn generate_refuses_without_progress_when_no_chapters_read() {
        let conn = crate::db::open_in_memory().unwrap();
        let book = crate::models::insert_book(
            &conn,
            "空书",
            "",
            crate::models::BookType::Humanities,
            "empty",
        )
        .unwrap();
        let p = Script(Mutex::new(vec![]));
        assert!(matches!(
            generate(&conn, &p, std::path::Path::new("."), &policy(), book).unwrap_err(),
            CoreError::InvalidInput(_)
        ));
    }

    #[test]
    fn save_persists_user_edits_and_keeps_up_to_seq() {
        let (conn, book) = setup();
        crate::reader_marks::set_position(&conn, book, "ch1.xhtml", "epubcfi(/6/4!/4/2)").unwrap();
        let p = Script(Mutex::new(vec![Ok(GRAPH.into())]));
        generate(&conn, &p, std::path::Path::new("."), &policy(), book).unwrap();
        let mut g = get(&conn, book).unwrap().unwrap().graph;
        g.nodes[0].title = "我改的标题".into();
        g.nodes[0].user_edited = true;
        g.nodes[0].x = Some(120.0);
        save(&conn, book, &g).unwrap();
        let after = get(&conn, book).unwrap().unwrap();
        assert_eq!(after.up_to_seq, 1, "保存不动 up_to_seq");
        assert_eq!(after.graph.nodes[0].title, "我改的标题");
        assert!(after.graph.nodes[0].user_edited);
        assert_eq!(after.graph.nodes[0].x, Some(120.0));
    }

    /// 记住最后一次 system prompt 的 provider
    struct Capture(Mutex<Option<String>>, String);
    impl AiProvider for Capture {
        fn complete(&self, req: &CompletionRequest) -> crate::Result<String> {
            *self.0.lock().unwrap() = Some(req.system.clone());
            Ok(self.1.clone())
        }
    }

    #[test]
    fn generate_skips_cover_and_short_pages_in_prompt() {
        let conn = crate::db::open_in_memory().unwrap();
        let book = crate::models::insert_book(
            &conn,
            "书",
            "",
            crate::models::BookType::Humanities,
            "cover-book",
        )
        .unwrap();
        let chapters = vec![
            SpineChapter {
                idx: 0,
                href: "cover.xhtml".into(),
                title: "封面".into(),
                text: "x".into(),
            },
            SpineChapter {
                idx: 1,
                href: "toc.xhtml".into(),
                title: "目录".into(),
                text: "正文".repeat(200),
            },
            SpineChapter {
                idx: 2,
                href: "part.xhtml".into(),
                title: "第一部分".into(),
                text: "短".into(),
            },
            SpineChapter {
                idx: 3,
                href: "c1.xhtml".into(),
                title: "第一章 工作伦理".into(),
                text: "正文".repeat(200),
            },
        ];
        store_spine(&conn, book, &chapters).unwrap();
        crate::reader_marks::set_position(&conn, book, "c1.xhtml", "epubcfi(/6/8!/4/2)").unwrap();
        let p = Capture(Mutex::new(None), GRAPH.into());
        generate(&conn, &p, std::path::Path::new("."), &policy(), book).unwrap();
        let sys = p.0.lock().unwrap().clone().unwrap();
        assert!(sys.contains("第一章 工作伦理"));
        for junk in ["封面", "cover.xhtml", "toc.xhtml", "part.xhtml"] {
            assert!(
                !sys.contains(&format!("[{junk}]")) && !sys.contains(&format!("] {junk}")),
                "{junk} 不该进 prompt: {sys}"
            );
        }
        // 只读到封面 → 没有正文章 → 拒绝
        crate::reader_marks::set_position(&conn, book, "cover.xhtml", "epubcfi(/6/2!/4/2)")
            .unwrap();
        assert!(matches!(
            generate(&conn, &p, std::path::Path::new("."), &policy(), book).unwrap_err(),
            CoreError::InvalidInput(_)
        ));
    }

    #[test]
    fn get_reports_chapter_titles_for_progress() {
        let (conn, book) = setup();
        crate::reader_marks::set_position(&conn, book, "ch1.xhtml", "epubcfi(/6/4!/4/2)").unwrap();
        let p = Script(Mutex::new(vec![Ok(GRAPH.into())]));
        let g = generate(&conn, &p, std::path::Path::new("."), &policy(), book).unwrap();
        assert_eq!(g.up_to_title, "第1章");
        crate::reader_marks::set_position(&conn, book, "ch3.xhtml", "epubcfi(/6/8!/4/2)").unwrap();
        let got = get(&conn, book).unwrap().unwrap();
        assert_eq!(
            (got.up_to_title.as_str(), got.current_title.as_str()),
            ("第1章", "第3章")
        );
    }

    #[test]
    fn parse_graph_chains_nodes_when_ai_gives_no_edges() {
        let g = parse_graph(r#"{"nodes":[{"id":"a","title":"甲"},{"id":"b","title":"乙"},{"id":"c","title":"丙"}],"edges":[]}"#).unwrap();
        assert_eq!(g.edges.len(), 2);
        assert_eq!(
            (g.edges[0].from.as_str(), g.edges[0].to.as_str()),
            ("a", "b")
        );
        assert_eq!(
            (g.edges[1].from.as_str(), g.edges[1].to.as_str()),
            ("b", "c")
        );
    }

    #[test]
    fn save_cleans_empty_titles_but_does_not_chain() {
        let (conn, book) = setup();
        let data = LineageGraphData {
            nodes: vec![
                LineageNode {
                    id: "a".into(),
                    title: "甲".into(),
                    ..Default::default()
                },
                LineageNode {
                    id: "b".into(),
                    title: "  ".into(),
                    ..Default::default()
                },
                LineageNode {
                    id: "c".into(),
                    title: "丙".into(),
                    ..Default::default()
                },
            ],
            edges: vec![LineageEdge {
                from: "a".into(),
                to: "b".into(),
                label: String::new(),
            }],
        };
        let saved = save(&conn, book, &data).unwrap();
        assert_eq!(
            saved
                .graph
                .nodes
                .iter()
                .map(|n| n.id.as_str())
                .collect::<Vec<_>>(),
            vec!["a", "c"]
        );
        assert!(
            saved.graph.edges.is_empty(),
            "指向被删节点的边去掉;手改保存不自动串链"
        );
    }

    #[test]
    fn regenerate_at_same_progress_calls_ai_again_instead_of_replaying() {
        let (conn, book) = setup();
        crate::reader_marks::set_position(&conn, book, "ch1.xhtml", "epubcfi(/6/4!/4/2)").unwrap();
        let second = r#"{"nodes":[{"id":"z","title":"第二次生成的图"}],"edges":[]}"#;
        let p = Script(Mutex::new(vec![Ok(GRAPH.into()), Ok(second.into())]));
        let g1 = generate(&conn, &p, std::path::Path::new("."), &policy(), book).unwrap();
        assert_eq!(g1.graph.nodes.len(), 2);
        let g2 = generate(&conn, &p, std::path::Path::new("."), &policy(), book).unwrap();
        assert_eq!(
            g2.graph.nodes[0].title, "第二次生成的图",
            "同进度重生成不该重放旧结果"
        );
        assert!(p.0.lock().unwrap().is_empty(), "两次都真的调了 provider");
        let ids: Vec<String> = conn
            .prepare("SELECT request_id FROM ai_request WHERE request_id LIKE 'lineage:%' ORDER BY request_id")
            .unwrap()
            .query_map([], |r| r.get(0))
            .unwrap()
            .collect::<rusqlite::Result<_>>()
            .unwrap();
        assert_eq!(
            ids,
            vec![
                format!("lineage:{book}:s1:r0"),
                format!("lineage:{book}:s1:r1")
            ]
        );
    }

    fn nodes(ids: &[(&str, &str, bool)]) -> Vec<LineageNode> {
        ids.iter()
            .map(|(id, title, edited)| LineageNode {
                id: id.to_string(),
                title: title.to_string(),
                user_edited: *edited,
                ..Default::default()
            })
            .collect()
    }
    fn edge(from: &str, to: &str) -> LineageEdge {
        LineageEdge {
            from: from.into(),
            to: to.into(),
            label: String::new(),
        }
    }

    #[test]
    fn merge_preserving_keeps_user_edited_nodes_and_their_edges() {
        let old = LineageGraphData {
            nodes: nodes(&[("a", "甲", false), ("b", "我改的", true), ("c", "丙", true)]),
            edges: vec![edge("a", "b"), edge("b", "c")],
        };
        // AI:改了 b 的标题、删了 c、加了 d
        let fresh = LineageGraphData {
            nodes: nodes(&[
                ("a", "甲2", false),
                ("b", "AI改的", false),
                ("d", "丁", false),
            ]),
            edges: vec![edge("a", "b"), edge("b", "d")],
        };
        let m = merge_preserving(&old, fresh);
        let t = |id: &str| m.nodes.iter().find(|n| n.id == id).map(|n| n.title.clone());
        assert_eq!(t("b").as_deref(), Some("我改的"), "手改节点整体覆盖");
        assert_eq!(t("c").as_deref(), Some("丙"), "被 AI 删的手改节点补回");
        assert_eq!(t("a").as_deref(), Some("甲2"), "未手改的节点采用 AI 版本");
        assert_eq!(
            m.nodes.iter().map(|n| n.id.as_str()).collect::<Vec<_>>(),
            vec!["a", "b", "c", "d"],
            "补回原位"
        );
        assert!(
            m.edges.iter().any(|e| e.from == "b" && e.to == "c"),
            "触及手改节点的旧边保留"
        );
        assert!(m.edges.iter().any(|e| e.from == "b" && e.to == "d"));
        assert!(m.nodes.iter().find(|n| n.id == "b").unwrap().user_edited);
    }

    #[test]
    fn update_refuses_when_not_behind_and_merges_when_behind() {
        let (conn, book) = setup();
        crate::reader_marks::set_position(&conn, book, "ch1.xhtml", "epubcfi(/6/4!/4/2)").unwrap();
        let p = Script(Mutex::new(vec![Ok(GRAPH.into())]));
        generate(&conn, &p, std::path::Path::new("."), &policy(), book).unwrap();
        // 没往后读 → 拒绝
        let p2 = Script(Mutex::new(vec![]));
        assert!(matches!(
            update(&conn, &p2, std::path::Path::new("."), &policy(), book).unwrap_err(),
            CoreError::InvalidInput(_)
        ));
        // 手改 a,再读到 ch3
        let mut data = get(&conn, book).unwrap().unwrap().graph;
        data.nodes[0].title = "我改的".into();
        data.nodes[0].user_edited = true;
        save(&conn, book, &data).unwrap();
        crate::reader_marks::set_position(&conn, book, "ch3.xhtml", "epubcfi(/6/8!/4/2)").unwrap();
        let fresh = r#"{"nodes":[{"id":"a","title":"AI 想改掉","summary":""},{"id":"b","title":"消费者社会"},{"id":"c","title":"新穷人"}],"edges":[{"from":"a","to":"b","label":""},{"from":"b","to":"c","label":"引出"}]}"#;
        let p3 = Capture(Mutex::new(None), fresh.into());
        let g = update(&conn, &p3, std::path::Path::new("."), &policy(), book).unwrap();
        assert_eq!(g.up_to_seq, 3);
        assert_eq!(g.graph.nodes[0].title, "我改的", "增量更新保留手改");
        assert_eq!(g.graph.nodes.len(), 3);
        let sys = p3.0.lock().unwrap().clone().unwrap();
        assert!(
            sys.contains("第2章") && sys.contains("第3章") && !sys.contains("] 第1章"),
            "只喂新读章节: {sys}"
        );
        assert!(
            sys.contains("\"userEdited\":true"),
            "旧图连同手改标记一起给 AI"
        );
    }

    #[test]
    fn revise_marks_changed_nodes_and_validates_input() {
        let (conn, book) = setup();
        crate::reader_marks::set_position(&conn, book, "ch1.xhtml", "epubcfi(/6/4!/4/2)").unwrap();
        let p = Script(Mutex::new(vec![Ok(GRAPH.into())]));
        generate(&conn, &p, std::path::Path::new("."), &policy(), book).unwrap();
        let p0 = Script(Mutex::new(vec![]));
        assert!(matches!(
            revise(
                &conn,
                &p0,
                std::path::Path::new("."),
                &policy(),
                book,
                None,
                "  "
            )
            .unwrap_err(),
            CoreError::InvalidInput(_)
        ));
        assert!(matches!(
            revise(
                &conn,
                &p0,
                std::path::Path::new("."),
                &policy(),
                book,
                Some("nope"),
                "改"
            )
            .unwrap_err(),
            CoreError::NotFound(_)
        ));
        let fresh = r#"{"nodes":[{"id":"a","title":"生产者社会","summary":"以工作定义身份","spineHrefs":["ch0.xhtml"]},{"id":"b","title":"消费社会(改)","summary":"以消费定义身份"}],"edges":[{"from":"a","to":"b","label":"转向"}]}"#;
        let p1 = Capture(Mutex::new(None), fresh.into());
        let g = revise(
            &conn,
            &p1,
            std::path::Path::new("."),
            &policy(),
            book,
            Some("b"),
            "把 b 改得更准确",
        )
        .unwrap();
        assert!(!g.graph.nodes[0].user_edited, "没变的节点不标");
        assert!(g.graph.nodes[1].user_edited, "改了的节点标 userEdited");
        assert_eq!(g.up_to_seq, 1, "修正不动进度");
        let sys = p1.0.lock().unwrap().clone().unwrap();
        assert!(sys.contains("《消费者社会》") && sys.contains("把 b 改得更准确"));
    }

    #[test]
    fn node_source_lists_chapters_blocks_and_excerpt() {
        let (conn, book) = setup();
        crate::reader_marks::set_position(&conn, book, "ch1.xhtml", "epubcfi(/6/4!/4/2)").unwrap();
        let p = Script(Mutex::new(vec![Ok(GRAPH.into())]));
        generate(&conn, &p, std::path::Path::new("."), &policy(), book).unwrap();
        let src = node_source(&conn, book, "a").unwrap();
        assert_eq!(src.hrefs.len(), 1);
        assert_eq!(
            (src.hrefs[0].href.as_str(), src.hrefs[0].title.as_str()),
            ("ch0.xhtml", "第0章")
        );
        assert!(src.excerpt.starts_with("正文正文"));
        assert!(matches!(
            node_source(&conn, book, "zzz").unwrap_err(),
            CoreError::NotFound(_)
        ));
    }

    #[test]
    fn render_markdown_lists_nodes_in_order_and_relations() {
        let g = LineageGraphData {
            nodes: nodes(&[("a", "甲", false), ("b", "乙", true)]),
            edges: vec![LineageEdge {
                from: "a".into(),
                to: "b".into(),
                label: "转向".into(),
            }],
        };
        let md = render_markdown("书", "第二章", &g);
        assert!(md.contains("覆盖到:第二章"));
        assert!(md.contains("1. **甲**"));
        assert!(md.contains("2. **乙** ✎"));
        assert!(md.contains("- 甲 →(转向) 乙"));
    }

    #[test]
    fn upsert_enqueues_sync_lineage_with_content_watermark() {
        let (conn, book) = setup();
        crate::reader_marks::set_position(&conn, book, "ch1.xhtml", "epubcfi(/6/4!/4/2)").unwrap();
        let p = Script(Mutex::new(vec![Ok(GRAPH.into())]));
        generate(&conn, &p, std::path::Path::new("."), &policy(), book).unwrap();
        let count = |conn: &Connection| -> i64 {
            conn.query_row(
                "SELECT count(*) FROM projection_outbox WHERE kind='sync_lineage'",
                [],
                |r| r.get(0),
            )
            .unwrap()
        };
        assert_eq!(count(&conn), 1);
        let data = get(&conn, book).unwrap().unwrap().graph;
        save(&conn, book, &data).unwrap(); // 同内容 → 同 op_id,被忽略
        assert_eq!(count(&conn), 1);
        let mut changed = data.clone();
        changed.nodes[0].title = "改".into();
        save(&conn, book, &changed).unwrap();
        assert_eq!(count(&conn), 2, "内容变了才入队新 op");
    }
}
