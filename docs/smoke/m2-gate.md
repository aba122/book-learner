# M2 学习系统桌面门禁(Apple Silicon 桌面会话)

对应 `docs/superpowers/plans/2026-09-08-m2-learning-system.md` T9.1。**以 bundle 形式运行**(macOS 通知要求):

```bash
cd ~/Developer/book-learner && git checkout main && git pull
pnpm -C web tauri build --debug --bundles app
open web/src-tauri/target/debug/bundle/macos/book-learner.app
```

首次运行系统会询问通知权限,选择"允许"。每项把观察值填进括号。

## 1. 系统通知(T2)

- [ ] 设置页把"提醒时间"改为 2 分钟后、"晚间提醒"改为 4 分钟后并保存;关闭主窗口(app 常驻 Dock/托盘)。
- [ ] 到点收到"攻书 · 今日学习"通知(每日,无条件):(          )
- [ ] 若今日队列仍有未完成任务,晚间到点收到"攻书 · 今天还没学完 … 还有 N 项任务未完成":(          );把队列全部完成后同一天不再重复。
- [ ] 同一天内两类通知各只发一次(`sqlite3 … "select key from setting where key like 'notified:%'"`):(          )

## 2. 番茄钟与托盘倒计时(T3)

- [ ] 今日页对某任务点"专注":托盘标题出现 `●MM:SS` 每秒递减;面板显示同一剩余时间:(          )
- [ ] "暂停"→ 托盘变 `‖MM:SS` 且不再递减;"继续"恢复;关闭主窗口后托盘仍在走:(          )
- [ ] 把设置的番茄钟改为 1 分钟后启动,到点收到"专注结束"系统通知并自动进入休息(`○MM:SS`),休息结束回到空闲:(          )
- [ ] 专注 ≥1 分钟后"结束":统计页"今日投入"取 max(预估, 番茄分钟)(`sqlite3 … "select date,minutes from study_minutes"`):(          )
- [ ] 番茄钟运行中 Cmd+Q:重启后 `study_minutes` 已记入已专注的整分钟:(          )

## 3. 落后重排(T4)

- [ ] DevTools 设置 `bookLearner.testDate` 推进两天且不完成新块 → 第三天今日页弹"进度落后,需要你决定";验证"顺延"与"缩减"两分支各一次,截止日仅在顺延时改变:(          )

## 4. 单主攻书(T8)

- [ ] 书架"标记为已学完"后:该书徽标变"已学完 · 复习照常",点击直接看地图;其到期复习次日仍进入今日队列:(          )

## 5. 快问会话(T1)

- [ ] 第 1 天通过的块,第 2 天今日页出现"间隔复习",点击"开始复习"直接进入快问(自动出题,无需先讲授);答完确认后复习调度推进:(          )

## 6. 通过后附加环节(T5)

- [ ] 教材书:新块判定"通过"后出现"迁移应用题"卡;"开始"后自动出现"请出题"提示条与 1 道贴近画像"个人情境"的题;作答后"整理并归档"→ 展示整理稿(题目/作答要点/评语/掌握判断)并提示已归档到 `books/<slug>/_applications.md`;记忆库该文件与 git log(`extra: 归档迁移应用 · <块>`)一致:(          )
- [ ] 方法论书:同一流程为"情境化方法论",三轮引导后写「我的版本」,归档 `_methodology.md`:(          )
- [ ] 人文书:"观点讨论",对立视角 → 看法 → 归档 `_notes.md`:(          )
- [ ] "跳过"直接回今日且块状态/明日计划不受影响;重进同块同类附加环节(从阅读器/地图无入口,可用 DevTools 调 `extraStart` 验证)返回既有会话:(          )
- [ ] 复习/重考会话与"暂不通过"判定均不出现附加环节:(          )

## 7. 学习者画像(T6)

- [ ] 设置页"学习者画像"编辑"知识背景/个人情境"并保存 → `memory/profile.md` 对应小节更新、其它小节保留、git log 出现 `profile: 更新学习者画像`:(          )
- [ ] 教材/方法论书的费曼会话 prompt 含"个人情境"节,人文书不含(DevTools 或 `RUST_LOG=debug` 观察 system prompt 或对话中 AI 引用情境):(          )

## 8. 统计页三区(T7)

- [ ] 进度区按书显示通过/巩固/截止/预计完成(预计完成随近 7 天通过数变化);投入区 14 天柱状与 56 格打卡日历与实际学习日一致;质量区薄弱点新增/修复、评估均分、复习通过率与 `sqlite3` 查询一致:(          )

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
| 执行日期 / 机器 | |
| 分支与提交 | |
| 结果 | |
