fn main() {
    // 版本标识注入(设置页「诊断」分区与日志首行):git 短提交 + 构建时间;无 git 时为 unknown
    let sha = std::process::Command::new("git")
        .args(["rev-parse", "--short", "HEAD"])
        .output()
        .ok()
        .filter(|output| output.status.success())
        .map(|output| String::from_utf8_lossy(&output.stdout).trim().to_string())
        .filter(|sha| !sha.is_empty())
        .unwrap_or_else(|| "unknown".to_string());
    let dirty = std::process::Command::new("git")
        .args(["status", "--porcelain", "--untracked-files=no"])
        .output()
        .ok()
        .filter(|output| output.status.success())
        .map(|output| !output.stdout.is_empty())
        .unwrap_or(false);
    println!(
        "cargo:rustc-env=BL_GIT_SHA={}{}",
        sha,
        if dirty { "-dirty" } else { "" }
    );
    println!(
        "cargo:rustc-env=BL_BUILT_AT={}",
        chrono::Utc::now().format("%Y-%m-%dT%H:%M:%SZ")
    );
    println!("cargo:rerun-if-changed=../../.git/HEAD");
    println!("cargo:rerun-if-changed=../../.git/index");
    tauri_build::build()
}
