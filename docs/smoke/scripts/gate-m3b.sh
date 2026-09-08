#!/bin/zsh
# m3-gate 补跑:§1 语音学完一个块(合成 16 kHz 语音走 voice_transcribe → 输入框 → 判定;真麦克风段只验录音态)
#            §4 阅读器(置前后再等首屏)、§7b 书名/作者取自 OPF
# 首跑发现:扬声器播放 TTS 让麦克风录会被回声消除压掉(电平 1%),后台 WebView 被节流让阅读器 30 s 未渲染
setopt pipefail
export PATH=/opt/homebrew/bin:$PATH; source ~/.cargo/env
export https_proxy=http://127.0.0.1:7897 HTTPS_PROXY=http://127.0.0.1:7897 no_proxy=localhost,127.0.0.1
cd ~/Developer/book-learner || exit 97
AUTO=~/Developer/bl-logs/bl-auto.py
BOOK=$HOME/Developer/bl-smoke/book-24039.epub
MODEL=$HOME/Developer/bl-smoke/models/ggml-large-v3-turbo-q5_0.bin
D=$(mktemp -d /private/tmp/bl-m3b.XXXX); SOCK=$D/auto.sock
echo "HEAD=$(git rev-parse --short HEAD) DATA_DIR=$D $(date)"
ts() { date +%H:%M:%S; }
a() { python3 $AUTO $SOCK "$@"; }
sql() { sqlite3 $D/app.db "$1"; }
front() { osascript -e 'tell application "System Events" to set frontmost of process "book-learner" to true' >/dev/null 2>&1; }
dclick() { a js "const d=document.querySelector('[aria-label=\"$1\"]'); if(!d) return 'no-dialog'; const b=[...d.querySelectorAll('button')].find(x=>x.innerText.trim()==='$2'); if(!b) return 'no-button:'+[...d.querySelectorAll('button')].map(x=>x.innerText.trim()).join('|'); b.click(); return 'clicked'"; }
wait_think_done() { a wait "$1" 8 >/dev/null 2>&1; a waitgone "$1" 300 >/dev/null || { echo "THINK TIMEOUT"; a text | tail -20; }; a waitgone "▍" 120 >/dev/null 2>&1; }
phase() { a js "return document.querySelector('[data-testid=voice-input]')?.dataset.phase ?? 'none'" 2>/dev/null; }
wait_phase() { for i in {1..$2}; do [ "$(phase)" = "\"$1\"" ] && return 0; sleep 1; done; echo "phase timeout: $(phase)"; return 1; }

( cd web && pnpm tauri build --debug --bundles app 2>&1 | grep -E "Finished|Bundling|error" | tail -3 ); echo "STEP bundle rc=$?"
APP=$PWD/web/src-tauri/target/debug/bundle/macos/book-learner.app
rm -f $SOCK; open -a "$APP" --env BOOK_LEARNER_DATA_DIR=$D --env BOOK_LEARNER_AUTOMATION_SOCK=$SOCK --env RUST_LOG=info
for i in {1..60}; do [ -S $SOCK ] && break; sleep 0.5; done; [ -S $SOCK ] || { echo "NO SOCKET"; exit 3; }
pgrep -x book-learner | head -1 > $D/pid; sleep 5; front; echo "[$(ts)] launched pid=$(cat $D/pid)"

echo "== §0 导入模型 $(ts)"
a go /settings >/dev/null; a wait "whisper 模型" 30 >/dev/null
a type 'input[aria-label="模型文件路径"]' "$MODEL" >/dev/null; a click "导入路径" exact >/dev/null; a wait "547 MB" 120 >/dev/null && echo "model imported"

echo "== §7b 导入书:书名/作者应来自 OPF $(ts)"
a go /library >/dev/null; a wait "导入书籍" 60 >/dev/null
a click "导入书籍" >/dev/null; a wait "选择 EPUB 文件" 20 >/dev/null
a file 'input[type=file]' $BOOK >/dev/null; a wait "这是哪一类书" 20 >/dev/null; a click "教材" >/dev/null
T0=$(date +%s)
for i in {1..240}; do t=$(a js "const d=document.querySelector('[aria-label=\"导入书籍\"]'); return d ? d.innerText.split('\n').find(l=>/正在|导入/.test(l)) : null" 2>/dev/null); [ "$t" = "null" ] && break; [ $((i % 6)) -eq 0 ] && echo "  [$(ts)] $t"; echo "$t" | grep -q "导入未完成" && { echo "IMPORT FAILED"; a text | sed -n 1,30p; break; }; sleep 5; done
echo "[$(ts)] imported in $(( $(date +%s) - T0 ))s: $(sql "select id,title,author,type from book")"
BOOK_ID=$(sql "select id from book order by id desc limit 1")
a go /library >/dev/null; sleep 1; a text | grep -m2 "老子\|Laozi"
a go /map/$BOOK_ID >/dev/null; a wait "知识地图" 30 >/dev/null
a click "编辑地图" exact >/dev/null; sleep 1; a click "确认定稿" exact >/dev/null; a wait "设定攻克目标" 60 >/dev/null
a type 'input[type=date]' $(date -v+7d +%F) >/dev/null; sleep 1; a click "开始学习" exact >/dev/null; a wait "今日学习" 30 >/dev/null
FIRST=$(sql "select title from knowledge_block where book_id=$BOOK_ID order by seq limit 1"); echo "blocks=$(sql "select count(*) from knowledge_block where book_id=$BOOK_ID") first=$FIRST"

