# 产品 M1 端到端门禁(真书 + 真 codex,Apple Silicon 桌面会话)

对应 `docs/superpowers/plans/2026-09-07-mac-m1-wiring.md` M8.1 与基线 Node 12 七步。**必须在有桌面会话的 Mac 上执行**;经 SSH 隧道无法完成。每步把观察值填进复选框后的括号,失败先修再重跑,不跳步。

## 状态

- 无人值守部分(M8.2)已于 2026-09-07 通过:三套测试、clippy/fmt/lint/tsc、web build、`tauri build --debug/--no-bundle`、真实 codex 冒烟、干净目录启动冒烟(见 DEVLOG)。
- 本文七步:**待执行**。签字后在 main 打 annotated tag `m1`。

## 执行前提

```bash
cd ~/Developer/book-learner && git checkout main && git pull
codex exec "hi"                      # 已登录
export BOOK_LEARNER_DATA_DIR=$(mktemp -d /tmp/bl-e2e.XXXXXX)   # 仅 debug 构建生效;不要用 release 二进制做本门禁
pnpm -C web tauri dev
```

- [ ] 使用一本**真实教材类 EPUB**(记录书名与大小,不要把文件提交进仓库):(          )
- [ ] `BOOK_LEARNER_DATA_DIR` 为本次新建的空目录:(          )

## 1. 导入并重启

- [ ] 书架 → 导入 EPUB → 选"教材";进度文案依次出现"正在导入书籍…/正在抽取章节文本…/正在生成知识地图…";记录导入耗时与文件大小(ADR-0004 真实 WebView 吞吐数据):(          )
- [ ] `$BOOK_LEARNER_DATA_DIR/books/<id>.epub` 存在且大小与源文件一致;`import/` 下无残留暂存目录。
- [ ] Cmd+Q 后重新 `tauri dev`:书架仍显示该书;`sqlite3 $BOOK_LEARNER_DATA_DIR/app.db 'select id,title,import_state,map_revision from book'` 的 import_state 为 `extracted` 或 `ready`:(          )

## 2. 地图生成、编辑、定稿与目标

- [ ] 地图作业进度事件按章出现(Chapter i/N → Merging → Done);记录章数与总耗时:(          )
- [ ] 至少做一次重命名、一次标记跳过、一次重排;定稿后 `map_revision` 递增;再次以过期修订号提交被拒(conflict)可通过 DevTools 观察一次。
- [ ] 设置目标(截止日或每日块数),今日页出现新块任务。

## 3. 今日新块:阅读精确原文、讲授并暴露一个薄弱点

- [ ] 从今日卡片进入阅读器:epub.js 以 asset URL 打开,定位到块的 exact 段(或 chapter_fallback 时明示"整章");记录锚点精度:(          )
- [ ] 费曼页第一轮讲授故意遗漏/混淆一个概念;学生追问命中该点;记录首轮 codex 往返耗时:(          )

## 4. 制造一次 codex 超时并重试,transcript 不丢

- [ ] 方法之一:设置页把 codex 路径改为一个 `sleep 200` 的脚本、或断网后提交一轮;页面出现可重试错误(非永久 spinner)。
- [ ] 恢复后点击重试:同一 clientTurnId 续跑,历史回合完整,无重复用户回合;`pgrep -f codex` 无残留子进程:(          )

## 5. 评估、确认通过、记忆库投影与 git

- [ ] 评估卡显示 verdict/三项分数/薄弱点;确认"通过";块状态 → passed,任务 → done。
- [ ] `$BOOK_LEARNER_DATA_DIR/memory/books/<slug>/blocks/<id>-<slug>.md` 出现,含 `status: passed` 与复述终稿;`_weakpoints.md` 含步骤 3 暴露的薄弱点;`git -C memory log --oneline` 出现 `study: …` 提交:(          )

## 6. Cmd+Q 重启后一致性

- [ ] Cmd+Q(观察日志"有序退出:无进行中任务"),重新启动:书/地图/计划/任务/会话/设置全部一致;`projection_outbox` 无 pending/failed 行:`sqlite3 … "select status,count(*) from projection_outbox group by status"`:(          )
- [ ] 启动日志出现"启动投影恢复完成 processed=0"。

## 7. 推进受控测试日期,完成队首薄弱点重考

- [ ] DevTools:`localStorage.setItem('bookLearner.testDate','<明天>')` 后刷新;今日队列队首为薄弱点重考(红),其后为到期复习(如有)与新块。
- [ ] 完成重考并确认;`weak_point` 行的 `pass_streak` 递增;再推进一天重考通过 → 状态 `fixed`:(          )

## 8. 日志与泄漏检查

- [ ] `tauri dev` 终端输出与 `~/Library/Logs`(如有)不含 EPUB 正文、transcript 原文、私有路径以外的用户数据;错误日志只含 `error_code`/`internal_cause`。

## 9. 签字

| 项 | 值 |
|---|---|
| 执行日期 | |
| 机器 / macOS | |
| 分支与提交 | |
| 书名 / 大小 / 章数 | |
| 结果 | 通过 / 未通过(附 DEVLOG 条目) |
| tag | `m1` @ (sha) |
