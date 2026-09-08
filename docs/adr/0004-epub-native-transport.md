# ADR-0004 EPUB 原生传输(选择、暂存、抽取入口)

**Status:** Deferred(2026-09-05)——待 Mac 阶段在 Apple Silicon 上用大文件 spike 后决策(基线 Node 2)

## Context

Foundation 的 `importEpub(file: File, type)` 只对 Mock 成立:WebView 里的 `File` 对象无法高效地把大文件交给 Rust,且任意用户路径不能作为未经检查的文件系统输入(基线 §2 P1、§3"EPUB files live only below the managed books root")。本机(Linux)无 GTK,无法编译 Tauri crate,所以传输方式无法在 Plan A/B 中验证。同时 TECH_DESIGN §7.3 约定文本抽取在前端 epub.js 完成。

## Options(待决)

- **A. 路径能力**:原生文件对话框返回受限的路径能力(不是裸字符串),Rust 侧在 app 拥有的 import 目录内暂存、校验(扩展名、container/package、条目数与体积上限、路径遍历)、再 finalize 到 `books/<book_id>.epub`。
- **B. 有界二进制通道**:WebView 读 `File` 分块经 Tauri channel 送 Rust,同样的暂存/校验/finalize。

任一选项都必须:以 operation id 幂等(重复导入返回同一 book/import job)、crash 后可清理与恢复、不向前端暴露任意源路径。

## Decision(core 侧不变的接口)

无论选 A 或 B,core 只消费"已抽取的 spine 文本":

- `mapgen::store_spine(conn, book_id, chapters: &[SpineChapter{idx, href, title, text}])` 写 `spine_item`,`import_state='extracted'`;
- `mapgen::run_map_job` 只读取 `spine_item`,不接触 EPUB 文件;
- 抽取在 JS 侧(`web/src/epub/extract.ts`,Plan B)用 epub.js 完成后经契约提交。

**已知限制(记录,不在本 ADR 决策):** Codex prompt 经单个 argv 传入,Linux `MAX_ARG_STRLEN` 为 128 KiB,`MAX_PROMPT_BYTES` 定为 100 KiB;地图 Stage A 对长章分片(≤60 KiB/片),Stage B 候选超限先去 summary 压缩、仍超则明确失败。将来改为 stdin 传输可放宽上限而不改用例接口。

## Consequences

- Plan A 可在 Linux 完成全部引擎工作;Mac 阶段只需接线传输与调用 `store_spine`。
- 在传输决策前,原生 `importEpub` 保持 `not_implemented`。

## Tests that enforce it

- `core/src/mapgen.rs`:`store_spine` 替换旧缓存;作业只依赖 `spine_item`。
- Mac 阶段:Node 2 的导入用例(合法/损坏/遍历/超限/重复/崩溃恢复)。
