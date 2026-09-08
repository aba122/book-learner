use crate::{CoreError, Result};
use std::io::Read;
use std::path::PathBuf;
use std::sync::mpsc;
use std::time::{Duration, Instant};

#[derive(Debug, Clone, Copy, PartialEq)]
pub enum Role {
    User,
    Assistant,
}

#[derive(Debug, Clone)]
pub struct CompletionRequest {
    pub system: String,
    pub messages: Vec<(Role, String)>,
    pub workdir: PathBuf,
    pub read_only: bool,
    /// 幂等请求 id(ADR-0002 命名空间);由 orchestrate 填入,CodexCliProvider 不使用,Mock 用它分发应答
    pub request_id: String,
    pub timeout_secs: u64,
}

/// 渲染后 prompt 的字节上限:prompt 经单个 argv 传入,Linux MAX_ARG_STRLEN=128 KiB(macOS 更严),
/// 取 100 KiB 留余量;超限为 InvalidInput(不重试)。
pub const MAX_PROMPT_BYTES: usize = 100 * 1024;
/// `--output-last-message` 文件的字节上限(先看 metadata 再读)
pub const MAX_OUTPUT_BYTES: u64 = 1024 * 1024;
/// `test_connection` 的超时
const TEST_CONNECTION_TIMEOUT_SECS: u64 = 10;

#[derive(Debug, Clone, PartialEq)]
pub struct ConnectionReport {
    pub version: String,
    pub latency_ms: u64,
}

pub trait AiProvider {
    fn complete(&self, req: &CompletionRequest) -> Result<String>;
}

pub struct CodexCliProvider {
    pub bin: PathBuf,
    pub extra_args: Vec<String>,
}

/// stderr 只保留末尾这么多字节(有界缓冲,防止噪声子进程撑爆内存)
const STDERR_TAIL_BYTES: usize = 4096;
/// 错误信息里附带的 stderr 尾部字符数
const ERROR_TAIL_CHARS: usize = 400;
/// 等待 stderr 排空线程收尾的上限;超过则放弃(线程读到 EOF 会自行结束)
const DRAIN_JOIN_TIMEOUT: Duration = Duration::from_secs(2);

fn render_prompt(req: &CompletionRequest) -> String {
    let mut p = req.system.clone();
    if !req.messages.is_empty() {
        p.push_str("\n\n=== 对话记录 ===\n");
        for (role, text) in &req.messages {
            let who = match role {
                Role::User => "用户",
                Role::Assistant => "学生",
            };
            p.push_str(&format!("{who}:{text}\n"));
        }
        p.push_str("\n(请给出你的下一条回复)");
    }
    p
}

/// 终止整个进程组(子进程经 process_group(0) 成为组长)。
/// 注:组长被回收后 pgid 理论上可被复用;Linux 上该窗口可忽略,勿"修复"掉此调用。
#[cfg(unix)]
pub(crate) fn kill_process_group(leader_pid: u32) {
    // SAFETY: 纯系统调用,参数为进程组 id 与信号常量;失败(ESRCH 等)忽略即可。
    unsafe {
        libc::kill(-(leader_pid as i32), libc::SIGKILL);
    }
}
#[cfg(not(unix))]
pub(crate) fn kill_process_group(_leader_pid: u32) {}

/// 在独立线程持续读取管道到有界尾部缓冲,避免子进程因管道写满而阻塞(被误判为超时)。
fn spawn_stderr_drain<R: Read + Send + 'static>(stderr: Option<R>) -> mpsc::Receiver<Vec<u8>> {
    let (tx, rx) = mpsc::channel::<Vec<u8>>();
    std::thread::spawn(move || {
        let mut tail: Vec<u8> = Vec::new();
        if let Some(mut se) = stderr {
            let mut buf = [0u8; 4096];
            loop {
                match se.read(&mut buf) {
                    Ok(0) | Err(_) => break,
                    Ok(n) => {
                        tail.extend_from_slice(&buf[..n]);
                        if tail.len() > STDERR_TAIL_BYTES {
                            let cut = tail.len() - STDERR_TAIL_BYTES;
                            tail.drain(..cut);
                        }
                    }
                }
            }
        }
        let _ = tx.send(tail);
    });
    rx
}

