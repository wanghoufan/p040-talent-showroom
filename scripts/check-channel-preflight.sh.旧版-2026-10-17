#!/bin/bash
# check-channel-preflight.sh | Pre-dispatch channel preflight
# Purpose: verify every model the role table actually dispatches is still present in its
#          channel catalog. Catches the real failure mode:
#          table lists a new model ID, but the channel client is too old to expose it
#          -> dispatch fails at runtime.
#          Real case 2026-09-29: codex 0.155.1 had no gpt-6.1-sol, reported
#          "The 'gpt-6.1-sol' model is not supported when using Codex with a ChatGPT account".
# Usage:   bash scripts/check-channel-preflight.sh      (from governance repo root)
# Exit:    0 = CHANNEL-OK, 1 = CHANNEL-FAIL (do NOT dispatch; upgrade the channel client,
#          or dispatch the backup model for that role instead)
# Policy:  never auto-installs client updates. An upgrade changes the catalog, auth and
#          sandbox defaults, and can invalidate the whole table, so it stays a human call.
set -u
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
TBL="$ROOT/USER_MODEL_OVERRIDE.md"
[ -f "$TBL" ] || { echo "FATAL: table not found: $TBL"; exit 1; }

echo "=== [1] collect channel catalogs ==="
CODEX_LIST="$(codex debug models 2>/dev/null | python3 -c "
import json,sys
try: d=json.load(sys.stdin)
except Exception: sys.exit(0)
items = d if isinstance(d,list) else (d.get('models') or d.get('data') or [])
for m in items: print(m.get('id') or m.get('slug') or m.get('name') or '')
" 2>/dev/null)"
CODEBUDDY_LIST="$(codebuddy --help 2>&1 | grep -oE '\(hy4-preview[^)]*\)' | head -1 | tr -d '()' | tr ',' '\n' | tr -d ' ')"
OPENCODE_LIST="$(opencode models 2>/dev/null)"

echo "  codex:     $(printf '%s\n' "$CODEX_LIST"     | grep -c .) models"
echo "  codebuddy: $(printf '%s\n' "$CODEBUDDY_LIST" | grep -c .) models"
echo "  opencode:  $(printf '%s\n' "$OPENCODE_LIST"  | grep -c .) models"
[ -n "$CODEX_LIST" ]     || echo "  ! cannot read codex catalog"
[ -n "$CODEBUDDY_LIST" ] || echo "  ! cannot read codebuddy catalog"
[ -n "$OPENCODE_LIST" ]  || echo "  ! cannot read opencode catalog"

role_models=$(awk -F'|' '/^\| *(task-manager|supervisor|planner|builder|code-reviewer|qa|product-reviewer|experience-recorder|neat-freak|senior-expert|db-admin) *\|/ {print $3}' "$TBL" \
  | grep -oE '(codex|codebuddy|opencode|opencode-go|volcengine-plan|radeon-mimo)/[A-Za-z0-9._-]+' | sort -u)
arch_models=$(awk -F'|' '/^\| *[0-9]+ *\|/ {print $4}' "$TBL" \
  | grep -oE '(codex|codebuddy|opencode|opencode-go|volcengine-plan|radeon-mimo)/[A-Za-z0-9._-]+' | sort -u)

lookup() {
  m="$1"
  case "${m%%/*}" in
    codex)     printf '%s\n' "$CODEX_LIST"     | grep -qx "${m#codex/}"     && echo OK || echo MISS ;;
    codebuddy) printf '%s\n' "$CODEBUDDY_LIST" | grep -qx "${m#codebuddy/}" && echo OK || echo MISS ;;
    *)         printf '%s\n' "$OPENCODE_LIST"  | grep -qx "$m"              && echo OK || echo MISS ;;
  esac
}

echo "=== [2] reconcile role table (MISS here blocks dispatch) ==="
fail=0; nrole=0
for m in $role_models; do
  nrole=$((nrole+1))
  if [ "$(lookup "$m")" = "OK" ]; then
    echo "  OK     $m"
  else
    echo "  STALE  $m  <- in role table but MISSING from channel catalog; dispatch would FAIL"
    fail=1
  fi
done
echo "  role models checked: $nrole"

echo "=== [3] reconcile archive (informational only) ==="
narch=0
for m in $arch_models; do
  case " $role_models " in *" $m "*) continue;; esac
  narch=$((narch+1))
  if [ "$(lookup "$m")" = "OK" ]; then
    echo "  OK     $m  (archive)"
  else
    echo "  note   $m  (archive entry, not in current catalog; historical record only)"
  fi
done
echo "  archive models checked: $narch"

echo "=== [4] client versions (report only, never auto-install) ==="
cv=$(codex --version 2>&1 | grep -oE '[0-9]+\.[0-9]+\.[0-9]+' | head -1)
echo "  codex CLI: ${cv:-unknown}   (new model IDs may need a client update to appear)"
echo "  manual upgrade: codex update   -- then RE-RUN this script (catalog changes on upgrade)"

echo "=== [5] minimum client version required by the table ==="
minreq=$(grep -oE '0\.[0-9]{2,}\.[0-9]+' "$TBL" | head -1)
if [ -n "$minreq" ] && [ -n "$cv" ]; then
  low=$(printf '%s\n%s\n' "$cv" "$minreq" | sort -V | head -1)
  if [ "$low" = "$minreq" ] && [ "$cv" != "$minreq" ]; then
    echo "  WARN  codex $cv is below the table requirement $minreq"
  else
    echo "  OK    codex $cv meets requirement $minreq"
  fi
else
  echo "  (no explicit minimum version in table)"
fi

if [ "$fail" -eq 0 ]; then echo "CHANNEL-OK"; else echo "CHANNEL-FAIL"; fi
exit "$fail"
