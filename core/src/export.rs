//! Obsidian 导出(TECH_DESIGN §9;M3 T2)。**只读 SQLite**(ADR-0001:md 不是任何用例的读取来源)。
//!
//! 目标目录 `<target>`(设置项 `obsidianVault`,由 application 层展开 `~`)下:
//! ```text
//! <书名>/00-学习报告.md            ← artifact(report),无则占位说明
//! <书名>/01-我的方法论.md          ← 方法论书:artifact(methodology) 合并
//! <书名>/blocks/<seq>-<块名>.md    ← 复述终稿 + 评估历史 + 薄弱点演变
//! <书名>/notes/<seq>-<块名>.md     ← 人文书:artifact(reflection)
//! <书名>/applications/<seq>-<块名>.md ← 教材书:artifact(application)
//! ```
//! wikilink 以目标目录为根(`[[<书名>/blocks/<seq>-<块名>]]`);目标目录应是 vault 根,否则 Obsidian 退回按文件名匹配。
//! 写入:内容相同不写(增量),临时文件 + fsync + rename;只覆盖清单内文件,不删其它文件。
use rusqlite::{Connection, OptionalExtension};
use std::collections::BTreeMap;
use std::path::{Path, PathBuf};

use crate::{CoreError, Result};

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ExportFile {
    /// 相对目标目录的路径(正斜杠)
    pub rel_path: String,
    pub content: String,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ExportPlan {
    pub root: PathBuf,
    pub book_dir: String,
    pub files: Vec<ExportFile>,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ExportReport {
    pub dir: PathBuf,
    pub written: usize,
    pub unchanged: usize,
}

const MAX_NAME_BYTES: usize = 120;

/// 文件名安全化:去路径分隔符、Windows 保留字符与控制字符;去首尾空白与点;禁 `.`/`..`/空;限长(字符边界)。
pub fn safe_name(raw: &str) -> Result<String> {
    let cleaned: String = raw
        .chars()
        .filter(|c| {
            !matches!(c, '/' | '\\' | ':' | '*' | '?' | '"' | '<' | '>' | '|') && !c.is_control()
        })
        .collect();
    let trimmed = cleaned.trim().trim_matches('.').trim();
    if trimmed.is_empty() {
        return Err(CoreError::InvalidInput(format!(
            "name {raw:?} has no usable characters for a file name"
        )));
    }
    let mut end = trimmed.len().min(MAX_NAME_BYTES);
    while !trimmed.is_char_boundary(end) {
        end -= 1;
    }
    Ok(trimmed[..end].trim().to_string())
}

fn frontmatter(pairs: &[(&str, String)]) -> String {
    let mut out = String::from("---\n");
    for (key, value) in pairs {
        out.push_str(&format!("{key}: {value}\n"));
    }
    out.push_str("---\n");
    out
}

fn yaml_str(value: &str) -> String {
    format!("\"{}\"", value.replace('\\', "\\\\").replace('"', "\\\""))
}

struct BlockRow {
    id: i64,
    seq: i64,
    module: String,
    title: String,
    status: String,
    scores: Option<(i64, i64, i64)>,
    passed_at: Option<String>,
}

struct HistoryRow {
    date: String,
    verdict: String,
    summary: String,
    final_restatement: String,
    weak_points: Vec<String>,
}

pub fn plan(conn: &Connection, book_id: i64, target_dir: &Path) -> Result<ExportPlan> {
    let (title, book_type, status): (String, String, String) = conn
        .query_row(
            "SELECT title,type,status FROM book WHERE id=?1",
            [book_id],
            |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?)),
        )
        .optional()?
        .ok_or_else(|| CoreError::NotFound(format!("book {book_id}")))?;
    let book_dir = safe_name(&title)?;
    let tags = format!("[book-learner, {}]", yaml_str(&title));
    let mut files: Vec<ExportFile> = Vec::new();

    // 块
    let mut st = conn.prepare(
        "SELECT id,seq,module_name,title,status,scores_json,passed_at FROM knowledge_block \
         WHERE book_id=?1 AND skipped=0 ORDER BY seq,id",
    )?;
    let blocks: Vec<BlockRow> = st
        .query_map([book_id], |r| {
            let scores_json: Option<String> = r.get(5)?;
            Ok(BlockRow {
                id: r.get(0)?,
                seq: r.get(1)?,
                module: r.get(2)?,
                title: r.get(3)?,
                status: r.get(4)?,
                scores: scores_json.and_then(|s| {
                    serde_json::from_str::<crate::eval::Scores>(&s)
                        .ok()
                        .map(|v| (v.accuracy as i64, v.completeness as i64, v.clarity as i64))
                }),
                passed_at: r.get(6)?,
            })
        })?
        .collect::<rusqlite::Result<_>>()?;
    drop(st);
    let block_names: Vec<String> = blocks
        .iter()
        .map(|b| Ok(format!("{:02}-{}", b.seq, safe_name(&b.title)?)))
        .collect::<Result<_>>()?;
    let link_block = |i: usize| format!("[[{book_dir}/blocks/{}]]", block_names[i]);
    let report_link = format!("[[{book_dir}/00-学习报告]]");

    for (i, block) in blocks.iter().enumerate() {
        // 评估历史(按会话时间)
        let mut st = conn.prepare(
            "SELECT started_at, eval_json FROM feynman_session \
             WHERE block_id=?1 AND eval_json IS NOT NULL AND state='confirmed' AND book_id IS NULL \
             ORDER BY started_at, id",
        )?;
        let history: Vec<HistoryRow> = st
            .query_map([block.id], |r| {
                Ok((r.get::<_, String>(0)?, r.get::<_, String>(1)?))
            })?
            .collect::<rusqlite::Result<Vec<_>>>()?
            .into_iter()
            .filter_map(|(started, json)| {
                let eval: crate::eval::EvalResult = serde_json::from_str(&json).ok()?;
                Some(HistoryRow {
                    date: started.get(..10).unwrap_or(&started).to_string(),
                    verdict: match eval.verdict {
                        crate::eval::Verdict::PassSuggested => "通过建议".into(),
                        crate::eval::Verdict::RelearnSuggested => "重学建议".into(),
                    },
                    summary: eval.summary,
                    final_restatement: eval.final_restatement,
                    weak_points: eval.weak_points.iter().map(|w| w.title.clone()).collect(),
                })
            })
            .collect();
        drop(st);
        let mut st = conn.prepare(
            "SELECT title,status,created_at,COALESCE(fixed_at,'') FROM weak_point WHERE block_id=?1 ORDER BY created_at,id",
        )?;
        let weak: Vec<(String, String, String, String)> = st
            .query_map([block.id], |r| {
                Ok((r.get(0)?, r.get(1)?, r.get(2)?, r.get(3)?))
            })?
            .collect::<rusqlite::Result<_>>()?;
        drop(st);
        let final_text = history
            .iter()
            .rev()
            .find(|h| !h.final_restatement.trim().is_empty())
            .map(|h| h.final_restatement.clone())
            .unwrap_or_else(|| "(尚未通过)".into());
        let history_md = if history.is_empty() {
            "(尚无评估)".to_string()
        } else {
            history
                .iter()
                .enumerate()
                .map(|(n, h)| {
                    let wp = if h.weak_points.is_empty() {
                        "无".to_string()
                    } else {
                        h.weak_points.join("、")
                    };
                    format!(
                        "- {} 第{}次:{};{};薄弱点:{wp}",
                        h.date,
                        n + 1,
                        h.verdict,
                        h.summary
                    )
                })
                .collect::<Vec<_>>()
                .join("\n")
        };
        let weak_md = if weak.is_empty() {
            "(无)".to_string()
        } else {
            weak.iter()
                .map(|(t, s, c, f)| {
                    let c = c.get(..10).unwrap_or(c);
                    if s == "fixed" {
                        format!("- {t}:{c} 暴露 → {} 修复", f.get(..10).unwrap_or(f))
                    } else {
                        format!("- {t}:{c} 暴露,待考")
                    }
                })
                .collect::<Vec<_>>()
                .join("\n")
        };
        let neighbours: Vec<String> = blocks
            .iter()
            .enumerate()
            .filter(|(j, b)| *j != i && b.module == block.module)
            .map(|(j, _)| link_block(j))
            .collect();
        let scores = block
            .scores
            .map(|(a, c, l)| format!("{{accuracy: {a}, completeness: {c}, clarity: {l}}}"))
            .unwrap_or_else(|| "null".into());
        let content = format!(
            "{}# {}\n\n所属:{report_link} · 模块「{}」{}\n\n## 复述终稿\n\n{final_text}\n\n## 评估历史\n\n{history_md}\n\n## 薄弱点演变\n\n{weak_md}\n",
            frontmatter(&[
                ("book", yaml_str(&title)),
                ("block", yaml_str(&block.title)),
                ("seq", block.seq.to_string()),
                ("module", yaml_str(&block.module)),
                ("status", block.status.clone()),
                ("scores", scores),
                ("passed_at", block.passed_at.clone().unwrap_or_else(|| "null".into())),
                ("tags", tags.clone()),
            ]),
            block.title,
            block.module,
            if neighbours.is_empty() {
                String::new()
            } else {
                format!(" · 同模块:{}", neighbours.join(" "))
            }
        );
        files.push(ExportFile {
            rel_path: format!("{book_dir}/blocks/{}.md", block_names[i]),
            content,
        });
    }

    // artifact:按 kind 分组
    let mut st = conn.prepare(
        "SELECT kind, block_id, content_md, created_at FROM artifact WHERE book_id=?1 ORDER BY id",
    )?;
    let artifacts: Vec<(String, Option<i64>, String, String)> = st
        .query_map([book_id], |r| {
            Ok((r.get(0)?, r.get(1)?, r.get(2)?, r.get(3)?))
        })?
        .collect::<rusqlite::Result<_>>()?;
    drop(st);
    let index_of = |block_id: Option<i64>| blocks.iter().position(|b| Some(b.id) == block_id);
    let mut per_block: BTreeMap<(String, usize), Vec<(String, String)>> = BTreeMap::new();
    let mut methodology: Vec<(String, Option<usize>, String)> = Vec::new();
    let mut report: Option<(String, String)> = None;
    for (kind, block_id, content, created) in artifacts {
        let date = created.get(..10).unwrap_or(&created).to_string();
        match kind.as_str() {
            "report" => report = Some((date, content)),
            "methodology" => methodology.push((date, index_of(block_id), content)),
            "application" | "reflection" => {
                if let Some(i) = index_of(block_id) {
                    per_block
                        .entry((kind.clone(), i))
                        .or_default()
                        .push((date, content));
                }
            }
            _ => {}
        }
    }
    for ((kind, i), entries) in per_block {
        let (dir, heading) = if kind == "application" {
            ("applications", "迁移应用")
        } else {
            ("notes", "思考笔记")
        };
        let body = entries
            .iter()
            .map(|(date, content)| format!("## {date}\n\n{}\n", content.trim()))
            .collect::<Vec<_>>()
            .join("\n");
        let content = format!(
            "{}# {heading}:{}\n\n来源块:{} · {report_link}\n\n{body}",
            frontmatter(&[
                ("book", yaml_str(&title)),
                ("block", yaml_str(&blocks[i].title)),
                ("seq", blocks[i].seq.to_string()),
                ("kind", kind.clone()),
                ("tags", tags.clone()),
            ]),
            blocks[i].title,
            link_block(i)
        );
        files.push(ExportFile {
            rel_path: format!("{book_dir}/{dir}/{}.md", block_names[i]),
            content,
        });
    }
    if book_type == "methodology" || !methodology.is_empty() {
        let body = if methodology.is_empty() {
            "(尚未产出:方法论书每块通过后的「我的版本」会汇集到这里)".to_string()
        } else {
            methodology
                .iter()
                .map(|(date, i, content)| {
                    let source = i.map(link_block).unwrap_or_else(|| "(块已删除)".into());
                    format!("## {date} · 来源块 {source}\n\n{}\n", content.trim())
                })
                .collect::<Vec<_>>()
                .join("\n")
        };
        files.push(ExportFile {
            rel_path: format!("{book_dir}/01-我的方法论.md"),
            content: format!(
                "{}# 我的方法论:{title}\n\n{report_link}\n\n{body}",
                frontmatter(&[
                    ("book", yaml_str(&title)),
                    ("kind", "methodology".into()),
                    ("tags", tags.clone()),
                ])
            ),
        });
    }
    // 学习报告(始终生成:无报告时占位并给出块索引)
    let block_index = blocks
        .iter()
        .enumerate()
        .map(|(i, b)| format!("- {} · {}({})", link_block(i), b.module, b.status))
        .collect::<Vec<_>>()
        .join("\n");
    let report_body = match &report {
        Some((date, content)) => format!("生成于 {date}\n\n{}\n", content.trim()),
        None => "(尚未终评:全部知识块通过后可在地图页发起整书终评,报告会写到这里)\n".to_string(),
    };
    files.push(ExportFile {
        rel_path: format!("{book_dir}/00-学习报告.md"),
        content: format!(
            "{}# 学习报告:{title}\n\n{report_body}\n## 知识块索引\n\n{block_index}\n",
            frontmatter(&[
                ("book", yaml_str(&title)),
                ("book_type", book_type.clone()),
                ("status", status),
                ("kind", "report".into()),
                ("tags", tags),
            ])
        ),
    });
    files.sort_by(|a, b| a.rel_path.cmp(&b.rel_path));
    Ok(ExportPlan {
        root: target_dir.to_path_buf(),
        book_dir,
        files,
    })
}

