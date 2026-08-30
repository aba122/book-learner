use std::path::{Path, PathBuf};
use crate::{CoreError, Result};

pub struct MemoryStore { root: PathBuf }

const INDEX_TEMPLATE: &str = "# INDEX — 记忆库总索引\n\n\
每次 AI 调用请先读本文件。`profile.md` 是跨书学习者画像;每本书在 `books/<slug>/` 下:\
`_map.md` 知识地图与状态、`_weakpoints.md` 薄弱点清单、`blocks/` 各知识块记忆。\n\n\
## 书目\n\n| 书名 | 目录 |\n|---|---|\n";

const PROFILE_TEMPLATE: &str = "# 学习者画像\n\n\
## 知识背景\n\n(待补充)\n\n\
## 已掌握概念\n\n(按领域列出,随学习自动积累)\n\n\
## 误区模式\n\n(AI 观察积累,只增不删)\n\n\
## 个人情境\n\n(工作/研究/生活现状;方法论书情境化与教材迁移题都依赖本节)\n";

impl MemoryStore {
    pub fn init(root: &Path) -> Result<Self> {
        std::fs::create_dir_all(root.join("books"))?;
        let store = Self { root: root.to_path_buf() };
        let index = root.join("INDEX.md");
        if !index.exists() { std::fs::write(&index, INDEX_TEMPLATE)?; }
        let profile = root.join("profile.md");
        if !profile.exists() { std::fs::write(&profile, PROFILE_TEMPLATE)?; }
        if !root.join(".git").exists() {
            store.git(&["init", "-b", "main"])?;
            store.git(&["config", "user.name", "book-learner"])?;
            store.git(&["config", "user.email", "book-learner@local"])?;
            store.git(&["add", "-A"])?;
            store.git(&["commit", "-m", "init: 记忆库初始化"])?;
        }
        Ok(store)
    }

    pub fn root(&self) -> &Path { &self.root }

    pub fn ensure_book(&self, slug: &str, title: &str) -> Result<()> {
        let dir = self.root.join("books").join(slug);
        std::fs::create_dir_all(dir.join("blocks"))?;
        let map = dir.join("_map.md");
        if !map.exists() {
            std::fs::write(&map, format!("# 知识地图 — {title}\n\n(待生成)\n"))?;
        }
        let wp = dir.join("_weakpoints.md");
        if !wp.exists() {
            std::fs::write(&wp, "# 薄弱点清单\n\n## 待考\n\n## 已修复\n")?;
        }
        let index_path = self.root.join("INDEX.md");
        let idx = std::fs::read_to_string(&index_path)?;
        let line = format!("| {title} | books/{slug}/ |\n");
        if !idx.contains(&line) {
            std::fs::write(&index_path, idx + &line)?;
        }
        Ok(())
    }


    pub fn apply_eval(&self, book_slug: &str, seq: i64, title: &str, block_slug: &str,
                      eval: &crate::eval::EvalResult, date: &str) -> Result<()> {
        use crate::eval::Verdict;
        let path = self.root.join("books").join(book_slug).join("blocks")
            .join(format!("{seq:02}-{block_slug}.md"));
        let old = std::fs::read_to_string(&path).unwrap_or_default();
        let old_final = extract_section(&old, "## 复述终稿");
        let old_history = extract_section(&old, "## 评估历史");
        let old_notes = extract_section(&old, "## AI 观察笔记");
        let old_passed_at = old.lines()
            .find_map(|l| l.strip_prefix("passed_at: ").map(str::to_string));

        let is_pass = eval.verdict == Verdict::PassSuggested;
        let n = old_history.lines().filter(|l| l.trim_start().starts_with("- ")).count() + 1;
        let status = if is_pass { "passed" } else { "learning" };
        let passed_at = if is_pass { date.to_string() } else { old_passed_at.unwrap_or_default() };
        let verdict_cn = if is_pass { "通过建议 ✓" } else { "重学建议" };
        let wp_str = if eval.weak_points.is_empty() { "无".to_string() } else {
            eval.weak_points.iter().map(|w| {
                if w.fixed_in_session { format!("{}(已当场修复)", w.title) } else { w.title.clone() }
            }).collect::<Vec<_>>().join("、")
        };
        let final_text = if is_pass { eval.final_restatement.clone() }
            else if old_final.is_empty() { "(尚未通过)".to_string() } else { old_final };
        let mut notes = old_notes;
        if !eval.observation_note.is_empty() {
            if !notes.is_empty() { notes.push('\n'); }
            notes.push_str(&format!("- {date} {}", eval.observation_note));
        }
        let content = format!(
"---\nblock_seq: {seq}\nstatus: {status}\nscores: {{accuracy: {}, completeness: {}, clarity: {}}}\npassed_at: {passed_at}\nreview_stage: 0\n---\n# {title}\n\n\
## 复述终稿\n\n{final_text}\n\n\
## 评估历史\n\n- {date} 第{n}次:{verdict_cn};薄弱点:{wp_str}\n{}\n\
## AI 观察笔记\n\n{notes}\n",
            eval.scores.accuracy, eval.scores.completeness, eval.scores.clarity,
            if old_history.is_empty() { String::new() } else { format!("{old_history}\n") });
        std::fs::write(&path, content)?;
        Ok(())
    }

