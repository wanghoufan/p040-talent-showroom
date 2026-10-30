#!/bin/bash
# install-governance-hooks.sh | install the governance pre-commit hook into project repos
# (2026-10-17, from the second self-audit)
#
# Why: the three ledger gates (ACCEPTED-MISSING / SIGNOFF-MISSING / LEDGER-XREF) are only
# reachable through pre-commit-guard.sh -> check-ledger. But no installer existed anywhere:
# the guard said "can be used as a git hook, or run manually" and nothing ever installed it.
# Worse, on the master repo the guard branch can never fire (master ledgers are permanently
# _example shells by design), so the gates had **an implementation but no trigger path**.
# This installer closes that gap.
#
# Usage: bash scripts/install-governance-hooks.sh <project-root> [<project-root> ...]
# Safe: idempotent, refuses to overwrite a foreign hook without backup, read-only otherwise.
# NOTE: ASCII only (CJK in bash scripts has corrupted bytes before).
set -u
rc=0
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
GUARD="$HERE/pre-commit-guard.sh"

[ -f "$GUARD" ] || { echo "install-hooks: missing $GUARD" >&2; exit 2; }

for root in "$@"; do
  [ -d "$root" ] || { echo "SKIP (not a dir): $root"; continue; }
  gitdir="$(git -C "$root" rev-parse --git-dir 2>/dev/null)" || { echo "SKIP (not a git repo): $root"; continue; }
  case "$gitdir" in /*) ;; *) gitdir="$root/$gitdir" ;; esac
  hooks="$gitdir/hooks"
  [ -d "$hooks" ] || mkdir -p "$hooks"
  target="$hooks/pre-commit"

  # project repos need their own copy? No -- install the SAME guard file, which decides
  # --allow-example by repo path (master only). So one file works everywhere.
  if [ -f "$target" ] && ! grep -q "pre-commit-guard" "$target" 2>/dev/null; then
    if [ ! -f "$target.bak-2026-10-17" ]; then cp "$target" "$target.bak-2026-10-17"; echo "  backed up existing hook -> $target.bak-2026-10-17"; fi
  fi
  cp "$GUARD" "$target" && chmod +x "$target"
  echo "installed: $target"
done
exit "$rc"
