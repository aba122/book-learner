#!/bin/zsh
# docs/smoke/m3-gate.md:§1 语音学完一个块(TTS 经扬声器→麦克风)§2 Obsidian 导出 §3 整书终评 §4 阅读器标记 §5 快照/恢复 §7 codex 路径
# debug bundle(自动化桥)经 `open` 在 GUI 会话启动(TCC 麦克风授权)+ 真 codex
setopt pipefail
export PATH=/opt/homebrew/bin:$PATH; source ~/.cargo/env
export https_proxy=http://127.0.0.1:7897 HTTPS_PROXY=http://127.0.0.1:7897 no_proxy=localhost,127.0.0.1
cd ~/Developer/book-learner || exit 97
AUTO=~/Developer/bl-logs/bl-auto.py
BOOK=$HOME/Developer/bl-smoke/book-24039.epub               # 老子(教材模板)
MODEL=$HOME/Developer/bl-smoke/models/ggml-large-v3-turbo-q5_0.bin
D=$(mktemp -d /private/tmp/bl-m3.XXXX); SOCK=$D/auto.sock; VAULT=$(mktemp -d /private/tmp/bl-m3-vault.XXXX)
echo "HEAD=$(git rev-parse --short HEAD) DATA_DIR=$D VAULT=$VAULT $(date)"
ts() { date +%H:%M:%S; }
a() { python3 $AUTO $SOCK "$@"; }
sql() { sqlite3 $D/app.db "$1"; }
front() { osascript -e 'tell application "System Events" to set frontmost of process "book-learner" to true' >/dev/null 2>&1; }
dclick() { a js "const d=document.querySelector('[aria-label=\"$1\"]'); if(!d) return 'no-dialog'; const b=[...d.querySelectorAll('button')].find(x=>x.innerText.trim()==='$2'); if(!b) return 'no-button:'+[...d.querySelectorAll('button')].map(x=>x.innerText.trim()).join('|'); b.click(); return 'clicked'"; }
wait_think_done() { a wait "$1" 8 >/dev/null 2>&1; a waitgone "$1" 300 >/dev/null || { echo "THINK TIMEOUT"; a text | tail -20; }; a waitgone "▍" 120 >/dev/null 2>&1; }
phase() { a js "return document.querySelector('[data-testid=voice-input]')?.dataset.phase ?? 'none'" 2>/dev/null; }
wait_phase() { for i in {1..$2}; do [ "$(phase)" = "\"$1\"" ] && return 0; sleep 1; done; echo "phase timeout: $(phase)"; return 1; }
set_textarea() { a js "const el=document.querySelector('$1'); Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype,'value').set.call(el, $(python3 -c 'import json,sys; print(json.dumps(sys.argv[1], ensure_ascii=False))' "$2")); el.dispatchEvent(new Event('input',{bubbles:true})); return el.value.length"; }

( cd web && pnpm tauri build --debug --bundles app 2>&1 | grep -E "Finished|Bundling|error" | tail -3 ); echo "STEP bundle rc=$?"
APP=$PWD/web/src-tauri/target/debug/bundle/macos/book-learner.app
launch() {
  rm -f $SOCK
  open -a "$APP" --env BOOK_LEARNER_DATA_DIR=$D --env BOOK_LEARNER_AUTOMATION_SOCK=$SOCK --env RUST_LOG=info
  for i in {1..60}; do [ -S $SOCK ] && break; sleep 0.5; done
  [ -S $SOCK ] || { echo "NO SOCKET"; exit 3; }
  pgrep -x book-learner | head -1 > $D/pid; sleep 5; front
  echo "[$(ts)] launched pid=$(cat $D/pid)"
}
wait_exit() { for i in {1..60}; do a js "return 1" >/dev/null 2>&1 || { sleep 2; echo "[$(ts)] app exited"; return 0; }; sleep 1; done; echo "STILL RUNNING"; return 1; }