    /// 镜像再生:元组为 (块标题, 薄弱点标题, 日期)
    pub fn sync_weakpoints(&self, book_slug: &str,
                           open: &[(String, String, String)],
                           fixed: &[(String, String, String)]) -> Result<()> {
        let fmt = |items: &[(String, String, String)]| items.iter()
            .map(|(b, t, d)| format!("- [{b}] {t} ({d})"))
            .collect::<Vec<_>>().join("\n");
        let content = format!("# 薄弱点清单\n\n## 待考\n\n{}\n\n## 已修复\n\n{}\n",
            fmt(open), fmt(fixed));
        std::fs::write(self.root.join("books").join(book_slug).join("_weakpoints.md"), content)?;
        Ok(())
    }

    /// 镜像再生:元组为 (块标题, 状态)
    pub fn sync_map(&self, book_slug: &str, title: &str, blocks: &[(String, String)]) -> Result<()> {
        let rows = blocks.iter().map(|(t, s)| format!("| {t} | {s} |"))
            .collect::<Vec<_>>().join("\n");
        let content = format!("# 知识地图 — {title}\n\n| 知识块 | 状态 |\n|---|---|\n{rows}\n");
        std::fs::write(self.root.join("books").join(book_slug).join("_map.md"), content)?;
        Ok(())
    }


    /// 学习会话结束后的自动提交;无变更时容忍空提交。
    pub fn commit(&self, msg: &str) -> Result<()> {
        self.git(&["add", "-A"])?;
        let out = self.git(&["commit", "-m", msg])?;
        if !out.status.success() {
            let text = format!("{}{}",
                String::from_utf8_lossy(&out.stdout), String::from_utf8_lossy(&out.stderr));
            if text.contains("nothing to commit") || text.contains("nothing added") {
                return Ok(());
            }
            return Err(CoreError::Other(format!("git commit failed: {text}")));
        }
        Ok(())
    }

    fn git(&self, args: &[&str]) -> Result<std::process::Output> {
        let out = std::process::Command::new("git")
            .arg("-C").arg(&self.root)
            .args(args)
            .output()?;
        Ok(out)
    }
}


/// 取 `heading` 之后到下一个 `## ` 或文件尾的内容(去首尾空白)。
fn extract_section(text: &str, heading: &str) -> String {
    let Some(start) = text.find(heading) else { return String::new() };
    let body = &text[start + heading.len()..];
    let end = body.find("\n## ").unwrap_or(body.len());
    body[..end].trim().to_string()
}

