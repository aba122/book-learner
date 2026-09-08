use crate::{CoreError, Result};
use std::io::Write;
use std::path::{Path, PathBuf};

pub struct MemoryStore {
    root: PathBuf,
}

/// 远程 git 操作(ls-remote / push)的超时秒数(评审 #12:GUI 无 TTY,必须有超时)。
pub const GIT_REMOTE_TIMEOUT_SECS: u64 = 30;

/// `profile.md` 的四个固定小节(M2 T6);标题即模板标题。
pub const PROFILE_HEADINGS: [&str; 4] =
    ["## 知识背景", "## 已掌握概念", "## 误区模式", "## 个人情境"];

#[derive(Debug, Clone, PartialEq, Eq, Default, serde::Serialize, serde::Deserialize)]
pub struct ProfileSections {
    pub background: String,
    pub mastered: String,
    pub pitfalls: String,
    pub context: String,
}

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
        let store = Self {
            root: root.to_path_buf(),
        };
        let index = root.join("INDEX.md");
        if !index.exists() {
            atomic_write(&index, INDEX_TEMPLATE)?;
        }
        let profile = root.join("profile.md");
        if !profile.exists() {
            atomic_write(&profile, PROFILE_TEMPLATE)?;
        }
        if !root.join(".git").exists() {
            store.git(&["init", "-b", "main"])?;
            store.git(&["config", "user.name", "book-learner"])?;
            store.git(&["config", "user.email", "book-learner@local"])?;
            store.git(&["add", "-A"])?;
            store.git(&["commit", "-m", "init: 记忆库初始化"])?;
        }
        Ok(store)
    }

    pub fn root(&self) -> &Path {
        &self.root
    }

    /// 固定注入用的画像摘要:`profile.md` 前两节(知识背景、已掌握概念),带小节标题。
    /// 其余小节(误区模式、个人情境)由 codex 在记忆库工作目录按需自主翻阅。
    /// 画像四小节(M2 T6);缺失小节为空串。
    pub fn profile_sections(&self) -> Result<ProfileSections> {
        let text = std::fs::read_to_string(self.root.join("profile.md"))?;
        Ok(ProfileSections {
            background: extract_section(&text, PROFILE_HEADINGS[0]),
            mastered: extract_section(&text, PROFILE_HEADINGS[1]),
            pitfalls: extract_section(&text, PROFILE_HEADINGS[2]),
            context: extract_section(&text, PROFILE_HEADINGS[3]),
        })
    }

    /// 写回四小节(原子写);未知小节按原顺序保留在末尾。**不直接 git commit**——调用方经 outbox `git_commit`,
    /// 避免与 `run_pending` 的后台重放争抢 index.lock。
    pub fn write_profile_sections(&self, sections: &ProfileSections) -> Result<()> {
        let path = self.root.join("profile.md");
        let existing = std::fs::read_to_string(&path).unwrap_or_default();
        let mut unknown: Vec<(String, String)> = Vec::new();
        let mut current: Option<(String, Vec<String>)> = None;
        for line in existing.lines() {
            if let Some(heading) = line.strip_prefix("## ") {
                if let Some((h, body)) = current.take() {
                    if !PROFILE_HEADINGS.contains(&h.as_str()) {
                        unknown.push((h, body.join("\n").trim().to_string()));
                    }
                }
                current = Some((format!("## {heading}"), Vec::new()));
            } else if let Some((_, body)) = current.as_mut() {
                body.push(line.to_string());
            }
        }
        if let Some((h, body)) = current.take() {
            if !PROFILE_HEADINGS.contains(&h.as_str()) {
                unknown.push((h, body.join("\n").trim().to_string()));
            }
        }
        let mut out = String::from("# 学习者画像\n");
        for (heading, body) in PROFILE_HEADINGS.iter().zip([
            sections.background.trim(),
            sections.mastered.trim(),
            sections.pitfalls.trim(),
            sections.context.trim(),
        ]) {
            out.push_str(&format!(
                "\n{heading}\n\n{}\n",
                if body.is_empty() { "(待补充)" } else { body }
            ));
        }
        for (heading, body) in unknown {
            out.push_str(&format!("\n{heading}\n\n{body}\n"));
        }
        atomic_write(&path, &out)
    }

    /// 按书类型的固定注入摘要:教材/方法论追加"个人情境"(§6.4/6.5 依赖),人文只前两节。
    pub fn profile_summary_for(&self, ty: crate::models::BookType) -> Result<String> {
        let mut summary = self.profile_summary()?;
        if matches!(
            ty,
            crate::models::BookType::Textbook | crate::models::BookType::Methodology
        ) {
            let text = std::fs::read_to_string(self.root.join("profile.md"))?;
            let context = extract_section(&text, PROFILE_HEADINGS[3]);
            if !context.is_empty()
                && context != "(工作/研究/生活现状;方法论书情境化与教材迁移题都依赖本节)"
            {
                if !summary.is_empty() {
                    summary.push_str("\n\n");
                }
                summary.push_str(&format!("{}\n{context}", PROFILE_HEADINGS[3]));
            }
        }
        Ok(summary)
    }

    pub fn profile_summary(&self) -> Result<String> {
        let text = std::fs::read_to_string(self.root.join("profile.md"))?;
        let mut parts = Vec::new();
        for heading in ["## 知识背景", "## 已掌握概念"] {
            let body = extract_section(&text, heading);
            if !body.is_empty() {
                parts.push(format!("{heading}\n{body}"));
            }
        }
        Ok(parts.join("\n\n"))
    }

    pub fn ensure_book(&self, slug: &str, title: &str) -> Result<()> {
        let slug = validate_slug(slug)?;
        let dir = self.root.join("books").join(slug);
        std::fs::create_dir_all(dir.join("blocks"))?;
        let map = dir.join("_map.md");
        if !map.exists() {
            atomic_write(&map, &format!("# 知识地图 — {title}\n\n(待生成)\n"))?;
        }
        let wp = dir.join("_weakpoints.md");
        if !wp.exists() {
            atomic_write(&wp, "# 薄弱点清单\n\n## 待考\n\n## 已修复\n")?;
        }
        let index_path = self.root.join("INDEX.md");
        let idx = std::fs::read_to_string(&index_path)?;
        let line = format!("| {title} | books/{slug}/ |\n");
        if !idx.contains(&line) {
            atomic_write(&index_path, &(idx + &line))?;
        }
        Ok(())
    }

    /// 块 md 投影(ADR-0001/0003):文件 `blocks/{block_id:04}-{slug}.md`;`passed` 为用户判定(覆盖 eval.verdict);
    /// `entry_key`(通常为 outbox op_id)写入评估历史行,同 key 已存在则整次调用 no-op(跨崩溃重放幂等)。
    #[allow(clippy::too_many_arguments)]
    pub fn apply_eval(
        &self,
        book_slug: &str,
        block_id: i64,
        title: &str,
        block_slug: &str,
        eval: &crate::eval::EvalResult,
        passed: bool,
        entry_key: &str,
        date: &str,
    ) -> Result<()> {
        let book_slug = validate_slug(book_slug)?;
        let block_slug = validate_slug(block_slug)?;
        let path = self
            .root
            .join("books")
            .join(book_slug)
            .join("blocks")
            .join(format!("{block_id:04}-{block_slug}.md"));
        let old = std::fs::read_to_string(&path).unwrap_or_default();
        let marker = format!("<!-- {entry_key} -->");
        if old.contains(&marker) {
            return Ok(());
        }
        let old_final = extract_section(&old, "## 复述终稿");
        let old_history = extract_section(&old, "## 评估历史");
        let old_notes = extract_section(&old, "## AI 观察笔记");
        let old_passed_at = old
            .lines()
            .find_map(|l| l.strip_prefix("passed_at: ").map(str::to_string));

        let is_pass = passed;
        let n = old_history
            .lines()
            .filter(|l| l.trim_start().starts_with("- "))
            .count()
            + 1;
        let status = if is_pass { "passed" } else { "learning" };
        let passed_at = if is_pass {
            date.to_string()
        } else {
            old_passed_at.unwrap_or_default()
        };
        let verdict_cn = if is_pass {
            "通过建议 ✓"
        } else {
            "重学建议"
        };
        let wp_str = if eval.weak_points.is_empty() {
            "无".to_string()
        } else {
            eval.weak_points
                .iter()
                .map(|w| {
                    if w.fixed_in_session {
                        format!("{}(已当场修复)", w.title)
                    } else {
                        w.title.clone()
                    }
                })
                .collect::<Vec<_>>()
                .join("、")
        };
        let final_text = if is_pass {
            eval.final_restatement.clone()
        } else if old_final.is_empty() {
            "(尚未通过)".to_string()
        } else {
            old_final
        };
        let mut notes = old_notes;
        if !eval.observation_note.is_empty() {
            if !notes.is_empty() {
                notes.push('\n');
            }
            notes.push_str(&format!("- {date} {}", eval.observation_note));
        }
        let content = format!(
"---\nblock_id: {block_id}\nstatus: {status}\nscores: {{accuracy: {}, completeness: {}, clarity: {}}}\npassed_at: {passed_at}\nreview_stage: 0\n---\n# {title}\n\n\
## 复述终稿\n\n{final_text}\n\n\
## 评估历史\n\n- {date} 第{n}次:{verdict_cn};薄弱点:{wp_str} {marker}\n{}\n\
## AI 观察笔记\n\n{notes}\n",
            eval.scores.accuracy, eval.scores.completeness, eval.scores.clarity,
            if old_history.is_empty() { String::new() } else { format!("{old_history}\n") });
        atomic_write(&path, &content)?;
        Ok(())
    }

    /// 镜像再生:元组为 (块标题, 薄弱点标题, 日期)
    pub fn sync_weakpoints(
        &self,
        book_slug: &str,
        open: &[(String, String, String)],
        fixed: &[(String, String, String)],
    ) -> Result<()> {
        let book_slug = validate_slug(book_slug)?;
        let fmt = |items: &[(String, String, String)]| {
            items
                .iter()
                .map(|(b, t, d)| format!("- [{b}] {t} ({d})"))
                .collect::<Vec<_>>()
                .join("\n")
        };
        let content = format!(
            "# 薄弱点清单\n\n## 待考\n\n{}\n\n## 已修复\n\n{}\n",
            fmt(open),
            fmt(fixed)
        );
        atomic_write(
            &self
                .root
                .join("books")
                .join(book_slug)
                .join("_weakpoints.md"),
            &content,
        )?;
        Ok(())
    }

    /// 镜像再生:元组为 (块标题, 状态)
    pub fn sync_map(
        &self,
        book_slug: &str,
        title: &str,
        blocks: &[(String, String)],
    ) -> Result<()> {
        let book_slug = validate_slug(book_slug)?;
        let rows = blocks
            .iter()
            .map(|(t, s)| format!("| {t} | {s} |"))
            .collect::<Vec<_>>()
            .join("\n");
        let content = format!("# 知识地图 — {title}\n\n| 知识块 | 状态 |\n|---|---|\n{rows}\n");
        atomic_write(
            &self.root.join("books").join(book_slug).join("_map.md"),
            &content,
        )?;
        Ok(())
    }

    /// 附加环节产出归档(M2 T5):向 `books/<slug>/<file>` 追加一节;文件不存在则以 `title` 建头;
    /// `entry_key`(outbox op_id)写成 HTML 注释标记,已存在则整次 no-op(跨崩溃重放幂等)。
    #[allow(clippy::too_many_arguments)]
    pub fn append_archive(
        &self,
        book_slug: &str,
        book_title: &str,
        file: &str,
        title: &str,
        entry_key: &str,
        heading: &str,
        body: &str,
    ) -> Result<()> {
        let book_slug = validate_slug(book_slug)?;
        if file.contains('/') || file.contains("..") || !file.ends_with(".md") {
            return Err(CoreError::InvalidInput(format!(
                "bad archive file {file:?}"
            )));
        }
        let path = self.root.join("books").join(book_slug).join(file);
        let existing = match std::fs::read_to_string(&path) {
            Ok(text) => text,
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => {
                format!("# {title} — {book_title}\n")
            }
            Err(e) => return Err(e.into()),
        };
        let marker = format!("<!-- entry:{entry_key} -->");
        if existing.contains(&marker) {
            return Ok(());
        }
        let content = format!("{existing}\n## {heading}\n{marker}\n\n{}\n", body.trim());
        atomic_write(&path, &content)
    }

    /// 学习会话结束后的自动提交;无变更时容忍空提交。
    pub fn commit(&self, msg: &str) -> Result<()> {
        self.git(&["add", "-A"])?;
        let out = self.git(&["commit", "-m", msg])?;
        if !out.status.success() {
            let text = format!(
                "{}{}",
                String::from_utf8_lossy(&out.stdout),
                String::from_utf8_lossy(&out.stderr)
            );
            if text.contains("nothing to commit") || text.contains("nothing added") {
                return Ok(());
            }
            return Err(CoreError::Other(format!("git commit failed: {text}")));
        }
        Ok(())
    }

    /// 记忆库 git 远程(origin)URL;未配置为 None。
    pub fn remote_url(&self) -> Result<Option<String>> {
        let out = self.git(&["remote", "get-url", "origin"])?;
        if !out.status.success() {
            return Ok(None);
        }
        let url = String::from_utf8_lossy(&out.stdout).trim().to_string();
        Ok(if url.is_empty() { None } else { Some(url) })
    }

    /// 设置/清除远程:空 url 删除 origin;否则 add/set-url 后以 `ls-remote` 校验(有超时、无 TTY 提示)。
    pub fn set_remote(&self, url: &str) -> Result<Option<String>> {
        let url = url.trim();
        if url.is_empty() {
            let _ = self.git(&["remote", "remove", "origin"]);
            return Ok(None);
        }
        if url.contains(char::is_whitespace) || url.starts_with('-') {
            return Err(CoreError::InvalidInput(format!(
                "bad git remote url {url:?}"
            )));
        }
        let sub = if self.remote_url()?.is_some() {
            "set-url"
        } else {
            "add"
        };
        let out = self.git(&["remote", sub, "origin", url])?;
        if !out.status.success() {
            return Err(CoreError::Other(format!(
                "git remote {sub} failed: {}",
                String::from_utf8_lossy(&out.stderr).trim()
            )));
        }
        self.git_timeout(
            &["ls-remote", "--exit-code", "--heads", "origin"],
            GIT_REMOTE_TIMEOUT_SECS,
        )
        .map(|_| ())
        .or_else(|e| match e {
            // 空仓库(无 heads)也算可达:exit-code 2 表示无匹配引用
            CoreError::Other(ref m) if m.contains("exit code 2") => Ok(()),
            other => Err(other),
        })?;
        Ok(Some(url.to_string()))
    }

    /// 推送 HEAD 到 origin(有超时;无 remote 为 no-op 返回 false)。失败返回错误,由 outbox push 通道退避重试。
    pub fn push(&self) -> Result<bool> {
        if self.remote_url()?.is_none() {
            return Ok(false);
        }
        self.git_timeout(&["push", "-u", "origin", "HEAD"], GIT_REMOTE_TIMEOUT_SECS)?;
        Ok(true)
    }

    /// 带超时的 git(网络操作用):进程组 + SIGKILL 兜底;`GIT_TERMINAL_PROMPT=0` 与 `BatchMode` 避免在无 TTY 的
    /// GUI 进程里挂在凭据/known_hosts 提示上。
    fn git_timeout(&self, args: &[&str], timeout_secs: u64) -> Result<String> {
        let mut cmd = std::process::Command::new("git");
        cmd.arg("-C")
            .arg(&self.root)
            .args(args)
            .env("GIT_TERMINAL_PROMPT", "0")
            .env("GIT_SSH_COMMAND", "ssh -oBatchMode=yes -oConnectTimeout=15")
            .stdin(std::process::Stdio::null())
            .stdout(std::process::Stdio::piped())
            .stderr(std::process::Stdio::piped());
        #[cfg(unix)]
        {
            use std::os::unix::process::CommandExt;
            cmd.process_group(0);
        }
        let mut child = cmd.spawn()?;
        let stdout = child.stdout.take();
        let stderr = child.stderr.take();
        let out_thread = std::thread::spawn(move || {
            let mut buf = String::new();
            if let Some(mut s) = stdout {
                use std::io::Read;
                let _ = s.read_to_string(&mut buf);
            }
            buf
        });
        let err_thread = std::thread::spawn(move || {
            let mut buf = String::new();
            if let Some(mut s) = stderr {
                use std::io::Read;
                let _ = s.read_to_string(&mut buf);
            }
            buf
        });
        let status = crate::ai::wait_with_timeout(&mut child, timeout_secs)
            .map_err(|e| CoreError::Other(format!("git {}: {e}", args.join(" "))))?;
        let stdout = out_thread.join().unwrap_or_default();
        let stderr = err_thread.join().unwrap_or_default();
        if !status.success() {
            return Err(CoreError::Other(format!(
                "git {} failed with exit code {}: {}",
                args.join(" "),
                status.code().unwrap_or(-1),
                stderr.trim()
            )));
        }
        Ok(stdout)
    }

    fn git(&self, args: &[&str]) -> Result<std::process::Output> {
        let out = std::process::Command::new("git")
            .arg("-C")
            .arg(&self.root)
            .args(args)
            .output()?;
        Ok(out)
    }
}

