# M2 学习系统桌面门禁(Apple Silicon 桌面会话)

对应 `docs/superpowers/plans/2026-09-08-m2-learning-system.md` T9.1。**以 bundle 形式运行**(macOS 通知要求):

> **执行记录(2026-09-08)**:经用户 SSH 隧道由 Claude 在 Apple Silicon 上执行——§1/§2 用 debug bundle(`gate-m2-bundle.sh`),§3–§8 用 `tauri dev`(受控日期)+ 真 codex(`gate-m2-dev.sh` 及补跑 `gate-m2-hum.sh`/`gate-m2-meth.sh`/`gate-m2-replan.sh`/`gate-m2-replan2.sh`,均在 `docs/smoke/scripts/`);UI 经调试自动化桥驱动,窗口关闭/置前经 System Events(用户授了辅助功能权限),观察值取自页面文本、日志、SQLite 与记忆库;无屏幕录制权限,横幅/托盘未截图。托盘"点击快速恢复窗口"以 `open -a` 触发 Reopen 验证:关窗后窗口数 0 → 重开后窗口 1、页面 visible。

```bash
cd ~/Developer/book-learner && git checkout main && git pull
pnpm -C web tauri build --debug --bundles app
open web/src-tauri/target/debug/bundle/macos/book-learner.app
```

首次运行系统会询问通知权限,选择"允许"。每项把观察值填进括号。

## 1. 系统通知(T2)

- [x] 设置页把"提醒时间"改为 15:10、"晚间提醒"改为 15:12(当时 15:08:51)并保存(`setting` 表已更新);经 System Events 点击关闭按钮 → 窗口数 0、进程存活(CloseRequested → 隐藏,常驻)。
- [x] 15:10:14 日志"已发送系统通知 kind=daily"(`tauri-plugin-notification` 调用成功、无失败告警;SSH 无屏幕录制权限,横幅本身未截图):(daily @15:10:14)
- [x] 今日队列有 1 个 pending 新块 → 15:12:15 "已发送系统通知 kind=evening":(evening @15:12:15);其后 60 s 内无第三次发送。
- [x] `setting` 表 `notified:daily:2026-09-08`、`notified:evening:2026-09-08` 各一行,日志发送计数 2:(2 条标记,各一次)

## 2. 番茄钟与托盘倒计时(T3)

- [x] 今日页"专注"→ 托盘标题 `●00:58 → ●00:57 → ●00:56` 每秒递减,面板"专注中 · 建立模型 0:59/0:56/0:55"同步:(●,每秒)
- [x] "暂停"→ 托盘 `‖00:54`,2 s 后仍 `‖00:54`;"继续"→ `●00:53`;关闭主窗口后托盘继续 `●00:49 → ●00:46`:(‖ 停、● 续、隐藏仍走)
- [x] 番茄钟/休息各设 1 分钟:`●00:05` 后转 `○01:00`(自动进入休息;通知调用无失败告警),`○00:04` 后托盘标题变 null(空闲);`study_minutes` 记 `2026-09-08|1 分钟|pomodoro`:(● → ○ → 空闲)
- [x] 再专注 65 s 后手动"结束"→ 第二行 1 分钟;统计页"今日投入"= 3(预估 0 vs 番茄 3 取大):(3 分钟)
- [x] 运行中(托盘 `○00:58`)经 ExitRequested 退出:日志"退出前番茄钟已结束并落分钟"→ 第三行 1 分钟;重启后统计页仍为 3:(落分钟)

## 3. 落后重排(T4)

- [x] 主攻方法论书(8 块未学、上限 4)截止日已过且连续两天未完成 → 今日页弹"进度落后,需要你决定"("剩余 8 块要在 1 天内学完,均摊后每日需 8 块,超过每日上限 4 块。截止日不会被静默修改"):**缩减**分支 → 4 个靠后未学块 `skipped=1`、截止不变(2026-09-23);恢复跳过块后再次触发 → **顺延**分支 → 截止 2026-09-27→2026-10-04、每日 4 块、无块被跳过;剩余块 ≤ 上限时则只显示"进度落后,已按剩余天数均摊…截止不变"提示条(auto_adjusted):(两分支各一次,截止仅在顺延时改变)

## 4. 单主攻书(T8)

- [x] 书架"标记为已学完"(实际标记的是当时主攻的人文书):徽标"已学完 · 复习照常",`book.status=finished`、全部计划 `active=0`;另两本为"计划冻结 · 复习照常"(paused)。次日(受控日期 +1)今日队列仍含**暂停书**已通过块的间隔复习 2 条与薄弱点重考 3 条,新块为 0(无主攻):(复习照常入队)

## 5. 快问会话(T1)

- [x] 第 1 天通过的块第 2 天出现"间隔复习";"开始复习"直达快问,固定 opener"请开始快问"后 AI 直接出两道快问(不寒暄、不讲授);答完"结束讲授"→ 评估 → 确认通过后 `review_schedule`:stage 1 `done`,新增 stage 3 `due 2026-09-12`(1 → 3 推进):(快问 + 调度推进)

## 6. 通过后附加环节(T5)

