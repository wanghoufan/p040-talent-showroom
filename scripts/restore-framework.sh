#!/bin/bash
# restore-framework.sh | re-deploy the generic ORCA framework into a project that was cloned
#                         fresh from a public repo (where ORCA scaffolding is not tracked).
#
# Usage:
#   bash scripts/restore-framework.sh <project-root> [--source <governance-repo-root>]
#
# Scenario: your public repo excludes ORCA (see scripts/orca-public-ignore.txt), so a fresh
#   `git clone` gives you the app + the project's own records, but NOT the ORCA framework.
#   This script copies the framework back from the local governance母版 so you can resume
#   ORCA-driven development. Your app code, README, plans, reviews, handoff and ledgers are
#   never touched.
#
# Source resolution order for --source:
#   1) explicit --source <path>          (path to母版 root, i.e. the folder that contains 新项目模板包/)
#   2) $ORCA_MOTHER_ROOT env var
#   3) auto-detect: parent of this script's grandparent (script lives in <母版>/scripts/)
#
# Guarantees:
#   - copies ONLY the framework whitelist below
#   - NEVER overwrites existing files (app README, real ledgers, instance docs, experience file)
#   - recreates the USER_MODEL_OVERRIDE.md symlink -> <source>/USER_MODEL_OVERRIDE.md
#   - prints a self-check command block at the end
set -eu

PROJ="${1:-}"
SRC=""
shift || true
while [ $# -gt 0 ]; do
  case "$1" in
    --source) SRC="${2:-}"; shift 2;;
    *) shift;;
  esac
done

SELF_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
[ -z "$SRC" ] && SRC="${ORCA_MOTHER_ROOT:-}"
[ -z "$SRC" ] && SRC="$(cd "$SELF_DIR/.." && pwd)"   # script is in <母版>/scripts -> parent is母版 root

[ -n "$PROJ" ] || { echo "usage: bash $0 <project-root> [--source <母版根路径>]"; exit 2; }
[ -d "$PROJ" ] || { echo "ERR: project root not found: $PROJ"; exit 2; }
[ -d "$SRC/新项目模板包" ] || { echo "ERR: source is not an ORCA母版 (no 新项目模板包/ under): $SRC"; exit 2; }

PKG="$SRC/新项目模板包"
cd "$PROJ"
PROJ_ROOT="$(pwd)"

copied=0; skipped=0

# copy_if_missing <relative-path>   (skips if target already exists — never clobbers)
copy_if_missing() {
  local rel="$1"
  local src="$PKG/$rel"
  local dst="$PROJ_ROOT/$rel"
  [ -e "$src" ] || return 0                 # not in package, skip silently
  if [ -e "$dst" ]; then skipped=$((skipped+1)); return 0; fi
  mkdir -p "$(dirname "$dst")"
  cp -R "$src" "$dst"
  copied=$((copied+1))
}

echo "RESTORE: source(母版) = $SRC"
echo "RESTORE: project     = $PROJ_ROOT"
echo "RESTORE: package     = $PKG"

# ── root framework files ────────────────────────────
for f in AGENTS.md ORCA治理体系说明.md 归位表.template.md 编排者提示词.md 外部开发者提示词.md \
         "Orca 编排治理监督者提示词.md" "Orca 通用编排者持续推进协议.md"; do
  copy_if_missing "$f"
done
# README: only create the ORCA nav if the project has NO README yet (never clobber app README)
if [ ! -e "$PROJ_ROOT/README.md" ]; then
  copy_if_missing "README.md"
fi

# ── directories that are pure framework ────────────
for d in docs/roles docs/sop docs/templates docs/prompts scripts/model scripts/decision scripts/orchestration; do
  copy_if_missing "$d"
done

# ── individual framework files under docs/ + scripts/ ──
for f in docs/assets/orca-roles-dispatch-chain.png docs/assets/orca-two-phase-flow.png \
         docs/model/TASK-MANAGER-QUALIFICATION.md \
         scripts/detect-client.sh scripts/check-channel-preflight.sh; do
  copy_if_missing "$f"
done

# ── .template.md files (framework; instances are separate and untouched) ──
for f in docs/pm/PLAN.template.md docs/pm/PRODUCT_PLAN.template.md \
         docs/plan/后续开发计划.template.md \
         docs/qa/BUGS.template.md docs/qa/产品验收追踪矩阵.template.md \
         docs/review/CODE_REVIEW.template.md docs/review/RESEARCH_REVIEW.template.md \
         docs/review/PRODUCT_BACKLOG.template.md \
         docs/handoff/HANDOFF.template.md docs/handoff/EXT-WORKLOG.template.md; do
  copy_if_missing "$f"
done

# ── ledgers: create ONLY if missing (empty shells); never touch existing real ledgers ──
for f in docs/model/TASK-MODEL-LOG.jsonl docs/model/DISPATCH-LOG.jsonl \
         docs/model/TASK-MANAGER-QUALIFICATION-EVENTS.jsonl docs/model/JEV-DECISION-LOG.jsonl; do
  if [ ! -e "$PROJ_ROOT/$f" ]; then
    copy_if_missing "$f"
  else
    skipped=$((skipped+1))   # existing ledger preserved
  fi
done
# GOVERNANCE_VERSION pointer (framework)
copy_if_missing "GOVERNANCE_VERSION"

# ── USER_MODEL_OVERRIDE.md: make it a symlink to母版真源 (softlink policy) ──
if [ ! -e "$PROJ_ROOT/USER_MODEL_OVERRIDE.md" ]; then
  ln -sfn "$SRC/USER_MODEL_OVERRIDE.md" "$PROJ_ROOT/USER_MODEL_OVERRIDE.md"
  echo "RESTORE: created USER_MODEL_OVERRIDE.md symlink -> $SRC/USER_MODEL_OVERRIDE.md"
else
  echo "RESTORE: USER_MODEL_OVERRIDE.md already present, left as-is"
fi

echo "RESTORE: copied=$copied skipped(existing)=$skipped"
echo "RESTORE: DONE (app code, README, plans, reviews, handoff, ledgers, experience untouched)"
cat <<'EOF'

SELF-CHECK (run these in the project root):
  bash scripts/check-channel-preflight.sh          # expect CHANNEL-OK
  node scripts/model/check-ledger.mjs docs/model   # expect LEDGER-OK (real history preserved)
  bash scripts/detect-client.sh                    # auto-detect client / dispatch mode
EOF