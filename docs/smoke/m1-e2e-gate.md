# 产品 M1 端到端门禁(真书 + 真 codex,Apple Silicon 桌面会话)

对应 `docs/superpowers/plans/2026-09-07-mac-m1-wiring.md` M8.1 与基线 Node 12 七步。**必须在有桌面会话的 Mac 上执行**;经 SSH 隧道无法完成。每步把观察值填进复选框后的括号,失败先修再重跑,不跳步。

## 状态

- 无人值守部分(M8.2)已于 2026-09-07 通过:三套测试、clippy/fmt/lint/tsc、web build、`tauri build --debug/--no-bundle`、真实 codex 冒烟、干净目录启动冒烟(见 DEVLOG)。
- 本文七步:**已于 2026-09-08 经 SSH 隧道在 Apple Silicon 上执行**(`tauri dev` + 调试自动化桥,真书 + 真 codex;脚本 `docs/smoke/scripts/gate-m1-e2e.sh`、`gate-m1-step4.sh`、`gate-m1-day2.sh`,观察值取自页面文本、日志与 SQLite)。签字见 §9。

## 执行前提

```bash
cd ~/Developer/book-learner && git checkout main && git pull
codex exec "hi"                      # 已登录
export BOOK_LEARNER_DATA_DIR=$(mktemp -d /tmp/bl-e2e.XXXXXX)   # 仅 debug 构建生效;不要用 release 二进制做本门禁
pnpm -C web tauri dev
```

