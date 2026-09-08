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

- [ ] 待 T3 完成后补充。

## 3. 落后重排(T4)

- [ ] DevTools 设置 `bookLearner.testDate` 推进两天且不完成新块 → 第三天今日页弹"进度落后,需要你决定";验证"顺延"与"缩减"两分支各一次,截止日仅在顺延时改变:(          )

## 4. 单主攻书(T8)

- [ ] 书架"标记为已学完"后:该书徽标变"已学完 · 复习照常",点击直接看地图;其到期复习次日仍进入今日队列:(          )

## 5. 快问会话(T1)

- [ ] 第 1 天通过的块,第 2 天今日页出现"间隔复习",点击"开始复习"直接进入快问(自动出题,无需先讲授);答完确认后复习调度推进:(          )

## 签字

| 项 | 值 |
|---|---|
| 执行日期 / 机器 | |
| 分支与提交 | |
| 结果 | |
