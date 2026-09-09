#!/bin/zsh
# 发布并替换本机正式版(唯一入口;不要再手动 cp):
#   拉 main(或 REF=分支/提交)→ 壳层测试 → release app+dmg → 优雅退出正在运行的正式版 → 替换 /Applications → 重开 → 打印版本
# 用法:zsh docs/smoke/scripts/install-release.sh            # main
#       REF=feat/xxx zsh docs/smoke/scripts/install-release.sh
#       SKIP_TESTS=1 zsh ...                                  # 跳过壳层测试(CI 已绿时)
setopt pipefail
export PATH=/opt/homebrew/bin:$PATH; source ~/.cargo/env 2>/dev/null
export https_proxy=${https_proxy:-http://127.0.0.1:7897} HTTPS_PROXY=${HTTPS_PROXY:-http://127.0.0.1:7897} no_proxy=localhost,127.0.0.1
REPO=${REPO:-$HOME/Developer/book-learner}; REF=${REF:-main}
APP=/Applications/book-learner.app
cd "$REPO" || { echo "repo missing: $REPO"; exit 97 }
git checkout -q -- web/src-tauri/Cargo.lock 2>/dev/null
git fetch -q origin && git checkout -q "$REF" 2>/dev/null && git pull -q --ff-only 2>/dev/null
echo "== build $(git rev-parse --short HEAD) ($REF) $(date '+%F %T')"
if [ -z "$SKIP_TESTS" ]; then
  # 只跑一次:输出落到临时文件,既打印摘要又按退出码/FAILED 判定
  TLOG=$(mktemp /tmp/bl-install-test.XXXX)
  ( cd web/src-tauri && cargo test > "$TLOG" 2>&1 ); rc=$?
  grep -E "^test result|FAILED|panicked" "$TLOG" | head -8
  { [ "$rc" != 0 ] || grep -q "FAILED" "$TLOG"; } && { echo "壳层测试失败,停止发布(日志 $TLOG)"; exit 1 }
  rm -f "$TLOG"
fi
( cd web && pnpm tauri build --bundles app,dmg 2>&1 | grep -E "Finished|Bundling|error\[|error:" | tail -4 ); rc=${pipestatus[1]}
[ "$rc" = 0 ] || { echo "构建失败 rc=$rc"; exit 1 }
SRC="$REPO/web/src-tauri/target/release/bundle/macos/book-learner.app"
[ -d "$SRC" ] || { echo "no bundle at $SRC"; exit 1 }

echo "== replace $APP"
if pgrep -f "$APP" >/dev/null; then
  osascript -e 'tell application "book-learner" to quit' >/dev/null 2>&1   # 走有序退出:结束番茄、刷快照
  for i in {1..30}; do pgrep -f "$APP" >/dev/null || break; sleep 1; done
  pgrep -f "$APP" >/dev/null && { echo "优雅退出超时,按 pid 结束"; kill $(pgrep -f "$APP"); sleep 2 }
  echo "old app quit"
fi
rm -rf "$APP" && cp -R "$SRC" "$APP" || { echo "copy failed"; exit 1 }
# 清掉门禁遗留的临时安装副本(只删本脚本族创建的目录)
rm -rf /private/tmp/bl-t6-inst.*(N) 2>/dev/null   # (N):zsh 无匹配时不报错
open -a "$APP" && sleep 4
pgrep -f "$APP" >/dev/null && echo "new app running" || echo "WARN: app not running after open"
echo "== installed: $(plutil -extract CFBundleShortVersionString raw "$APP/Contents/Info.plist" 2>/dev/null) git=$(git rev-parse --short HEAD) built=$(stat -f %Sm -t '%F %T' "$APP/Contents/MacOS/book-learner")"
echo "logs: ~/Library/Application Support/book-learner/logs/"
echo "INSTALL-RELEASE-DONE"
