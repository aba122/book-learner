//! 地图草图落库与带修订号的地图确认(ADR-0003):稳定 block id、`map_revision` 乐观并发、
//! 操作集(Rename/RenameModule/Reorder/SetSkipped/Merge/Split)、有序多段锚点。

use crate::eval::DraftMap;
use crate::mapgen::{list_spine, resolve_source_section};
use crate::{CoreError, Result};
use rusqlite::{Connection, OptionalExtension, Transaction, TransactionBehavior};
use std::collections::{HashMap, HashSet};

pub const MAX_SLUG_CHARS: usize = 40;

/// slug 派生:保留 Unicode 字母数字,其余替换为 '-',折叠连续 '-'、去首尾,≤40 字符;
/// 空 → `block-{seq}`;与 `taken` 重复加 `-2`/`-3` 后缀。结果必过 memory::validate_slug。
pub fn slugify(title: &str, seq: i64, taken: &HashSet<String>) -> String {
    let mut out = String::new();
    let mut last_dash = false;
    for c in title.chars() {
        if c.is_alphanumeric() {
            out.push(c);
            last_dash = false;
        } else if !last_dash && !out.is_empty() {
            out.push('-');
            last_dash = true;
        }
    }
    let base: String = out
        .trim_matches('-')
        .chars()
        .take(MAX_SLUG_CHARS)
        .collect::<String>()
        .trim_matches('-')
        .to_string();
    let base = if base.is_empty() {
        format!("block-{seq}")
    } else {
        base
    };
    if !taken.contains(&base) {
        return base;
    }
    (2..)
        .map(|n| format!("{base}-{n}"))
        .find(|cand| !taken.contains(cand))
        .expect("unbounded suffix search terminates")
}

#[derive(Debug, Clone, PartialEq)]
pub struct AnchorSegment {
    pub spine_href: String,
    pub cfi_start: String,
    pub cfi_end: String,
    /// exact | chapter_fallback
    pub precision: String,
    /// 原文小节标题(供阅读器解析 CFI)
    pub hint: String,
    /// 段纯文本(exact 段回填;空则用整章 spine 文本)
    pub text: String,
}

#[derive(Debug, Clone, PartialEq)]
pub enum MapEditOp {
    Rename {
        block_id: i64,
        title: String,
    },
    RenameModule {
        from: String,
        to: String,
    },
    /// 该书全部块 id 的一个排列(新顺序)
    Reorder {
        block_ids: Vec<i64>,
    },
    SetSkipped {
        block_id: i64,
        skipped: bool,
    },
    /// from 标记 skipped(保留自身锚点);其锚点段复制追加到 into 尾部;其他块 prereq 中的 from 改为 into
    Merge {
        into: i64,
        from: Vec<i64>,
    },
    /// 删除块(BL-002):只允许没有学习痕迹的块(status=unlearned 且无任务/会话/薄弱点/复习计划);
    /// 锚点一并删除,其他块 prereq 中去掉它。有痕迹的块用 SetSkipped。
    Delete {
        block_id: i64,
    },
    /// 拆成两块(BL-002):原块改名 title_a,紧随其后插入新块 title_b(同模块、同 prereq、复制全部锚点段、unlearned)。
    /// 两块暂共用同一段原文;按选区精确切分锚点属手动锚点校正(范围外)。
    Split {
        block_id: i64,
        title_a: String,
        title_b: String,
    },
}

fn book_revision(conn: &Connection, book_id: i64) -> Result<i64> {
    conn.query_row(
        "SELECT map_revision FROM book WHERE id=?1",
        [book_id],
        |r| r.get(0),
    )
    .optional()?
    .ok_or_else(|| CoreError::NotFound(format!("book {book_id}")))
}

fn block_ids_of(conn: &Connection, book_id: i64) -> Result<Vec<i64>> {
    let mut st = conn.prepare("SELECT id FROM knowledge_block WHERE book_id=?1 ORDER BY seq")?;
    let rows = st.query_map([book_id], |r| r.get(0))?;
    Ok(rows.collect::<rusqlite::Result<_>>()?)
}

