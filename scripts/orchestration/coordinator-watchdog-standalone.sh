#!/bin/bash
# coordinator-watchdog-standalone.sh — 零配置 L3 watchdog（任何 Orca 项目即拷即用）
# 不依赖治理模板/registry/STATE：只用 orca CLI + /tmp 日志。
# 发现漂移就往该 Run 的协调者终端发一条唤醒指令；只唤醒，不代做。
# Env overrides（全可选）:
#   RUN_IDS            为空则自动发现全部 Run（run-list 首列）
#   COORDINATOR_TERMINAL  覆盖某 Run 的协调者（默认用各 Run 登记的 coordinator_handle）
#   STALE_EXEC_SEC     默认 2700；CONSUME_STALE_SEC 默认 300；COOLDOWN_SEC 默认 900
#   ORCA_BIN / LOG / MARK / LOCK
set -uo pipefail

ORCA_BIN="${ORCA_BIN:-$(command -v orca 2>/dev/null || echo /opt/homebrew/bin/orca)}"
RUN_IDS="${RUN_IDS:-}"
COORD_OVERRIDE="${COORDINATOR_TERMINAL:-}"
LOG="${LOG:-/tmp/coordinator-watchdog.log}"
MARK="${MARK:-/tmp/.coord-watchdog-poke}"
LOCK="${LOCK:-/tmp/.coord-watchdog.lock}"
STALE_EXEC_SEC="${STALE_EXEC_SEC:-2700}"
CONSUME_STALE_SEC="${CONSUME_STALE_SEC:-300}"
COOLDOWN_SEC="${COOLDOWN_SEC:-900}"

log() { echo "[$(date '+%F %T')] $*" >> "$LOG"; }

if [ -d "$LOCK" ]; then
  age=$(( $(date +%s) - $(stat -f %m "$LOCK" 2>/dev/null || echo 0) ))
  if [ "$age" -lt 50 ]; then exit 0; fi
  rm -rf "$LOCK"
fi
mkdir "$LOCK" || exit 0
trap 'rm -rf "$LOCK"' EXIT

if [ -f "$LOG" ] && [ "$(stat -f %z "$LOG" 2>/dev/null || echo 0)" -gt 524288 ]; then
  tail -1000 "$LOG" > "$LOG.tmp" && mv "$LOG.tmp" "$LOG"
fi

if [ -z "$RUN_IDS" ]; then
  RUN_IDS=$("$ORCA_BIN" orchestration run-list 2>/dev/null | awk '/^run_/ {print $1}')
fi
if [ -z "$RUN_IDS" ]; then log 'ok: no runs discovered'; exit 0; fi

coord_for_run() {
  "$ORCA_BIN" orchestration run-show --id "$1" --json 2>/dev/null | python3 -c 'import json,sys; d=json.load(sys.stdin); print(((d.get('"'"'result'"'"',{}) or {}).get('"'"'run'"'"',{}) or {}).get('"'"'coordinator_handle'"'"') or '"'"''"'"')' 2>/dev/null
}

DRIFT_SIG=''; DRIFT_MSG=''; DRIFT_RUN=''; DRIFT_COORD=''
for RUN_ID in $RUN_IDS; do
task_json=$("$ORCA_BIN" orchestration task-list --run "$RUN_ID" --json 2>/dev/null) || { log "error: task-list failed for $RUN_ID"; continue; }
count=$(echo "$task_json" | python3 -c 'import json,sys; d=json.load(sys.stdin); print(d.get('"'"'result'"'"',{}).get('"'"'count'"'"',0))' 2>/dev/null || echo 0)
if [ "$count" = '0' ]; then log "ok: no tasks in $RUN_ID"; continue; fi
TASK_ID=''; TASK_STATUS=''; DISPATCH_ID=''; ASSIGNEE=''; OPEN='0'
eval "$(echo "$task_json" | python3 -c 'import json,sys
d=json.load(sys.stdin)
ts=d.get('"'"'result'"'"',{}).get('"'"'tasks'"'"',[])
open_t=[t for t in ts if t.get('"'"'status'"'"') not in ('"'"'completed'"'"','"'"'failed'"'"','"'"'cancelled'"'"')]
if not open_t:
  print('"'"'OPEN=0'"'"')
else:
  t=open_t[0]
  print('"'"'OPEN=1'"'"')
  print('"'"'TASK_ID='"'"'+t['"'"'id'"'"'])
  print('"'"'TASK_STATUS='"'"'+t['"'"'status'"'"'])
  print('"'"'DISPATCH_ID='"'"'+(t.get('"'"'dispatch_id'"'"') or '"'"''"'"'))
  print('"'"'ASSIGNEE='"'"'+(t.get('"'"'assignee_handle'"'"') or '"'"''"'"'))
