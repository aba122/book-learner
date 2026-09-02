# Mac Foundation 原生持久化冒烟

## 状态

- 实现状态:本地代码已收口。
- 发布门禁:**PENDING — 需 Apple Silicon Mac 上的交互式原生验证**。
- 当前验证主机:`Linux x86_64`,不能代替 macOS WebView、Cmd+Q 退出/重启和生产 Application Support 路径断言。
- 记录日期:2026-09-02。

`mac-m1` tag、合并和“Mac Foundation 发布完成”状态均必须等待本文的原生检查全部填绿;产品 M1 始终是另一个后续里程碑。

## 自动化预检

| 检查 | 当前结果 | 证据/限制 |
|---|---|---|
| core rustfmt | PASS | `cargo fmt --manifest-path core/Cargo.toml -- --check` |
| Tauri rustfmt | PASS | `cargo fmt --manifest-path web/src-tauri/Cargo.toml -- --check` |
| core tests | PASS | `cargo test --manifest-path core/Cargo.toml --all-targets`:66 passed,1 ignored(real Codex smoke) |
| core clippy | PASS | `cargo clippy --manifest-path core/Cargo.toml --all-targets -- -D warnings` |
| Web tests | PASS | 158 passed,2 timezone-conditional skipped |
| Web lint/build | PASS | lint exit 0(原有 6 warnings);179 modules;minified JS 602.96 kB 警告 |
| EPUB CFI Playwright | PASS | Chromium;`chap1.xhtml`;CFI round-trip 还原“第一章 供给与需求”;1/1 |
| Tauri tests/clippy/debug build | PENDING(macOS CI) | 当前 Linux 缺 `gdk-3.0`/Pango/Cairo 系统库,GTK build script 在本项目 Rust 代码前失败 |
| 远程 CI | PENDING | 当前 GitHub 身份对 `aba122/book-learner` 仅 READ,本地提交无法推送 |

Playwright 可在无浏览器的新机器上先执行:

```bash
pnpm -C web exec playwright install chromium
pnpm -C web exec playwright test e2e/cfi-smoke.spec.ts
```

## Apple Silicon 执行前提

- 确认 `uname -m` 输出 `arm64`,`sw_vers` 可用。
- 确认 Rust stable、Node 22 与 pnpm 11.24.0。
- 在仓库根目录完成依赖安装:`corepack enable && corepack prepare pnpm@11.24.0 --activate && pnpm -C web install --frozen-lockfile`。
- 在一个持久的交互式 shell 中完成下方两次原生启动;不要换 shell,不要重新 seed。

## 1. 新建唯一 fixture

```bash
SMOKE_DATA_DIR="$(mktemp -d /private/tmp/book-learner-mac-m1-smoke.XXXXXX)"
test -n "$SMOKE_DATA_DIR" && test -d "$SMOKE_DATA_DIR"
cargo run --manifest-path web/src-tauri/Cargo.toml --example seed_smoke -- "$SMOKE_DATA_DIR"
test -f "$SMOKE_DATA_DIR/app.db"
```

填写:

- [ ] `SMOKE_DATA_DIR` 由本次 `mktemp -d` 新建,不是旧数据目录。
- [ ] seed 打印路径精确等于 `$SMOKE_DATA_DIR/app.db`。
- [ ] 整个退出/重启验证期间未再次 seed。

## 2. 第一次原生启动

```bash
BOOK_LEARNER_DATA_DIR="$SMOKE_DATA_DIR" pnpm -C web tauri dev
```

在 UI 中检查:

- [ ] runtime 选择 `TauriBackend`;可在 DevTools 确认 `window.__TAURI_INTERNALS__` 存在,且书架内容为 fixture 的“Mac 冒烟学习书”。
- [ ] Library 与 Map 读到 fixture 的 1 本书、3 个块;不出现 Mock 的“微观经济学”。
- [ ] Today 使用 SQLite 计划/队列;在当日无任务时也不出现 Mock 卡片。
- [ ] Import、Map 定稿、Reader、Feynman、Stats 显示真实中文不可用状态,无永久 spinner、无 Mock 成功。
- [ ] Settings 显示 SQLite 值;将番茄钟改为一个非默认值(例如 37),保存并看到“已保存”。
- [ ] 使用 macOS Cmd+Q 正常退出,确认 Tauri/Vite 进程结束;不强制 kill。

首次启动备注/Issues:

> PENDING

## 3. 使用同一 fixture 重启

在同一 shell 中执行同一条命令:

```bash
test -n "$SMOKE_DATA_DIR" && test -f "$SMOKE_DATA_DIR/app.db"
BOOK_LEARNER_DATA_DIR="$SMOKE_DATA_DIR" pnpm -C web tauri dev
```

- [ ] Library/Map 仍显示同一 fixture 数据。
- [ ] Settings 仍显示上次保存的非默认值。
- [ ] 再次 Cmd+Q 正常退出。

重启备注/Issues:

> PENDING

## 4. 浏览器与生产路径对照

```bash
pnpm -C web dev --host 127.0.0.1
```

- [ ] 普通浏览器仍为 `MockBackend`,书架显示 Mock 快乐路径。
- [ ] 无 `BOOK_LEARNER_DATA_DIR` 的 production 原生运行把数据库解析为 `~/Library/Application Support/book-learner/app.db`。
- [ ] 没有将真实用户路径、私有 EPUB、SQLite 或 transcript 写入本文/仓库。

## 5. 签字

- 执行人:PENDING
- 机器/macOS 版本:PENDING
- 原生冒烟结果:PENDING
- 执行时间:PENDING
