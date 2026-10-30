#!/bin/bash
# check-product-review.sh | product-review dual-audit output gate (added 2026-10-17 self-audit)
#
# Why: the 2026-10-07 incident -- two codebuddy instances dispatched concurrently interfere,
# the loser fails SILENTLY with exit 0 and zero output. The rule written for it
# ("must verify the output file exists and is non-empty; missing => BLOCKED rerun; never trust exit 0")
# lived ONLY in the prompt, with no script behind it. Now it is a command.
#
# Usage:
#   bash scripts/check-product-review.sh docs/review/PRODUCT_REVIEW_<plan>_<date>.md
#   bash scripts/check-product-review.sh --scan docs/review
# Exit: 0 all good; 1 zero-output / incomplete summary; 2 bad usage.
# NOTE: keep this file ASCII-only. Writing CJK into bash scripts has corrupted bytes before.
set -u
rc=0

check_one() {
  f="$1"
  if [ ! -f "$f" ]; then
    echo "PRODUCT-REVIEW-EMPTY: missing file $f (zero output; never trust exit 0)"
    rc=1; return
  fi
  sz=$(wc -c < "$f" | tr -d ' ')
  if [ "${sz:-0}" -lt 80 ]; then
    echo "PRODUCT-REVIEW-EMPTY: $f is only ${sz} bytes, effectively zero output (never trust exit 0)"
    rc=1; return
  fi
  miss=""
  # 2026-10-17 G4 修：原先只校验 3 个锚点，而文档要求 5 段 —— 缺「仅A/仅B」仍能放行，
  # 等于「汇总不得抄边」没有机器约束。现在五段全查。
  grep -q "PRODUCT_REVIEW_CONSENSUS" "$f" || miss="$miss consensus"
  grep -q "PRODUCT_REVIEW_DIVERGENCE" "$f" || miss="$miss divergence"
  grep -q "PRODUCT_REVIEW_ONLY_A"    "$f" || miss="$miss only_a"
  grep -q "PRODUCT_REVIEW_ONLY_B"    "$f" || miss="$miss only_b"
  grep -q "PRODUCT_REVIEW_REJECTED"  "$f" || miss="$miss rejected"
  if [ -n "$miss" ]; then
    echo "PRODUCT-REVIEW-INCOMPLETE: $f missing required summary sections:$miss"
    echo "  required anchors: PRODUCT_REVIEW_CONSENSUS / _DIVERGENCE / _ONLY_A / _ONLY_B / _REJECTED"
    rc=1; return
  fi
  echo "PRODUCT-REVIEW-OK: $f (${sz} bytes, all sections present)"
}

if [ "${1:-}" = "--scan" ]; then
  dir="${2:-docs/review}"
  n=0
  for f in "$dir"/PRODUCT_REVIEW_*.md; do
    [ -f "$f" ] || continue
    n=$((n+1)); check_one "$f"
  done
  if [ "$n" -eq 0 ]; then
    echo "PRODUCT-REVIEW-EMPTY: no PRODUCT_REVIEW_*.md under $dir (zero output)"
    rc=1
  fi
else
  f="${1:-}"
  if [ -z "$f" ]; then
    echo "usage: bash scripts/check-product-review.sh <report.md> | --scan [dir]" >&2
    exit 2
  fi
  check_one "$f"
fi
exit "$rc"
