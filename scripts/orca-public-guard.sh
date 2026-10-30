#!/bin/bash
# orca-public-guard.sh | 让「公开作品仓不带 ORCA」变成自动动作，不需用户逐个交代。
#
# 用途（对应 AGENTS.md「默认自决自做」）：
#   ORCA 忽略块注入 + 摘索引 是**可逆、只在本项目内、不碰业务**的操作，
#   因此由编排者/TM 自动执行，不问用户；只有 commit/push 才需要用户授权。
#
# 判定：仓库在 GitHub 上是 PUBLIC 且尚未注入托管忽略块 → 自动注入 + untrack。
#   PRIVATE → 跳过（私有仓保留 ORCA 作云备份，这正是我们要的）。
#   「先私有后公开」这类转换无需额外配置：本脚本每次都**实时查可见性**，
#   一旦转公开即自动补上忽略块。
#
# 用法：
#   bash scripts/orca-public-guard.sh                # 扫描全部已治理项目
#   bash scripts/orca-public-guard.sh <项目根>       # 只处理单个项目
#
# 环境变量：
#   ORCA_PROJECTS_ROOT  项目根目录（默认 ~/Developer/coding/1.Active）
#   ORCA_MOTHER_ROOT    母版根（默认取本脚本上两级）
#
# 幂等：已注入则跳过；重复执行不会重复写块、不会重复摘。
set -eu

SELF_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
MOTHER="${ORCA_MOTHER_ROOT:-$(cd "$SELF_DIR/.." && pwd)}"
PROJECTS_ROOT="${ORCA_PROJECTS_ROOT:-$HOME/Developer/coding/1.Active}"
INJECT="$MOTHER/scripts/orca-gitignore.sh"

[ -f "$INJECT" ] || { echo "ERR: 找不到注入脚本：$INJECT"; exit 2; }

# 仓库是否已注入托管块
has_block() { [ -f "$1/.gitignore" ] && grep -qF 'ORCA 治理块 BEGIN' "$1/.gitignore"; }

# 查 GitHub 可见性；查不到返回空
visibility() {
  local slug="$1"
  gh repo view "$slug" --json visibility -q .visibility 2>/dev/null || true
}

# 处理单个项目；返回 0=已处理/无需处理，1=出错
process_one() {
  local D="$1" name slug vis
  [ -d "$D/.git" ] || return 0
  slug="$(basename "$(git -C "$D" remote get-url origin 2>/dev/null || echo x)" .git)"
  case "$slug" in
    x|*"not a git repo"*) return 0 ;;   # 无 origin，跳过
  esac

  vis="$(visibility "$slug")"
  case "$vis" in
    PUBLIC) ;;
    PRIVATE) echo "  跳过（私有仓，ORCA 保留作云备份）: $slug"; return 0 ;;
    *) echo "  跳过（查不到可见性，多半是没推或非 GitHub）: $slug"; return 0 ;;
  esac

  if has_block "$D"; then
    echo "  已就绪（忽略块在位）: $slug"
    return 0
  fi

  echo "  → 自动注入并摘除: $slug"
  bash "$INJECT" "$D" --untrack 2>&1 | sed 's/^/      /'
}

if [ $# -ge 1 ]; then
  echo "ORCA 公开仓守卫｜单项目: $1"
  process_one "$1"
else
  echo "ORCA 公开仓守卫｜扫描: $PROJECTS_ROOT"
  n=0
  for d in "$PROJECTS_ROOT"/*/; do
    [ -d "$d" ] || continue
    process_one "${d%/}"
    n=$((n+1))
  done
  echo
  echo "扫描 $n 个项目完成。**本地变更未提交**——commit/push 属红线，须用户授权后再做。"
fi