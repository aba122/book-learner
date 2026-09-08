#!/bin/zsh
# M3 T3 语音门禁(debug bundle + 调试自动化桥,经 `open` 在 GUI 会话启动以便 TCC 弹麦克风授权):
# §1 设置页语音分区导入模型 → §2 `say` 合成中文语音喂 voice_transcribe(冷/热时延)→ §3 费曼页 🎙 真麦克风全链路
setopt pipefail
export PATH=/opt/homebrew/bin:$PATH; source ~/.cargo/env
export https_proxy=http://127.0.0.1:7897 HTTPS_PROXY=http://127.0.0.1:7897 no_proxy=localhost,127.0.0.1
cd ~/Developer/book-learner || exit 97
AUTO=~/Developer/bl-logs/bl-auto.py
MODEL=$HOME/Developer/bl-smoke/models/ggml-large-v3-turbo-q5_0.bin
SEED=${SEED:-/private/tmp/bl-e2e.eWapcE}   # 已有一本书与待办任务的数据目录(m1-e2e 门禁遗留)
echo "HEAD=$(git rev-parse --short HEAD) $(date)"
ts() { date +%H:%M:%S; }
a() { python3 $AUTO $SOCK "$@"; }
front() { osascript -e 'tell application "System Events" to set frontmost of process "book-learner" to true' >/dev/null 2>&1; }

( cd web && pnpm tauri build --debug --bundles app 2>&1 | grep -E "Finished|Bundling|error" | tail -3 ); echo "STEP bundle rc=$?"
APP=$PWD/web/src-tauri/target/debug/bundle/macos/book-learner.app
D=$(mktemp -d /private/tmp/bl-t3.XXXX); SOCK=$D/auto.sock
[ -f $SEED/app.db ] && cp $SEED/app.db $D/app.db && cp -R $SEED/books $D/books 2>/dev/null; cp -R $SEED/memory $D/memory 2>/dev/null
echo "DATA_DIR=$D (seeded from $SEED: books=$(sqlite3 $D/app.db 'select count(*) from book' 2>/dev/null))"
open -a "$APP" --env BOOK_LEARNER_DATA_DIR=$D --env BOOK_LEARNER_AUTOMATION_SOCK=$SOCK --env RUST_LOG=info
for i in {1..60}; do [ -S $SOCK ] && break; sleep 0.5; done
[ -S $SOCK ] || { echo "NO SOCKET"; exit 3; }
pgrep -x book-learner | head -1 > $D/pid; sleep 5; front

echo "=== §1 设置页语音分区:导入模型 $(ts)"
a go /settings >/dev/null; a wait "whisper 模型" 30 >/dev/null
a js "return [...document.querySelectorAll('[data-testid=voice-model-row]')].map(r => r.innerText.replace(/\n/g,' '))"
a type 'input[aria-label="模型文件路径"]' "$MODEL" >/dev/null; a click "导入路径" exact >/dev/null
a wait "547 MB" 120 >/dev/null && echo "[$(ts)] model imported"
a js "return [...document.querySelectorAll('[data-testid=voice-model-row]')].map(r => r.querySelector('input[type=radio]').checked + ' ' + r.innerText.replace(/\n/g,' '))"
ls -la $D/models; sqlite3 $D/app.db "select key,value from setting where key='voiceModel'"

echo "=== §2 合成语音 → voice_transcribe(第一次含模型加载,第二次为热) $(ts)"
TEXT="道可道,非常道;名可名,非常名。无名天地之始,有名万物之母。故常无欲以观其妙,常有欲以观其徼。"
say -v Tingting -o $D/clip.wav --data-format=LEI16@16000 "$TEXT"
afinfo $D/clip.wav | grep -E "Data format|estimated duration"
tail -c +45 $D/clip.wav > $D/clip.raw; B64=$(base64 -i $D/clip.raw | tr -d '\n'); echo "raw bytes=$(stat -f %z $D/clip.raw)"
for round in cold warm; do
  a js "const b = Uint8Array.from(atob('$B64'), c => c.charCodeAt(0)); const t0 = performance.now(); try { const r = await window.__TAURI_INTERNALS__.invoke('voice_transcribe', b, { headers: { 'x-bl-lang': 'zh', 'x-bl-hint': encodeURIComponent('道德经 第一章') } }); r.round = '$round'; r.roundtripMs = Math.round(performance.now() - t0); return r } catch (e) { return { round: '$round', error: e } }"
done
echo "expected: $TEXT"

echo "=== §3 费曼页 🎙 真麦克风(录 5 秒环境音;如弹系统授权框需点允许) $(ts)"
TID=$(sqlite3 $D/app.db "select id from daily_task where status<>'done' order by id limit 1")
a go /feynman/$TID >/dev/null; a wait "复述输入" 90 >/dev/null; front
a js "document.querySelector('button[aria-label=\"语音输入\"]').click(); return 'clicked'"
for i in {1..60}; do p=$(a js "return document.querySelector('[data-testid=voice-input]')?.dataset.phase" 2>/dev/null); [ "$p" = '"recording"' ] && break; sleep 1; done
echo "[$(ts)] phase=$p"
sleep 5
a js "return { level: document.querySelector('[data-testid=voice-level]')?.style.width, clock: document.querySelector('button[aria-label=\"停止录音\"]')?.innerText }"
a js "document.querySelector('button[aria-label=\"停止录音\"]')?.click(); return 'stop'"
for i in {1..90}; do p=$(a js "return document.querySelector('[data-testid=voice-input]')?.dataset.phase" 2>/dev/null); [ "$p" = '"idle"' ] && break; sleep 1; done
echo "[$(ts)] phase=$p"
a js "const v = document.querySelector('[data-testid=voice-input]'); return { status: v.querySelector('[role=status]')?.innerText ?? null, alert: v.querySelector('[role=alert]')?.innerText ?? null, draft: document.querySelector('textarea[aria-label=\"复述输入\"]').value }"

a quit >/dev/null; sleep 2
echo "GATE-M3-T3-DONE"
