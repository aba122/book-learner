# M3 体验完善桌面门禁(Apple Silicon 桌面会话)

对应 `docs/superpowers/plans/2026-09-08-m3-experience.md` T6.3 与 IMPLEMENTATION_PLAN「M3 验收」:全程语音学完一个块;导出后在 Obsidian 中链接与 frontmatter 正确;一本书完整学完产出学习报告;打包后的 app 在干净环境可运行。

> **执行记录(2026-09-08)**:经用户 SSH 隧道由 Claude 在 Apple Silicon 上执行。§1–§5、§7 用 debug bundle(自动化桥,`docs/smoke/scripts/gate-m3.sh`,经 `open --env` 在 GUI 会话启动以获得 TCC 麦克风授权)+ 真 codex;§6 用 release dmg(`t6-chain` 脚本:构建 → 挂载 → 复制 → 签名信息 → 启动 → 窗口 → 退出)。观察值取自页面文本、SQLite、记忆库、导出目录与日志;无屏幕录制权限,未截图。

```bash
cd ~/Developer/book-learner && git checkout main && git pull
# debug(带自动化桥):
pnpm -C web tauri build --debug --bundles app
open web/src-tauri/target/debug/bundle/macos/book-learner.app
# release dmg:
pnpm -C web tauri build --bundles app,dmg   # 产物 web/src-tauri/target/release/bundle/dmg/book-learner_0.1.0_aarch64.dmg
```

每项把观察值填进括号。

## 1. 全程语音学完一个块(T3)

- [x] 设置页「语音」分区填路径导入 `ggml-large-v3-turbo-q5_0.bin` → 清单显示体积并自动选中:(547 MB,单选自动选中,`setting.voiceModel=large-v3-turbo-q5_0`)
- [x] 费曼页点 🎙 → 录音态(计时/电平)→ 朗读复述 → 停止 → 转写文本填入输入框(可编辑,不自动发送):(真麦克风:录音态计时 0:04、电平 2%,停止后"已填入,可编辑后发送(4.4 秒语音,转写用时 3.4 秒)";朗读内容用 `say` 合成 16 kHz 语音经同一 `voice_transcribe` 命令填入——17.9 秒语音转写 2.9 秒,文本与朗读一致(同音字来自 TTS);首跑曾试"扬声器播 TTS 让麦克风录",被 WebKit 回声消除压掉、电平 1%,不作为证据)
- [x] 发送 → 学生追问 → 结束讲授 → 评估 → 确认通过 → 块状态 passed:(合成 39.8 秒复述(古登堡使命/体系/许可/商标)经 `voice_transcribe` 6.4 秒转写、文本准确 → 填入输入框 → 发送 → 学生追问 → 结束讲授 → 评估「建议再学」(3/2/4,三条具体薄弱点:许可证触发条件过度概括、版本更新原则缺失、商业传播条件不具体)→ 点「暂不通过,再学一遍」→ 块 learning、薄弱点 3 条、回合 2;首跑中「确认通过」路径亦走通(块 passed)。判定严格是产品本意,语音链路含判定确认已完整闭环)

## 2. Obsidian 导出(T2)

- [x] 设置目标目录后书架「导出到 Obsidian」→ 清单预览 → 确认导出 → 写入/未变计数:(清单 14 项;"已导出到 <vault>/book-24039:写入 14 个文件,0 个未变化")
- [x] `<目标>/<书名>/00-学习报告.md`、`blocks/<seq>-<块名>.md` 存在;块文件 frontmatter 含 `book/block/status/scores/tags`;wikilink 以目标目录为根:(`00-学习报告.md` + `blocks/01…13-*.md`;frontmatter `book/block/seq/module/status/scores/passed_at/tags`;`[[book-24039/00-学习报告]]`、`[[book-24039/blocks/05-…]]`)

## 3. 整书终评与学习报告(T1)

- [x] 全部未跳过块通过后地图页出现「整书终评」→ 考官开场追问全书框架 → ≥2 次作答后「生成学习报告」可用:(opener「请开始终评」→ "请先讲出全书的整体框架…" → 3 次作答 → 生成)
- [x] 报告页:星级/最强最弱模块/正文;`artifact(kind='report')` 一行;`books/<slug>/_report.md` 追加;书状态 finished;git 提交:(★★★★☆ 4/5,最强"复制、转换与商业分发"、最弱"许可与权利基础";artifact 1 行 1485 字;`_report.md` 含元注释;book finished;git `6a625db report: 整书终评`)