fn insert_anchor(conn: &Connection, block_id: i64, seq: i64, seg: &AnchorSegment) -> Result<()> {
    if !matches!(seg.precision.as_str(), "exact" | "chapter_fallback") {
        return Err(CoreError::InvalidInput(format!(
            "invalid anchor precision {:?}",
            seg.precision
        )));
    }
    conn.execute(
        "INSERT INTO block_anchor(block_id,seq,spine_href,cfi_start,cfi_end,precision,hint,text) \
         VALUES(?1,?2,?3,?4,?5,?6,?7,?8)",
        rusqlite::params![
            block_id,
            seq,
            seg.spine_href,
            seg.cfi_start,
            seg.cfi_end,
            seg.precision,
            seg.hint,
            seg.text
        ],
    )?;
    Ok(())
}

/// 首次确认:草图 → knowledge_block + block_anchor(chapter_fallback 段,带 hint),map_revision=1,
/// import_state='ready',同一事务入队 outbox `init_book`。map_revision≠0 或已有块 → Conflict;
/// source_section 无法解析 → InvalidInput 并整体回滚。
pub fn apply_draft_map(conn: &Connection, book_id: i64, draft: &DraftMap) -> Result<u64> {
    let tx = Transaction::new_unchecked(conn, TransactionBehavior::Immediate)?;
    let revision = book_revision(&tx, book_id)?;
    if revision != 0 || !block_ids_of(&tx, book_id)?.is_empty() {
        return Err(CoreError::Conflict(format!(
            "map already applied for book {book_id} (revision {revision})"
        )));
    }
    let chapters = list_spine(&tx, book_id)?;
    let mut taken: HashSet<String> = HashSet::new();
    let mut id_by_title: HashMap<String, i64> = HashMap::new();
    let mut pending: Vec<(i64, Vec<String>)> = vec![];
    let mut seq = 0i64;
    for module in &draft.modules {
        for block in &module.blocks {
            seq += 1;
            let title = block.title.trim();
            if title.is_empty() {
                return Err(CoreError::InvalidInput("empty block title".into()));
            }
            let slug = slugify(title, seq, &taken);
            taken.insert(slug.clone());
            tx.execute(
                "INSERT INTO knowledge_block(book_id,module_name,seq,title,slug,prereq_ids) \
                 VALUES(?1,?2,?3,?4,?5,'[]')",
                rusqlite::params![book_id, module.name, seq, title, slug],
            )?;
            let id = tx.last_insert_rowid();
            if id_by_title.insert(title.to_string(), id).is_some() {
                return Err(CoreError::InvalidInput(format!(
                    "duplicate block title: {title}"
                )));
            }
            for (k, section) in block.source_sections.iter().enumerate() {
                let (href, hint) = resolve_source_section(section, &chapters).ok_or_else(|| {
                    CoreError::InvalidInput(format!(
                        "unresolved source_section {section:?} (block {title})"
                    ))
                })?;
                insert_anchor(
                    &tx,
                    id,
                    (k + 1) as i64,
                    &AnchorSegment {
                        spine_href: href,
                        cfi_start: String::new(),
                        cfi_end: String::new(),
                        precision: "chapter_fallback".into(),
                        hint,
                        text: String::new(),
                    },
                )?;
            }
            pending.push((id, block.prereqs.clone()));
        }
    }
    for (id, prereqs) in pending {
        let mut ids = vec![];
        for p in prereqs {
            let pid = id_by_title
                .get(p.trim())
                .ok_or_else(|| CoreError::InvalidInput(format!("unknown prereq {p:?}")))?;
            if *pid != id && !ids.contains(pid) {
                ids.push(*pid);
            }
        }
        tx.execute(
            "UPDATE knowledge_block SET prereq_ids=?2 WHERE id=?1",
            rusqlite::params![id, serde_json::to_string(&ids).unwrap()],
        )?;
    }
    tx.execute(
        "UPDATE book SET map_revision=1, import_state='ready' WHERE id=?1",
        [book_id],
    )?;
    crate::projection::enqueue(
        &tx,
        &format!("map:{book_id}:r1:init_book"),
        "init_book",
        &serde_json::json!({ "book_id": book_id }),
    )?;
    tx.commit()?;
    Ok(1)
}

