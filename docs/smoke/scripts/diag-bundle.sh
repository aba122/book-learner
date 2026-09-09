#!/bin/zsh
# 一键诊断包(Mac,用户报 bug 时运行):把日志、数据库只读快照、关键表导出、版本与系统信息打成 zip 放到桌面。
# 用法:zsh ~/Developer/book-learner/docs/smoke/scripts/diag-bundle.sh   [可选:DAYS=3 收最近 3 天日志,默认 2]
# 不包含:EPUB 正文、复述原文只在 app.db 快照里(与 app 本地数据同等级,不上传任何地方)。
setopt pipefail null_glob
export PATH=/opt/homebrew/bin:/usr/bin:/bin:$PATH
DATA="$HOME/Library/Application Support/book-learner"
DAYS=${DAYS:-2}
TS=$(date +%Y%m%d-%H%M%S)
OUT="$HOME/Desktop/bl-diag-$TS"
mkdir -p "$OUT/logs" "$OUT/tables" || exit 1
[ -f "$DATA/app.db" ] || { echo "没有找到数据目录 $DATA(app 还没运行过?)"; exit 2 }

# 1. 版本与环境
{
  echo "collected_at=$(date '+%F %T %z')"
  echo "app=$(plutil -extract CFBundleShortVersionString raw /Applications/book-learner.app/Contents/Info.plist 2>/dev/null) built=$(stat -f %Sm -t '%F %T' /Applications/book-learner.app/Contents/MacOS/book-learner 2>/dev/null)"
  echo "macos=$(sw_vers -productVersion) arch=$(uname -m) node=$(node --version 2>/dev/null) codex=$(codex --version 2>/dev/null | head -1)"
  echo "data_dir=$DATA"
  echo "log_first_line=$(head -1 "$(ls -t "$DATA"/logs/app.log.* 2>/dev/null | head -1)" 2>/dev/null)"
  echo "running=$(pgrep -x book-learner | head -1)"
} > "$OUT/info.txt"

# 2. 日志(最近 DAYS 天)
for f in $(ls -t "$DATA"/logs/app.log.* 2>/dev/null | head -$DAYS); do cp "$f" "$OUT/logs/"; done

# 3. 数据库只读快照 + 关键表(只读连接;VACUUM INTO 不改原库)
sqlite3 -readonly "$DATA/app.db" "VACUUM INTO '$OUT/app.db'" 2>"$OUT/tables/snapshot.err" || echo "snapshot failed: $(cat "$OUT/tables/snapshot.err")"
q() { sqlite3 -readonly -header -column "$DATA/app.db" "$2" > "$OUT/tables/$1.txt" 2>&1 }
q schema      "PRAGMA user_version; SELECT name FROM sqlite_master WHERE type='table' ORDER BY name;"
q books       "SELECT id,title,author,type,status,import_state,map_revision,created_at FROM book;"
q plans       "SELECT * FROM study_plan;"
q blocks      "SELECT id,book_id,seq,module_name,title,status,skipped,passed_at FROM knowledge_block ORDER BY book_id,seq;"
q anchors     "SELECT block_id,seq,precision,spine_href,length(text) AS text_len FROM block_anchor ORDER BY block_id,seq;"
q tasks       "SELECT * FROM daily_task ORDER BY date DESC, seq LIMIT 60;"
q sessions    "SELECT id,block_id,task_id,book_id,kind,extra_kind,state,version,started_at,ended_at FROM feynman_session ORDER BY id DESC LIMIT 40;"
q turns       "SELECT session_id,seq,role,status,length(text) AS len,client_turn_id FROM session_turn ORDER BY session_id DESC,seq DESC LIMIT 80;"
q ai_requests "SELECT request_id,kind,status,attempts,substr(error,1,300) AS error FROM ai_request ORDER BY rowid DESC LIMIT 40;"
q map_jobs    "SELECT job_id,stage,next_chapter,substr(error,1,300) AS error FROM map_job ORDER BY rowid DESC LIMIT 10;"
q outbox      "SELECT id,kind,lane,status,attempts,substr(error,1,200) AS error,next_retry_at,done_at FROM projection_outbox ORDER BY id DESC LIMIT 60;"
q weakpoints  "SELECT id,block_id,title,status,pass_streak,created_at,fixed_at FROM weak_point ORDER BY id DESC LIMIT 60;"
q reviews     "SELECT * FROM review_schedule ORDER BY due_date DESC LIMIT 60;"
q settings    "SELECT key, CASE WHEN key LIKE 'codexBin' THEN value ELSE substr(value,1,80) END AS value FROM setting;"
q marks       "SELECT id,book_id,kind,spine_href,substr(cfi_start,1,40) AS cfi,created_at FROM reader_mark ORDER BY id DESC LIMIT 40;"

# 4. 记忆库状态(不含正文)
if [ -d "$DATA/memory/.git" ]; then
  git -C "$DATA/memory" log --oneline -20 > "$OUT/memory-git-log.txt" 2>&1
  git -C "$DATA/memory" status --short > "$OUT/memory-git-status.txt" 2>&1
  find "$DATA/memory" -type f -name '*.md' | sed "s#$DATA/memory/##" | sort > "$OUT/memory-files.txt"
fi
ls -la "$DATA/snapshots" > "$OUT/snapshots.txt" 2>&1; ls -la "$DATA/books" > "$OUT/books-dir.txt" 2>&1

# 5. 打包
( cd "$HOME/Desktop" && zip -qr "bl-diag-$TS.zip" "bl-diag-$TS" && rm -rf "bl-diag-$TS" )
echo "诊断包:$HOME/Desktop/bl-diag-$TS.zip ($(du -h "$HOME/Desktop/bl-diag-$TS.zip" | cut -f1))"