fn last_chars(text: &str, n: usize) -> String {
    let total = text.chars().count();
    text.chars().skip(total.saturating_sub(n)).collect()
}

/// spawn 遇 ETXTBSY(可执行文件正被写入/被并行 fork 的子进程短暂持有写 fd)时有界重试。
fn spawn_with_retry(cmd: &mut std::process::Command) -> std::io::Result<std::process::Child> {
    const ATTEMPTS: usize = 20;
    let mut last = None;
    for _ in 0..ATTEMPTS {
        match cmd.spawn() {
            Err(e) if e.kind() == std::io::ErrorKind::ExecutableFileBusy => {
                last = Some(e);
                std::thread::sleep(Duration::from_millis(10));
            }
            other => return other,
        }
    }
    Err(last.expect("at least one attempt"))
}

/// 轮询等待子进程,超时则整组 SIGKILL 并回收;正常退出后同样补杀进程组(不留孙进程)。
pub(crate) fn wait_with_timeout(
    child: &mut std::process::Child,
    timeout_secs: u64,
) -> Result<std::process::ExitStatus> {
    let leader = child.id();
    let deadline = Instant::now() + Duration::from_secs(timeout_secs);
    let status = loop {
        match child.try_wait().map_err(CoreError::Io)? {
            Some(st) => break st,
            None if Instant::now() >= deadline => {
                kill_process_group(leader);
                let _ = child.wait();
                return Err(CoreError::Ai(format!("timeout after {timeout_secs}s")));
            }
            None => std::thread::sleep(Duration::from_millis(100)),
        }
    };
    // 正常退出也补杀进程组:codex 若留下孙进程,管道不会关闭,排空线程永不 EOF
    kill_process_group(leader);
    Ok(status)
}

fn resolve_binary(bin: &std::path::Path) -> Option<PathBuf> {
    if bin.components().count() > 1 {
        return bin.is_file().then(|| bin.to_path_buf());
    }
    let path = std::env::var_os("PATH")?;
    std::env::split_paths(&path)
        .map(|dir| dir.join(bin))
        .find(|candidate| candidate.is_file())
}

impl CodexCliProvider {
    /// 配置校验:可执行文件可解析(绝对/相对路径须存在;裸名在 PATH 中查找)、工作目录存在。
    pub fn validate(&self, workdir: &std::path::Path) -> Result<()> {
        if resolve_binary(&self.bin).is_none() {
            return Err(CoreError::InvalidInput(format!(
                "codex binary not found: {}",
                self.bin.display()
            )));
        }
        if !workdir.is_dir() {
            return Err(CoreError::InvalidInput(format!(
                "workdir not found: {}",
                workdir.display()
            )));
        }
        Ok(())
    }

    /// 连接测试:`bin --version`,10s 超时,同样的进程组处理;返回首行版本与耗时。
    pub fn test_connection(&self) -> Result<ConnectionReport> {
        let started = Instant::now();
        let mut cmd = std::process::Command::new(&self.bin);
        cmd.arg("--version")
            .stdin(std::process::Stdio::null())
            .stdout(std::process::Stdio::piped())
            .stderr(std::process::Stdio::piped());
        #[cfg(unix)]
        {
            use std::os::unix::process::CommandExt;
            cmd.process_group(0);
        }
        let mut child = spawn_with_retry(&mut cmd)
            .map_err(|e| CoreError::Ai(format!("spawn {}: {e}", self.bin.display())))?;
        let out_rx = spawn_stderr_drain(child.stdout.take());
        let err_rx = spawn_stderr_drain(child.stderr.take());
        let status = wait_with_timeout(&mut child, TEST_CONNECTION_TIMEOUT_SECS)?;
        let stdout = out_rx.recv_timeout(DRAIN_JOIN_TIMEOUT).unwrap_or_default();
        let stderr = err_rx.recv_timeout(DRAIN_JOIN_TIMEOUT).unwrap_or_default();
        if !status.success() {
            let text = String::from_utf8_lossy(&stderr);
            return Err(CoreError::Ai(format!(
                "codex --version exit {status}: {}",
                last_chars(&text, ERROR_TAIL_CHARS)
            )));
        }
        let text = String::from_utf8_lossy(&stdout);
        let version = text.lines().next().unwrap_or("").trim().to_string();
        if version.is_empty() {
            return Err(CoreError::Ai("codex --version printed nothing".into()));
        }
        Ok(ConnectionReport {
            version,
            latency_ms: started.elapsed().as_millis() as u64,
        })
    }
}

