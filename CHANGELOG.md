# 更新日志

版本号 = `web/src-tauri/tauri.conf.json` 的 `version`;设置页「诊断」显示当前包的 git 提交与构建时间。测试阶段按批次发版:攒 3–5 个修复或遇 P0 即发;每个批次打 tag。

## Unreleased(main)
- 修复:Finder 启动后 codex 子进程找不到 node,导入/回合报「AI 暂时没有回应」(PR #32,BL-004)
- 新增:文件日志 `logs/app.log.YYYY-MM-DD`、设置页「诊断」分区、`install-release.sh` 换包脚本(PR #34)
- 新增:书架删除书、「导入未完成」徽标(PR #35,BL-005)
- 新增:测试阶段套件——缺陷台账 `docs/testing/BUGS.md`、报告模板、测试清单、一键诊断包 `diag-bundle.sh`
- 文档:代码地图 `docs/CODE_MAP.md`、PDF 过渡方案 `docs/pdf-import.md`
- 修复:阅读器选中文字出高亮工具条(PR #39,BL-006);「回读原文」精确锚点回填(PR #38,BL-001)
- 新增:阅读器取消高亮/换色、双页显示、两侧点击翻页(PR #40,BL-007/008/009)
- 新增:仿纸书两拍 3D 翻页(PR #41,BL-010 返工;双页整跨翻转)
- 新增:知识地图编辑态「并入上一块 / 拆分 / 删除」(PR #41,BL-002)
- 修复:夜读模式重开后失效(PR #41,BL-003)

## 0.1.0 — 2026-09-08(tag `m3`)
- M1 核心闭环、M2 学习系统、M3 体验完善(整书终评、Obsidian 导出、whisper 语音、阅读器打磨、数据安全、dmg 打包)全部合入;桌面门禁 `docs/smoke/*.md` 签字。