- [x] 教材书(Gutenberg #24039《老子》按教材模板):判定"通过"(AI 建议再学,用户终审通过)后出现"通过了。要不要来一道迁移应用题?";"开始"→ 提示条"请出题"→ 1 道情境题(高校数字人文项目搭建古籍电子图书馆:使命/机制/版权与商标边界);作答后"整理并归档"→ 展示"## 题目 / 作答要点 / 评语 / 掌握判断"并提示归档路径;`artifact(kind=application)` 1 行、`books/book-24039/_applications.md` 含该节(entry 注释标记)、`git log`:`1e2f9dc extra: 归档迁移应用 · 古登堡计划的使命与电子图书馆形成`:(全链路一致)
- [x] 方法论书(Gutenberg #23864《孫子兵法》,按方法论模板;书架切换主攻时弹"切换主攻书?"(计划冻结、复习照常、今日队列明天起按新书生成)):通过后"要不要来一道情境化方法论?";"开始"→ 提示条"请引导"→ AI 引用画像情境("在你的平台定价研究或 5 人团队协作中…")三轮引导 → 交出「我的版本」→ "整理并归档"→ "## 我的版本 / 适用情境 / 来源块";`artifact(kind=methodology)`、`_methodology.md` 含该节、`git log`:`ed8046a extra: 归档个人方法论 · 开放传播的使命与制度基础`:(全链路一致)
- [x] 人文书(Gutenberg #24225《戲中戲》,按人文·社科模板):通过后"要不要来一道观点讨论?";"开始"→ 提示条"请提出对立视角"→ AI 提出对立视角(藐姑"由戏成真"是主体性还是礼教规训);写下看法后"整理并归档"→ "## 争议 / 我的看法 / 用到的史实 / 来源块";`artifact(kind=reflection)`、`books/<slug>/_notes.md` 含该节、`git log`:`9abaf68 extra: 归档思考笔记 · 寒士遠遊與梨園眾生`:(全链路一致)
- [x] "跳过"直接回今日(m1-e2e 第 5 步实测),块状态 passed、次日计划照常;"同块同类一次"由 `feynman_session_extra_once` 索引与 core/foundation 用例保证:(是)
- [x] 复习/重考会话确认后直接回今日(m1-e2e 第 7 步、本文 §5),无附加环节;"暂不通过"分支由 vitest 用例覆盖:(是)

## 7. 学习者画像(T6)

- [x] 设置页"学习者画像"改"知识背景 = 经济学研究者,读过古典中国哲学入门"、"个人情境 = 在做平台定价研究,带一个 5 人的小团队"→ 保存后 `profile.md` 对应节更新、"已掌握概念/误区模式"模板节保留,`git log`:`ec3d114 profile: 更新学习者画像`:(经 outbox git_commit)
- [x] 教材书的迁移应用题直接引用了画像情境("你带领的 5 人平台定价研究团队…"),证明 prompt 注入了"个人情境"节;人文书不含该节由 `memory::profile_summary_for` 单测覆盖:(情境已注入)

## 8. 统计页三区(T7)

- [x] 进度区三本书:`book-24039 已暂停 已通过 2/13 · 截止 2026-09-15 · 预计完成 2026-10-21`、`book-23864 已暂停 0/9 · 预计完成 —`、`book-24225 已学完`;投入区近 14 天 65 分钟(2 个新块 ×30 预估 + 复习 5)、打卡 2 天;质量区新增薄弱点 8 / 修复 0、复习通过率 100%(done 1 / due 2)——与 `weak_point`(open 8)、`review_schedule`(done|1)、`daily_task`(done 3)一致:(一致)

## 9. 无人值守门禁(T9.2,经 SSH 在同一台 Mac 执行)

2026-09-08 13:06–13:08 CST,Apple Silicon(macOS 26.6),提交 87aedf5(= main 上 PR #17 合并内容),脚本经 `bl-run.sh t9-gate` 无人值守执行:

| 项 | 结果 |
|---|---|
| core `cargo test` / clippy `-D warnings` / fmt | 146 通过 / 1 失败(`ai::tests::timeout_kills_descendants`,并行负载下 bash 晚于 3s 超时才启动、marker 缺失;已改为逐级放大超时重试,见 DEVLOG);集成 27/1/1 通过;clippy 0;fmt 通过 |
| src-tauri `cargo test` / clippy / fmt | foundation 26 通过(+wire 契约用例)、4/1 通过;clippy 0;fmt 通过 |
| web vitest / lint / `pnpm build` | 287 通过 / 1 跳过(Node 26);oxlint 0;`tsc -b && vite build` 通过 |
| `tauri build --debug --bundles app` | 通过,`book-learner.app` 41 MB |
| 干净目录首启冒烟(debug bundle,`BOOK_LEARNER_DATA_DIR` 隔离) | 12s 内生成 `app.db`(`user_version=5`,`study_minutes` 与 `feynman_session_extra_once` 均在)、`books/`、`memory/`(git 一次初始化提交);日志无 ERROR,通知权限 Granted,启动投影恢复 processed=0;按 pid 结束干净 |
| `tauri build --no-bundle` release | 通过,35.8s,二进制 15.4 MB |

## 签字

| 项 | 值 |
|---|---|
| 执行日期 / 机器 | 2026-09-08 15:05–17:35 CST / Apple Silicon(arm64),macOS 26.6.2;执行人 Claude(经用户隧道) |
| 分支与提交 | main 6b1e2da(bundle 段)/ main + 桥(dev 段,含 PR #21/#22 修复) |
| 结果 | 通过(§1–§8 全部观察到预期行为;附 DEVLOG 2026-09-08 "m2 门禁"条目;过程发现记入 M3 T6) |
| tag | `m2` @ main(本 PR 合并后打) |
