#!/bin/bash
# migration-status.sh｜老项目治理迁移状态总表（一条命令看全，不用记）
# 用法：在母版根执行 `bash scripts/migration-status.sh`
# 输出列：项目 | 规则版本 | AGENTS区块 | TASK账本 | LEDGER | PROJECT_PHASE | AC已补 | 最后提交
set -u
PROJECTS_ROOT="${PROJECTS_ROOT:-/Users/zzymima0000/Developer/coding/1.Active}"
RULES_VERSION="2026-10-03-客户端无关"

[ -d "$PROJECTS_ROOT" ] || { echo "FATAL: 找不到 $PROJECTS_ROOT"; exit 1; }

printf "%-38s %-14s %-6s %6s %-8s %-16s %-5s %s\n" 项目 规则版本 区块 账本 LEDGER PHASE AC 最后提交
printf -- "%.0s-" {1..104}; echo

total=0; synced=0; ac_done=0
for dir in "$PROJECTS_ROOT"/*/; do
  d="${dir%/}"; name="$(basename "$d")"
  case "$name" in 0-规则与索引|999-*|临时备份*|0-*) continue;; esac
  # 治理根：根 AGENTS.md；否则向下一层找唯一含 ORCA-RULES-BLOCK 的子目录（与 sync-old-projects.sh 同口径）
  govroot="$d"
  if [ ! -f "$govroot/AGENTS.md" ]; then
    hit=""
    d="$d/"   # 保证 glob 逐层展开（"$d"*/ 在无尾斜杠时只匹配自身）
    for sub in "$d"*/; do
      [ -f "$sub/AGENTS.md" ] || continue
      grep -q "ORCA-RULES-BLOCK:BEGIN" "$sub/AGENTS.md" 2>/dev/null && { [ -z "$hit" ] && hit="${sub%/}" || hit="__multi__"; }
    done
    case "$hit" in "") continue ;; __multi__) continue ;; *) govroot="$hit" ;; esac
  fi
  total=$((total+1))

  ver="-"; block="无"; ac="否"
  if [ -f "$govroot/docs/model/GOVERNANCE-STATE.json" ]; then
    ver=$(python3 -c "import json,sys;d=json.load(open(sys.argv[1]));print(d.get('rules_version','-'))" "$govroot/docs/model/GOVERNANCE-STATE.json" 2>/dev/null || echo "-")
    acv=$(python3 -c "import json,sys;d=json.load(open(sys.argv[1]));print('是' if d.get('product_acceptance_ac_added') else '否')" "$govroot/docs/model/GOVERNANCE-STATE.json" 2>/dev/null || echo "否")
    [ "$acv" = "是" ] && ac="是" && ac_done=$((ac_done+1))
  fi
  grep -q "ORCA-RULES-BLOCK:BEGIN" "$govroot/AGENTS.md" 2>/dev/null && block="有"

  rows=0; if [ -f "$govroot/docs/model/TASK-MODEL-LOG.jsonl" ]; then rows=$(wc -l < "$govroot/docs/model/TASK-MODEL-LOG.jsonl" | tr -d ' '); [ -z "$rows" ] && rows=0; fi

  led="-"
  if [ -f "$govroot/docs/model/TASK-MODEL-LOG.jsonl" ] && [ -f "$d/scripts/model/check-ledger.mjs" ]; then
    if (cd "$d" && node scripts/model/check-ledger.mjs docs/model >/dev/null 2>&1); then led="OK"; else led="FAIL"; fi
  fi

  ph="ABSENT"
  [ -f "$govroot/docs/handoff/HANDOFF.md" ] && p=$(grep -oE "PROJECT_PHASE[=：: ]+[A-Z_]+" "$govroot/docs/handoff/HANDOFF.md" 2>/dev/null | head -1 | sed 's/.*[=：: ]//') && [ -n "$p" ] && ph="$p"

  gd="-"; [ -d "$d/.git" ] && gd=$(git -C "$d" log -1 --format="%ad" --date=short 2>/dev/null)

  [ "$ver" = "$RULES_VERSION" ] && synced=$((synced+1))
  printf "%-38s %-14s %-6s %6s %-8s %-16s %-5s %s\n" "${name:0:36}" "${ver:0:13}" "$block" "$rows" "$led" "$ph" "$ac" "$gd"
done

printf -- "%.0s-" {1..104}; echo
echo "合计: $total 个项目 ｜ 已同步到 ${RULES_VERSION}: $synced ｜ 未同步: $((total-synced)) ｜ 已补 AC: $ac_done"
[ $((total-synced)) -gt 0 ] && echo "→ 同步命令：bash scripts/sync-old-projects.sh（先加 --dry-run 预演）"
exit 0
