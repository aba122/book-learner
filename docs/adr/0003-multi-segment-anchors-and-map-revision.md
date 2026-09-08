# ADR-0003 知识块锚点为有序多段,地图编辑为稳定 id + 修订号的操作集

**Status:** Accepted(2026-09-05,Plan A)

## Context

v1 schema 在 `knowledge_block` 上只有单段 `spine_href/cfi_start/cfi_end`,无法表达跨章块与合并块(TECH_DESIGN §7.2 要求"跨章块存多段 CFI 范围数组",标题匹配失败回退整章并标记"锚点粗略")。Foundation 的 `MapEditBlock[]` 以位置/标题描述编辑,没有稳定 block id 与期望版本,原生实现会覆盖状态、评分、依赖或并发编辑。基线 §3:"Map edits use stable block IDs and optimistic map revision. Merge/split is an explicit operation union; skip remains a flag, never physical deletion. Store normalized spine text and ordered anchor segments … each segment records precision."

## Decision

1. **spine 缓存**:`spine_item(book_id, idx, href, title, text)`,`UNIQUE(book_id, idx)`;同一 href 可重复出现(EPUB spine 可多次引用同一 manifest 项),抽取侧去重。
2. **锚点段**:`block_anchor(block_id, seq, spine_href, cfi_start, cfi_end, precision ∈ exact|chapter_fallback, hint, text)`。地图落库时每个 `source_section`("{href}#{小节标题}")生成一段 `chapter_fallback`,`hint` 保存小节标题;Plan B/Mac 用 `hint` 在该章 DOM 中解析出 CFI 与段文本后经 `set_anchor_segments` 回填为 `exact`。费曼上下文的原文 = 各段 `text`(空则整章 spine 文本)。
3. **修订号**:`book.map_revision` 从 0 开始;`apply_draft_map` 置 1;`confirm_map(expected_revision, ops)` 不等则 `Conflict` 且无变更,成功 +1,单事务。
4. **操作集**:`Rename`、`RenameModule`、`Reorder`(必须是全部块 id 的排列)、`SetSkipped`(标记,不删除)、`Merge`(来源块标记 skipped 并保留自身锚点;其锚点段**复制**追加到目标块尾部;其他块 prereq 中的来源 id 改为目标 id)、`Split`(需要阅读器选区,core 返回 `InvalidInput`,Mac 阶段实现)。任何操作不触碰 `status/scores/passed_at`。
5. **slug**:`map::slugify`——保留 Unicode 字母数字,其余替换为 `-`,折叠、去首尾、≤40 字符;空则 `block-{seq}`;同书重复加 `-2/-3`;结果必过 `memory::validate_slug`。
6. **块文件命名**:记忆库块文件改为 `blocks/{block_id:04}-{slug}.md`,frontmatter 用 `block_id:`(TECH_DESIGN §3.1 模板本就如此);Reorder 改 seq 不再让历史文件孤立。`MemoryStore::apply_eval` 的 seq 参数改为 block_id。

## Consequences

- 一个块可以有 0..n 段;`chapter_fallback` 段在阅读器中以整章高亮并显示"锚点粗略"。
- 地图页发送的是"我基于第 N 版做了这些操作",并发或过期编辑被拒绝而非静默覆盖。
- 合并后的来源块仍可 unskip(锚点仍在);目标块的原文会包含复制的段。
- 既有以 `{seq:02}` 命名的块文件(仅测试数据)不迁移。

## Tests that enforce it

- `core/src/db.rs`:v4 表/索引/外键;同 href 不同 idx 允许。
- `core/src/map.rs`:slugify 规则;apply 生成 fallback 段与 hint;过期修订号 Conflict 且无变更;Reorder/SetSkipped 保留评分;Merge 复制段并重写 prereq;Split 被拒;精确段回填。
- `core/src/memory.rs`:`{block_id:04}-{slug}.md` 与 `block_id:` frontmatter。