' 2>/dev/null)"
if [ "${OPEN:-0}" = '0' ]; then log "ok: all tasks settled in $RUN_ID"; continue; fi
sig=''; msg=''
if [ -n "${ASSIGNEE:-}" ]; then
  if ! "$ORCA_BIN" terminal list --json 2>/dev/null | grep -q "$ASSIGNEE"; then
    sig="W|${RUN_ID}/${TASK_ID} worker-lost"
    msg="【watchdog→协调者】${TASK_ID}(${TASK_STATUS}) 的 worker 终端 ${ASSIGNEE} 已失联。检查 worker-show --dispatch ${DISPATCH_ID}，优先保留成果做局部恢复，不得直接宣布失败。"
  fi
fi
if [ -z "$sig" ] && [ "$TASK_STATUS" = 'dispatched' ]; then
  sig="S|${RUN_ID}/${TASK_ID} dispatched-open"
  msg="【watchdog→协调者】${RUN_ID}/${TASK_ID} 处于 dispatched 且有未完成项。请 terminal read ${ASSIGNEE} + worker-show --dispatch ${DISPATCH_ID} 对账，超时只是 checkpoint，不得结束监督。"
  HITDIR="${HITDIR:-/tmp/.wd-standalone-hits}"
  mkdir -p "$HITDIR" 2>/dev/null
  hf="$HITDIR/$(printf '%s' "$sig" | cksum | awk '{print $1}')"
  n=$(cat "$hf" 2>/dev/null || echo 0)
  case "$n" in ''|*[!0-9]*) n=0 ;; esac
  n=$((n+1)); echo "$n" > "$hf" 2>/dev/null
  if [ "$n" -lt 3 ]; then
    log "watch: $sig hit ${n}/3, hold"
    sig=''; msg=''
  fi
fi
if [ -z "$sig" ]; then
  log "ok: no drift (${RUN_ID}/${TASK_ID} ${TASK_STATUS})"
  continue
fi
DRIFT_SIG="$sig"; DRIFT_MSG="$msg"; DRIFT_RUN="$RUN_ID"
break
done