echo "== §1 语音学完一个块 $(ts)"
a click "开始" exact >/dev/null; a wait "开始费曼讲授" 120 >/dev/null
a click "开始费曼讲授" exact >/dev/null; a wait "复述输入" 60 >/dev/null; front
echo "-- 1a 真麦克风:录 4 秒环境音,验证录音态/电平/转写回填(内容不作要求)"
a js "document.querySelector('button[aria-label=\"语音输入\"]').click(); return 1" >/dev/null
wait_phase recording 20; sleep 4
a js "return { clock: document.querySelector('button[aria-label=\"停止录音\"]')?.innerText.trim(), level: document.querySelector('[data-testid=voice-level]')?.style.width }"
a js "document.querySelector('button[aria-label=\"停止录音\"]')?.click(); return 1" >/dev/null; wait_phase idle 150
a js "const v=document.querySelector('[data-testid=voice-input]'); return { status: v.querySelector('[role=status]')?.innerText ?? null, alert: v.querySelector('[role=alert]')?.innerText ?? null }"
echo "-- 1b 合成语音(与真实说话同一格式 16 kHz i16)经 voice_transcribe 填入输入框"
SPEECH="老子说的道,是天地万物运行的根本规律,不能用言语完全说尽;德是道在具体事物上的体现。统治者应当无为而治,少干预,让百姓自然发展。这一块讲的是$FIRST。"
say -v Tingting -o $D/clip.wav --data-format=LEI16@16000 "$SPEECH"; tail -c +45 $D/clip.wav > $D/clip.raw; B64=$(base64 -i $D/clip.raw | tr -d '\n')
a js "const b=Uint8Array.from(atob('$B64'),c=>c.charCodeAt(0)); const t0=performance.now(); const r=await window.__TAURI_INTERNALS__.invoke('voice_transcribe', b, {headers:{'x-bl-lang':'zh','x-bl-hint':encodeURIComponent('$FIRST')}}); const el=document.querySelector('textarea[aria-label=\"复述输入\"]'); Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype,'value').set.call(el, r.text); el.dispatchEvent(new Event('input',{bubbles:true})); return { seconds: r.seconds, elapsed: r.elapsed, roundtripMs: Math.round(performance.now()-t0), text: r.text }"
a click "发送" exact >/dev/null; wait_think_done "学生思考中"
a text | grep -m1 -A3 "学生" | head -5
a click "结束讲授" >/dev/null; a wait "讲授评估" 400 >/dev/null
VERDICT=$(a text | grep -m1 -o "建议通过\|建议再学"); echo "verdict=$VERDICT"
if [ "$VERDICT" = "建议通过" ]; then a click "确认通过" exact >/dev/null; a wait "附加环节" 30 >/dev/null; dclick "附加环节" "跳过" >/dev/null; a wait "今日学习" 30 >/dev/null
else a text | grep -m6 "薄弱\|漏洞\|建议" ; a click "确认再学" exact >/dev/null 2>&1 || a js "const b=[...document.querySelectorAll('button')].find(x=>/再学/.test(x.innerText)); b?.click(); return b?.innerText ?? 'no-relearn-button'"; sleep 2; fi
echo "block1=$(sql "select status,passed_at,scores_json from knowledge_block where book_id=$BOOK_ID order by seq limit 1") weak=$(sql "select count(*) from weak_point") turns=$(sql "select count(*) from session_turn")"

echo "== §4 阅读器(置前后等首屏) $(ts)"
BLOCK_ID=$(sql "select id from knowledge_block where book_id=$BOOK_ID order by seq limit 1")
a go /reader/$BLOCK_ID >/dev/null; front; a wait "书签" 60 >/dev/null
for i in {1..40}; do s=$(a js "return !!document.querySelector('[data-testid=epub-skeleton]')"); [ "$s" = "false" ] && break; sleep 1; done; echo "[$(ts)] skeleton gone=$([ "$s" = "false" ] && echo yes || echo no) after ${i}s; iframe=$(a js "return !!document.querySelector('[data-testid=epub-container] iframe')")"
a js "return document.querySelector('[data-testid=epub-container] iframe')?.contentDocument?.body?.innerText.replace(/\s+/g,' ').slice(0,80)"
a click "书签" exact >/dev/null; sleep 1; a click "标记" exact >/dev/null; a wait "书签与高亮" 10 >/dev/null
a js "return [...document.querySelectorAll('[data-testid=mark-bookmark]')].map(x=>x.innerText.replace(/\n/g,' '))"
a js "document.querySelector('button[aria-label=\"下一页\"]').click(); return 1" >/dev/null; sleep 2
a go /library >/dev/null; sleep 1.5
sql "select kind,spine_href,substr(cfi_start,1,40) from reader_mark"
a go /reader/$BLOCK_ID >/dev/null; front; sleep 4
a js "return { skeleton: !!document.querySelector('[data-testid=epub-skeleton]'), text: document.querySelector('[data-testid=epub-container] iframe')?.contentDocument?.body?.innerText.replace(/\s+/g,' ').slice(0,60) }"

a quit >/dev/null; sleep 2
echo "GATE-M3B-DONE"
