#!/bin/zsh
# m2-gate §3 落后重排补跑:主攻书(book 2,方法论)截止日改到"明天",连续两天不完成 → 第三天 needs_decision;
# 先验"顺延"分支(截止日改变),再制造一次验"缩减"分支(块被跳过,截止不变)。
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
pick() { a js "const d=document.querySelector('[aria-label=\"进度落后,需要你决定\"]'); if(!d) return 'no-dialog'; const b=[...d.querySelectorAll('button')].find(x=>x.innerText.trim().startsWith('$1')); if(!b) return 'no-button:'+[...d.querySelectorAll('button')].map(x=>x.innerText.trim()).join('|'); b.click(); return 'clicked:'+b.innerText.trim()"; }
rm -f $SOCK
( BOOK_LEARNER_DATA_DIR=$D BOOK_LEARNER_AUTOMATION_SOCK=$SOCK pnpm -C web tauri dev > $D/dev-replan.log 2>&1 & )
for i in {1..720}; do [ -S $SOCK ] && break; sleep 0.5; done; sleep 6; front
ACTIVE=$(sql "select book_id from study_plan where active=1"); echo "active=$ACTIVE"
[ -z "$ACTIVE" ] && { echo "NO ACTIVE BOOK"; a quit >/dev/null; exit 1; }
BASE=$(a ls bookLearner.testDate | tr -d '"'); echo "testDate now=$BASE"
# 截止 = 基准日 +1,然后跳到 +3:截止已过 → 剩余块/1 天 > 上限 4 → needs_decision
sql "update study_plan set deadline='$(date -v+13d +%F)' where book_id=$ACTIVE;"
sql "select book_id,deadline,daily_new_blocks,daily_cap,active from study_plan where active=1; select count(*) from knowledge_block where book_id=$ACTIVE and skipped=0 and status='unlearned';"
echo "== 顺延分支:推进到 $(date -v+15d +%F)"
a set bookLearner.testDate $(date -v+15d +%F) >/dev/null; a js "location.reload(); return 1" >/dev/null; sleep 5; front
a go / >/dev/null; a wait "进度落后" 60; a text | grep -m4 "进度落后\|顺延\|缩减\|均摊"
pick "顺延"; sleep 3
sql "select book_id,deadline,daily_new_blocks from study_plan where active=1;"
a text | sed -n 8,14p
echo "== 缩减分支:截止改回已过,推进到 $(date -v+17d +%F)"
sql "update study_plan set deadline='$(date -v+15d +%F)' where book_id=$ACTIVE;"
BEFORE=$(sql "select count(*) from knowledge_block where book_id=$ACTIVE and skipped=1")
a set bookLearner.testDate $(date -v+17d +%F) >/dev/null; a js "location.reload(); return 1" >/dev/null; sleep 5; front
a go / >/dev/null; a wait "进度落后" 60; a text | grep -m4 "进度落后\|顺延\|缩减"
pick "缩减"; sleep 3
sql "select book_id,deadline,daily_new_blocks from study_plan where active=1; select count(*) from knowledge_block where book_id=$ACTIVE and skipped=1;"
echo "skipped before=$BEFORE after=$(sql "select count(*) from knowledge_block where book_id=$ACTIVE and skipped=1")"
a text | sed -n 8,14p
a quit >/dev/null; for i in {1..60}; do a js "return 1" >/dev/null 2>&1 || break; sleep 1; done; sleep 3
echo "GATE-M2-REPLAN-DONE $(date)"