/// 写入导出树:目标目录必须已存在(不自动创建 vault 根);创建 `<书名>/` 及子目录;内容相同不写。
pub fn write(plan: &ExportPlan) -> Result<ExportReport> {
    if !plan.root.is_dir() {
        return Err(CoreError::InvalidInput(format!(
            "export target {} does not exist or is not a directory",
            plan.root.display()
        )));
    }
    let mut written = 0;
    let mut unchanged = 0;
    for file in &plan.files {
        let path = plan.root.join(&file.rel_path);
        if std::fs::read_to_string(&path).ok().as_deref() == Some(file.content.as_str()) {
            unchanged += 1;
            continue;
        }
        if let Some(parent) = path.parent() {
            std::fs::create_dir_all(parent)?;
        }
        let tmp = path.with_extension("md.tmp");
        {
            use std::io::Write;
            let mut f = std::fs::File::create(&tmp)?;
            f.write_all(file.content.as_bytes())?;
            f.sync_all()?;
        }
        std::fs::rename(&tmp, &path)?;
        written += 1;
    }
    Ok(ExportReport {
        dir: plan.root.join(&plan.book_dir),
        written,
        unchanged,
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::models::BookType;

    const EVAL: &str = r#"{"verdict":"pass_suggested","scores":{"accuracy":4,"completeness":4,"clarity":5},"summary":"讲解到位","weak_points":[{"title":"弹性vs斜率","detail":"","fixed_in_session":false}],"final_restatement":"弹性是相对变化率","observation_note":""}"#;

    fn seed(conn: &Connection) -> (i64, Vec<i64>) {
        let book =
            crate::models::insert_book(conn, "微观/经济学: 入门?", "", BookType::Textbook, "micro")
                .unwrap();
        let b1 =
            crate::models::insert_block(conn, book, "供给与需求", 1, "供需弹性", "elasticity", &[])
                .unwrap();
        let b2 =
            crate::models::insert_block(conn, book, "供给与需求", 2, "消费者剩余", "surplus", &[])
                .unwrap();
        let b3 = crate::models::insert_block(conn, book, "生产", 3, "..", "dots", &[]).unwrap();
        conn.execute("UPDATE knowledge_block SET skipped=1 WHERE id=?1", [b3])
            .unwrap();
        conn.execute(
            "UPDATE knowledge_block SET status='passed', passed_at='2026-09-01', scores_json=?2 WHERE id=?1",
            rusqlite::params![b1, r#"{"accuracy":4,"completeness":4,"clarity":5}"#],
        )
        .unwrap();
        conn.execute(
            "INSERT INTO feynman_session(block_id,kind,started_at,state,version,eval_json) VALUES(?1,'learn','2026-09-01T10:00:00Z','confirmed',3,?2)",
            rusqlite::params![b1, EVAL],
        )
        .unwrap();
        conn.execute(
            "INSERT INTO weak_point(block_id,title,status,created_at,fixed_at) VALUES(?1,'弹性vs斜率','fixed','2026-09-01','2026-09-03')",
            [b1],
        )
        .unwrap();
        conn.execute(
            "INSERT INTO artifact(book_id,kind,block_id,content_md,created_at) VALUES(?1,'application',?2,'## 题目\n定价题','2026-09-02')",
            rusqlite::params![book, b1],
        )
        .unwrap();
        (book, vec![b1, b2, b3])
    }

    #[test]
    fn safe_name_strips_dangerous_characters() {
        assert_eq!(safe_name("微观/经济学: 入门?").unwrap(), "微观经济学 入门");
        assert_eq!(safe_name(" ..hidden.. ").unwrap(), "hidden");
        assert!(safe_name("..").is_err());
        assert!(safe_name("///").is_err());
        let long = "字".repeat(200);
        assert!(safe_name(&long).unwrap().len() <= MAX_NAME_BYTES);
    }

    #[test]
    fn plan_builds_the_tree_with_frontmatter_and_wikilinks_from_sqlite_only() {
        let conn = crate::db::open_in_memory().unwrap();
        let (book, _) = seed(&conn);
        let plan = plan(&conn, book, Path::new("/vault")).unwrap();
        assert_eq!(plan.book_dir, "微观经济学 入门");
        let paths: Vec<&str> = plan.files.iter().map(|f| f.rel_path.as_str()).collect();
        assert_eq!(
            paths,
            vec![
                "微观经济学 入门/00-学习报告.md",
                "微观经济学 入门/applications/01-供需弹性.md",
                "微观经济学 入门/blocks/01-供需弹性.md",
                "微观经济学 入门/blocks/02-消费者剩余.md",
            ],
            "跳过块不导出;教材书无 01-我的方法论"
        );
        let block = &plan.files[2].content;
        assert!(
            block.starts_with("---\nbook: \"微观/经济学: 入门?\"\nblock: \"供需弹性\"\nseq: 1\n"),
            "{block}"
        );
        assert!(
            block.contains("status: passed")
                && block.contains("scores: {accuracy: 4, completeness: 4, clarity: 5}")
                && block.contains("passed_at: 2026-09-01")
        );
        assert!(block.contains("tags: [book-learner, \"微观/经济学: 入门?\"]"));
        assert!(block.contains("## 复述终稿\n\n弹性是相对变化率"));
        assert!(block.contains("- 2026-09-01 第1次:通过建议;讲解到位;薄弱点:弹性vs斜率"));
        assert!(block.contains("- 弹性vs斜率:2026-09-01 暴露 → 2026-09-03 修复"));
        assert!(
            block.contains("[[微观经济学 入门/00-学习报告]]")
                && block.contains("[[微观经济学 入门/blocks/02-消费者剩余]]")
        );
        let unlearned = &plan.files[3].content;
        assert!(
            unlearned.contains("(尚未通过)")
                && unlearned.contains("(尚无评估)")
                && unlearned.contains("scores: null")
        );
        let app = &plan.files[1].content;
        assert!(
            app.contains("kind: application")
                && app.contains("来源块:[[微观经济学 入门/blocks/01-供需弹性]]")
                && app.contains("## 2026-09-02\n\n## 题目\n定价题")
        );
        let report = &plan.files[0].content;
        assert!(
            report.contains("(尚未终评")
                && report.contains("- [[微观经济学 入门/blocks/01-供需弹性]] · 供给与需求(passed)")
        );
        // 所有 wikilink 目标都在清单内
        for f in &plan.files {
            for link in f
                .content
                .split("[[")
                .skip(1)
                .map(|s| s.split("]]").next().unwrap())
            {
                assert!(
                    paths.contains(&format!("{link}.md").as_str()),
                    "dangling link {link}"
                );
            }
        }
        assert!(matches!(
            super::plan(&conn, 999, Path::new("/vault")),
            Err(CoreError::NotFound(_))
        ));
    }

    #[test]
    fn methodology_and_report_artifacts_get_their_files() {
        let conn = crate::db::open_in_memory().unwrap();
        let book =
            crate::models::insert_book(&conn, "孫子兵法", "", BookType::Methodology, "sunzi")
                .unwrap();
        let b1 = crate::models::insert_block(&conn, book, "计", 1, "始计", "jijie", &[]).unwrap();
        conn.execute("INSERT INTO artifact(book_id,kind,block_id,content_md,created_at) VALUES(?1,'methodology',?2,'## 我的版本\n先算后战','2026-09-05')", rusqlite::params![book, b1]).unwrap();
        conn.execute("INSERT INTO artifact(book_id,kind,block_id,content_md,created_at) VALUES(?1,'report',NULL,'<!-- overall:4 strongest:计 weakest:计 -->\n## 总体掌握度\n好','2026-09-06')", [book]).unwrap();
        let plan = plan(&conn, book, Path::new("/vault")).unwrap();
        let paths: Vec<&str> = plan.files.iter().map(|f| f.rel_path.as_str()).collect();
        assert_eq!(
            paths,
            vec![
                "孫子兵法/00-学习报告.md",
                "孫子兵法/01-我的方法论.md",
                "孫子兵法/blocks/01-始计.md"
            ]
        );
        assert!(plan.files[1].content.contains(
            "## 2026-09-05 · 来源块 [[孫子兵法/blocks/01-始计]]\n\n## 我的版本\n先算后战"
        ));
        assert!(
            plan.files[0]
                .content
                .contains("生成于 2026-09-06\n\n<!-- overall:4")
                && plan.files[0].content.contains("book_type: methodology")
        );
    }

    #[test]
    fn write_is_incremental_atomic_and_requires_an_existing_target() {
        let conn = crate::db::open_in_memory().unwrap();
        let (book, _) = seed(&conn);
        let dir = tempfile::tempdir().unwrap();
        let missing = plan(&conn, book, &dir.path().join("nope")).unwrap();
        assert!(matches!(write(&missing), Err(CoreError::InvalidInput(_))));
        let p = plan(&conn, book, dir.path()).unwrap();
        let r1 = write(&p).unwrap();
        assert_eq!((r1.written, r1.unchanged), (4, 0));
        assert_eq!(r1.dir, dir.path().join("微观经济学 入门"));
        assert!(dir
            .path()
            .join("微观经济学 入门/blocks/01-供需弹性.md")
            .exists());
        assert!(!dir
            .path()
            .join("微观经济学 入门/blocks/01-供需弹性.md.tmp")
            .exists());
        let r2 = write(&p).unwrap();
        assert_eq!((r2.written, r2.unchanged), (0, 4));
        // 用户在 vault 里放的其它文件不受影响;内容变化只重写变化的文件
        std::fs::write(dir.path().join("微观经济学 入门/我的笔记.md"), "keep").unwrap();
        conn.execute(
            "UPDATE knowledge_block SET status='consolidated' WHERE title='供需弹性'",
            [],
        )
        .unwrap();
        let r3 = write(&plan(&conn, book, dir.path()).unwrap()).unwrap();
        assert_eq!(
            (r3.written, r3.unchanged),
            (2, 2),
            "块文件与报告索引变化,其余不写"
        );
        assert_eq!(
            std::fs::read_to_string(dir.path().join("微观经济学 入门/我的笔记.md")).unwrap(),
            "keep"
        );
    }
}
