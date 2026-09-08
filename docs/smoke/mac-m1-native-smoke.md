# Mac Foundation 原生持久化冒烟

## 状态

- 实现状态:本地代码已收口;M1/M2 已在其上合入 main。
- 发布门禁:**PASS(2026-09-08,Apple Silicon,经 SSH 隧道用 debug bundle + 调试自动化桥执行,见 §6 执行记录)**。
- 说明:本文 2026-09-02 的清单写于 Foundation 期,"Import/Map 定稿/Reader/Feynman/Stats 显示不可用状态"一项在 M1 后已变为真实可用能力,按"无 Mock、无永久 spinner"复核。
- 记录日期:2026-09-02;执行日期:2026-09-08。

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
| 远程 CI | PENDING | 最新远程运行 [33606579463](https://github.com/aba122/book-learner/actions/runs/33606579463) 在 `28f563f` 上的 core 成功,Web/macOS 均在 pnpm install 失败后跳过其余门禁;本地 `980e83e` 已显式激活 pnpm 11.24.0,但当前 GitHub 权限为 `pull:true,push:false` |

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

- [x] `SMOKE_DATA_DIR` 由本次 `mktemp -d` 新建,不是旧数据目录。(`/private/tmp/book-learner-mac-m1-smoke.4Phiqb`)
- [x] seed 打印路径精确等于 `$SMOKE_DATA_DIR/app.db`。
- [x] 整个退出/重启验证期间未再次 seed。

## 2. 第一次原生启动

```bash
BOOK_LEARNER_DATA_DIR="$SMOKE_DATA_DIR" pnpm -C web tauri dev
```

在 UI 中检查:

- [x] runtime 选择 `TauriBackend`;`window.__TAURI_INTERNALS__` 存在(桥返回 `{"tauri": true, "title": "攻书 · book-learner"}`),书架内容为 fixture 的“Mac 冒烟学习书”。
- [x] Library 与 Map 读到 fixture 的 1 本书、3 个块(地图页“《Mac 冒烟学习书》· 3 个知识块”);不出现 Mock 的“微观经济学”。
- [x] Today 使用 SQLite 计划/队列;当日无任务时无 Mock 卡片。
- [x] Import 向导打开为真实向导(“导入 EPUB / 选择 EPUB 文件”),Stats 显示 SQLite 数字(0/3、0 天),无永久 spinner、无 Mock 成功。
- [x] Settings 显示 SQLite 值(25);番茄钟改为 37,保存后出现“已保存”。
- [x] 经 `app.exit(0)`(与 Cmd+Q 同走 `RunEvent::ExitRequested`)退出,日志“有序退出:无进行中任务”,进程约 1s 内结束;未强制 kill。

首次启动备注/Issues:

> 2026-09-08 用 `pnpm -C web tauri build --debug --bundles app` 的 bundle 代替 `tauri dev`(bundle 同为 debug 构建,`BOOK_LEARNER_DATA_DIR` 生效);UI 操作经调试自动化桥(`BOOK_LEARNER_AUTOMATION_SOCK`,仅 debug 构建)在 WebView 内执行,观察值取自页面文本与日志。无 Issue。

## 3. 使用同一 fixture 重启

在同一 shell 中执行同一条命令:

```bash
test -n "$SMOKE_DATA_DIR" && test -f "$SMOKE_DATA_DIR/app.db"
BOOK_LEARNER_DATA_DIR="$SMOKE_DATA_DIR" pnpm -C web tauri dev
```

- [x] Library/Map 仍显示同一 fixture 数据。
- [x] Settings 仍显示上次保存的非默认值(37;`sqlite3` 亦为 `pomodoroMinutes|37`)。
- [x] 再次经 ExitRequested 路径正常退出(“有序退出:无进行中任务”)。

重启备注/Issues:

> 无。`pragma user_version` = 5。

## 4. 浏览器与生产路径对照

```bash
pnpm -C web dev --host 127.0.0.1
```

- [x] 普通浏览器仍为 `MockBackend`(`web/src/backend/index.test.ts`:无 `__TAURI_INTERNALS__` → Mock;Playwright 冒烟同)。
- [x] 无 `BOOK_LEARNER_DATA_DIR` 的 production 原生运行把数据库解析为 `~/Library/Application Support/book-learner/app.db`(M8.2 release 首启实测,该目录含 app.db/books/memory)。
- [x] 没有将真实用户路径、私有 EPUB、SQLite 或 transcript 写入本文/仓库。

## 5. 签字

- 执行人:Claude(经用户建立的 SSH 隧道,用户授权辅助功能权限并同意启用调试自动化桥)
- 机器/macOS 版本:Apple Silicon(arm64),macOS 26.6.2
- 原生冒烟结果:PASS
- 执行时间:2026-09-08 13:49 CST;提交 2bceae0(main 08a2062 + 调试自动化桥)

## 6. 执行记录

脚本 `docs/smoke/scripts/gate-mac-m1.sh`(经 `bl-run.sh` 在 Mac 上无人值守执行),驱动器 `docs/smoke/scripts/bl-auto.py`。关键输出:首次启动 `{"route":"/","tauri":true}`、书架/地图/统计文本、设置 25 → 37 → “已保存”、退出日志、重启后 `pomodoro-after-restart="37"`、`sqlite3` 设置表与 `book`/`knowledge_block` 计数。