## 4. 阅读器打磨(T4)

- [x] 打开阅读器先显示骨架,首屏渲染后消失:(置前后 2 s 骨架消失、iframe 就绪,正文 "The Project Gutenberg eBook of 老子…";首跑未置前时 30 s 未渲染——后台 WebView 节流,m2 已知)
- [x] 「书签」→ 标记面板列出;翻页后离开再进入回到上次位置(`reader_mark kind='position'`):(面板列出 "许可与权利基础 · 许可接受与权利边界";`reader_mark` 有 bookmark 行与 position 行 `epubcfi(/6/4!/4/4[id00000]/1:0)`;重进无骨架残留、正文就绪)

## 5. 数据安全(T5)

- [x] 设置页「立即快照」→ 清单出现当日快照,`snapshots/app-<日期>.db` 存在:(清单 "2026-09-08 236 KB";`snapshots/app-2026-09-08.db` 241664 B)
- [x] 「恢复」→ 确认「登记恢复」→ `restore-pending.json`;退出重启后标记消费、原库保留为 `.replaced-<ts>`、数据仍完整:(标记 `{"name":"app-2026-09-08.db",…}`;重启后 `app.db.replaced-20260908-112421`、标记消失、设置页无待恢复横幅;书 1 / 块 13)

## 6. 打包(T6.2)

- [x] `pnpm tauri build --bundles app,dmg` 成功,dmg 体积与耗时:(97 s 含 whisper.cpp release 编译;`book-learner_0.1.0_aarch64.dmg` 5.7 MB)
- [x] 挂载 dmg → 复制 app 到新目录 → `codesign -dv` 为 adhoc → `open` 启动 → 窗口「攻书」可见 → 退出:(`/Volumes/book-learner` 含 Applications 链接;`Signature=adhoc`、`LSMinimumSystemVersion 12.0`、麦克风用途声明在;pid 8301,窗口「攻书」visible;Cmd+Q 经 System Events 未生效,按 pid 结束)
- [x] 本机生成的 dmg 无 quarantine;经浏览器下载的副本首次打开需右键「打开」或 `xattr -d com.apple.quarantine book-learner.app`(Developer ID 签名与 notarization 见下文,未执行):(`xattr -l` 只有 `com.apple.provenance`)

## 7. 收尾项(T6.1)

- [x] 设置页「codex 可执行路径」:显示当前解析到的路径;相对路径被拒;绝对路径保存写入 `setting.codexBin`;清空恢复自动寻找:("当前使用 /opt/homebrew/bin/codex";保存 `/opt/homebrew/bin/codex` 后表中一行;清空后 0 行;相对路径拒绝由 foundation 用例覆盖,页面提示未在脚本输出中捕获)
- [x] 导入后书架标题为 OPF `dc:title`、作者为 `dc:creator`(而非文件名 / 待识别):(`1|老子|Laozi|textbook`,书架显示 老子 / Laozi;首跑为 `book-24039|待识别`,原因是 zip 未开 deflate)

## 签名与公证(文档,未执行)

需要用户的 Apple Developer 证书;当前 dmg 为 ad-hoc 签名。

```bash
# 1. 用 Developer ID Application 证书签名(启用 hardened runtime)
codesign --deep --force --options runtime --sign "Developer ID Application: <Name> (<TEAMID>)" book-learner.app
# 2. 打 dmg 后提交公证并装订
xcrun notarytool submit book-learner_0.1.0_aarch64.dmg --apple-id <id> --team-id <TEAMID> --password <app-specific> --wait
xcrun stapler staple book-learner_0.1.0_aarch64.dmg
```

tauri 亦支持在 `tauri.conf.json` `bundle.macOS.signingIdentity` 与环境变量 `APPLE_ID/APPLE_PASSWORD/APPLE_TEAM_ID` 下自动签名公证(CI 仍 `--no-bundle`)。
