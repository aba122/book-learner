# ADR-0004 EPUB 原生传输(选择、暂存、抽取入口)

**Status:** Accepted(2026-09-07,选项 B)——原 Deferred(2026-09-05)。决策与数据见文末"Decision(传输)"。

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

## Decision(传输,2026-09-07)

**选项 B:有界二进制通道。** WebView 已持有 `File`(epub.js 抽取也在 JS 侧完成),原生只需接收字节落盘;不暴露任何用户路径。实现:

- 前端 `TauriBackend.importEpub` 按 4 MiB 分块 `invoke('library_import_epub_chunk', Uint8Array, { headers: { 'x-op-id', 'x-chunk-index' } })`(Tauri 2 原始请求体),再 `library_import_epub_finalize[opId, bookType, title]`。
- 原生 `import::ImportStore`:`stage_chunk` 同目录临时文件 + fsync + rename;单块 ≤ 8 MiB、单书 ≤ 200 MiB(超限即清理暂存);`finalize` 要求分块 0..n 连续 → 拼装 → 校验(zip 魔数、条目 ≤ 5000、无 `..`/绝对路径条目、首条目 `mimetype` = `application/epub+zip`、存在 `META-INF/container.xml`,不解压正文)→ 书行(`import_state='staged'`)与原子 rename 到 `books/<book_id>.epub`;失败无书行且暂存清理;同 `op_id` 重复 finalize 返回同一 `book_id`;启动清理 24h 前的暂存目录。
- `library_epub_url[bookId]` 只返回受管路径 `books/<id>.epub`(书行与文件都必须存在);asset protocol 作用域在 setup 内运行时 `allow_directory(books_dir)`。

**Spike 数据(2026-09-07,Apple Silicon,MockRuntime IPC 层):** `get_ipc_response` 以 `InvokeBody::Raw` 传递分块并落盘的用例见 `web/src-tauri/tests/foundation.rs::native_import_over_ipc_*`。**真实 WebView 的 50 MB / 300 MB 吞吐与内存数据待 M8 GUI 冒烟补测**(本阶段经 SSH 隧道无桌面会话);若实测不可接受,回退选项 A 只需替换前端 `importEpub` 的传输段,`ImportStore` 与 core 不变。

**未做(记入计划偏差):** 书架对 `staged`/`extracted` 书目的"导入未完成"徽标与续跑/删除入口——需要 `Book.importState` 进契约与 `deleteBook` 新命令,留待 M8 前评估。
