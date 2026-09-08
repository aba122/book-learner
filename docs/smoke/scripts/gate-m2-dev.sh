#!/bin/zsh
# docs/smoke/m2-gate.md §3 落后重排、§4 单主攻书、§5 快问、§6 附加环节(三类书)、§7 画像、§8 统计
# tauri dev(DEV 构建:受控日期)+ 调试自动化桥 + 真 codex
setopt pipefail
export PATH=/opt/homebrew/bin:$PATH; source ~/.cargo/env
export https_proxy=http://127.0.0.1:7897 HTTPS_PROXY=http://127.0.0.1:7897 no_proxy=localhost,127.0.0.1
cd ~/Developer/book-learner || exit 97
AUTO=~/Developer/bl-logs/bl-auto.py
B_TEXT=$HOME/Developer/bl-smoke/book-24039.epub   # 老子(教材模板)
B_METH=$HOME/Developer/bl-smoke/book-23864.epub   # 孫子兵法(方法论模板)
B_HUM=$HOME/Developer/bl-smoke/book-24225.epub    # 戲中戲(人文模板)
D=$(mktemp -d /tmp/bl-m2-dev.XXXXXX); SOCK=$D/auto.sock
echo "DATA_DIR=$D HEAD=$(git rev-parse --short HEAD) $(date)"
a() { python3 $AUTO $SOCK "$@"; }
ts() { date +%H:%M:%S; }
sql() { sqlite3 $D/app.db "$1"; }
launch_dev() {
  rm -f $SOCK
  ( BOOK_LEARNER_DATA_DIR=$D BOOK_LEARNER_AUTOMATION_SOCK=$SOCK pnpm -C web tauri dev > $D/dev-$1.log 2>&1 & )
  for i in {1..720}; do [ -S $SOCK ] && break; sleep 0.5; done; sleep 6
  echo "[$(ts)] dev-$1 sock=$([ -S $SOCK ] && echo yes || echo no)"
}
wait_exit() { for i in {1..60}; do a js "return 1" >/dev/null 2>&1 || { sleep 3; echo "[$(ts)] app exited"; return 0; }; sleep 1; done; echo "STILL RUNNING"; return 1; }
# 在某个 dialog 内点按钮
dclick() { a js "const d=document.querySelector('[aria-label=\"$1\"]'); if(!d) return 'no-dialog'; const b=[...d.querySelectorAll('button')].find(x=>x.innerText.trim()==='$2'); if(!b) return 'no-button:'+[...d.querySelectorAll('button')].map(x=>x.innerText.trim()).join('|'); b.click(); return 'clicked'"; }
wait_think_done() { a wait "$1" 8 >/dev/null 2>&1; a waitgone "$1" 300 >/dev/null || { echo "THINK TIMEOUT"; a text | tail -20; }; a waitgone "▍" 120 >/dev/null 2>&1; }

import_book() { # file typeLabel deadlineDays
  a go /library >/dev/null; a wait "导入书籍" 60 >/dev/null
  a click "导入书籍" >/dev/null; a wait "选择 EPUB 文件" 20 >/dev/null
  a file 'input[type=file]' $1 >/dev/null; a wait "这是哪一类书" 20 >/dev/null; a click "$2" >/dev/null
  T0=$(date +%s)
  for i in {1..240}; do t=$(a js "const d=document.querySelector('[aria-label=\"导入书籍\"]'); return d ? d.innerText.split('\n')[0] : null" 2>/dev/null); [ "$t" = "null" ] && break; echo "$t" | grep -q "导入未完成" && { echo "IMPORT FAILED"; a text | sed -n 1,30p; return 1; }; sleep 5; done
  echo "[$(ts)] imported $(basename $1) as $2 in $(( $(date +%s) - T0 ))s"
  BOOK_TITLE=$(sql "select title from book order by id desc limit 1"); BOOK_ID=$(sql "select id from book order by id desc limit 1")
  a click "$BOOK_TITLE" >/dev/null; a wait "知识地图" 30 >/dev/null
  a click "编辑地图" exact; sleep 1
  a click "确认定稿" exact; a wait "设定攻克目标" 60
  a type 'input[type=date]' $(date -v+${3}d +%F); sleep 1
  a click "开始学习" exact; a wait "今日学习" 30
  echo "book=$BOOK_ID title=$BOOK_TITLE blocks=$(sql "select count(*) from knowledge_block where book_id=$BOOK_ID") plan=$(sql "select deadline,daily_new_blocks,active from study_plan where book_id=$BOOK_ID")"
}

