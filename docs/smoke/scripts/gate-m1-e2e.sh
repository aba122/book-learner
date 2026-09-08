#!/bin/zsh
# docs/smoke/m1-e2e-gate.md 七步(真书 + 真 codex),tauri dev(DEV 构建:受控日期可用)+ 调试自动化桥
setopt pipefail
export PATH=/opt/homebrew/bin:$PATH; source ~/.cargo/env
export https_proxy=http://127.0.0.1:7897 HTTPS_PROXY=http://127.0.0.1:7897 no_proxy=localhost,127.0.0.1
cd ~/Developer/book-learner || exit 97
AUTO=~/Developer/bl-logs/bl-auto.py
EPUB=${EPUB:-$HOME/Developer/bl-smoke/book-7337.epub}
D=$(mktemp -d /tmp/bl-e2e.XXXXXX); SOCK=$D/auto.sock
echo "DATA_DIR=$D EPUB=$EPUB size=$(stat -f %z $EPUB) HEAD=$(git rev-parse --short HEAD) $(date)"
codex --version
a() { python3 $AUTO $SOCK "$@"; }
ts() { date +%H:%M:%S; }
launch_dev() {
  rm -f $SOCK
  ( BOOK_LEARNER_DATA_DIR=$D BOOK_LEARNER_AUTOMATION_SOCK=$SOCK pnpm -C web tauri dev > $D/dev-$1.log 2>&1 & )
  for i in {1..720}; do [ -S $SOCK ] && break; sleep 0.5; done
  sleep 6
  echo "[$(ts)] dev-$1 sock=$([ -S $SOCK ] && echo yes || echo no) pid=$(pgrep -f 'target/debug/book-learner$' | head -1)"
}
wait_exit() {
  for i in {1..60}; do a js "return 1" >/dev/null 2>&1 || { sleep 3; echo "[$(ts)] app exited; tauri-dev alive=$(pgrep -fc 'tauri dev')"; return 0; }; sleep 1; done
  echo "STILL RUNNING"; return 1
}
sql() { sqlite3 $D/app.db "$1"; }

echo "== 1. 导入并重启"
launch_dev 1
a go /library >/dev/null; a wait "导入书籍" 60 >/dev/null
a click "导入书籍" >/dev/null; a wait "选择 EPUB 文件" 20 >/dev/null
a file 'input[type=file]' $EPUB
a wait "这是哪一类书" 20 >/dev/null; a click "教材"
T_IMPORT0=$(date +%s)
for i in {1..240}; do
  t=$(a js "const d=document.querySelector('[aria-label=\"导入书籍\"]'); return d ? d.innerText.split('\n').slice(0,2).join(' | ') : null" 2>/dev/null)
  echo "[$(ts)] wizard: $t"
  [ "$t" = "null" ] && break
  echo "$t" | grep -q "导入未完成" && { a text | sed -n 1,40p; break; }
  sleep 5
done
echo "import-seconds=$(( $(date +%s) - T_IMPORT0 ))"
a text | sed -n 8,20p
ls -la $D/books/; ls -la $D/import 2>/dev/null | head; echo "src-size=$(stat -f %z $EPUB)"
sql "select id,title,type,import_state,map_revision from book;"
sql "select count(*) from spine_item; select count(*) from knowledge_block;"
a quit >/dev/null; wait_exit
launch_dev 2
a go /library >/dev/null; a wait "导入书籍" 60 >/dev/null; a text | sed -n 10,16p
sql "select id,title,import_state,map_revision from book;"

echo "== 2. 地图:编辑、定稿、目标"
BOOK_TITLE=$(sql "select title from book limit 1")
a click "$BOOK_TITLE" >/dev/null; a wait "知识地图" 30 >/dev/null; a route
a text | sed -n 9,40p
a click "编辑地图" >/dev/null; sleep 1
a js "const i=document.querySelector('input[aria-label^=\"模块名:\"]'); const set=Object.getOwnPropertyDescriptor(HTMLInputElement.prototype,'value').set; set.call(i, i.value+'(改)'); i.dispatchEvent(new Event('input',{bubbles:true})); return i.value"
a js "const bs=[...document.querySelectorAll('button')].filter(b=>b.innerText.trim()==='跳过'); bs[bs.length-1].click(); return bs.length"
a js "const bs=[...document.querySelectorAll('button')].filter(b=>b.innerText.trim()==='下移'); bs[0].click(); return bs.length"
a click "确认定稿" exact; a wait "设定攻克目标" 60 >/dev/null
a type 'input[type=date]' $(date -v+7d +%F); sleep 1
a text | grep -m2 "每天\|块/日"
a click "开始学习" exact; a wait "今日学习" 30 >/dev/null; a route
sql "select id,title,map_revision from book; select count(*) from knowledge_block where skipped=1; select id,seq,title,skipped from knowledge_block order by seq limit 6; select * from study_plan;"
echo "-- stale revision → conflict"
a js "try { await window.__TAURI_INTERNALS__.invoke('map_confirm', { bookId: 1, expectedRevision: 1, ops: [] }); return 'accepted?!' } catch (e) { return e }"
a text | sed -n 8,24p

