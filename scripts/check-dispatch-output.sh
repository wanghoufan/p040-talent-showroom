#!/bin/bash
# check-dispatch-output.sh | generic zero-output gate for ANY dispatch (2026-10-17)
#
# Why: check-product-review.sh only guarded the product-review chain. But the project
# orchestrators reported zero-output / silent-failure at least three times in one round
# (concurrent instances losing the race, exit 0 with empty output, two codebuddy instances).
# Those failures are invisible to the ledger checker: the role was dispatched, exit code was 0,
# and nothing landed. This script makes the rule generic -- any role that declares an output
# file must produce a non-empty one, checked at run time (not trusted from exit code).
#
# Usage:
#   bash scripts/check-dispatch-output.sh <expected-output-file> [<expected> ...]
#   bash scripts/check-dispatch-output.sh --spec <spec-file>
#     spec file lines:  <role>\t<output-file>   (tab or >=2 spaces separated)
#
# Exit: 0 all produced; 1 any missing/empty; 2 usage error.
# NOTE: ASCII only. Writing CJK into bash scripts has corrupted bytes before.
set -u
rc=0
MIN=10   # bytes; below this a file is treated as "no real output"

check_one() {
  f="$1"
  if [ -z "$f" ]; then echo "DISPATCH-OUTPUT-MISSING: empty path declared"; rc=1; return; fi
  if [ ! -f "$f" ]; then echo "DISPATCH-OUTPUT-MISSING: $f not found (silent zero-output / lost race)"; rc=1; return; fi
  sz=$(wc -c < "$f" | tr -d ' ')
  if [ "${sz:-0}" -lt "$MIN" ]; then
    echo "DISPATCH-OUTPUT-EMPTY: $f is ${sz} bytes (effectively zero; never trust exit 0)"; rc=1; return
  fi
  echo "DISPATCH-OUTPUT-OK: $f (${sz} bytes)"
}

if [ "${1:-}" = "--spec" ]; then
  spec="${2:-}"
  [ -f "$spec" ] || { echo "DISPATCH-OUTPUT-MISSING: spec file $spec" >&2; exit 2; }
  n=0
  while IFS= read -r line; do
    case "$line" in ''|'#'*) continue;; esac
    role=$(printf '%s' "$line" | cut -f1 | awk '{print $1}')
    f=$(printf '%s' "$line" | cut -f2- | sed 's/^ *//; s/ *$//')
    [ -n "$f" ] || continue
    n=$((n+1))
    if check_one "$f" | grep -q "MISSING\|EMPTY"; then
      echo "  ^ declared by role: ${role:-?}"
      rc=1
    fi
  done < "$spec"
  [ "$n" -eq 0 ] && { echo "DISPATCH-OUTPUT-MISSING: spec has no entries"; rc=1; }
else
  [ "$#" -ge 1 ] || { echo "usage: check-dispatch-output.sh <file> [<file>...] | --spec <file>" >&2; exit 2; }
  for f in "$@"; do check_one "$f"; done
fi
exit "$rc"
