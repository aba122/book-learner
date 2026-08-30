use std::path::PathBuf;
use crate::{CoreError, Result};

#[derive(Debug, Clone, Copy, PartialEq)]
pub enum Role { User, Assistant }

pub struct CompletionRequest {
    pub system: String,
    pub messages: Vec<(Role, String)>,
    pub workdir: PathBuf,
    pub read_only: bool,
    pub timeout_secs: u64,
}

pub trait AiProvider {
    fn complete(&self, req: &CompletionRequest) -> Result<String>;
}

pub struct CodexCliProvider {
    pub bin: PathBuf,
    pub extra_args: Vec<String>,
}

fn render_prompt(req: &CompletionRequest) -> String {
    let mut p = req.system.clone();
    if !req.messages.is_empty() {
        p.push_str("\n\n=== 对话记录 ===\n");
        for (role, text) in &req.messages {
            let who = match role { Role::User => "用户", Role::Assistant => "学生" };
            p.push_str(&format!("{who}:{text}\n"));
        }
        p.push_str("\n(请给出你的下一条回复)");
    }
    p
}

impl AiProvider for CodexCliProvider {
    fn complete(&self, req: &CompletionRequest) -> Result<String> {
        let tmp = tempfile::NamedTempFile::new().map_err(CoreError::Io)?;
        let sandbox = if req.read_only { "read-only" } else { "workspace-write" };
        let mut child = std::process::Command::new(&self.bin)
            .arg("exec")
            .arg("-C").arg(&req.workdir)
            .arg("--sandbox").arg(sandbox)
            .arg("--output-last-message").arg(tmp.path())
            .args(&self.extra_args)
            .arg(render_prompt(req))
            .stdout(std::process::Stdio::null())
            .stderr(std::process::Stdio::piped())
            .spawn()
            .map_err(|e| CoreError::Ai(format!("spawn {}: {e}", self.bin.display())))?;

        let deadline = std::time::Instant::now() + std::time::Duration::from_secs(req.timeout_secs);
        let status = loop {
            match child.try_wait().map_err(CoreError::Io)? {
                Some(st) => break st,
                None if std::time::Instant::now() >= deadline => {
                    let _ = child.kill();
                    let _ = child.wait();
                    return Err(CoreError::Ai(format!("timeout after {}s", req.timeout_secs)));
                }
                None => std::thread::sleep(std::time::Duration::from_millis(100)),
            }
        };
        if !status.success() {
            let mut err = String::new();
            if let Some(mut se) = child.stderr.take() {
                use std::io::Read;
                let _ = se.read_to_string(&mut err);
            }
            let tail: String = err.chars().rev().take(400).collect::<Vec<_>>().into_iter().rev().collect();
            return Err(CoreError::Ai(format!("codex exit {status}: {tail}")));
        }
        let reply = std::fs::read_to_string(tmp.path()).map_err(CoreError::Io)?;
        if reply.trim().is_empty() {
            return Err(CoreError::Ai("empty last message".into()));
        }
        Ok(reply)
    }
}

#[cfg(test)]
mod tests {
    fn write_script(dir: &std::path::Path, name: &str, body: &str) -> std::path::PathBuf {
        use std::os::unix::fs::PermissionsExt;
        let p = dir.join(name);
        std::fs::write(&p, body).unwrap();
        std::fs::set_permissions(&p, std::fs::Permissions::from_mode(0o755)).unwrap();
        p
    }
    fn fake_codex(dir: &std::path::Path, reply: &str) -> std::path::PathBuf {
        write_script(dir, "fake-codex", &format!(
"#!/bin/bash
while [[ $# -gt 0 ]]; do
  if [[ \"$1\" == \"--output-last-message\" ]]; then out=\"$2\"; shift; fi; shift; done
printf '%s' '{reply}' > \"$out\"
"))
    }

    #[test]
    fn codex_provider_returns_last_message() {
        let dir = tempfile::tempdir().unwrap();
        let bin = fake_codex(dir.path(), "你好,我是学生");
        let p = super::CodexCliProvider { bin, extra_args: vec![] };
        let req = super::CompletionRequest {
            system: "s".into(),
            messages: vec![(super::Role::User, "讲弹性".into())],
            workdir: dir.path().to_path_buf(), read_only: true, timeout_secs: 10 };
        assert_eq!(super::AiProvider::complete(&p, &req).unwrap(), "你好,我是学生");
    }
    #[test]
    fn codex_provider_times_out() {
        let dir = tempfile::tempdir().unwrap();
        let bin = write_script(dir.path(), "slow-codex", "#!/bin/bash\nsleep 30\n");
        let prov = super::CodexCliProvider { bin, extra_args: vec![] };
        let req = super::CompletionRequest { system: "".into(), messages: vec![],
            workdir: dir.path().to_path_buf(), read_only: true, timeout_secs: 1 };
        let t0 = std::time::Instant::now();
        assert!(super::AiProvider::complete(&prov, &req).is_err());
        assert!(t0.elapsed().as_secs() < 5, "kill 应及时发生");
    }
    #[test]
    #[ignore] // 需要本机已登录 codex;手动 cargo test codex_real_smoke -- --ignored
    fn codex_real_smoke() {
        let dir = tempfile::tempdir().unwrap();
        let p = super::CodexCliProvider { bin: "codex".into(), extra_args: vec![] };
        let req = super::CompletionRequest { system: "只回答一个词".into(),
            messages: vec![(super::Role::User, "1+1=?".into())],
            workdir: dir.path().to_path_buf(), read_only: true, timeout_secs: 120 };
        let out = super::AiProvider::complete(&p, &req).unwrap();
        println!("codex real reply: {out}");
        assert!(!out.is_empty());
    }
}
