#!/bin/zsh
# m2-gate §6 补跑:在 dev 段数据目录上,推进日期让今日队列按当前主攻书(人文)生成 → 观点讨论;
# 再切换主攻到方法论书 → 情境化方法论。窗口置前 + 关 App Nap,避免后台 WebView 被节流。
setopt pipefail
export PATH=/opt/homebrew/bin:$PATH; source ~/.cargo/env
export https_proxy=http://127.0.0.1:7897 HTTPS_PROXY=http://127.0.0.1:7897 no_proxy=localhost,127.0.0.1
cd ~/Developer/book-learner || exit 97
AUTO=~/Developer/bl-logs/bl-auto.py
D=${1:?data dir}; SOCK=$D/auto.sock
a() { python3 $AUTO $SOCK "$@"; }
ts() { date +%H:%M:%S; }
sql() { sqlite3 $D/app.db "$1"; }
front() { osascript -e 'tell application "System Events" to set frontmost of process "book-learner" to true' >/dev/null 2>&1; }
dclick() { a js "const d=document.querySelector('[aria-label=\"$1\"]'); if(!d) return 'no-dialog'; const b=[...d.querySelectorAll('button')].find(x=>x.innerText.trim()==='$2'); if(!b) return 'no-button:'+[...d.querySelectorAll('button')].map(x=>x.innerText.trim()).join('|'); b.click(); return 'clicked'"; }
wait_think_done() { local t0=$(date +%s); a wait "$1" 8 >/dev/null 2>&1; a waitgone "$1" 300 >/dev/null || { echo "THINK TIMEOUT"; a text | tail -12; }; a waitgone "▍" 120 >/dev/null 2>&1; echo "[$(ts)] reply in $(( $(date +%s) - t0 ))s"; }
defaults write com.aba122.booklearner NSAppSleepDisabled -bool YES
rm -f $SOCK
( BOOK_LEARNER_DATA_DIR=$D BOOK_LEARNER_AUTOMATION_SOCK=$SOCK pnpm -C web tauri dev > $D/dev-extra2.log 2>&1 & )
for i in {1..720}; do [ -S $SOCK ] && break; sleep 0.5; done; sleep 6; front
echo "[$(ts)] dev sock=$([ -S $SOCK ] && echo yes || echo no) visible=$(a js "return document.visibilityState")"
sql "select id,title,type,status from book; select book_id,active,deadline from study_plan;"

teach_and_pass() {
  a go / >/dev/null; a wait "开始" 30 >/dev/null; front
  a click "开始" exact; a wait "开始费曼讲授" 120 >/dev/null; a route
  a click "开始费曼讲授" exact >/dev/null; a wait "复述输入" 30 >/dev/null; a route
  a type 'textarea[aria-label="复述输入"]' "$1" >/dev/null; a click "发送" exact >/dev/null; wait_think_done "学生思考中"
  a click "结束讲授" >/dev/null; a wait "讲授评估" 400 >/dev/null; a text | grep -m1 "建议通过\|建议再学"
  a click "确认通过" exact >/dev/null; a wait "附加环节" 30 >/dev/null
  a js "const d=document.querySelector('[aria-label=\"附加环节\"]'); return d ? d.querySelector('h2').innerText : 'no-extra-dialog'"
}
extra_stage() {
  dclick "附加环节" "开始" >/dev/null; wait_think_done "正在思考"
  a js "const d=document.querySelector('[aria-label=\"附加环节\"]'); return d.innerText.split('\n').slice(0,6).join(' | ')"
  for ans in "$@"; do a type 'textarea[aria-label="附加环节输入"]' "$ans" >/dev/null; dclick "附加环节" "发送" >/dev/null; wait_think_done "正在思考"; done
  dclick "附加环节" "整理并归档"; a wait "已归档" 400 >/dev/null
  a js "const d=document.querySelector('[aria-label=\"附加环节\"]'); return d.innerText.split('\n').slice(0,14).join(' | ')"
  dclick "附加环节" "返回今日" >/dev/null; a wait "今日学习" 20 >/dev/null
}

echo "== 人文 · 观点讨论(主攻书 = 当前 active,推进到第 5 天让队列重生成)"
a set bookLearner.testDate $(date -v+5d +%F) >/dev/null; a js "location.reload(); return 1" >/dev/null; sleep 5; front
a go / >/dev/null; sleep 3; a text | sed -n 8,22p
sql "select date,kind,status,book_id from daily_task where date='$(date -v+5d +%F)' order by id;"
teach_and_pass "这一段讲的是戏中戏的叙事结构:故事里嵌套着另一场演出,观众同时看到两层现实,作者借此讨论真假与人生如戏;这种双层结构在明清戏曲里并不少见。"
extra_stage "我认为这不只是叙事技巧,而是作者对当时社会虚伪风气的批评;文本里演出与现实的对照正是证据,观众的反应也被写进了戏里。"
ls $D/memory/books/; for f in $D/memory/books/*/_notes.md; do echo "--- $f"; head -16 $f; done
git -C $D/memory log --oneline | head -3
sql "select id,kind,book_id,block_id from artifact order by id;"

echo "== 方法论 · 情境化方法论(切换主攻到 book 2)"
METH_TITLE=$(sql "select title from book where type='methodology' limit 1")
a go /library >/dev/null; a wait "$METH_TITLE" 30 >/dev/null; front
a click "$METH_TITLE"; sleep 1; a text | grep -m2 "切换主攻书\|计划冻结"
dclick "切换主攻书?" "切换"; sleep 3; a route
sql "select book_id,active from study_plan; select id,title,status from book;"
a set bookLearner.testDate $(date -v+6d +%F) >/dev/null; a js "location.reload(); return 1" >/dev/null; sleep 5; front
a go / >/dev/null; sleep 3; a text | sed -n 8,22p
sql "select date,kind,status,book_id from daily_task where date='$(date -v+6d +%F)' order by id;"
teach_and_pass "孙子讲兵者诡道,核心是先算后战:庙算多者胜。要知彼知己,把胜负建立在充分的信息和准备之上,而不是靠运气;这一节的要点是计算与准备决定胜负。"
extra_stage "我当下的问题是给一个新功能定价,竞争对手也在观望。" "先算=先做用户调研和竞品价格测算;知彼=摸清对手成本结构;知己=清楚自己的边际成本和留存目标。" "我的版本:任何定价决策前,先用一周做三件事——用户支付意愿访谈、竞品价格与成本推测、自身成本与留存目标核算;三者不齐不决策。"
for f in $D/memory/books/*/_methodology.md; do echo "--- $f"; head -16 $f; done
git -C $D/memory log --oneline | head -3
sql "select id,kind,book_id,block_id from artifact order by id; select request_id,status,attempts,created_at,updated_at from ai_request where kind in ('turn','extra') order by rowid desc limit 8;"
a quit >/dev/null; for i in {1..60}; do a js "return 1" >/dev/null 2>&1 || break; sleep 1; done; sleep 3
echo "GATE-M2-EXTRA2-DONE $(date)"
