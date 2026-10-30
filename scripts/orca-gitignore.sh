#!/bin/bash
# orca-gitignore.sh | inject/update the managed ORCA ignore block into a project's root .gitignore,
#                     and optionally untrack already-committed ORCA files (C1: current view only).
#
# Usage:
#   bash scripts/orca-gitignore.sh <project-root>                 # inject/update block only
#   bash scripts/orca-gitignore.sh <project-root> --untrack       # also git rm --cached matching tracked files
#   bash scripts/orca-gitignore.sh <project-root> --list <file>   # use a custom ignore list
#
# Boundary A1 (framework only): hides the *generic* ORCA scaffolding shared by every project,
#   keeps this project's OWN records (product plan / reviews / handoff / ledgers / experience /
#   app README) in the public repo as cloud backup. See scripts/orca-public-ignore.txt.
#
# Guarantees:
#   - idempotent: re-running rewrites the managed block in place, never duplicates
#   - never commits / pushes; untrack only unstages from the index, local files untouched
#   - leaves any user content outside the managed block alone
set -eu

PROJ="${1:-}"
UNTRACK=0
LIST=""
[ "${2:-}" = "--untrack" ] && UNTRACK=1
[ "${3:-}" = "--list" ] && LIST="${4:-}"

SELF_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
DEFAULT_LIST="$SELF_DIR/orca-public-ignore.txt"
[ -z "$LIST" ] && LIST="$DEFAULT_LIST"

[ -n "$PROJ" ] || { echo "usage: bash $0 <project-root> [--untrack] [--list <file>]"; exit 2; }
[ -d "$PROJ/.git" ] || { echo "ERR: not a git repo: $PROJ"; exit 2; }
[ -f "$LIST" ] || { echo "ERR: ignore list not found: $LIST"; exit 2; }

cd "$PROJ"
PROJ_ROOT="$(pwd)"

BEGIN="# >>> ORCA 治理块 BEGIN（母版托管，勿手改） >>>"
END="# <<< ORCA 治理块 END <<<"
GI=".gitignore"

# Extract the pattern lines (non-empty, non-comment) from the manifest.
patterns_file="$(mktemp)"
trap 'rm -f "$patterns_file"' EXIT
grep -vE '^\s*(#|$)' "$LIST" | sed 's/[[:space:]]*$//' > "$patterns_file"

# 1) Build the managed block content.
block_tmp="$(mktemp)"
{
  echo "$BEGIN"
  echo "# 本块由母版 scripts/orca-gitignore.sh 托管，请勿手改；要改请改 scripts/orca-public-ignore.txt 后重跑。"
  cat "$patterns_file"
  echo "$END"
} > "$block_tmp"

# 2) Inject or replace the block in .gitignore (idempotent).
if [ -f "$GI" ] && grep -qF "$BEGIN" "$GI"; then
  before="$(awk -v b="$BEGIN" '$0==b{exit} {print}' "$GI")"
  after="$(awk -v e="$END" 'f{print} $0==e{f=1}' "$GI")"
  { printf '%s\n' "$before"; cat "$block_tmp"; [ -n "$after" ] && printf '%s\n' "$after"; } > "$GI.new"
  action="updated"
else
  { [ -f "$GI" ] && cat "$GI"; echo; cat "$block_tmp"; } > "$GI.new"
  action="inserted"
fi
mv "$GI.new" "$GI"
echo "GITIGNORE: $action managed ORCA block in $PROJ_ROOT/.gitignore"

# 3) Optional: untrack already-committed ORCA files (C1 current view only).
if [ "$UNTRACK" = "1" ]; then
  echo "UNTRACK: scanning currently-tracked ORCA files..."
  removed_total=0
  ls_tmp="$(mktemp)"
  while IFS= read -r pat || [ -n "$pat" ]; do
    [ -z "$pat" ] && continue
    # gitignore 的前导 "/" 是"锚定仓库根"，但 git pathspec 不认，必须剥掉
    spec="${pat#/}"
    # ⚠️ 必须用 -z + core.quotepath=false，且经**文件**中转（bash 变量装不下 NUL 字节）：
    #    否则含中文的文件名会被 git 引用成 "ORCA\346\262\273..." 这种转义串，
    #    传给 git rm 会静默失败（初版实测漏摘中文名文件 12 个）。
    : > "$ls_tmp"
    git -c core.quotepath=false ls-files -z -- "$spec" > "$ls_tmp" 2>/dev/null || true
    [ -s "$ls_tmp" ] || continue
    while IFS= read -r -d '' f; do
      [ -z "$f" ] && continue
      if git rm --cached --quiet -- "$f" 2>/dev/null; then
        removed_total=$((removed_total+1))
      else
        echo "  WARN: 摘除失败 $f"
      fi
    done < "$ls_tmp"
  done < "$patterns_file"
  rm -f "$ls_tmp"
  echo "UNTRACK: unstaged $removed_total ORCA file(s) from index (local files kept)."
  if [ "$removed_total" -gt 0 ]; then
    echo "NOTE: run 'git status' to review; commit only after you authorize it (ORCA red line: no push without explicit instruction)."
  fi
fi

echo "DONE: $PROJ_ROOT"