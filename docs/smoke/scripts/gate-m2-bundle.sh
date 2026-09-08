#!/bin/zsh
# docs/smoke/m2-gate.md §1 系统通知、§2 番茄钟与托盘:以 debug bundle 运行(macOS 通知要求 bundle)
setopt pipefail
export PATH=/opt/homebrew/bin:$PATH; source ~/.cargo/env
cd ~/Developer/book-learner || exit 97
APP=web/src-tauri/target/debug/bundle/macos/book-learner.app/Contents/MacOS/book-learner
AUTO=~/Developer/bl-logs/bl-auto.py
D=$(mktemp -d /private/tmp/bl-m2-bundle.XXXXXX); SOCK=$D/auto.sock
echo "DATA_DIR=$D HEAD=$(git rev-parse --short HEAD) $(date)"
cargo run -q --manifest-path web/src-tauri/Cargo.toml --example seed_smoke -- "$D" 2>&1 | tail -1
a() { python3 $AUTO $SOCK "$@"; }
ts() { date +%H:%M:%S; }
sql() { sqlite3 $D/app.db "$1"; }
launch() {
  rm -f $SOCK
  BOOK_LEARNER_DATA_DIR=$D BOOK_LEARNER_AUTOMATION_SOCK=$SOCK $APP > $D/run-$1.log 2>&1 &
  echo $! > $D/pid
  for i in {1..60}; do [ -S $SOCK ] && break; sleep 0.5; done; sleep 4
  echo "[$(ts)] launched pid=$(cat $D/pid) sock=$([ -S $SOCK ] && echo yes || echo no)"
}
quit_and_wait() {
  a quit >/dev/null
  pid=$(cat $D/pid)
  for i in {1..40}; do kill -0 $pid 2>/dev/null || { echo "[$(ts)] exited"; return 0; }; sleep 0.5; done
  echo "STILL RUNNING pid=$pid"; return 1
}
launch 1
grep -E "系统通知权限|自动化桥" $D/run-1.log | head -2
# 今日队列:seed 的计划让今天有新块任务(pending)→ 晚间提醒条件成立
a go / >/dev/null; sleep 2; a text | sed -n 8,20p

echo "== §1 系统通知:提醒时间 = 现在+2 分钟,晚间 = 现在+4 分钟"
R1=$(date -v+2M +%H:%M); R2=$(date -v+4M +%H:%M); echo "remind=$R1 evening=$R2 now=$(date +%H:%M:%S)"
a go /settings >/dev/null; a wait "提醒时间" 20 >/dev/null
a type '[id="field-提醒时间"]' $R1 >/dev/null; a type '[id="field-晚间提醒(当日未完成时)"]' $R2 >/dev/null
a click "保存" exact >/dev/null; a wait "已保存" 20
sql "select key,value from setting where key in ('remindTime','eveningRemindTime');"
echo "-- 关闭主窗口(CloseRequested → 隐藏,app 常驻)"
osascript -e 'tell application "System Events" to tell process "book-learner" to set frontmost to true' 2>&1 | head -1
sleep 1
osascript -e 'tell application "System Events" to tell process "book-learner" to click button 1 of window 1' 2>&1 | head -1
sleep 2
echo "windows-visible=$(osascript -e 'tell application "System Events" to tell process "book-learner" to count of windows' 2>&1) pid-alive=$(kill -0 $(cat $D/pid) 2>/dev/null && echo yes || echo no)"
echo "-- 等到点(最多 5.5 分钟),每 20s 看日志与 setting 标记"
for i in {1..17}; do
  sleep 20
  marks=$(sql "select group_concat(key,',') from setting where key like 'notified:%';")
  sent=$(grep -c "已发送系统通知" $D/run-1.log)
  echo "[$(ts)] sent-log=$sent marks=$marks"
  [ "$sent" -ge 2 ] && break
done
grep -E "已发送系统通知|通知发送失败|提醒检查失败" $D/run-1.log | tail -4
sql "select key,value from setting where key like 'notified:%';"
echo "-- 同一天不再重复:再等 60s"
sleep 60; echo "sent-log-after=$(grep -c '已发送系统通知' $D/run-1.log)"
echo "-- 恢复窗口(Reopen 路径由 Dock 点击触发;此处直接把窗口显示)"
osascript -e 'tell application "System Events" to tell process "book-learner" to set frontmost to true' 2>&1 | head -1
sleep 1; a js "return { visible: document.visibilityState, route: location.pathname }"

echo "== §2 番茄钟与托盘倒计时(番茄钟 1 分钟、休息 1 分钟)"
a go /settings >/dev/null; a wait "番茄钟" 20 >/dev/null
a type '[id="field-番茄钟(分钟)"]' 1 >/dev/null; a type '[id="field-休息(分钟)"]' 1 >/dev/null
a click "保存" exact >/dev/null; a wait "已保存" 20 >/dev/null
a go / >/dev/null; a wait "专注" 20 >/dev/null
a click "专注" exact; sleep 2
for i in 1 2 3; do echo "[$(ts)] tray=$(a tray) panel=$(a js "return (document.body.innerText.match(/(专注中|小憩片刻|已暂停)[^\n]*\n[^\n]*/)||[''])[0].replace(/\n/g,' ')")"; sleep 1; done
echo "-- 暂停 / 继续"
a click "暂停" exact >/dev/null; sleep 2; T1=$(a tray); sleep 2; T2=$(a tray); echo "paused tray: $T1 → $T2 (should be equal, ‖)"
a click "继续" exact >/dev/null; sleep 2; echo "resumed tray=$(a tray)"
echo "-- 关窗后托盘继续走"
osascript -e 'tell application "System Events" to tell process "book-learner" to click button 1 of window 1' 2>&1 | head -1
sleep 3; echo "hidden tray=$(a tray)"; sleep 3; echo "hidden tray=$(a tray)"
echo "-- 等专注结束(≤70s):通知 + 自动进入休息(○)"
for i in {1..14}; do sleep 5; t=$(a tray); echo "[$(ts)] tray=$t"; echo "$t" | grep -q "○" && break; done
grep -E "专注结束|休息结束|番茄钟通知" $D/run-1.log | tail -3
sql "select date,book_id,task_id,minutes,source from study_minutes;"
echo "-- 等休息结束(≤70s)→ 空闲"
for i in {1..14}; do sleep 5; t=$(a tray); echo "[$(ts)] tray=$t"; [ "$t" = '{"title": null}' ] && break; done
grep -E "专注结束|休息结束" $D/run-1.log | tail -3
echo "-- 再专注 65s 后手动结束 → 记 1 分钟;然后运行中退出 → 落分钟"
osascript -e 'tell application "System Events" to tell process "book-learner" to set frontmost to true' >/dev/null 2>&1
a go / >/dev/null; a wait "专注" 20 >/dev/null; a click "专注" exact >/dev/null; sleep 65; a click "结束" exact >/dev/null; sleep 2
sql "select date,minutes from study_minutes;"
a click "专注" exact >/dev/null; sleep 62; echo "tray-before-quit=$(a tray)"
quit_and_wait
grep -E "退出前番茄钟|有序退出" $D/run-1.log | tail -2
sql "select date,minutes from study_minutes;"
echo "-- 统计页今日投入 = max(预估, 番茄)"
launch 2
a go /stats >/dev/null; a wait "今日投入" 20 >/dev/null; a js "return document.querySelector('[data-testid=stat-minutes]').innerText"
quit_and_wait
echo "GATE-M2-BUNDLE-DONE $D $(date)"
