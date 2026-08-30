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

    fn git(&self, args: &[&str]) -> Result<std::process::Output> {
        let out = std::process::Command::new("git")
            .arg("-C").arg(&self.root)
            .args(args)
            .output()?;
        Ok(out)
    }
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
}
