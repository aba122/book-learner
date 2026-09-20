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
    /// 节点性质(阶段/主题/概念/事件…),仅作前端配色提示,可空
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
    pub graph: LineageGraphData,
    pub generated_at: Option<String>,
    pub updated_at: String,
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

/// 去围栏、解析并清洗 graph:去空标题节点、id 去重、边只保留两端都存在的
pub fn parse_graph(text: &str) -> Result<LineageGraphData> {
    let t = text.trim();
    let json = t
        .strip_prefix("```json")
        .or_else(|| t.strip_prefix("```"))
        .and_then(|x| x.strip_suffix("```"))
        .unwrap_or(t)
        .trim();
    let mut g: LineageGraphData =
        serde_json::from_str(json).map_err(|e| CoreError::Ai(format!("lineage json: {e}")))?;
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
    let ids: std::collections::HashSet<&str> = g.nodes.iter().map(|n| n.id.as_str()).collect();
    g.edges
        .retain(|e| e.from != e.to && ids.contains(e.from.as_str()) && ids.contains(e.to.as_str()));
    if g.nodes.len() > LINEAGE_NODES_MAX {
        g.nodes.truncate(LINEAGE_NODES_MAX);
        let ids: std::collections::HashSet<&str> = g.nodes.iter().map(|n| n.id.as_str()).collect();
        g.edges
            .retain(|e| ids.contains(e.from.as_str()) && ids.contains(e.to.as_str()));
    }
    Ok(g)
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
    Ok(())
}

/// 用户手改保存:原样持久化前端传来的 graph(节点 x/y、改名、增删、连线;前端给改过的节点置 userEdited)
pub fn save(conn: &Connection, book_id: i64, graph: &LineageGraphData) -> Result<LineageGraph> {
    crate::models::get_book_slug_type(conn, book_id)?;
    let up_to_seq = read_row(conn, book_id)?.map(|r| r.0).unwrap_or(0);
    upsert(conn, book_id, up_to_seq, graph, false)?;
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
    let chapters = crate::mapgen::list_spine(conn, book_id)?;
    let read: Vec<&crate::mapgen::SpineChapter> =
        chapters.iter().filter(|c| c.idx <= up_to).collect();
    if read.is_empty() {
        return Err(CoreError::InvalidInput("先阅读一部分再生成脉络图".into()));
    }
    let read_hrefs: std::collections::HashSet<&str> =
        read.iter().map(|c| c.href.as_str()).collect();
    let chapters_txt = read
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
    // 已读范围内的知识块(按锚点章节归属),给标题/模块作骨架
    let mut blocks_txt = String::new();
    let blocks = crate::models::list_blocks(conn, book_id)?;
    let mut st = conn.prepare("SELECT DISTINCT spine_href FROM block_anchor WHERE block_id=?1")?;
    for b in &blocks {
        let hrefs: Vec<String> = st
            .query_map([b.id], |r| r.get(0))?
            .collect::<rusqlite::Result<_>>()?;
        if hrefs.iter().any(|h| read_hrefs.contains(h.as_str())) {
            blocks_txt.push_str(&format!("- #{} [{}] {}\n", b.id, b.module_name, b.title));
        }
    }
    drop(st);
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
    let graph = run_ai_json(
        conn,
        provider,
        &format!("lineage:{book_id}:s{up_to}"),
        "lineage",
        &req,
        policy,
        &parse_graph,
    )?;
    upsert(conn, book_id, up_to, &graph, true)?;
    Ok(get(conn, book_id)?.expect("just generated"))
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
                text: "正文".repeat(20),
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
}
