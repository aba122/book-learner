#!/bin/zsh
# m1-e2e 第 7 步补跑:受控日期 +2 天,完成队首薄弱点重考并确认 → weak_point.pass_streak 2 → fixed
setopt pipefail
export PATH=/opt/homebrew/bin:$PATH; source ~/.cargo/env
export https_proxy=http://127.0.0.1:7897 HTTPS_PROXY=http://127.0.0.1:7897 no_proxy=localhost,127.0.0.1
cd ~/Developer/book-learner || exit 97
AUTO=~/Developer/bl-logs/bl-auto.py
D=${1:?data dir}; SOCK=$D/auto.sock
a() { python3 $AUTO $SOCK "$@"; }
ts() { date +%H:%M:%S; }
sql() { sqlite3 $D/app.db "$1"; }
rm -f $SOCK
( BOOK_LEARNER_DATA_DIR=$D BOOK_LEARNER_AUTOMATION_SOCK=$SOCK pnpm -C web tauri dev > $D/dev-day2.log 2>&1 & )
for i in {1..720}; do [ -S $SOCK ] && break; sleep 0.5; done; sleep 6
echo "[$(ts)] dev sock=$([ -S $SOCK ] && echo yes || echo no)"
sql "select id,title,status,pass_streak from weak_point; select id,kind,state,version from feynman_session order by id desc limit 3;"
for day in 2 3; do
  NEXT=$(date -v+${day}d +%F); echo "-- testDate=$NEXT"
  a set bookLearner.testDate $NEXT >/dev/null; a js "location.reload(); return 1" >/dev/null; sleep 5
  a go / >/dev/null; a wait "重考" 60 >/dev/null; a text | sed -n 8,16p
  a click "开始重考" exact >/dev/null; a wait "复述输入" 30 >/dev/null
  a wait "学生思考中" 8 >/dev/null 2>&1; a waitgone "学生思考中" 300 >/dev/null; a waitgone "▍" 120 >/dev/null
  echo "[$(ts)] opener answered"; a text | sed -n 12,24p
  a type 'textarea[aria-label="复述输入"]' "我之前把道当成可以说尽的规则,这是错的:道可道,非常道,道不可言尽;无为也不是多干预,而是不妄为、顺其自然。原文第一章和第二章都是反证。" >/dev/null
  a click "发送" exact >/dev/null; a wait "学生思考中" 8 >/dev/null 2>&1; a waitgone "学生思考中" 300 >/dev/null; a waitgone "▍" 120 >/dev/null
  echo "[$(ts)] answer replied"; a text | sed -n 12,30p
  a click "结束讲授" >/dev/null; a wait "讲授评估" 400 >/dev/null; a text | grep -m2 "建议通过\|建议再学"
  a click "确认通过" exact >/dev/null; a wait "今日学习" 30 >/dev/null; a route
  sql "select id,title,status,pass_streak,fixed_at from weak_point order by id; select date,kind,status from daily_task where date='$NEXT';"
  sql "select status,count(*) from projection_outbox group by status;"
  fixed=$(sql "select count(*) from weak_point where status='fixed'")
  [ "$fixed" -ge 1 ] && { echo "FIXED after day $day"; break; }
done
cat $D/memory/books/*/_weakpoints.md; git -C $D/memory log --oneline | head -4
a quit >/dev/null; for i in {1..60}; do a js "return 1" >/dev/null 2>&1 || break; sleep 1; done; sleep 3
grep -E "有序退出" $D/dev-day2.log | tail -1
echo "GATE-M1-DAY2-DONE $(date)"