/// slug 白名单:非空、≤128 字符、仅 Unicode 字母数字与 `._-`(天然排除路径分隔符与控制字符),
/// 且不得全为 `.`(`.`/`..` 会把文件写到 books/ 本身或其上级)。所有拼接进路径的 slug 必经此处。
pub(crate) fn validate_slug(slug: &str) -> Result<&str> {
    let ok = !slug.is_empty()
        && slug.chars().count() <= 128
        && slug
            .chars()
            .all(|c| c.is_alphanumeric() || matches!(c, '.' | '_' | '-'))
        && !slug.chars().all(|c| c == '.');
    if ok {
        Ok(slug)
    } else {
        Err(CoreError::InvalidInput(format!("unsafe slug {slug:?}")))
    }
}

/// 原子写:同目录临时文件 + fsync + rename。中断不会截断上一份好文件;失败不留残片
/// (NamedTempFile 在 persist 失败/创建失败路径上 drop 即删除)。
pub(crate) fn atomic_write(path: &Path, content: &str) -> Result<()> {
    let dir = path
        .parent()
        .ok_or_else(|| CoreError::Other(format!("no parent dir for {}", path.display())))?;
    let mut tmp = tempfile::NamedTempFile::new_in(dir)?;
    tmp.write_all(content.as_bytes())?;
    tmp.as_file().sync_all()?;
    tmp.persist(path).map_err(|e| CoreError::Io(e.error))?;
    Ok(())
}

