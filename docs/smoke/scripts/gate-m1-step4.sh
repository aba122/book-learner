#!/bin/zsh
# m1-e2e 第 4 步补跑:在既有 e2e 数据目录上开第二个新块的讲授,首轮正常,等渐显结束后把 codexBin 指向 sleep 200 脚本,
# 第二轮应在 3×120s 超时后出现可重试错误;恢复后点"重试"用同一 clientTurnId 续跑。
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
( BOOK_LEARNER_DATA_DIR=$D BOOK_LEARNER_AUTOMATION_SOCK=$SOCK pnpm -C web tauri dev > $D/dev-step4.log 2>&1 & )
for i in {1..720}; do [ -S $SOCK ] && break; sleep 0.5; done; sleep 6
echo "[$(ts)] dev sock=$([ -S $SOCK ] && echo yes || echo no) testDate=$(a ls bookLearner.testDate)"
a set bookLearner.testDate "" >/dev/null; a js "localStorage.removeItem('bookLearner.testDate'); location.reload(); return 1" >/dev/null; sleep 4
a go / >/dev/null; sleep 2; a text | sed -n 8,24p
a click "开始" exact; a wait "开始费曼讲授" 120 >/dev/null; a route
a text | grep -m3 "精确\|整章\|锚点\|原文参考"
a click "开始费曼讲授" exact >/dev/null; a wait "复述输入" 30 >/dev/null; a route
SID=$(sql "select id from feynman_session order by id desc limit 1"); echo "session=$SID"
a type 'textarea[aria-label="复述输入"]' "这一节讲的是古登堡计划许可证:只要保留许可证声明就可以自由复制这本电子书,商业使用也不需要任何条件。" >/dev/null
a click "发送" exact >/dev/null; a wait "学生思考中" 8 >/dev/null 2>&1; a waitgone "学生思考中" 240 >/dev/null
a waitgone "▍" 120 >/dev/null; echo "[$(ts)] turn1 done; typewriter finished"
cat > $D/slow-codex.sh <<'EOS'
#!/bin/bash
sleep 200
EOS
chmod +x $D/slow-codex.sh
sql "insert or replace into setting(key,value) values('codexBin','$D/slow-codex.sh');"
T0=$(date +%s)
a type 'textarea[aria-label="复述输入"]' "更正:商业使用其实有条件,许可证里对收费分发有额外要求。" >/dev/null
a click "发送" exact; sleep 3
echo "[$(ts)] sent turn2 under slow codex; pending=$(sql "select count(*) from session_turn where session_id=$SID and role='user' and status='pending'") codex-procs=$(pgrep -f slow-codex.sh | wc -l | tr -d ' ')"
a wait "重试" 480
echo "timeout-seconds=$(( $(date +%s) - T0 ))"; a text | grep -m3 "重试\|超时\|失败\|未完成"
sql "delete from setting where key='codexBin';"
sql "select seq,role,status,client_turn_id from session_turn where session_id=$SID order by seq;"
sql "select request_id,kind,status,attempts from ai_request where request_id like 'turn:$SID:%' order by rowid;"
echo "slow-procs-after-timeout=$(pgrep -f slow-codex.sh | wc -l | tr -d ' ')"
a click "重试" exact; a wait "学生思考中" 8 >/dev/null 2>&1; a waitgone "学生思考中" 300 >/dev/null; a waitgone "▍" 120 >/dev/null
sql "select seq,role,status,client_turn_id from session_turn where session_id=$SID order by seq;"
sql "select request_id,status,attempts from ai_request where request_id like 'turn:$SID:%' order by rowid;"
echo "codex-procs=$(pgrep -f 'codex exec' | wc -l | tr -d ' ') slow=$(pgrep -f slow-codex.sh | wc -l | tr -d ' ')"
a text | sed -n 12,40p
a click "放弃本次" >/dev/null; sleep 1; a click "放弃" exact >/dev/null; a wait "今日学习" 20 >/dev/null
a quit >/dev/null; for i in {1..60}; do a js "return 1" >/dev/null 2>&1 || break; sleep 1; done; sleep 3
grep -E "error_code|有序退出" $D/dev-step4.log | tail -4
echo "GATE-M1-STEP4-DONE $(date)"
