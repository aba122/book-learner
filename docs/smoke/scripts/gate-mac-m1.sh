#!/bin/zsh
# docs/smoke/mac-m1-native-smoke.md §1–§3:seed → 首次原生启动检查 → 退出 → 同 fixture 重启 → 持久化检查
setopt pipefail
export PATH=/opt/homebrew/bin:$PATH; source ~/.cargo/env
cd ~/Developer/book-learner || exit 97
APP=web/src-tauri/target/debug/bundle/macos/book-learner.app/Contents/MacOS/book-learner
AUTO=~/Developer/bl-logs/bl-auto.py
SMOKE_DATA_DIR=$(mktemp -d /private/tmp/book-learner-mac-m1-smoke.XXXXXX)
echo "SMOKE_DATA_DIR=$SMOKE_DATA_DIR"
echo "== 1. seed"
cargo run -q --manifest-path web/src-tauri/Cargo.toml --example seed_smoke -- "$SMOKE_DATA_DIR" 2>&1 | tail -3
test -f "$SMOKE_DATA_DIR/app.db" && echo "seed-db-ok"
SOCK=$SMOKE_DATA_DIR/auto.sock
a() { python3 $AUTO $SOCK "$@"; }
launch() {
  BOOK_LEARNER_DATA_DIR=$SMOKE_DATA_DIR BOOK_LEARNER_AUTOMATION_SOCK=$SOCK $APP > $SMOKE_DATA_DIR/run-$1.log 2>&1 &
  echo $! > $SMOKE_DATA_DIR/pid
  for i in {1..60}; do [ -S $SOCK ] && break; sleep 0.5; done
  sleep 4
  echo "launched pid=$(cat $SMOKE_DATA_DIR/pid) sock=$([ -S $SOCK ] && echo yes || echo no)"
}
quit_and_wait() {
  a quit
  pid=$(cat $SMOKE_DATA_DIR/pid)
  for i in {1..40}; do kill -0 $pid 2>/dev/null || { echo "exited after ~$((i/2))s"; return 0; }; sleep 0.5; done
  echo "STILL RUNNING pid=$pid"; return 1
}
echo "== 2. first launch"
launch first
a js "return { tauri: !!window.__TAURI_INTERNALS__, title: document.title, route: location.pathname }"
echo "-- library"; a go /library >/dev/null; a wait "Mac 冒烟学习书" 30; a text | sed -n 1,25p
echo "-- map"; a click "Mac 冒烟学习书"; a wait "知识地图" 20 >/dev/null; a route; a text | sed -n 1,30p
echo "-- today"; a go / >/dev/null; sleep 2; a text | sed -n 1,20p
echo "-- stats"; a go /stats >/dev/null; a wait "统计" 20 >/dev/null; a text | sed -n 1,16p
echo "-- settings"; a go /settings >/dev/null; a wait "番茄钟" 20 >/dev/null
a js "return document.querySelector('[id=\"field-番茄钟(分钟)\"]').value"
a type '[id="field-番茄钟(分钟)"]' 37
a click "保存" exact; a wait "已保存" 20
echo "-- import wizard opens (real, not mock)"; a go /library >/dev/null; a wait "Mac 冒烟学习书" 20 >/dev/null; a click "导入" ; sleep 1; a text | grep -m3 "导入 EPUB\|选择 EPUB" ; a click "取消"
echo "-- quit (ExitRequested path)"; quit_and_wait
grep -E "有序退出|ERROR|panicked|自动化桥" $SMOKE_DATA_DIR/run-first.log | head -5
echo "== 3. relaunch same fixture"
launch second
a go /library >/dev/null; a wait "Mac 冒烟学习书" 30 >/dev/null; a text | sed -n 1,12p
a go /settings >/dev/null; a wait "番茄钟" 20 >/dev/null
echo "pomodoro-after-restart=$(a js "return document.querySelector('[id=\"field-番茄钟(分钟)\"]').value")"
quit_and_wait
grep -E "有序退出|ERROR|panicked" $SMOKE_DATA_DIR/run-second.log | head -5
echo "== db"; sqlite3 $SMOKE_DATA_DIR/app.db "select key,value from setting; select id,title,status from book; select count(*) from knowledge_block; pragma user_version;"
echo "GATE-MAC-M1-DONE $SMOKE_DATA_DIR"