#[cfg(test)]
mod tests {
    #[test]
    fn init_creates_templates_and_git() {
        let dir = tempfile::tempdir().unwrap();
        let m = super::MemoryStore::init(dir.path()).unwrap();
        assert!(dir.path().join("INDEX.md").exists());
        assert!(dir.path().join("profile.md").exists());
        assert!(dir.path().join(".git").exists());
        let prof = std::fs::read_to_string(dir.path().join("profile.md")).unwrap();
        for sec in ["## 知识背景", "## 已掌握概念", "## 误区模式", "## 个人情境"] {
            assert!(prof.contains(sec), "missing {sec}");
        }
        let _ = m;
    }
    #[test]
    fn ensure_book_creates_book_dir_and_updates_index() {
        let dir = tempfile::tempdir().unwrap();
        let m = super::MemoryStore::init(dir.path()).unwrap();
        m.ensure_book("microecon", "微观经济学").unwrap();
        m.ensure_book("microecon", "微观经济学").unwrap(); // 幂等
        assert!(dir.path().join("books/microecon/blocks").is_dir());
        assert!(dir.path().join("books/microecon/_map.md").exists());
        assert!(dir.path().join("books/microecon/_weakpoints.md").exists());
        let idx = std::fs::read_to_string(dir.path().join("INDEX.md")).unwrap();
        assert_eq!(idx.matches("微观经济学").count(), 1);
    }
    fn sample_eval(pass: bool) -> crate::eval::EvalResult {
        let v = if pass { "pass_suggested" } else { "relearn_suggested" };
        serde_json::from_str(&format!(r#"{{
            "verdict":"{v}","scores":{{"accuracy":4,"completeness":3,"clarity":5}},
            "summary":"总评","final_restatement":"弹性是相对变化率",
            "weak_points":[{{"title":"弹性vs斜率","detail":"混淆概念"}}],
            "observation_note":"倾向用比喻"}}"#)).unwrap()
    }

    #[test]
    fn apply_eval_writes_block_file_and_accumulates() {
        let dir = tempfile::tempdir().unwrap();
        let m = super::MemoryStore::init(dir.path()).unwrap();
        m.ensure_book("microecon", "微观经济学").unwrap();
        m.apply_eval("microecon", 3, "供需弹性", "elasticity", &sample_eval(false), "2026-08-29").unwrap();
        m.apply_eval("microecon", 3, "供需弹性", "elasticity", &sample_eval(true), "2026-08-30").unwrap();
        let f = std::fs::read_to_string(dir.path().join("books/microecon/blocks/03-elasticity.md")).unwrap();
        assert!(f.contains("status: passed"), "frontmatter status");
        assert!(f.contains("## 复述终稿") && f.contains("弹性是相对变化率"));
        assert!(f.matches("- 2026-08-").count() >= 2, "评估历史两条: {f}");
        assert!(f.contains("第2次"));
        assert!(f.contains("## AI 观察笔记") && f.matches("倾向用比喻").count() == 2);
    }
    #[test]
    fn sync_weakpoints_regenerates_mirror() {
        let dir = tempfile::tempdir().unwrap();
        let m = super::MemoryStore::init(dir.path()).unwrap();
        m.ensure_book("microecon", "微观经济学").unwrap();
        m.sync_weakpoints("microecon",
            &[("供需弹性".into(), "弹性vs斜率".into(), "2026-08-30".into())],
            &[("消费者剩余".into(), "混淆总剩余".into(), "2026-08-28".into())]).unwrap();
        let f = std::fs::read_to_string(dir.path().join("books/microecon/_weakpoints.md")).unwrap();
        let (open_pos, fixed_pos) = (f.find("## 待考").unwrap(), f.find("## 已修复").unwrap());
        assert!(f.find("弹性vs斜率").unwrap() > open_pos && f.find("弹性vs斜率").unwrap() < fixed_pos);
        assert!(f.find("混淆总剩余").unwrap() > fixed_pos);
    }
    #[test]
    fn sync_map_regenerates_mirror() {
        let dir = tempfile::tempdir().unwrap();
        let m = super::MemoryStore::init(dir.path()).unwrap();
        m.ensure_book("microecon", "微观经济学").unwrap();
        m.sync_map("microecon", "微观经济学",
            &[("供需弹性".into(), "passed".into()), ("消费者剩余".into(), "unlearned".into())]).unwrap();
        let f = std::fs::read_to_string(dir.path().join("books/microecon/_map.md")).unwrap();
        assert!(f.contains("供需弹性") && f.contains("passed") && f.contains("消费者剩余"));
    }
    #[test]
    fn commit_creates_git_commit_and_tolerates_empty() {
        let dir = tempfile::tempdir().unwrap();
        let m = super::MemoryStore::init(dir.path()).unwrap();
        m.ensure_book("microecon", "微观经济学").unwrap();
        m.commit("study: 微观经济学/供需弹性 2026-08-30").unwrap();
        m.commit("study: 空提交容忍").unwrap();
        let log = std::process::Command::new("git")
            .arg("-C").arg(dir.path())
            .args(["log", "--oneline"]).output().unwrap();
        assert!(String::from_utf8_lossy(&log.stdout).contains("供需弹性"));
    }
}