teach_and_pass() { # 讲授一轮 → 评估 → 确认通过(留在附加环节对话框)
  a go / >/dev/null; a wait "开始" 30 >/dev/null
  a click "开始" exact >/dev/null; a wait "开始费曼讲授" 120 >/dev/null
  a click "开始费曼讲授" exact >/dev/null; a wait "复述输入" 30 >/dev/null
  a type 'textarea[aria-label="复述输入"]' "$1" >/dev/null; a click "发送" exact >/dev/null; wait_think_done "学生思考中"
  a click "结束讲授" >/dev/null; a wait "讲授评估" 400 >/dev/null
  a text | grep -m2 "建议通过\|建议再学"
  a click "确认通过" exact >/dev/null; a wait "附加环节" 30 >/dev/null
  a js "const d=document.querySelector('[aria-label=\"附加环节\"]'); return d.querySelector('h2').innerText"
}

extra_stage() { # kindTitle answers...
  local title=$1; shift
  dclick "附加环节" "开始" >/dev/null; wait_think_done "正在思考"
  a js "const d=document.querySelector('[aria-label=\"附加环节\"]'); return d.innerText.split('\n').slice(0,6).join(' | ')"
  for ans in "$@"; do
    a type 'textarea[aria-label="附加环节输入"]' "$ans" >/dev/null; dclick "附加环节" "发送" >/dev/null; wait_think_done "正在思考"
  done
  dclick "附加环节" "整理并归档"; a wait "已归档" 400 >/dev/null
  a js "const d=document.querySelector('[aria-label=\"附加环节\"]'); return d.innerText.split('\n').slice(0,12).join(' | ')"
  dclick "附加环节" "返回今日" >/dev/null; a wait "今日学习" 20 >/dev/null
}

echo "== 0. 启动"
launch_dev 1

echo "== §6a 教材:迁移应用题"
import_book $B_TEXT "教材" 7
teach_and_pass "老子说的道,是天地万物运行的根本规律,不能用言语完全说尽;德是道在具体事物上的体现。统治者应当无为而治,少干预,让百姓自然发展。"
extra_stage "迁移应用题" "如果把这套思路用到团队管理上:少发指令、多定边界,让成员自己找到做事的方式;我会先核实团队成员是否已经具备自我驱动的能力,再决定放手的程度。"
sql "select id,kind,block_id,length(content_md) from artifact;"; ls $D/memory/books/*/; head -12 $D/memory/books/*/_applications.md; git -C $D/memory log --oneline | head -3

echo "== §7 学习者画像"
a go /settings >/dev/null; a wait "学习者画像" 20 >/dev/null
a js "const set=(l,v)=>{const el=[...document.querySelectorAll('label')].find(x=>x.innerText.trim().startsWith(l)).querySelector('textarea'); Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype,'value').set.call(el,v); el.dispatchEvent(new Event('input',{bubbles:true}));}; set('知识背景','经济学研究者,读过古典中国哲学入门'); set('个人情境','在做平台定价研究,带一个 5 人的小团队'); return 'set'"
a click "保存画像" exact >/dev/null; a wait "画像已保存" 30
sleep 3; sed -n 1,14p $D/memory/profile.md; git -C $D/memory log --oneline | head -2