if [ -z "$DRIFT_SIG" ]; then
  MID=''; MSUBJ=''; MRUN=''; MAGE=''; scan_out=''
  scan_out=$("$ORCA_BIN" orchestration inbox --limit 20 --json 2>/dev/null | CONSUME_STALE_SEC="$CONSUME_STALE_SEC" RUN_IDS="$RUN_IDS" python3 -c 'import json,sys,os,datetime
now=datetime.datetime.now(datetime.timezone.utc)
stale=int(os.environ.get('"'"'CONSUME_STALE_SEC'"'"','"'"'600'"'"'))
watched=set(os.environ.get('"'"'RUN_IDS'"'"','"'"''"'"').split())
try:
  d=json.load(sys.stdin)
except Exception:
  print('"'"'NONE'"'"'); raise SystemExit
for m in d.get('"'"'result'"'"',{}).get('"'"'messages'"'"',[]):
  if m.get('"'"'type'"'"')!='"'"'worker_done'"'"' or m.get('"'"'read'"'"'): continue
  if watched and (m.get('"'"'run_id'"'"') or '"'"''"'"') not in watched: continue
  try:
    t=datetime.datetime.fromisoformat((m.get('"'"'created_at'"'"') or '"'"''"'"').replace('"'"'Z'"'"','"'"'+00:00'"'"'))
    if t.tzinfo is None:
      t=t.replace(tzinfo=datetime.timezone.utc)
  except Exception:
    continue
  age=(now-t).total_seconds()
  if age>stale:
    subj=(m.get('"'"'subject'"'"') or '"'"''"'"').replace(chr(9),'"'"' '"'"').replace(chr(10),'"'"' '"'"')[:60]
    print('"'"'FOUND'"'"'+chr(9)+m['"'"'id'"'"']+chr(9)+subj+chr(9)+(m.get('"'"'run_id'"'"') or '"'"''"'"')+chr(9)+str(int(age)))
    break
else:
  print('"'"'NONE'"'"')
' 2>/dev/null)
  if [ "${scan_out#FOUND}" != "$scan_out" ]; then
    IFS='	' read -r _ MID MSUBJ MRUN MAGE <<< "$scan_out" || true
    if [ -n "${MID:-}" ]; then
    DRIFT_SIG="M|${MID} unconsumed"
    DRIFT_MSG="【watchdog→协调者】worker_done ${MID}（${MRUN}，${MAGE}s前到达仍未读）疑似未被消费。请立即 check 消费→核对业务证据→推进下游→ack。Task 自动 completed 不等于已消费。"
    DRIFT_RUN="${MRUN}"
    else
      log 'warn: consumption scan matched but MID empty, skip'
    fi
  fi
fi

if [ -z "$DRIFT_SIG" ]; then
  TDID=''; TTID=''; TRUN=''; TTERM=''; tscan=''
  tscan=$("$ORCA_BIN" orchestration inbox --limit 40 --json 2>/dev/null | RUN_IDS="$RUN_IDS" ORCA_BIN="$ORCA_BIN" python3 -c 'import json,subprocess,os,sys,datetime,re
bin=os.environ.get('"'"'ORCA_BIN'"'"','"'"'orca'"'"')
runs=os.environ.get('"'"'RUN_IDS'"'"','"'"''"'"').split()
def run(*a):
  p=subprocess.run([bin]+list(a),capture_output=True,text=True,timeout=30)
  return p.stdout
try:
  inbox=json.loads(run('"'"'orchestration'"'"','"'"'inbox'"'"','"'"'--limit'"'"','"'"'40'"'"','"'"'--json'"'"'))
except Exception:
  print('"'"'NONE'"'"'); raise SystemExit
msgs=inbox.get('"'"'result'"'"',{}).get('"'"'messages'"'"',[])
def landed(taskid):
  for m in msgs:
    if m.get('"'"'type'"'"')!='"'"'worker_done'"'"': continue
    if taskid in (m.get('"'"'payload'"'"') or '"'"''"'"'): return True
  return False
for rid in runs:
  try: tl=json.loads(run('"'"'orchestration'"'"','"'"'task-list'"'"','"'"'--run'"'"',rid,'"'"'--json'"'"'))
  except Exception: continue
  for t in tl.get('"'"'result'"'"',{}).get('"'"'tasks'"'"',[]):
    if t.get('"'"'status'"'"')!='"'"'dispatched'"'"' or not t.get('"'"'dispatch_id'"'"'): continue
    did=t['"'"'dispatch_id'"'"']; tid=t['"'"'id'"'"']
    try: ws=json.loads(run('"'"'orchestration'"'"','"'"'worker-show'"'"','"'"'--dispatch'"'"',did,'"'"'--json'"'"'))
    except Exception: continue
    rs=ws.get('"'"'result'"'"',{}) or {}
    if ((rs.get('"'"'dispatch'"'"',{}) or {}).get('"'"'status'"'"') or '"'"''"'"')!='"'"'dispatched'"'"': continue
    term=((rs.get('"'"'terminal'"'"',{}) or {}).get('"'"'handle'"'"') or '"'"''"'"')
    if not term: continue
    try: tr=json.loads(run('"'"'terminal'"'"','"'"'read'"'"','"'"'--terminal'"'"',term,'"'"'--limit'"'"','"'"'30'"'"','"'"'--json'"'"'))
    except Exception: continue
    tail=str(chr(10).join(((tr.get('"'"'result'"'"',{}) or {}).get('"'"'terminal'"'"',{}) or {}).get('"'"'tail'"'"',[]) or []))
    if not re.search('"'"'worker_done.*(sent|已发送)|Sent msg_'"'"',tail,re.I|re.S): continue
    if landed(tid): continue
    print('"'"'FOUND'"'"'+chr(9)+did+chr(9)+tid+chr(9)+rid+chr(9)+term)
    raise SystemExit
print('"'"'NONE'"'"')
' 2>/dev/null)
  if [ "${tscan#FOUND}" != "$tscan" ]; then
    IFS='	' read -r _ TDID TTID TRUN TTERM <<< "$tscan" || true
    if [ -n "${TDID:-}" ]; then
    DRIFT_SIG="T|${TDID} transport-lost"
    DRIFT_MSG="【watchdog→协调者】${TDID}（${TTID}）疑似完成信号传输丢失：工人屏上有 worker_done 已发送字样但无回告。工作禁重做：先取回完整结论落盘备份，再让工人在自己终端重试一次 worker_done，仍失败则记账 settle 并路由下游。"
    DRIFT_RUN="${TRUN}"
    else
      log 'warn: transport scan matched but TDID empty, skip'
    fi
  fi
fi

if [ -z "$DRIFT_SIG" ]; then
  exit 0
fi
sig="$DRIFT_SIG"; msg="$DRIFT_MSG"
COORD="${COORD_OVERRIDE:-$(coord_for_run "$DRIFT_RUN")}"

now=$(date +%s)
if [ -f "$MARK" ]; then
  msig=$(cut -d'|' -f1-2 "$MARK" 2>/dev/null); mts=$(cut -d'|' -f3 "$MARK" 2>/dev/null || echo 0)
  if [ "$msig" = "$sig" ] && [ $((now - mts)) -lt "$COOLDOWN_SEC" ]; then
    log "cooldown: $sig poked $((now - mts))s ago, skip"
    exit 0
  fi
fi

if [ -z "${COORD:-}" ] || ! "$ORCA_BIN" terminal list --json 2>/dev/null | grep -q "$COORD"; then
  echo "$sig|$now" > "$MARK"
  log "error: coordinator $COORD not found for drift=$sig not delivered (cooled)"
  exit 1
fi

if "$ORCA_BIN" terminal send --terminal "$COORD" --text "$msg" --enter >/dev/null 2>&1; then
  echo "$sig|$now" > "$MARK"
  log "poked coordinator ($sig)"
else
  echo "$sig|$now" > "$MARK"
  log "error: terminal send failed for $sig (cooled)"
  exit 1
fi