impl AiProvider for CodexCliProvider {
    fn complete(&self, req: &CompletionRequest) -> Result<String> {
        let prompt = render_prompt(req);
        if prompt.len() > MAX_PROMPT_BYTES {
            return Err(CoreError::InvalidInput(format!(
                "prompt exceeds {MAX_PROMPT_BYTES} bytes: {}",
                prompt.len()
            )));
        }
        // NamedTempFile 在所有返回路径上 drop 即删除,临时输出不残留
        let tmp = tempfile::NamedTempFile::new().map_err(CoreError::Io)?;
        let sandbox = if req.read_only {
            "read-only"
        } else {
            "workspace-write"
        };
        let mut cmd = std::process::Command::new(&self.bin);
        cmd.arg("exec")
            .arg("--skip-git-repo-check")
            .arg("-C")
            .arg(&req.workdir)
            .arg("--sandbox")
            .arg(sandbox)
            .arg("--output-last-message")
            .arg(tmp.path())
            .args(&self.extra_args)
            .arg(prompt)
            .stdout(std::process::Stdio::null())
            .stderr(std::process::Stdio::piped());
        #[cfg(unix)]
        {
            use std::os::unix::process::CommandExt;
            cmd.process_group(0); // 独立进程组:超时/收尾可整组终止,不留孙进程
        }
        let mut child = spawn_with_retry(&mut cmd)
            .map_err(|e| CoreError::Ai(format!("spawn {}: {e}", self.bin.display())))?;
        let tail_rx = spawn_stderr_drain(child.stderr.take());
        let status = wait_with_timeout(&mut child, req.timeout_secs)?;
        let tail = tail_rx.recv_timeout(DRAIN_JOIN_TIMEOUT).unwrap_or_default();

        if !status.success() {
            let text = String::from_utf8_lossy(&tail);
            return Err(CoreError::Ai(format!(
                "codex exit {status}: {}",
                last_chars(&text, ERROR_TAIL_CHARS)
            )));
        }
        let size = std::fs::metadata(tmp.path()).map_err(CoreError::Io)?.len();
        if size > MAX_OUTPUT_BYTES {
            return Err(CoreError::Ai(format!(
                "output exceeds {MAX_OUTPUT_BYTES} bytes: {size}"
            )));
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
        write_script(
            dir,
            "fake-codex",
            &format!(
                "#!/bin/bash
while [[ $# -gt 0 ]]; do
  if [[ \"$1\" == \"--output-last-message\" ]]; then out=\"$2\"; shift; fi; shift; done
printf '%s' '{reply}' > \"$out\"
"
            ),
        )
    }

    #[test]
    fn codex_provider_returns_last_message() {
        let dir = tempfile::tempdir().unwrap();
        let bin = fake_codex(dir.path(), "你好,我是学生");
        let p = super::CodexCliProvider {
            bin,
            extra_args: vec![],
        };
        let req = super::CompletionRequest {
            system: "s".into(),
            messages: vec![(super::Role::User, "讲弹性".into())],
            workdir: dir.path().to_path_buf(),
            read_only: true,
            request_id: String::new(),
            timeout_secs: 10,
        };
        assert_eq!(
            super::AiProvider::complete(&p, &req).unwrap(),
            "你好,我是学生"
        );
    }
    #[test]
    fn codex_provider_skips_git_repo_check_for_managed_workdir() {
        let dir = tempfile::tempdir().unwrap();
        let bin = write_script(
            dir.path(),
            "trust-check-codex",
            r#"#!/bin/bash
skip_git_check=0
while [[ $# -gt 0 ]]; do
  if [[ "$1" == "--skip-git-repo-check" ]]; then skip_git_check=1; fi
  if [[ "$1" == "--output-last-message" ]]; then out="$2"; shift; fi
  shift
done
if [[ "$skip_git_check" != "1" ]]; then
  echo "missing --skip-git-repo-check" >&2
  exit 42
fi
printf '%s' 'ok' > "$out"
"#,
        );
        let provider = super::CodexCliProvider {
            bin,
            extra_args: vec![],
        };
        let request = super::CompletionRequest {
            system: "s".into(),
            messages: vec![],
            workdir: dir.path().to_path_buf(),
            read_only: true,
            request_id: String::new(),
            timeout_secs: 10,
        };

        assert_eq!(
            super::AiProvider::complete(&provider, &request).unwrap(),
            "ok"
        );
    }
    #[test]
    fn codex_provider_times_out() {
        let dir = tempfile::tempdir().unwrap();
        let bin = write_script(dir.path(), "slow-codex", "#!/bin/bash\nsleep 30\n");
        let prov = super::CodexCliProvider {
            bin,
            extra_args: vec![],
        };
        let req = super::CompletionRequest {
            system: "".into(),
            messages: vec![],
            workdir: dir.path().to_path_buf(),
            read_only: true,
            request_id: String::new(),
            timeout_secs: 1,
        };
        let t0 = std::time::Instant::now();
        assert!(super::AiProvider::complete(&prov, &req).is_err());
        assert!(t0.elapsed().as_secs() < 5, "kill 应及时发生");
    }
    #[test]
    #[ignore] // 需要本机已登录 codex;手动 cargo test codex_real_smoke -- --ignored
    fn codex_real_smoke() {
        let dir = tempfile::tempdir().unwrap();
        let p = super::CodexCliProvider {
            bin: "codex".into(),
            extra_args: vec![],
        };
        let req = super::CompletionRequest {
            system: "只回答一个词".into(),
            messages: vec![(super::Role::User, "1+1=?".into())],
            workdir: dir.path().to_path_buf(),
            read_only: true,
            request_id: String::new(),
            timeout_secs: 120,
        };
        let out = super::AiProvider::complete(&p, &req).unwrap();
        println!("codex real reply: {out}");
        assert!(!out.is_empty());
    }

    fn read_tail(err: &crate::CoreError) -> String {
        err.to_string()
    }

    #[test]
    fn stderr_larger_than_pipe_does_not_hang() {
        let dir = tempfile::tempdir().unwrap();
        let bin = write_script(
            dir.path(),
            "noisy-codex",
            "#!/bin/bash\nhead -c 2097152 /dev/zero | tr '\\0' 'e' >&2\nexit 3\n",
        );
        let prov = super::CodexCliProvider {
            bin,
            extra_args: vec![],
        };
        let req = super::CompletionRequest {
            system: "".into(),
            messages: vec![],
            workdir: dir.path().to_path_buf(),
            read_only: true,
            request_id: String::new(),
            timeout_secs: 20,
        };
        let t0 = std::time::Instant::now();
        let err = super::AiProvider::complete(&prov, &req).unwrap_err();
        assert!(t0.elapsed().as_secs() < 10, "stderr 洪泛不得阻塞到超时");
        let text = read_tail(&err);
        assert!(text.contains("exit status: 3"), "{text}");
        assert!(text.ends_with(&"e".repeat(50)), "应含 stderr 尾部: {text}");
    }

    /// 进程已不存在或已成僵尸(等待回收)即视为"已终止"。
    fn descendant_gone(pid: i32) -> bool {
        #[cfg(target_os = "linux")]
        {
            match std::fs::read_to_string(format!("/proc/{pid}/stat")) {
                Err(_) => true,
                Ok(stat) => stat
                    .split(") ")
                    .nth(1)
                    .is_none_or(|rest| rest.starts_with('Z')),
            }
        }
        #[cfg(not(target_os = "linux"))]
        {
            // macOS 无 /proc:用 ps 读状态列,进程不存在(无输出)或为僵尸(Z)均视为已终止
            match std::process::Command::new("ps")
                .args(["-o", "stat=", "-p", &pid.to_string()])
                .output()
            {
                Err(_) => true,
                Ok(out) => {
                    let text = String::from_utf8_lossy(&out.stdout);
                    let stat = text.trim();
                    stat.is_empty() || stat.starts_with('Z')
                }
            }
        }
    }

    #[test]
    fn timeout_kills_descendants() {
        let dir = tempfile::tempdir().unwrap();
        let bin = write_script(
            dir.path(),
            "forking-codex",
            "#!/bin/bash\nsleep 60 &\necho $! > \"$(dirname \"$0\")/marker\"\nwait\n",
        );
        let prov = super::CodexCliProvider {
            bin,
            extra_args: vec![],
        };
        // 整套用例并行且机器有负载时(macOS 实测),bash 可能晚于超时才写 marker:超时先到会把还没起来的脚本
        // 一起杀掉,marker 缺失并不说明"没杀干净",只说明环境太慢。逐级放大超时重试,直到 marker 出现再断言。
        let marker = dir.path().join("marker");
        let mut pid: Option<i32> = None;
        for timeout_secs in [3u64, 6, 12] {
            let req = super::CompletionRequest {
                system: "".into(),
                messages: vec![],
                workdir: dir.path().to_path_buf(),
                read_only: true,
                request_id: String::new(),
                timeout_secs,
            };
            assert!(super::AiProvider::complete(&prov, &req).is_err());
            if let Ok(text) = std::fs::read_to_string(&marker) {
                pid = Some(text.trim().parse().unwrap());
                break;
            }
            eprintln!("marker missing after {timeout_secs}s timeout; retrying with a longer one");
        }
        let pid = pid.expect("脚本在 12s 内都没能启动并写 marker,环境异常");
        // SIGKILL 后的孙进程可能短暂为僵尸(等 init 回收),kill -0 对僵尸仍成功,故轮询进程状态
        let deadline = std::time::Instant::now() + std::time::Duration::from_secs(3);
        loop {
            if descendant_gone(pid) {
                break;
            }
            assert!(
                std::time::Instant::now() < deadline,
                "孙进程 {pid} 未被进程组终止"
            );
            std::thread::sleep(std::time::Duration::from_millis(50));
        }
    }

    #[test]
    fn stderr_tail_is_bounded() {
        let dir = tempfile::tempdir().unwrap();
        let bin = write_script(
            dir.path(),
            "chatty-codex",
            "#!/bin/bash\nhead -c 5000 /dev/zero | tr '\\0' 'x' >&2\nexit 2\n",
        );
        let prov = super::CodexCliProvider {
            bin,
            extra_args: vec![],
        };
        let req = super::CompletionRequest {
            system: "".into(),
            messages: vec![],
            workdir: dir.path().to_path_buf(),
            read_only: true,
            request_id: String::new(),
            timeout_secs: 10,
        };
        let err = super::AiProvider::complete(&prov, &req).unwrap_err();
        assert!(read_tail(&err).chars().count() < 600);
    }

    #[test]
    fn rejects_oversized_prompt_before_spawn() {
        let dir = tempfile::tempdir().unwrap();
        let bin = write_script(
            dir.path(),
            "marker-codex",
            "#!/bin/bash\ntouch \"$(dirname \"$0\")/called\"\nwhile [[ $# -gt 0 ]]; do if [[ \"$1\" == \"--output-last-message\" ]]; then out=\"$2\"; shift; fi; shift; done\nprintf ok > \"$out\"\n",
        );
        let prov = super::CodexCliProvider {
            bin,
            extra_args: vec![],
        };
        let req = super::CompletionRequest {
            system: "a".repeat(super::MAX_PROMPT_BYTES + 1),
            messages: vec![],
            workdir: dir.path().to_path_buf(),
            read_only: true,
            request_id: String::new(),
            timeout_secs: 10,
        };
        let err = super::AiProvider::complete(&prov, &req).unwrap_err();
        assert!(matches!(err, crate::CoreError::InvalidInput(_)), "{err}");
        assert!(
            !dir.path().join("called").exists(),
            "超限 prompt 不得 spawn"
        );
    }

    #[test]
    fn prompt_exactly_at_limit_spawns() {
        let dir = tempfile::tempdir().unwrap();
        let bin = fake_codex(dir.path(), "ok");
        let prov = super::CodexCliProvider {
            bin,
            extra_args: vec![],
        };
        let req = super::CompletionRequest {
            system: "a".repeat(super::MAX_PROMPT_BYTES),
            messages: vec![],
            workdir: dir.path().to_path_buf(),
            read_only: true,
            request_id: String::new(),
            timeout_secs: 10,
        };
        assert_eq!(super::AiProvider::complete(&prov, &req).unwrap(), "ok");
    }

    #[test]
    fn rejects_oversized_output() {
        let dir = tempfile::tempdir().unwrap();
        let bin = write_script(
            dir.path(),
            "flood-codex",
            "#!/bin/bash\nwhile [[ $# -gt 0 ]]; do if [[ \"$1\" == \"--output-last-message\" ]]; then out=\"$2\"; shift; fi; shift; done\nhead -c 2097152 /dev/zero | tr '\\0' 'x' > \"$out\"\n",
        );
        let prov = super::CodexCliProvider {
            bin,
            extra_args: vec![],
        };
        let req = super::CompletionRequest {
            system: "s".into(),
            messages: vec![],
            workdir: dir.path().to_path_buf(),
            read_only: true,
            request_id: String::new(),
            timeout_secs: 10,
        };
        let err = super::AiProvider::complete(&prov, &req).unwrap_err();
        assert!(
            matches!(&err, crate::CoreError::Ai(m) if m.contains("output exceeds")),
            "{err}"
        );
    }

    #[test]
    fn validate_reports_missing_binary_and_workdir() {
        let dir = tempfile::tempdir().unwrap();
        let missing = super::CodexCliProvider {
            bin: dir.path().join("no-such-codex"),
            extra_args: vec![],
        };
        let err = missing.validate(dir.path()).unwrap_err();
        assert!(
            matches!(&err, crate::CoreError::InvalidInput(m) if m.contains("binary")),
            "{err}"
        );
        let ok_bin = fake_codex(dir.path(), "ok");
        let prov = super::CodexCliProvider {
            bin: ok_bin,
            extra_args: vec![],
        };
        let err = prov.validate(&dir.path().join("nowhere")).unwrap_err();
        assert!(
            matches!(&err, crate::CoreError::InvalidInput(m) if m.contains("workdir")),
            "{err}"
        );
        prov.validate(dir.path()).unwrap();
    }

    #[test]
    fn test_connection_reports_version_and_latency() {
        let dir = tempfile::tempdir().unwrap();
        let bin = write_script(
            dir.path(),
            "version-codex",
            "#!/bin/bash\nif [[ \"$1\" == \"--version\" ]]; then echo 'codex-cli 9.9.9'; exit 0; fi\nexit 1\n",
        );
        let prov = super::CodexCliProvider {
            bin,
            extra_args: vec![],
        };
        let report = prov.test_connection().unwrap();
        assert_eq!(report.version, "codex-cli 9.9.9");
        assert!(report.latency_ms < 10_000);
        let bad = super::CodexCliProvider {
            bin: dir.path().join("missing"),
            extra_args: vec![],
        };
        assert!(bad.test_connection().is_err());
    }
}
