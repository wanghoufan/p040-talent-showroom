#!/bin/bash
# codebuddy-auto.sh — codebuddy 调用包装：**撞 429 自动切账号重试**。
#
# 为什么需要（2026-10-16 实测）：CodeBuddy 账号按频率限额，builder 单角色 355 次派工
# 集中压在一个账号上，**撞 429 是必然不是偶发**。实测同一时刻：账号1 可用、
# 账号2/3 报 429。而 wb-switch 自带的 auto_rotate「enabled:false」且 min_gap_hours:24
# ——那是为**省额度**设计的慢速轮换，**救不了 429**。
#
# 口径：
#   · 粘性：成功就停在那个账号，不来回抖（同账号连续用，避免浪费额度）
#   · 快切：仅在输出含 429/频率限制时切下一个，最多试 AUTO_ROTATE_MAX 个
#   · 只切账号，不动模型：模型由调用方用 --model 指定
#   · 全部账号都限流 → 原样返回最后一个 429 并退出 1（**不假装成功**）
#
# 用法（替换裸 codebuddy）：
#   bash scripts/codebuddy-auto.sh --model deepseek-v4.1-flash --effort high -y -p "任务"
# 环境变量：
#   CODEBUDDY_ROTATE_DIR     默认 ~/.codebuddy-rotate
#   WB_SWITCH_ACCOUNTS_FILE  默认 ~/.wb-switch/accounts.json
#   AUTO_ROTATE_MAX          默认 3，试几个账号
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROT_DIR="${CODEBUDDY_ROTATE_DIR:-$HOME/.codebuddy-rotate}"
ACC_FILE="${WB_SWITCH_ACCOUNTS_FILE:-$HOME/.wb-switch/accounts.json}"
STATE="$ROT_DIR/state.json"
MAX="${AUTO_ROTATE_MAX:-3}"

N="$(python3 "$HERE/_cb-count.py" "$ACC_FILE" 2>/dev/null || echo 0)"
if [ "${N:-0}" -eq 0 ]; then
  echo "codebuddy-auto: 读不到账号列表，退回裸 codebuddy" >&2
  exec codebuddy "$@"
fi

is_limited() { printf '%s' "$1" | grep -qE '429|频率限制|rate.?limit'; }

out="$(codebuddy "$@" 2>&1)"; rc=$?
if ! is_limited "$out"; then
  printf '%s\n' "$out"
  exit "$rc"
fi

cur="$(python3 "$HERE/_cb-active.py" "$STATE" 2>/dev/null || echo 0)"
i=1
while [ "$i" -lt "$MAX" ]; do
  nxt=$(( (cur + i) % N ))
  python3 "$HERE/_cb-rotate.py" "$ACC_FILE" "$STATE" "$nxt" >/dev/null 2>&1
  out="$(codebuddy "$@" 2>&1)"; rc=$?
  if ! is_limited "$out"; then
    printf '%s\n' "$out"
    echo "[codebuddy-auto] 原账号限流 → 自动切到第 $((nxt+1))/$N 个账号，重试成功" >&2
    exit "$rc"
  fi
  i=$((i+1))
done

python3 "$HERE/_cb-rotate.py" "$ACC_FILE" "$STATE" "$cur" >/dev/null 2>&1
printf '%s\n' "$out"
echo "[codebuddy-auto] 已试 $MAX 个账号，全部限流；返回最后一个 429（未伪装成功）" >&2
exit 1