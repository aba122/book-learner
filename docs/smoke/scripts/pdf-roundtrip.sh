#!/bin/zsh
# PDF 过渡路线验证:公版 EPUB → PDF(制造一本带文字层的 PDF)→ Calibre 转回 EPUB → 导入 app(真 codex 地图)
# 只用公版书,不碰用户个人文件
setopt pipefail
export PATH=/opt/homebrew/bin:$PATH; source ~/.cargo/env
export https_proxy=http://127.0.0.1:7897 HTTPS_PROXY=http://127.0.0.1:7897 no_proxy=localhost,127.0.0.1
cd ~/Developer/book-learner || exit 97
EC=/Applications/calibre.app/Contents/MacOS/ebook-convert
AUTO=~/Developer/bl-logs/bl-auto.py
SRC=$HOME/Developer/bl-smoke/book-7337.epub      # 道德經(公版)
W=$(mktemp -d /private/tmp/bl-pdf.XXXX); D=$(mktemp -d /private/tmp/bl-pdfimp.XXXX); SOCK=$D/auto.sock
ts() { date +%H:%M:%S; }
a() { python3 $AUTO $SOCK "$@"; }
sql() { sqlite3 $D/app.db "$1"; }
echo "HEAD=$(git rev-parse --short HEAD) W=$W D=$D $(date)"; $EC --version | head -1

echo "== 1. 制造带文字层的 PDF(epub → pdf) $(ts)"
T0=$(date +%s); $EC "$SRC" "$W/道德經.pdf" >/dev/null 2>$W/topdf.err; echo "rc=$? $(( $(date +%s) - T0 ))s size=$(stat -f %z "$W/道德經.pdf")"; tail -2 $W/topdf.err
mdls -name kMDItemNumberOfPages "$W/道德經.pdf" 2>/dev/null

echo "== 2. PDF → EPUB(默认 + 启发式) $(ts)"
T0=$(date +%s); $EC "$W/道德經.pdf" "$W/道德經-from-pdf.epub" --enable-heuristics >/dev/null 2>$W/toepub.err; echo "rc=$? $(( $(date +%s) - T0 ))s size=$(stat -f %z "$W/道德經-from-pdf.epub")"; tail -2 $W/toepub.err
unzip -l "$W/道德經-from-pdf.epub" | tail -n +4 | head -20
OPF=$(unzip -p "$W/道德經-from-pdf.epub" META-INF/container.xml | grep -o 'full-path="[^"]*"' | cut -d\" -f2); echo "OPF=$OPF"
unzip -p "$W/道德經-from-pdf.epub" "$OPF" | grep -oE "<dc:(title|creator)[^>]*>[^<]*</dc:(title|creator)>" | head -3
echo "-- 正文样本(前 600 字符,看页眉页脚/断行噪音)"
H=$(unzip -l "$W/道德經-from-pdf.epub" | awk '{print $4}' | grep -E "\.x?html$" | head -1); unzip -p "$W/道德經-from-pdf.epub" "$H" | sed -e 's/<[^>]*>//g' | tr -s ' \n' | head -c 600; echo

echo "== 3. 导入 app(debug bundle + 桥,真 codex) $(ts)"
APP=$PWD/web/src-tauri/target/debug/bundle/macos/book-learner.app
( cd web && pnpm tauri build --debug --bundles app 2>&1 | grep -E "Finished|error" | tail -2 ); echo "bundle rc=$? HEAD=$(git rev-parse --short HEAD)"
for p in $(pgrep -f "target/debug/bundle/macos/book-learner.app"); do kill $p; done; sleep 1
rm -f $SOCK; open -a "$APP" --env BOOK_LEARNER_DATA_DIR=$D --env BOOK_LEARNER_AUTOMATION_SOCK=$SOCK --env RUST_LOG=info
for i in {1..60}; do [ -S $SOCK ] && break; sleep 0.5; done; [ -S $SOCK ] || { echo "NO SOCKET"; exit 3; }
pgrep -x book-learner | head -1 > $D/pid; sleep 5; osascript -e 'tell application "System Events" to set frontmost of process "book-learner" to true' >/dev/null 2>&1
a go /library >/dev/null; a wait "导入书籍" 60 >/dev/null; a click "导入书籍" >/dev/null; a wait "选择 EPUB 文件" 20 >/dev/null
echo "-- 先选 PDF:应只给转换提示、不导入"
a file 'input[type=file]' "$W/道德經.pdf" >/dev/null; sleep 1; a js "return document.querySelector('[role=dialog] [role=alert]')?.innerText.slice(0,160) ?? 'NO HINT'"; echo "books now=$(sql "select count(*) from book")"
echo "-- 再选转换后的 EPUB"
a file 'input[type=file]' "$W/道德經-from-pdf.epub" >/dev/null; a wait "这是哪一类书" 20 >/dev/null; a click "人文·社科" >/dev/null
T0=$(date +%s)
for i in {1..240}; do t=$(a js "const d=document.querySelector('[aria-label=\"导入书籍\"]'); return d ? d.innerText.split('\n').find(l=>/正在|导入/.test(l)) : null" 2>/dev/null); [ "$t" = "null" ] && break; [ $((i % 6)) -eq 0 ] && echo "  [$(ts)] $t"; echo "$t" | grep -q "导入未完成" && { echo "IMPORT FAILED"; a text | sed -n 1,30p; break; }; sleep 5; done
echo "[$(ts)] imported in $(( $(date +%s) - T0 ))s: $(sql "select id,title,author,type from book")"
echo "spine chapters=$(sql "select count(*) from spine_item") titles: $(sql "select idx||':'||substr(title,1,24)||'('||length(text)||')' from spine_item order by idx limit 8" | tr '\n' ' ')"
echo "blocks=$(sql "select count(*) from knowledge_block") first: $(sql "select seq||':'||title from knowledge_block order by seq limit 5" | tr '\n' ' ')"
echo "anchors: $(sql "select precision,count(*) from block_anchor group by precision" | tr '\n' ' ')"
a quit >/dev/null; sleep 2
echo "PDF-ROUNDTRIP-DONE"
