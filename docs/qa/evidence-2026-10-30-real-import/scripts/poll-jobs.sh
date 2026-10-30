#!/bin/zsh
# 只读轮询真实导入任务；token 只从文件读取，绝不输出。
set -u
ROOT="/Users/zzymima0000/Developer/coding/1.Active/040-ing-才艺展示厅"
ENV_DIR="$ROOT/var/vocal-v31-work/real-qa-20261030"
OUT="$ROOT/docs/qa/evidence-2026-10-30-real-import/raw"
FMT="$ROOT/docs/qa/evidence-2026-10-30-real-import/scripts/fmt.py"
mkdir -p "$OUT"
TOKEN=$(cat "$ENV_DIR/db/.qa-token")
API="http://127.0.0.1:28794/api/vocal-import/jobs"
MAX_TICKS=${MAX_TICKS:-42}
i=0
while [ $i -lt $MAX_TICKS ]; do
  TS=$(date "+%Y-%m-%dT%H:%M:%S%z")
  BODY=$(curl -s --max-time 20 -H "Authorization: Bearer $TOKEN" "$API")
  echo "$BODY" > "$OUT/snapshot-$(printf '%03d' $i).json"
  printf '%s %s\n' "$TS" "$(echo "$BODY" | python3 "$FMT")" >> "$OUT/poll.log"
  DONE=$(echo "$BODY" | python3 -c 'import sys,json
try:
    d=json.load(sys.stdin)
except Exception:
    print("no"); raise SystemExit
st=[j["status"] for j in d.get("jobs",[])]
print("yes" if all(s in ("IMPORTED","FAILED","CANCELLED") for s in st) else "no")')
  if [ "$DONE" = "yes" ]; then echo "ALL_TERMINAL $(date '+%Y-%m-%dT%H:%M:%S%z')" >> "$OUT/poll.log"; break; fi
  i=$((i+1))
  sleep 60
done
echo "POLL_FINISHED ticks=$i $(date '+%Y-%m-%dT%H:%M:%S%z')" >> "$OUT/poll.log"