echo "== §6b 方法论:情境化方法论"
import_book $B_METH "方法论" 7
teach_and_pass "孙子讲兵者诡道,核心是先算后战:庙算多者胜。要知彼知己,把胜负建立在充分的信息和准备之上,而不是靠运气。"
extra_stage "情境化方法论" "我当下的问题是给一个新功能定价,竞争对手也在观望。" "先算=先做用户调研和竞品价格测算;知彼=摸清对手成本结构;知己=清楚自己的边际成本和留存目标。" "我的版本:任何定价决策前,先用一周做三件事——用户支付意愿访谈、竞品价格与成本推测、自身成本与留存目标核算;三者不齐不决策。"
head -14 $D/memory/books/*/_methodology.md; git -C $D/memory log --oneline | head -2

echo "== §6c 人文:观点讨论(截止 +2 天,供 §3 制造落后)"
import_book $B_HUM "人文·社科" 2
teach_and_pass "这一段讲的是戏中戏的叙事结构:故事里嵌套着另一场演出,观众同时看到两层现实,作者借此讨论真假与人生如戏。"
extra_stage "观点讨论" "我认为这不只是叙事技巧,而是作者对当时社会虚伪风气的批评;文本里演出与现实的对照正是证据。"
head -14 $D/memory/books/*/_notes.md; git -C $D/memory log --oneline | head -3
sql "select id,title,type,status from book; select b.id,b.title,b.status,b.book_id from knowledge_block b where b.status<>'unlearned'; select id,kind,book_id from artifact;"

echo "== §4 单主攻书:把教材书标记为已学完"
a go /library >/dev/null; a wait "标记为已学完" 30 >/dev/null
a js "const card=[...document.querySelectorAll('button')].find(b=>b.innerText.trim()==='标记为已学完'); card.click(); return 'ok'"
sleep 1; dclick "标记为已学完?" "标记为已学完"; sleep 2
a text | grep -m3 "已学完\|复习照常\|主攻中"
sql "select id,title,status from book; select book_id,active from study_plan;"

echo "== §5 快问:推进 1 天,通过的块出现间隔复习"
a set bookLearner.testDate $(date -v+1d +%F) >/dev/null; a js "location.reload(); return 1" >/dev/null; sleep 4
a go / >/dev/null; sleep 3; a text | sed -n 8,30p
sql "select date,kind,status,book_id from daily_task order by id;"
a click "开始复习" exact >/dev/null; a wait "复述输入" 30 >/dev/null; wait_think_done "学生思考中"; a text | sed -n 12,26p
a type 'textarea[aria-label="复述输入"]' "核心结论:道是不可言尽的根本规律;成立的前提是承认人的认知有限,顺应而非强为。" >/dev/null; a click "发送" exact >/dev/null; wait_think_done "学生思考中"
a click "结束讲授" >/dev/null; a wait "讲授评估" 400 >/dev/null; a click "确认通过" exact >/dev/null; a wait "今日学习" 30 >/dev/null
sql "select block_id,stage,due_date,status from review_schedule order by id;"

echo "== §3 落后重排:推进到第 4 天(人文书截止 +2 已过)"
a set bookLearner.testDate $(date -v+4d +%F) >/dev/null; a js "location.reload(); return 1" >/dev/null; sleep 4
a go / >/dev/null; a wait "进度落后" 60; a text | grep -m4 "进度落后\|顺延\|缩减"
DEADLINE_BEFORE=$(sql "select deadline from study_plan where active=1")
a js "const d=document.querySelector('[aria-label=\"进度落后,需要你决定\"]'); if(!d) return 'no-dialog:'+document.body.innerText.slice(0,300); const b=[...d.querySelectorAll('button')].find(x=>x.innerText.trim().startsWith('顺延')); if(!b) return 'no-button:'+[...d.querySelectorAll('button')].map(x=>x.innerText.trim()).join('|'); b.click(); return 'clicked:'+b.innerText.trim()"; sleep 3
sql "select book_id,deadline,daily_new_blocks,active from study_plan;"
echo "deadline: $DEADLINE_BEFORE → $(sql "select deadline from study_plan where active=1")"

echo "== §8 统计页三区"
a go /stats >/dev/null; a wait "进度" 20 >/dev/null
a js "return [...document.querySelectorAll('[data-testid=progress-book]')].map(e=>e.innerText.replace(/\n/g,' '))"
a js "return { minutes: document.querySelector('[data-testid=effort-minutes]').innerText, active: document.querySelector('[data-testid=streak-active-days]').innerText, weakOpened: document.querySelector('[data-testid=weak-opened]').innerText, weakFixed: document.querySelector('[data-testid=weak-fixed]').innerText, pass: (document.querySelector('[data-testid=review-pass-rate]')||{}).innerText }"
sql "select count(*) from weak_point where status='open'; select status,count(*) from review_schedule group by status; select date,status,kind from daily_task where status='done';"
a quit >/dev/null; wait_exit
echo "GATE-M2-DEV-DONE $D $(date)"