fn assert_in_book(conn: &Connection, book_id: i64, block_id: i64) -> Result<()> {
    let found: Option<i64> = conn
        .query_row(
            "SELECT 1 FROM knowledge_block WHERE id=?1 AND book_id=?2",
            [block_id, book_id],
            |r| r.get(0),
        )
        .optional()?;
    found
        .map(|_| ())
        .ok_or_else(|| CoreError::NotFound(format!("block {block_id} in book {book_id}")))
}

fn prereqs_of(conn: &Connection, block_id: i64) -> Result<Vec<i64>> {
    let raw: String = conn.query_row(
        "SELECT prereq_ids FROM knowledge_block WHERE id=?1",
        [block_id],
        |r| r.get(0),
    )?;
    serde_json::from_str(&raw).map_err(|e| CoreError::Other(format!("corrupt prereq_ids: {e}")))
}

/// 乐观并发的地图确认:expected_revision≠当前 → Conflict 且无变更;单事务;成功 revision+1 并入队 `sync_map`。
/// 不触碰 status/scores/passed_at。
pub fn confirm_map(
    conn: &Connection,
    book_id: i64,
    expected_revision: u64,
    ops: &[MapEditOp],
) -> Result<u64> {
    let tx = Transaction::new_unchecked(conn, TransactionBehavior::Immediate)?;
    let revision = book_revision(&tx, book_id)?;
    if revision != expected_revision as i64 {
        return Err(CoreError::Conflict(format!(
            "map revision is {revision}, expected {expected_revision}"
        )));
    }
    for op in ops {
        match op {
            MapEditOp::Rename { block_id, title } => {
                assert_in_book(&tx, book_id, *block_id)?;
                let title = title.trim();
                if title.is_empty() {
                    return Err(CoreError::InvalidInput("empty block title".into()));
                }
                tx.execute(
                    "UPDATE knowledge_block SET title=?2 WHERE id=?1",
                    rusqlite::params![block_id, title],
                )?;
            }
            MapEditOp::RenameModule { from, to } => {
                let to = to.trim();
                if to.is_empty() {
                    return Err(CoreError::InvalidInput("empty module name".into()));
                }
                let n = tx.execute(
                    "UPDATE knowledge_block SET module_name=?3 WHERE book_id=?1 AND module_name=?2",
                    rusqlite::params![book_id, from, to],
                )?;
                if n == 0 {
                    return Err(CoreError::NotFound(format!("module {from:?}")));
                }
            }
            MapEditOp::Reorder { block_ids } => {
                let current = block_ids_of(&tx, book_id)?;
                let want: HashSet<i64> = block_ids.iter().copied().collect();
                if block_ids.len() != current.len()
                    || want.len() != current.len()
                    || !current.iter().all(|id| want.contains(id))
                {
                    return Err(CoreError::InvalidInput(
                        "reorder must list every block of the book exactly once".into(),
                    ));
                }
                for (pos, id) in block_ids.iter().enumerate() {
                    tx.execute(
                        "UPDATE knowledge_block SET seq=?2 WHERE id=?1",
                        rusqlite::params![id, (pos + 1) as i64],
                    )?;
                }
            }
            MapEditOp::SetSkipped { block_id, skipped } => {
                assert_in_book(&tx, book_id, *block_id)?;
                tx.execute(
                    "UPDATE knowledge_block SET skipped=?2 WHERE id=?1",
                    rusqlite::params![block_id, i64::from(*skipped)],
                )?;
            }
            MapEditOp::Merge { into, from } => {
                assert_in_book(&tx, book_id, *into)?;
                if from.is_empty() || from.contains(into) {
                    return Err(CoreError::InvalidInput(
                        "merge needs at least one other source block".into(),
                    ));
                }
                let mut next_seq: i64 = tx.query_row(
                    "SELECT COALESCE(max(seq),0) FROM block_anchor WHERE block_id=?1",
                    [into],
                    |r| r.get(0),
                )?;
                for f in from {
                    assert_in_book(&tx, book_id, *f)?;
                    tx.execute("UPDATE knowledge_block SET skipped=1 WHERE id=?1", [f])?;
                    for seg in list_anchors(&tx, *f)? {
                        next_seq += 1;
                        insert_anchor(&tx, *into, next_seq, &seg)?;
                    }
                }
                for id in block_ids_of(&tx, book_id)? {
                    let old = prereqs_of(&tx, id)?;
                    let mut new: Vec<i64> = vec![];
                    for p in &old {
                        let mapped = if from.contains(p) { *into } else { *p };
                        if mapped != id && !new.contains(&mapped) {
                            new.push(mapped);
                        }
                    }
                    if new != old {
                        tx.execute(
                            "UPDATE knowledge_block SET prereq_ids=?2 WHERE id=?1",
                            rusqlite::params![id, serde_json::to_string(&new).unwrap()],
                        )?;
                    }
                }
            }
            MapEditOp::Delete { block_id } => {
                assert_in_book(&tx, book_id, *block_id)?;
                let status: String = tx.query_row(
                    "SELECT status FROM knowledge_block WHERE id=?1",
                    [block_id],
                    |r| r.get(0),
                )?;
                let traces: i64 = tx.query_row(
                    "SELECT (SELECT count(*) FROM daily_task WHERE block_id=?1) \
                          + (SELECT count(*) FROM feynman_session WHERE block_id=?1) \
                          + (SELECT count(*) FROM weak_point WHERE block_id=?1) \
                          + (SELECT count(*) FROM review_schedule WHERE block_id=?1)",
                    [block_id],
                    |r| r.get(0),
                )?;
                if status != "unlearned" || traces > 0 {
                    return Err(CoreError::InvalidInput(format!(
                        "block {block_id} has learning history; skip it instead of deleting"
                    )));
                }
                tx.execute("DELETE FROM block_anchor WHERE block_id=?1", [block_id])?;
                tx.execute(
                    "UPDATE artifact SET block_id=NULL WHERE block_id=?1",
                    [block_id],
                )?;
                tx.execute("DELETE FROM knowledge_block WHERE id=?1", [block_id])?;
                for id in block_ids_of(&tx, book_id)? {
                    let old = prereqs_of(&tx, id)?;
                    let new: Vec<i64> = old.iter().copied().filter(|p| p != block_id).collect();
                    if new != old {
                        tx.execute(
                            "UPDATE knowledge_block SET prereq_ids=?2 WHERE id=?1",
                            rusqlite::params![id, serde_json::to_string(&new).unwrap()],
                        )?;
                    }
                }
            }
            MapEditOp::Split {
                block_id,
                title_a,
                title_b,
            } => {
                assert_in_book(&tx, book_id, *block_id)?;
                let (title_a, title_b) = (title_a.trim(), title_b.trim());
                if title_a.is_empty() || title_b.is_empty() {
                    return Err(CoreError::InvalidInput(
                        "split needs two non-empty titles".into(),
                    ));
                }
                let (seq, module_name, prereq_ids): (i64, String, String) = tx.query_row(
                    "SELECT seq, module_name, prereq_ids FROM knowledge_block WHERE id=?1",
                    [block_id],
                    |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?)),
                )?;
                tx.execute(
                    "UPDATE knowledge_block SET title=?2 WHERE id=?1",
                    rusqlite::params![block_id, title_a],
                )?;
                tx.execute(
                    "UPDATE knowledge_block SET seq=seq+1 WHERE book_id=?1 AND seq>?2",
                    rusqlite::params![book_id, seq],
                )?;
                let taken: HashSet<String> = {
                    let mut st = tx.prepare("SELECT slug FROM knowledge_block")?;
                    let rows = st.query_map([], |r| r.get::<_, String>(0))?;
                    rows.collect::<rusqlite::Result<_>>()?
                };
                let slug = slugify(title_b, seq + 1, &taken);
                tx.execute(
                    "INSERT INTO knowledge_block(book_id,module_name,seq,title,slug,prereq_ids) \
                     VALUES(?1,?2,?3,?4,?5,?6)",
                    rusqlite::params![book_id, module_name, seq + 1, title_b, slug, prereq_ids],
                )?;
                let new_id = tx.last_insert_rowid();
                for (i, seg) in list_anchors(&tx, *block_id)?.iter().enumerate() {
                    insert_anchor(&tx, new_id, (i + 1) as i64, seg)?;
                }
            }
        }
    }
    let new_rev = revision + 1;
    tx.execute(
        "UPDATE book SET map_revision=?2 WHERE id=?1",
        rusqlite::params![book_id, new_rev],
    )?;
    crate::projection::enqueue(
        &tx,
        &format!("map:{book_id}:r{new_rev}:sync_map"),
        "sync_map",
        &serde_json::json!({ "book_id": book_id }),
    )?;
    tx.commit()?;
    Ok(new_rev as u64)
}