launch
echo "== §0 设置:导入模型、导出目录、codex 路径检测 $(ts)"
a go /settings >/dev/null; a wait "whisper 模型" 30 >/dev/null
a type 'input[aria-label="模型文件路径"]' "$MODEL" >/dev/null; a click "导入路径" exact >/dev/null; a wait "547 MB" 120 >/dev/null && echo "model imported"
a js "return document.querySelector('[data-testid=codex-status]')?.innerText"
sql "INSERT OR REPLACE INTO setting(key,value) VALUES('obsidianVault','$VAULT')"

echo "== §1a 导入书(真 codex 地图) $(ts)"
a go /library >/dev/null; a wait "导入书籍" 60 >/dev/null
a click "导入书籍" >/dev/null; a wait "选择 EPUB 文件" 20 >/dev/null
a file 'input[type=file]' $BOOK >/dev/null; a wait "这是哪一类书" 20 >/dev/null; a click "教材" >/dev/null
T0=$(date +%s)
for i in {1..240}; do t=$(a js "const d=document.querySelector('[aria-label=\"导入书籍\"]'); return d ? d.innerText.split('\n')[0] : null" 2>/dev/null); [ "$t" = "null" ] && break; echo "$t" | grep -q "导入未完成" && { echo "IMPORT FAILED"; a text | sed -n 1,30p; break; }; sleep 5; done
echo "[$(ts)] imported in $(( $(date +%s) - T0 ))s: $(sql "select id,title,author,type from book")"
BOOK_ID=$(sql "select id from book order by id desc limit 1"); BOOK_TITLE=$(sql "select title from book where id=$BOOK_ID")
a go /map/$BOOK_ID >/dev/null; a wait "知识地图" 30 >/dev/null
a click "编辑地图" exact >/dev/null; sleep 1; a click "确认定稿" exact >/dev/null; a wait "设定攻克目标" 60 >/dev/null
a type 'input[type=date]' $(date -v+7d +%F) >/dev/null; sleep 1; a click "开始学习" exact >/dev/null; a wait "今日学习" 30 >/dev/null
echo "blocks=$(sql "select count(*) from knowledge_block where book_id=$BOOK_ID") first=$(sql "select title from knowledge_block where book_id=$BOOK_ID order by seq limit 1")"

