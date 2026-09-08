#!/bin/zsh
# ① bundle:关窗后经 Dock/open 的 Reopen 路径恢复窗口(m2-gate §3.8 托盘常驻·快速恢复);② 再跑 dev 段门禁
setopt pipefail
export PATH=/opt/homebrew/bin:$PATH; source ~/.cargo/env
cd ~/Developer/book-learner || exit 97
APPDIR=web/src-tauri/target/debug/bundle/macos/book-learner.app
APP=$APPDIR/Contents/MacOS/book-learner
AUTO=~/Developer/bl-logs/bl-auto.py
D=$(mktemp -d /private/tmp/bl-m2-reopen.XXXXXX); SOCK=$D/auto.sock
cargo run -q --manifest-path web/src-tauri/Cargo.toml --example seed_smoke -- "$D" 2>&1 | tail -1
a() { python3 $AUTO $SOCK "$@"; }
BOOK_LEARNER_DATA_DIR=$D BOOK_LEARNER_AUTOMATION_SOCK=$SOCK $APP > $D/run.log 2>&1 &
echo $! > $D/pid
for i in {1..60}; do [ -S $SOCK ] && break; sleep 0.5; done; sleep 4
echo "== reopen: visible=$(a js "return document.visibilityState")"
osascript -e 'tell application "System Events" to tell process "book-learner" to click button 1 of window 1' >/dev/null 2>&1; sleep 2
echo "after close: windows=$(osascript -e 'tell application "System Events" to tell process "book-learner" to count of windows' 2>&1) visible=$(a js "return document.visibilityState") tray=$(a tray)"
open "$APPDIR"; sleep 3
echo "after open -a (Reopen): windows=$(osascript -e 'tell application "System Events" to tell process "book-learner" to count of windows' 2>&1) visible=$(a js "return document.visibilityState")"
grep -E "Reopen|显示主窗口" $D/run.log | tail -2
a quit >/dev/null; pid=$(cat $D/pid); for i in {1..40}; do kill -0 $pid 2>/dev/null || break; sleep 0.5; done
echo "REOPEN-DONE"
zsh ~/Developer/bl-logs/gate-m2-dev-cmd.sh