/// 覆盖块的锚点段(Plan B/Mac 回填精确 CFI 与段文本)。
pub fn set_anchor_segments(
    conn: &Connection,
    block_id: i64,
    segments: &[AnchorSegment],
) -> Result<()> {
    let tx = Transaction::new_unchecked(conn, TransactionBehavior::Immediate)?;
    let exists: Option<i64> = tx
        .query_row(
            "SELECT 1 FROM knowledge_block WHERE id=?1",
            [block_id],
            |r| r.get(0),
        )
        .optional()?;
    if exists.is_none() {
        return Err(CoreError::NotFound(format!("block {block_id}")));
    }
    tx.execute("DELETE FROM block_anchor WHERE block_id=?1", [block_id])?;
    for (i, seg) in segments.iter().enumerate() {
        insert_anchor(&tx, block_id, (i + 1) as i64, seg)?;
    }
    tx.commit()?;
    Ok(())
}

pub fn list_anchors(conn: &Connection, block_id: i64) -> Result<Vec<AnchorSegment>> {
    let mut st = conn.prepare(
        "SELECT spine_href,cfi_start,cfi_end,precision,hint,text FROM block_anchor \
         WHERE block_id=?1 ORDER BY seq",
    )?;
    let rows = st.query_map([block_id], |r| {
        Ok(AnchorSegment {
            spine_href: r.get(0)?,
            cfi_start: r.get(1)?,
            cfi_end: r.get(2)?,
            precision: r.get(3)?,
            hint: r.get(4)?,
            text: r.get(5)?,
        })
    })?;
    Ok(rows.collect::<rusqlite::Result<_>>()?)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::eval::{DraftBlock, DraftMap, DraftModule};
    use crate::mapgen::{store_spine, SpineChapter};
    use crate::CoreError;
    use rusqlite::Connection;
    use std::collections::HashSet;

    const T0: &str = "需求弹性: 价格 vs 收入";
    fn block(title: &str, sections: &[&str], prereqs: &[&str]) -> DraftBlock {
        DraftBlock {
            title: title.into(),
            summary: String::new(),
            source_sections: sections.iter().map(|s| s.to_string()).collect(),
            prereqs: prereqs.iter().map(|s| s.to_string()).collect(),
        }
    }
    fn draft() -> DraftMap {
        DraftMap {
            modules: vec![
                DraftModule {
                    name: "M1".into(),
                    blocks: vec![
                        block(T0, &["ch0.xhtml#S0"], &[]),
                        block("C1", &["ch1.xhtml#S1", "ch1.xhtml#S1b"], &[T0]),
                    ],
                },
                DraftModule {
                    name: "M2".into(),
                    blocks: vec![block("C2", &["第二章#S2"], &["C1"])],
                },
            ],
        }
    }
    fn setup() -> (Connection, i64) {
        let conn = crate::db::open_in_memory().unwrap();
        let book =
            crate::models::insert_book(&conn, "书", "", crate::models::BookType::Textbook, "bk")
                .unwrap();
        let chapters: Vec<SpineChapter> = (0..3)
            .map(|i| SpineChapter {
                idx: i,
                href: format!("ch{i}.xhtml"),
                title: format!("第{}章", ["零", "一", "二"][i as usize]),
                text: format!("第{i}章正文"),
            })
            .collect();
        store_spine(&conn, book, &chapters).unwrap();
        (conn, book)
    }
    fn applied() -> (Connection, i64, Vec<crate::models::KnowledgeBlock>) {
        let (conn, book) = setup();
        apply_draft_map(&conn, book, &draft()).unwrap();
        let blocks = crate::models::list_blocks(&conn, book).unwrap();
        (conn, book, blocks)
    }
    fn outbox(conn: &Connection) -> Vec<(String, String)> {
        let mut st = conn
            .prepare("SELECT op_id,kind FROM projection_outbox ORDER BY id")
            .unwrap();
        st.query_map([], |r| Ok((r.get(0)?, r.get(1)?)))
            .unwrap()
            .collect::<rusqlite::Result<_>>()
            .unwrap()
    }
    fn book_state(conn: &Connection, book: i64) -> (i64, String) {
        conn.query_row(
            "SELECT map_revision,import_state FROM book WHERE id=?1",
            [book],
            |r| Ok((r.get(0)?, r.get(1)?)),
        )
        .unwrap()
    }
    fn seqs(conn: &Connection, book: i64) -> Vec<(i64, i64, bool)> {
        let mut st = conn
            .prepare("SELECT id,seq,skipped FROM knowledge_block WHERE book_id=?1 ORDER BY seq")
            .unwrap();
        st.query_map([book], |r| {
            Ok((r.get(0)?, r.get(1)?, r.get::<_, i64>(2)? == 1))
        })
        .unwrap()
        .collect::<rusqlite::Result<_>>()
        .unwrap()
    }

    #[test]
    fn slugify_rules() {
        let none = HashSet::new();
        assert_eq!(slugify(T0, 1, &none), "需求弹性-价格-vs-收入");
        assert_eq!(slugify("!!! ***", 3, &none), "block-3");
        let long = slugify(&"字".repeat(50), 1, &none);
        assert_eq!(long.chars().count(), 40);
        let mut taken = HashSet::new();
        taken.insert("a".to_string());
        taken.insert("a-2".to_string());
        assert_eq!(slugify("a", 1, &taken), "a-3");
        for s in [
            slugify(T0, 1, &none),
            slugify("x/y\\z..", 2, &none),
            long,
            slugify("a", 1, &taken),
        ] {
            crate::memory::validate_slug(&s).unwrap();
        }
    }

    #[test]
    fn apply_creates_blocks_prereqs_and_fallback_anchors() {
        let (conn, book, b) = applied();
        assert_eq!(b.len(), 3);
        assert_eq!(b[0].slug, "需求弹性-价格-vs-收入");
        assert_eq!(
            (b[0].module_name.as_str(), b[2].module_name.as_str()),
            ("M1", "M2")
        );
        assert_eq!(b[1].prereq_ids, vec![b[0].id]);
        assert_eq!(b[2].prereq_ids, vec![b[1].id]);
        assert_eq!(b.iter().map(|k| k.seq).collect::<Vec<_>>(), vec![1, 2, 3]);
        let a1 = list_anchors(&conn, b[1].id).unwrap();
        assert_eq!(a1.len(), 2);
        assert_eq!(
            (
                a1[0].spine_href.as_str(),
                a1[0].hint.as_str(),
                a1[0].precision.as_str()
            ),
            ("ch1.xhtml", "S1", "chapter_fallback")
        );
        assert_eq!(a1[1].hint, "S1b");
        assert_eq!(
            list_anchors(&conn, b[2].id).unwrap()[0].spine_href,
            "ch2.xhtml"
        );
        assert_eq!(book_state(&conn, book), (1, "ready".into()));
        assert_eq!(
            outbox(&conn),
            vec![(format!("map:{book}:r1:init_book"), "init_book".into())]
        );
        assert!(matches!(
            apply_draft_map(&conn, book, &draft()).unwrap_err(),
            CoreError::Conflict(_)
        ));
    }

    #[test]
    fn apply_rejects_unresolved_source_section_atomically() {
        let (conn, book) = setup();
        let mut d = draft();
        d.modules[1].blocks[0].source_sections = vec!["nowhere.xhtml#S2".into()];
        let err = apply_draft_map(&conn, book, &d).unwrap_err();
        assert!(
            matches!(&err, CoreError::InvalidInput(m) if m.contains("nowhere")),
            "{err}"
        );
        assert!(crate::models::list_blocks(&conn, book).unwrap().is_empty());
        assert_eq!(book_state(&conn, book).0, 0);
    }

    #[test]
    fn stale_revision_conflicts_without_change() {
        let (conn, book, b) = applied();
        let err = confirm_map(
            &conn,
            book,
            0,
            &[MapEditOp::Rename {
                block_id: b[0].id,
                title: "改名".into(),
            }],
        )
        .unwrap_err();
        assert!(matches!(err, CoreError::Conflict(_)));
        assert_eq!(crate::models::get_block(&conn, b[0].id).unwrap().title, T0);
        assert_eq!(book_state(&conn, book).0, 1);
        assert_eq!(outbox(&conn).len(), 1);
    }

    #[test]
    fn reorder_and_skip_keep_scores() {
        let (conn, book, b) = applied();
        conn.execute(
            "UPDATE knowledge_block SET status='passed', scores_json='{\"accuracy\":4,\"completeness\":4,\"clarity\":5}', passed_at='2026-09-01' WHERE id=?1",
            [b[0].id],
        )
        .unwrap();
        let rev = confirm_map(
            &conn,
            book,
            1,
            &[
                MapEditOp::Reorder {
                    block_ids: vec![b[2].id, b[0].id, b[1].id],
                },
                MapEditOp::SetSkipped {
                    block_id: b[1].id,
                    skipped: true,
                },
                MapEditOp::RenameModule {
                    from: "M2".into(),
                    to: "模块二".into(),
                },
            ],
        )
        .unwrap();
        assert_eq!(rev, 2);
        assert_eq!(
            seqs(&conn, book),
            vec![(b[2].id, 1, false), (b[0].id, 2, false), (b[1].id, 3, true)]
        );
        let k0 = crate::models::get_block(&conn, b[0].id).unwrap();
        assert_eq!(k0.status, "passed");
        assert_eq!(k0.passed_at.as_deref(), Some("2026-09-01"));
        assert_eq!(k0.scores.unwrap().accuracy, 4);
        assert_eq!(
            crate::models::get_block(&conn, b[2].id)
                .unwrap()
                .module_name,
            "模块二"
        );
        assert_eq!(book_state(&conn, book).0, 2);
        assert_eq!(outbox(&conn)[1].0, format!("map:{book}:r2:sync_map"));
    }

    #[test]
    fn merge_copies_anchors_and_remaps_prereqs() {
        let (conn, book, b) = applied();
        confirm_map(
            &conn,
            book,
            1,
            &[MapEditOp::Merge {
                into: b[0].id,
                from: vec![b[1].id],
            }],
        )
        .unwrap();
        assert!(seqs(&conn, book)[1].2, "来源块 skipped");
        assert_eq!(
            list_anchors(&conn, b[1].id).unwrap().len(),
            2,
            "来源块保留锚点"
        );
        let merged = list_anchors(&conn, b[0].id).unwrap();
        assert_eq!(
            merged.iter().map(|a| a.hint.as_str()).collect::<Vec<_>>(),
            vec!["S0", "S1", "S1b"]
        );
        assert_eq!(
            crate::models::get_block(&conn, b[2].id).unwrap().prereq_ids,
            vec![b[0].id]
        );
    }

    #[test]
    fn split_inserts_second_block_after_original_sharing_anchors() {
        let (conn, book, b) = applied();
        let rev = confirm_map(
            &conn,
            book,
            1,
            &[MapEditOp::Split {
                block_id: b[1].id,
                title_a: "C1 上".into(),
                title_b: " C1 下 ".into(),
            }],
        )
        .unwrap();
        assert_eq!(rev, 2);
        let s = seqs(&conn, book);
        assert_eq!(s.len(), 4);
        assert_eq!((s[0].0, s[1].0, s[3].0), (b[0].id, b[1].id, b[2].id));
        assert_eq!(s.iter().map(|x| x.1).collect::<Vec<_>>(), vec![1, 2, 3, 4]);
        let new_id = s[2].0;
        let k = crate::models::get_block(&conn, new_id).unwrap();
        assert_eq!(k.title, "C1 下");
        assert_eq!(k.module_name, "M1");
        assert_eq!(k.prereq_ids, vec![b[0].id]);
        assert_eq!(k.status, "unlearned");
        assert_eq!(
            crate::models::get_block(&conn, b[1].id).unwrap().title,
            "C1 上"
        );
        let copied = list_anchors(&conn, new_id).unwrap();
        assert_eq!(copied.len(), 2);
        assert_eq!(copied, list_anchors(&conn, b[1].id).unwrap());
        let err = confirm_map(
            &conn,
            book,
            2,
            &[MapEditOp::Split {
                block_id: b[0].id,
                title_a: "  ".into(),
                title_b: "x".into(),
            }],
        )
        .unwrap_err();
        assert!(matches!(err, CoreError::InvalidInput(_)));
        assert_eq!(seqs(&conn, book).len(), 4);
    }

    #[test]
    fn delete_removes_untouched_block_and_prereq_refs_but_refuses_history() {
        let (conn, book, b) = applied();
        // C1 是 C2 的前置;删掉 C1 后 C2 的 prereq 清空,锚点随之删除
        confirm_map(&conn, book, 1, &[MapEditOp::Delete { block_id: b[1].id }]).unwrap();
        assert_eq!(seqs(&conn, book).len(), 2);
        assert!(crate::models::get_block(&conn, b[1].id).is_err());
        assert!(list_anchors(&conn, b[1].id).unwrap().is_empty());
        assert_eq!(
            crate::models::get_block(&conn, b[2].id).unwrap().prereq_ids,
            Vec::<i64>::new()
        );
        // 状态不是 unlearned → 拒绝;进了今日计划(daily_task)也拒绝;都无变更
        conn.execute(
            "UPDATE knowledge_block SET status='learning' WHERE id=?1",
            [b[0].id],
        )
        .unwrap();
        let err =
            confirm_map(&conn, book, 2, &[MapEditOp::Delete { block_id: b[0].id }]).unwrap_err();
        assert!(
            matches!(&err, CoreError::InvalidInput(m) if m.contains("history")),
            "{err}"
        );
        conn.execute(
            "INSERT INTO daily_task(date,book_id,block_id,kind,seq,status,est_minutes) \
             VALUES('2026-09-10',?1,?2,'new',1,'pending',25)",
            [book, b[2].id],
        )
        .unwrap();
        let err =
            confirm_map(&conn, book, 2, &[MapEditOp::Delete { block_id: b[2].id }]).unwrap_err();
        assert!(matches!(err, CoreError::InvalidInput(_)));
        assert_eq!(seqs(&conn, book).len(), 2);
        assert_eq!(book_state(&conn, book).0, 2);
    }

    #[test]
    fn reorder_must_be_permutation() {
        let (conn, book, b) = applied();
        let err = confirm_map(
            &conn,
            book,
            1,
            &[MapEditOp::Reorder {
                block_ids: vec![b[0].id, b[1].id],
            }],
        )
        .unwrap_err();
        assert!(matches!(err, CoreError::InvalidInput(_)));
        assert_eq!(book_state(&conn, book).0, 1);
    }

    #[test]
    fn set_anchor_segments_overwrites_with_exact() {
        let (conn, _book, b) = applied();
        let segs = vec![AnchorSegment {
            spine_href: "ch1.xhtml".into(),
            cfi_start: "epubcfi(/6/4!/4/2)".into(),
            cfi_end: "epubcfi(/6/4!/4/8)".into(),
            precision: "exact".into(),
            hint: "S1".into(),
            text: "弹性原文段落".into(),
        }];
        set_anchor_segments(&conn, b[1].id, &segs).unwrap();
        let got = list_anchors(&conn, b[1].id).unwrap();
        assert_eq!(got, segs);
        assert!(matches!(
            set_anchor_segments(&conn, 999, &segs).unwrap_err(),
            CoreError::NotFound(_)
        ));
        let mut bad = segs.clone();
        bad[0].precision = "fuzzy".into();
        assert!(matches!(
            set_anchor_segments(&conn, b[1].id, &bad).unwrap_err(),
            CoreError::InvalidInput(_)
        ));
    }
}