echo "== §1b 语音讲授:🎙 录音时用 say 经扬声器朗读复述 $(ts)"
a click "开始" exact >/dev/null; a wait "开始费曼讲授" 120 >/dev/null
a click "开始费曼讲授" exact >/dev/null; a wait "复述输入" 60 >/dev/null; front
SPEECH="老子说的道,是天地万物运行的根本规律,不能用言语完全说尽;德是道在具体事物上的体现。统治者应当无为而治,少干预,让百姓自然发展。"
osascript -e 'set volume output volume 70' 2>/dev/null
a js "document.querySelector('button[aria-label=\"语音输入\"]').click(); return 1" >/dev/null
wait_phase recording 20 && { sleep 0.5; say -v Tingting -r 170 "$SPEECH"; sleep 1.5; }
a js "return { clock: document.querySelector('button[aria-label=\"停止录音\"]')?.innerText, level: document.querySelector('[data-testid=voice-level]')?.style.width }"
a js "document.querySelector('button[aria-label=\"停止录音\"]')?.click(); return 1" >/dev/null
wait_phase idle 150
a js "const v=document.querySelector('[data-testid=voice-input]'); return { status: v.querySelector('[role=status]')?.innerText ?? null, alert: v.querySelector('[role=alert]')?.innerText ?? null }"
DRAFT=$(a js "return document.querySelector('textarea[aria-label=\"复述输入\"]').value"); echo "draft(mic)=$DRAFT"
if [ ${#DRAFT} -lt 20 ]; then
  echo "(麦克风路径文本过短——扬声器回放可能被回声消除抑制;改走合成 PCM → voice_transcribe 填入)"
  say -v Tingting -o $D/clip.wav --data-format=LEI16@16000 "$SPEECH"; tail -c +45 $D/clip.wav > $D/clip.raw; B64=$(base64 -i $D/clip.raw | tr -d '\n')
  a js "const b=Uint8Array.from(atob('$B64'),c=>c.charCodeAt(0)); const r=await window.__TAURI_INTERNALS__.invoke('voice_transcribe', b, {headers:{'x-bl-lang':'zh','x-bl-hint':encodeURIComponent('道')}}); const el=document.querySelector('textarea[aria-label=\"复述输入\"]'); Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype,'value').set.call(el, r.text); el.dispatchEvent(new Event('input',{bubbles:true})); return { elapsed: r.elapsed, seconds: r.seconds, text: r.text }"
fi
a click "发送" exact >/dev/null; wait_think_done "学生思考中"
a text | grep -m1 -B1 -A3 "学生" | head -8
a click "结束讲授" >/dev/null; a wait "讲授评估" 400 >/dev/null
a text | grep -m2 "建议通过\|建议再学"
a click "确认通过" exact >/dev/null; a wait "附加环节" 30 >/dev/null; dclick "附加环节" "跳过" >/dev/null; a wait "今日学习" 30 >/dev/null
echo "block1=$(sql "select status,passed_at from knowledge_block where book_id=$BOOK_ID order by seq limit 1") weak=$(sql "select count(*) from weak_point") sessions=$(sql "select count(*) from feynman_session")"

echo "== §3 整书终评(其余块置为通过后从地图页进入) $(ts)"
sql "UPDATE knowledge_block SET status='passed', passed_at=date('now') WHERE book_id=$BOOK_ID AND skipped=0 AND status<>'passed'"
a go /map/$BOOK_ID >/dev/null; a wait "整书终评" 60 >/dev/null; a click "整书终评" exact >/dev/null
a wait "终评输入" 120 >/dev/null; front; wait_think_done "考官思考中"
a text | grep -m1 -A4 "考官\|请开始终评" | head -6
for ans in "全书框架:上篇道经讲道的本体——道不可名、无为而无不为;下篇德经讲道落到人事——柔弱胜刚强、治大国若烹小鲜。各章围绕'顺应自然、少干预'展开。" "综合应用:把无为用在带团队上,就是定清楚边界和目标后放手,不逐条指挥;用在定价上,是顺着用户的支付意愿定价而不是硬推。" "贯通:柔弱胜刚强与无为是一体两面——不与势硬碰,借势而行;上善若水是同一思想的比喻。"; do
  set_textarea 'textarea[aria-label="终评输入"]' "$ans" >/dev/null; a click "发送" exact >/dev/null; wait_think_done "考官思考中"
done
a click "生成学习报告" exact >/dev/null; a wait "学习报告" 400 >/dev/null
a text | sed -n 1,16p
echo "artifact=$(sql "select id,kind,length(content_md) from artifact where kind='report'") book=$(sql "select status from book where id=$BOOK_ID")"
sleep 4; ls $D/memory/books/*/; head -8 $D/memory/books/*/_report.md; git -C $D/memory log --oneline | head -3

echo "== §2 导出到 Obsidian $(ts)"
a go /library >/dev/null; a wait "导出到 Obsidian" 30 >/dev/null; a click "导出到 Obsidian" exact >/dev/null
a wait "确认导出" 30 >/dev/null; a js "const d=document.querySelector('[aria-label=\"导出到 Obsidian\"]'); return d.innerText.split('\n').slice(0,10).join(' | ')"
dclick "导出到 Obsidian" "确认导出" >/dev/null; a wait "在 Finder 中显示" 60 >/dev/null
a js "const d=document.querySelector('[aria-label=\"导出到 Obsidian\"]'); return d.innerText.split('\n').filter(l=>/写入|未变|个文件/.test(l)).join(' | ')"
find $VAULT -type f | sed "s#$VAULT#<vault>#" | head -20
F=$(find $VAULT -path "*blocks*" -name "*.md" | head -1); echo "--- $F"; head -14 "$F"; echo "wikilinks=$(grep -o '\[\[[^]]*\]\]' "$F" | head -3 | tr '\n' ' ')"
head -10 "$VAULT/$BOOK_TITLE/00-学习报告.md"
dclick "导出到 Obsidian" "关闭" >/dev/null 2>&1

echo "== §4 阅读器:骨架 → 书签 → 翻页 → 阅读位置 $(ts)"
BLOCK_ID=$(sql "select id from knowledge_block where book_id=$BOOK_ID order by seq limit 1")
a go /reader/$BLOCK_ID >/dev/null; a wait "书签" 60 >/dev/null
for i in {1..30}; do s=$(a js "return !!document.querySelector('[data-testid=epub-skeleton]')"); [ "$s" = "false" ] && break; sleep 1; done; echo "[$(ts)] skeleton gone=$([ "$s" = "false" ] && echo yes || echo no) after ${i}s"
a click "书签" exact >/dev/null; sleep 1; a click "标记" exact >/dev/null; a wait "书签与高亮" 10 >/dev/null
a js "return [...document.querySelectorAll('[data-testid=mark-bookmark]')].map(x=>x.innerText.replace(/\n/g,' '))"
a js "document.querySelector('button[aria-label=\"下一页\"]').click(); return 1" >/dev/null; sleep 2
a go /library >/dev/null; sleep 1
sql "select kind,spine_href,substr(cfi_start,1,40) from reader_mark"
a go /reader/$BLOCK_ID >/dev/null; a wait "书签" 60 >/dev/null; sleep 3
a js "return document.querySelector('[data-testid=epub-container] iframe')?.contentDocument?.body?.innerText.slice(0,60)"

echo "== §5 快照 → 登记恢复 → 重启生效 $(ts)"
a go /settings >/dev/null; a wait "立即快照" 30 >/dev/null; a click "立即快照" exact >/dev/null; sleep 2
a js "return [...document.querySelectorAll('[data-testid=snapshot-row]')].map(x=>x.innerText.replace(/\n/g,' '))"
ls -la $D/snapshots/
a js "document.querySelector('[data-testid=snapshot-row] button').click(); return 1" >/dev/null; sleep 1; dclick "恢复到这份快照?" "登记恢复" >/dev/null; a wait "已登记恢复" 20 >/dev/null && echo "restore registered"; cat $D/restore-pending.json
a quit >/dev/null; wait_exit
launch
ls $D | grep -E "replaced|restore-pending" ; echo "pending after relaunch: $(ls $D/restore-pending.json 2>/dev/null || echo none)"
a go /settings >/dev/null; a wait "立即快照" 30 >/dev/null; a js "return document.body.innerText.includes('已登记恢复') ? 'still pending' : 'no pending banner'"
echo "books after restore=$(sql "select count(*) from book") blocks=$(sql "select count(*) from knowledge_block")"

echo "== §7 codex 路径设置 $(ts)"
a type 'input[id="field-codex 可执行路径"]' "codex" >/dev/null; a click "保存路径" exact >/dev/null; sleep 1; a text | grep -m1 "绝对路径"
CODEX=$(which codex); a type 'input[id="field-codex 可执行路径"]' "$CODEX" >/dev/null; a click "保存路径" exact >/dev/null; sleep 1
a js "return document.querySelector('[data-testid=codex-status]')?.innerText"; sql "select value from setting where key='codexBin'"
a type 'input[id="field-codex 可执行路径"]' "" >/dev/null; a click "保存路径" exact >/dev/null; sleep 1; sql "select count(*) from setting where key='codexBin'"

a quit >/dev/null; sleep 2
echo "GATE-M3-DONE"
