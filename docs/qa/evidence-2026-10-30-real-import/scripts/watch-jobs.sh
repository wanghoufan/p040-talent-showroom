#!/bin/zsh
# 只读监控：API 端口存活 + DB 中任务状态；不重启、不写库。
set -u
ROOT="/Users/zzymima0000/Developer/coding/1.Active/040-ing-才艺展示厅"
DB="$ROOT/var/vocal-v31-work/real-qa-20261030/db/qa.db"
OUT="$ROOT/docs/qa/evidence-2026-10-30-real-import/raw/watch.log"
MAX=${MAX_TICKS:-30}
i=0
while [ $i -lt $MAX ]; do
  TS=$(date "+%Y-%m-%dT%H:%M:%S%z")
  if lsof -nP -iTCP:28794 -sTCP:LISTEN >/dev/null 2>&1; then API=UP; else API=DOWN; fi
  ROWS=$(sqlite3 -readonly "$DB" "select title||'|'||status||'|'||import_mode||'|'||stage||'|'||attempts from vocal_import_jobs order by created_at;" | tr '\n' ' ')
  printf '%s api=%s %s\n' "$TS" "$API" "$ROWS" >> "$OUT"
  i=$((i+1))
  sleep 60
done
echo "WATCH_FINISHED $(date '+%Y-%m-%dT%H:%M:%S%z')" >> "$OUT"