- [x] 使用一本**真实 EPUB**(Project Gutenberg #7337《道德經》,77,921 字节,2 个 spine 章节;公版书按"教材"模板导入——手头无真正教材类 EPUB,模板代码路径一致,记为偏差):(book-7337.epub / 77921 B / 2 章)
- [x] `BOOK_LEARNER_DATA_DIR` 为本次新建的空目录:(`/tmp/bl-e2e.eWapcE`)

## 1. 导入并重启

- [x] 书架 → 导入 EPUB → 选"教材";向导进度按章出现"正在分析第 1/2 章:wrap0000.html"→"第 2/2 章"→ 合并;导入 + 地图生成共 148 s(其中 Stage A 两章 9 s + 87 s,merge 49 s;文件 77,921 B,分块上传瞬时完成——真实 WebView 吞吐对该大小无压力,大文件吞吐待 M3 T6 用 ≥30 MB 书补测):(148 s / 77921 B)
- [x] `books/1.epub` 存在且 77,921 B 与源文件一致;`import/` 目录为空。
- [x] 经 ExitRequested 退出后重新 `tauri dev`:书架仍显示该书;`select id,title,import_state,map_revision from book` → `1|book-7337|ready|1`(**发现**:书名取自文件名而非 EPUB `dc:title`《道德經》,记入 M3 T6 收尾清单):(ready)

## 2. 地图生成、编辑、定稿与目标

- [x] 地图作业进度按章出现(向导文案 1/2 → 2/2 → 合并;`ai_request` 三条 map 请求 done);2 章,10 个知识块,总耗时 145 s:(2 章 / 145 s)
- [x] 编辑地图:模块名重命名(追加"(改)")、最后一块标记跳过、首块下移;确认定稿后 `map_revision` 1 → 2;再以 `expectedRevision: 1` 调 `map_confirm` 被拒 `conflict`("数据状态冲突,请刷新后重试",日志 `internal_cause="conflict: map revision is 2, expected 1"`)。
- [x] 设定截止日(今天 + 7 天)→ 每日 2 块;今日页出现 2 个新块任务(0/9,跳过 1 块)。

## 3. 今日新块:阅读精确原文、讲授并暴露一个薄弱点

- [x] 今日卡片"开始"→ `/reader/2?task=1`,阅读器以 asset URL 打开;本书整篇为单个 HTML 章节,地图小节标题在正文中无对应标题节点,锚点为 `chapter_fallback`(整章),阅读器与费曼页"原文参考"均给整章原文:(chapter_fallback)
- [x] 首轮故意把"道"说成可言尽的规则、把"无为"说成多干预;学生追问直指该点,评估列出 3 个薄弱点正是这两处混淆 + 未整合反证;首轮 codex 往返 10 s(`ai_request` 06:00:28 → 06:00:38):(10 s)

## 4. 制造一次 codex 超时并重试,transcript 不丢

- [x] 设置 `setting.codexBin` 为 `sleep 200` 脚本(设置页该字段仍为禁用占位,故直接写表)后提交第二轮:3 次尝试 × 120 s 超时 + 退避,362 s 后页面出现"AI 暂时没有回应,请重试"与"重试"按钮,无永久 spinner;`ai_request` 该回合 `failed|attempts=3`,用户回合 `pending`;超时后 `sleep 200` 子进程已被进程组终止(0 个残留)。**首轮实测发现**:codex 超时曾映射为不可重试的 `internal`("应用内部错误",无重试入口),已修(PR #22:`CoreError::Ai/EvalParse → ai_unavailable`,retryable)。
- [x] 恢复 codexBin 后点击"重试":同一 clientTurnId(`d9ff1a99…`)续跑,`session_turn` 为 user/student/user/student 四行无重复,`ai_request` 同 id `done|attempts=4`;学生追问紧扣许可证收费条款;`pgrep -f 'codex exec'` 为 0:(同 id 续跑,0 残留)

## 5. 评估、确认通过、记忆库投影与 git

- [x] 评估卡:建议再学、三项分数(1/1/3)、3 个薄弱点;用户确认"通过"(用户终审优先于 AI 建议,符合 PRODUCT_SPEC);块 → passed,任务 → done;随后按 M2 T5 出现"迁移应用题"附加环节卡,本步跳过。
- [x] `memory/books/book-7337/blocks/0002-商标-汇编版权与单部作品权利.md` 含 `status: passed`、复述终稿、评估历史与 AI 观察笔记;`_weakpoints.md` 待考区含 3 条;`git log`:`c34d61e study: book-7337/商标、汇编版权与单部作品权利 2026-09-08`:(是)

## 6. Cmd+Q 重启后一致性

- [x] 退出日志"有序退出:无进行中任务";重启后今日页 1/9、连续 1 天、今日 30 分钟,已完成/待办任务一致;`projection_outbox`:`done|6`,无 pending/failed:(done|6)
- [x] 启动日志"启动投影恢复完成 processed=0"。

## 7. 推进受控测试日期,完成队首薄弱点重考

- [x] `localStorage['bookLearner.testDate']` 设为明天后刷新:队列队首为"薄弱点重考"(3 条),其后为到期复习 1 条与新块 2 条(`daily_task` 2026-09-09:weak_retest×3、review×1、new×2)。
- [x] 第 1 天重考确认通过 → 薄弱点 #1 `pass_streak` 0 → 1;第 2 天(2026-09-10)再次重考确认通过 → `pass_streak` 2、`status='fixed'`、`fixed_at=2026-09-10`;`_weakpoints.md` 待考区不再含该条;`projection_outbox` 全部 `done`(12);第 3 天今日页出现落后自动均摊提示("今日起每日 2 个新块,截止不变",M2 T4 auto_adjusted 路径):(fixed @ day 2)
  - 备注:第 2 天重考复用了首轮脚本遗留的 `evaluated` 会话(重考评估"建议再学",用户终审通过),流程机制已验证;两次重考评估各新增了措辞略异的重复薄弱点(#4–#7,如"未整合直接反证"/"未整合原文反证"),现有去重只按标题精确匹配——**记入 M3 T6 收尾清单**。
  - 首轮脚本在 `tauri dev` 下暴露一个真实缺陷:React StrictMode 模拟重挂载使快问 opener 永远"学生思考中"(`useBackendOperation` 卸载清理清空代次),已修复(PR #21)并加回归用例。

## 8. 日志与泄漏检查

- [x] 三次 `tauri dev` 日志均不含原文片段("道可道"/"无为"0 次)与复述文本;唯一 ERROR 为步骤 2 故意制造的 `map_confirm` conflict,只含 `error_code`/`internal_cause`/`correlation_id`。

## 9. 签字

| 项 | 值 |
|---|---|
| 执行日期 | 2026-09-08 13:56–15:07 CST |
| 机器 / macOS | Apple Silicon(arm64),macOS 26.6.2;执行人 Claude 经用户 SSH 隧道,`tauri dev` + 调试自动化桥 |
| 分支与提交 | 主跑 2bceae0(main 08a2062 + 桥);第 4 步/第 7 步补跑 8c19ac0 / 3c49b1e(含 PR #21、#22 两个修复,均已合入 main) |
| 书名 / 大小 / 章数 | Project Gutenberg #7337《道德經》(导入后书名显示为文件名 book-7337)/ 77,921 B / 2 章(单章正文 + 许可证)/ 10 块 |
| 结果 | 通过(附 DEVLOG 2026-09-08 "m1-e2e 门禁"条目;两个缺陷已修,两个产品发现列入 M3 T6) |
| tag | `m1` @ main(本 PR 合并后打) |