echo "== 3. 阅读精确原文 → 讲授并暴露薄弱点"
a click "开始" exact; a wait "开始费曼讲授" 120 >/dev/null; a route
a text | grep -m3 "精确\|整章\|锚点\|段"
a click "开始费曼讲授" exact; a wait "复述输入" 30 >/dev/null; a route
sql "select id,block_id,kind,state,version from feynman_session;"
T0=$(date +%s)
a type 'textarea[aria-label="复述输入"]' "这一段讲的是"道"。我理解"道"就是一套可以明确说出来的规则,老子主张统治者要多做事、多干预,这样天下才会治理得好。"
a click "发送" exact >/dev/null
a wait "学生思考中" 10 >/dev/null 2>&1; a waitgone "学生思考中" 240
echo "turn1-seconds=$(( $(date +%s) - T0 ))"; a text | sed -n 12,40p

echo "== 4. 制造 codex 超时并重试"
cat > $D/slow-codex.sh <<'EOS'
#!/bin/bash
sleep 200
EOS
chmod +x $D/slow-codex.sh
sql "insert or replace into setting(key,value) values('codexBin','$D/slow-codex.sh');"
T0=$(date +%s)
a type 'textarea[aria-label="复述输入"]' "补充一点:老子讲"无为",是说不要妄为、顺应自然,和我刚才说的正好相反。"
a click "发送" exact >/dev/null
a wait "重试" 600
echo "timeout-seconds=$(( $(date +%s) - T0 ))"; a text | grep -m3 "重试\|超时\|失败"
sql "delete from setting where key='codexBin';"
sql "select seq,role,status,client_turn_id from session_turn order by seq;"
a click "重试" exact >/dev/null; a wait "学生思考中" 10 >/dev/null 2>&1; a waitgone "学生思考中" 300
sql "select seq,role,status,client_turn_id from session_turn order by seq;"
echo "codex-procs=$(pgrep -fc 'codex exec')"; a text | sed -n 12,44p

echo "== 5. 评估、确认通过、投影与 git"
a click "结束讲授" >/dev/null; a wait "讲授评估" 400 >/dev/null
a text | grep -m6 "建议通过\|建议再学\|星\|薄弱"
a click "确认通过" exact >/dev/null; a wait "附加环节" 30 >/dev/null; a text | grep -m2 "迁移应用题\|附加环节"
a click "跳过" exact >/dev/null; a wait "今日学习" 20 >/dev/null; a route
sql "select id,title,status from knowledge_block where status<>'unlearned'; select id,kind,status from daily_task; select id,block_id,title,status,pass_streak from weak_point;"
ls $D/memory/books/*/blocks/ ; head -20 $D/memory/books/*/blocks/*.md | head -30
cat $D/memory/books/*/_weakpoints.md; git -C $D/memory log --oneline | head -5

echo "== 6. 退出重启一致性"
a quit >/dev/null; wait_exit
grep -E "有序退出|ERROR" $D/dev-2.log | tail -3
launch_dev 3
grep -E "启动投影恢复完成|ERROR" $D/dev-3.log | tail -2
sql "select status,count(*) from projection_outbox group by status;"
a go / >/dev/null; sleep 2; a text | sed -n 8,24p

echo "== 7. 推进受控日期 → 薄弱点重考"
for day in 1 2; do
  NEXT=$(date -v+${day}d +%F); echo "-- testDate=$NEXT"
  a set bookLearner.testDate $NEXT >/dev/null; a js "location.reload(); return 1" >/dev/null; sleep 4
  a go / >/dev/null; a wait "重考" 60 >/dev/null; a text | sed -n 8,20p
  a click "开始重考" exact >/dev/null; a wait "复述输入" 30 >/dev/null
  a wait "学生思考中" 10 >/dev/null 2>&1; a waitgone "学生思考中" 240; a text | sed -n 12,30p
  a type 'textarea[aria-label="复述输入"]' "我之前混淆了:老子讲的是"无为而治",不是多干预;"道"也不是能明确说尽的规则,"道可道,非常道"。"
  a click "发送" exact >/dev/null; a wait "学生思考中" 10 >/dev/null 2>&1; a waitgone "学生思考中" 240
  a click "结束讲授" >/dev/null; a wait "讲授评估" 400 >/dev/null; a click "确认通过" exact >/dev/null
  a wait "今日学习" 30 >/dev/null; a route
  sql "select id,title,status,pass_streak from weak_point; select date,kind,status from daily_task order by id;"
done

echo "== 8. 日志泄漏检查"
for f in $D/dev-1.log $D/dev-2.log $D/dev-3.log; do echo "$f: 道可道=$(grep -c '道可道' $f) 无为=$(grep -c '无为' $f) transcript=$(grep -c '复述' $f) ERROR=$(grep -c ' ERROR' $f)"; done
grep -E "error_code|internal_cause" $D/dev-*.log | head -3
a quit >/dev/null; wait_exit
echo "GATE-M1-E2E-DONE $D $(date)"
