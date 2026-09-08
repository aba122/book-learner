#!/bin/zsh
# m2-gate §6 人文补跑:复制戲中戲为新文件名导入(书名当前取自文件名)→ 主攻 → 次日新块 → 讲授 → 观点讨论 → _notes.md
setopt pipefail
export PATH=/opt/homebrew/bin:$PATH; source ~/.cargo/env
export https_proxy=http://127.0.0.1:7897 HTTPS_PROXY=http://127.0.0.1:7897 no_proxy=localhost,127.0.0.1
cd ~/Developer/book-learner || exit 97
AUTO=~/Developer/bl-logs/bl-auto.py
D=${1:?data dir}; SOCK=$D/auto.sock
cp -f ~/Developer/bl-smoke/book-24225.epub ~/Developer/bl-smoke/xizhongxi.epub
a() { python3 $AUTO $SOCK "$@"; }
ts() { date +%H:%M:%S; }
sql() { sqlite3 $D/app.db "$1"; }
front() { osascript -e 'tell application "System Events" to set frontmost of process "book-learner" to true' >/dev/null 2>&1; }
dclick() { a js "const d=document.querySelector('[aria-label=\"$1\"]'); if(!d) return 'no-dialog'; const b=[...d.querySelectorAll('button')].find(x=>x.innerText.trim()==='$2'); if(!b) return 'no-button:'+[...d.querySelectorAll('button')].map(x=>x.innerText.trim()).join('|'); b.click(); return 'clicked'"; }
wait_think_done() { local t0=$(date +%s); a wait "$1" 8 >/dev/null 2>&1; a waitgone "$1" 300 >/dev/null || { echo "THINK TIMEOUT"; a text | tail -12; }; a waitgone "▍" 120 >/dev/null 2>&1; echo "[$(ts)] reply in $(( $(date +%s) - t0 ))s"; }
rm -f $SOCK
( BOOK_LEARNER_DATA_DIR=$D BOOK_LEARNER_AUTOMATION_SOCK=$SOCK pnpm -C web tauri dev > $D/dev-hum.log 2>&1 & )
for i in {1..720}; do [ -S $SOCK ] && break; sleep 0.5; done; sleep 6; front
BASE=$(a ls bookLearner.testDate | tr -d '"'); echo "[$(ts)] testDate=$BASE"
a go /library >/dev/null; a wait "导入书籍" 60 >/dev/null
a click "导入书籍" >/dev/null; a wait "选择 EPUB 文件" 20 >/dev/null
a file 'input[type=file]' ~/Developer/bl-smoke/xizhongxi.epub >/dev/null; a wait "这是哪一类书" 20 >/dev/null; a click "人文·社科" >/dev/null
T0=$(date +%s)
for i in {1..240}; do t=$(a js "const d=document.querySelector('[aria-label=\"导入书籍\"]'); return d ? d.innerText.split('\n')[0] : null" 2>/dev/null); [ "$t" = "null" ] && break; echo "$t" | grep -q "导入未完成" && { echo "IMPORT FAILED"; a text | sed -n 1,30p; break; }; sleep 5; done
echo "[$(ts)] imported in $(( $(date +%s) - T0 ))s"
BOOK_ID=$(sql "select id from book order by id desc limit 1"); BOOK_TITLE=$(sql "select title from book where id=$BOOK_ID")
a click "$BOOK_TITLE" >/dev/null; a wait "知识地图" 30 >/dev/null
a click "编辑地图" exact >/dev/null; sleep 1; a click "确认定稿" exact >/dev/null; a wait "设定攻克目标" 60 >/dev/null
a type 'input[type=date]' $(date -v+12d +%F) >/dev/null; sleep 1; a click "开始学习" exact >/dev/null; a wait "今日学习" 30 >/dev/null
echo "book=$BOOK_ID title=$BOOK_TITLE type=$(sql "select type from book where id=$BOOK_ID") blocks=$(sql "select count(*) from knowledge_block where book_id=$BOOK_ID") plan=$(sql "select deadline,daily_new_blocks,active from study_plan where book_id=$BOOK_ID")"
# 次日队列按新主攻书生成
NEXT=$(date -v+8d +%F); a set bookLearner.testDate $NEXT >/dev/null; a js "location.reload(); return 1" >/dev/null; sleep 5; front
a go / >/dev/null; sleep 3; sql "select date,kind,status,book_id from daily_task where date='$NEXT' order by id;"
a click "开始" exact; a wait "开始费曼讲授" 120 >/dev/null; a route
a click "开始费曼讲授" exact >/dev/null; a wait "复述输入" 30 >/dev/null
a type 'textarea[aria-label="复述输入"]' "这一段讲的是戏中戏的叙事结构:故事里嵌套着另一场演出,观众同时看到两层现实,作者借此讨论真假与人生如戏;这种双层结构在明清戏曲里并不少见。" >/dev/null
a click "发送" exact >/dev/null; wait_think_done "学生思考中"
a click "结束讲授" >/dev/null; a wait "讲授评估" 400 >/dev/null; a text | grep -m1 "建议通过\|建议再学"
a click "确认通过" exact >/dev/null; a wait "附加环节" 30 >/dev/null
a js "const d=document.querySelector('[aria-label=\"附加环节\"]'); return d ? d.querySelector('h2').innerText : 'no-extra-dialog'"
dclick "附加环节" "开始" >/dev/null; wait_think_done "正在思考"
a js "const d=document.querySelector('[aria-label=\"附加环节\"]'); return d.innerText.split('\n').slice(0,6).join(' | ')"
a type 'textarea[aria-label="附加环节输入"]' "我认为这不只是叙事技巧,而是作者对当时社会虚伪风气的批评;文本里演出与现实的对照正是证据,观众的反应也被写进了戏里。" >/dev/null
dclick "附加环节" "发送" >/dev/null; wait_think_done "正在思考"
dclick "附加环节" "整理并归档"; a wait "已归档" 400 >/dev/null
a js "const d=document.querySelector('[aria-label=\"附加环节\"]'); return d.innerText.split('\n').slice(0,14).join(' | ')"
dclick "附加环节" "返回今日" >/dev/null; a wait "今日学习" 20 >/dev/null
for f in $D/memory/books/*/_notes.md; do echo "--- $f"; head -16 $f; done
git -C $D/memory log --oneline | head -3
sql "select id,kind,book_id,block_id from artifact order by id;"
a quit >/dev/null; for i in {1..60}; do a js "return 1" >/dev/null 2>&1 || break; sleep 1; done; sleep 3
echo "GATE-M2-HUM-DONE $(date)"