/// 取 `heading` 之后到下一个 `## ` 或文件尾的内容(去首尾空白)。
fn extract_section(text: &str, heading: &str) -> String {
    let Some(start) = text.find(heading) else {
        return String::new();
    };
    let body = &text[start + heading.len()..];
    let end = body.find("\n## ").unwrap_or(body.len());
    body[..end].trim().to_string()
}

#[cfg(test)]
mod tests {
    #[test]
    fn profile_summary_takes_the_first_two_sections_with_headings() {
        let dir = tempfile::tempdir().unwrap();
        let m = super::MemoryStore::init(dir.path()).unwrap();
        std::fs::write(
            dir.path().join("profile.md"),
            "# 学习者画像\n\n## 知识背景\n\n经济学本科\n\n## 已掌握概念\n\n- 供需\n\n## 误区模式\n\n混淆弹性与斜率\n\n## 个人情境\n\n研究者\n",
        )
        .unwrap();
        let summary = m.profile_summary().unwrap();
        assert_eq!(summary, "## 知识背景\n经济学本科\n\n## 已掌握概念\n- 供需");
        assert!(!summary.contains("误区模式") && !summary.contains("研究者"));
    }

    #[test]
    fn profile_sections_round_trip_preserving_unknown_sections_and_summary_by_type() {
        use crate::models::BookType;
        let dir = tempfile::tempdir().unwrap();
        let m = super::MemoryStore::init(dir.path()).unwrap();
        std::fs::write(
            dir.path().join("profile.md"),
            "# 学习者画像\n\n## 知识背景\n\n经济学本科\n\n## 已掌握概念\n\n- 供需\n\n## 误区模式\n\n混淆弹性与斜率\n\n## 个人情境\n\n研究者\n\n## 自定义备注\n\n保留我\n",
        )
        .unwrap();
        let sections = m.profile_sections().unwrap();
        assert_eq!(
            sections,
            super::ProfileSections {
                background: "经济学本科".into(),
                mastered: "- 供需".into(),
                pitfalls: "混淆弹性与斜率".into(),
                context: "研究者".into(),
            }
        );
        m.write_profile_sections(&super::ProfileSections {
            background: "经济学博士".into(),
            mastered: String::new(),
            pitfalls: sections.pitfalls.clone(),
            context: "在做定价研究".into(),
        })
        .unwrap();
        let text = std::fs::read_to_string(dir.path().join("profile.md")).unwrap();
        assert!(text.starts_with("# 学习者画像\n"));
        assert!(text.contains("## 知识背景\n\n经济学博士\n"));
        assert!(text.contains("## 已掌握概念\n\n(待补充)\n"));
        assert!(text.contains("## 自定义备注\n\n保留我\n"), "{text}");
        assert!(!dir.path().join("profile.md.tmp").exists());
        let again = m.profile_sections().unwrap();
        assert_eq!(
            (
                again.background.as_str(),
                again.mastered.as_str(),
                again.context.as_str()
            ),
            ("经济学博士", "(待补充)", "在做定价研究")
        );
        // 摘要:人文只前两节;教材/方法论追加个人情境
        let humanities = m.profile_summary_for(BookType::Humanities).unwrap();
        assert!(humanities.contains("## 知识背景") && !humanities.contains("个人情境"));
        let textbook = m.profile_summary_for(BookType::Textbook).unwrap();
        assert!(
            textbook.ends_with("## 个人情境\n在做定价研究"),
            "{textbook}"
        );
    }

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
        let v = if pass {
            "pass_suggested"
        } else {
            "relearn_suggested"
        };
        serde_json::from_str(&format!(
            r#"{{
            "verdict":"{v}","scores":{{"accuracy":4,"completeness":3,"clarity":5}},
            "summary":"总评","final_restatement":"弹性是相对变化率",
            "weak_points":[{{"title":"弹性vs斜率","detail":"混淆概念"}}],
            "observation_note":"倾向用比喻"}}"#
        ))
        .unwrap()
    }

    #[test]
    fn apply_eval_writes_block_file_and_accumulates() {
        let dir = tempfile::tempdir().unwrap();
        let m = super::MemoryStore::init(dir.path()).unwrap();
        m.ensure_book("microecon", "微观经济学").unwrap();
        m.apply_eval(
            "microecon",
            3,
            "供需弹性",
            "elasticity",
            &sample_eval(false),
            false,
            "k1",
            "2026-08-29",
        )
        .unwrap();
        m.apply_eval(
            "microecon",
            3,
            "供需弹性",
            "elasticity",
            &sample_eval(true),
            true,
            "k2",
            "2026-08-30",
        )
        .unwrap();
        let f =
            std::fs::read_to_string(dir.path().join("books/microecon/blocks/0003-elasticity.md"))
                .unwrap();
        assert!(f.contains("block_id: 3"), "frontmatter block_id");
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
        m.sync_weakpoints(
            "microecon",
            &[("供需弹性".into(), "弹性vs斜率".into(), "2026-08-30".into())],
            &[(
                "消费者剩余".into(),
                "混淆总剩余".into(),
                "2026-08-28".into(),
            )],
        )
        .unwrap();
        let f = std::fs::read_to_string(dir.path().join("books/microecon/_weakpoints.md")).unwrap();
        let (open_pos, fixed_pos) = (f.find("## 待考").unwrap(), f.find("## 已修复").unwrap());
        assert!(
            f.find("弹性vs斜率").unwrap() > open_pos && f.find("弹性vs斜率").unwrap() < fixed_pos
        );
        assert!(f.find("混淆总剩余").unwrap() > fixed_pos);
    }
    #[test]
    fn sync_map_regenerates_mirror() {
        let dir = tempfile::tempdir().unwrap();
        let m = super::MemoryStore::init(dir.path()).unwrap();
        m.ensure_book("microecon", "微观经济学").unwrap();
        m.sync_map(
            "microecon",
            "微观经济学",
            &[
                ("供需弹性".into(), "passed".into()),
                ("消费者剩余".into(), "unlearned".into()),
            ],
        )
        .unwrap();
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
            .arg("-C")
            .arg(dir.path())
            .args(["log", "--oneline"])
            .output()
            .unwrap();
        assert!(String::from_utf8_lossy(&log.stdout).contains("供需弹性"));
    }

    #[test]
    fn rejects_unsafe_slugs() {
        let dir = tempfile::tempdir().unwrap();
        let m = super::MemoryStore::init(dir.path()).unwrap();
        for bad in [
            "../evil", "a/b", "a\\b", "", ".", "..", "...", "x\u{0}y", "tab\tx",
        ] {
            let err = m.ensure_book(bad, "T").unwrap_err();
            assert!(
                matches!(err, crate::CoreError::InvalidInput(_)),
                "{bad:?} -> {err}"
            );
        }
        assert!(!dir.path().join("../evil").exists());
        assert!(!dir.path().join("books/a").exists());
        let e = m
            .apply_eval(
                "ok",
                1,
                "T",
                "../x",
                &sample_eval(true),
                true,
                "k",
                "2026-09-05",
            )
            .unwrap_err();
        assert!(matches!(e, crate::CoreError::InvalidInput(_)));
        assert!(matches!(
            m.sync_map("../x", "T", &[]).unwrap_err(),
            crate::CoreError::InvalidInput(_)
        ));
        assert!(matches!(
            m.sync_weakpoints("a/b", &[], &[]).unwrap_err(),
            crate::CoreError::InvalidInput(_)
        ));
        // 合法:Unicode 字母数字与 ._-
        m.ensure_book("微观经济学-2nd_ed.v1", "T").unwrap();
    }

    #[test]
    fn atomic_write_leaves_no_temp_files() {
        let dir = tempfile::tempdir().unwrap();
        let m = super::MemoryStore::init(dir.path()).unwrap();
        m.ensure_book("microecon", "微观经济学").unwrap();
        m.apply_eval(
            "microecon",
            3,
            "供需弹性",
            "elasticity",
            &sample_eval(true),
            true,
            "k1",
            "2026-09-05",
        )
        .unwrap();
        m.sync_map(
            "microecon",
            "微观经济学",
            &[("供需弹性".into(), "passed".into())],
        )
        .unwrap();
        for entry in std::fs::read_dir(dir.path().join("books/microecon/blocks")).unwrap() {
            let name = entry.unwrap().file_name().to_string_lossy().into_owned();
            assert!(name.ends_with(".md"), "残留临时文件: {name}");
        }
        for entry in std::fs::read_dir(dir.path().join("books/microecon")).unwrap() {
            let name = entry.unwrap().file_name().to_string_lossy().into_owned();
            assert!(name.ends_with(".md") || name == "blocks", "残留: {name}");
        }
    }

    #[test]
    fn atomic_write_keeps_original_when_write_fails() {
        // root 不受目录权限约束,无法模拟写失败
        if unsafe { libc::geteuid() } == 0 {
            return;
        }
        use std::os::unix::fs::PermissionsExt;
        let dir = tempfile::tempdir().unwrap();
        let m = super::MemoryStore::init(dir.path()).unwrap();
        m.ensure_book("microecon", "微观经济学").unwrap();
        m.apply_eval(
            "microecon",
            3,
            "供需弹性",
            "elasticity",
            &sample_eval(false),
            false,
            "k1",
            "2026-09-04",
        )
        .unwrap();
        let path = dir.path().join("books/microecon/blocks/0003-elasticity.md");
        let original = std::fs::read(&path).unwrap();
        let blocks = dir.path().join("books/microecon/blocks");
        std::fs::set_permissions(&blocks, std::fs::Permissions::from_mode(0o555)).unwrap();
        let result = m.apply_eval(
            "microecon",
            3,
            "供需弹性",
            "elasticity",
            &sample_eval(true),
            true,
            "k2",
            "2026-09-05",
        );
        let after = std::fs::read(&path).unwrap();
        let leftovers: Vec<_> = std::fs::read_dir(&blocks)
            .unwrap()
            .map(|e| e.unwrap().file_name().to_string_lossy().into_owned())
            .filter(|n| !n.ends_with(".md"))
            .collect();
        std::fs::set_permissions(&blocks, std::fs::Permissions::from_mode(0o755)).unwrap();
        assert!(result.is_err());
        assert_eq!(after, original, "原文件必须逐字节不变");
        assert!(leftovers.is_empty(), "残留: {leftovers:?}");
    }

    #[test]
    fn apply_eval_same_key_is_noop() {
        let dir = tempfile::tempdir().unwrap();
        let m = super::MemoryStore::init(dir.path()).unwrap();
        m.ensure_book("microecon", "微观经济学").unwrap();
        for _ in 0..3 {
            m.apply_eval(
                "microecon",
                3,
                "供需弹性",
                "elasticity",
                &sample_eval(true),
                true,
                "verdict:5:req-1:block_eval",
                "2026-09-05",
            )
            .unwrap();
        }
        let f =
            std::fs::read_to_string(dir.path().join("books/microecon/blocks/0003-elasticity.md"))
                .unwrap();
        assert_eq!(f.matches("第1次").count(), 1, "{f}");
        assert_eq!(f.matches("倾向用比喻").count(), 1, "{f}");
        assert!(f.contains("<!-- verdict:5:req-1:block_eval -->"));
    }

    #[test]
    fn apply_eval_passed_overrides_verdict() {
        let dir = tempfile::tempdir().unwrap();
        let m = super::MemoryStore::init(dir.path()).unwrap();
        m.ensure_book("microecon", "微观经济学").unwrap();
        // AI 建议重学,用户判定通过 → md 以用户判定为准
        m.apply_eval(
            "microecon",
            3,
            "供需弹性",
            "elasticity",
            &sample_eval(false),
            true,
            "k1",
            "2026-09-05",
        )
        .unwrap();
        let f =
            std::fs::read_to_string(dir.path().join("books/microecon/blocks/0003-elasticity.md"))
                .unwrap();
        assert!(f.contains("status: passed") && f.contains("passed_at: 2026-09-05"));
        assert!(f.contains("弹性是相对变化率"), "终稿按通过写入: {f}");
        assert!(f.contains("通过建议 ✓"));
    }
}
