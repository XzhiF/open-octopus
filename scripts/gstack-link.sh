#!/usr/bin/env bash
# gstack-link.sh — 把全局 gstack skills 链接到项目级 .claude/skills/
#
# gstack 全局安装在 ~/.claude/skills/gstack/，但 Octopus AgentExecutor
# 的 Pi SDK 只扫描项目级 .claude/skills/。此脚本按需 symlink 指定 skills。
#
# Windows (MSYS2/Git Bash): symlink 降级为 cp -R（和 gstack setup 一致）
# macOS/Linux: 标准 symlink
#
# Usage:
#   bash scripts/gstack-link.sh              # 链接默认 skills
#   bash scripts/gstack-link.sh browse qa    # 链接指定 skills
#   bash scripts/gstack-link.sh --unlink     # 移除所有链接

set -euo pipefail

GSTACK_HOME="${HOME}/.claude/skills"
PROJECT_SKILLS=".claude/skills"

# 默认链接的 skills（gstack 全流程所需）
DEFAULT_SKILLS=(
  browse
  qa
  qa-only
  review
  ship
  canary
  benchmark
  design-review
  design-consultation
  design-shotgun
  design-html
  office-hours
  plan-ceo-review
  plan-eng-review
  plan-design-review
  investigate
  learn
  retro
  careful
  cso
  codex
  autoplan
)

IS_WINDOWS=0
case "$(uname -s)" in
  MINGW*|MSYS*|CYGWIN*|Windows_NT) IS_WINDOWS=1 ;;
esac

unlink_all() {
  if [ ! -d "$PROJECT_SKILLS" ]; then
    echo "No .claude/skills/ directory found."
    return
  fi
  local count=0
  for entry in "$PROJECT_SKILLS"/*/; do
    name=$(basename "$entry")
    # 只移除指向 gstack 的链接/拷贝
    if [ -L "$PROJECT_SKILLS/$name" ] || [ -f "$PROJECT_SKILLS/$name/.gstack-link" ]; then
      rm -rf "$PROJECT_SKILLS/$name"
      echo "  removed: $name"
      count=$((count + 1))
    fi
  done
  echo "Removed $count gstack skill links."
}

link_skill() {
  local skill="$1"
  local src="$GSTACK_HOME/$skill"
  local dst="$PROJECT_SKILLS/$skill"

  # 跳过 gstack 主目录（太大，不需要整体链接）
  if [ "$skill" = "gstack" ]; then
    return
  fi

  if [ ! -d "$src" ]; then
    echo "  skip: $skill (not found at $src)"
    return
  fi

  # 已存在且是正确链接 → 跳过
  if [ -L "$dst" ]; then
    local target
    target=$(readlink "$dst" 2>/dev/null || echo "")
    if [ "$target" = "$src" ] || [ "$target" = "$(cd "$src" && pwd)" ]; then
      echo "  ok: $skill (already linked)"
      return
    fi
    rm -f "$dst"
  fi

  mkdir -p "$PROJECT_SKILLS"

  if [ "$IS_WINDOWS" -eq 1 ]; then
    # Windows: cp -R（和 gstack setup 一致，symlink 在 MSYS2 下不可靠）
    rm -rf "$dst"
    cp -R "$src" "$dst"
    # 标记为 gstack-link 以便 unlink 识别
    touch "$dst/.gstack-link"
    echo "  copied: $skill (Windows fallback)"
  else
    ln -sfn "$src" "$dst"
    echo "  linked: $skill -> $src"
  fi
}

# ── Main ──

if [ "${1:-}" = "--unlink" ]; then
  unlink_all
  exit 0
fi

if [ $# -gt 0 ]; then
  SKILLS=("$@")
else
  SKILLS=("${DEFAULT_SKILLS[@]}")
fi

echo "Linking gstack skills to $PROJECT_SKILLS/ ..."
echo "Source: $GSTACK_HOME"
echo ""

# 确保 browse 二进制可用
if [ ! -x "$GSTACK_HOME/gstack/browse/dist/browse" ]; then
  echo "browse binary not found. Running gstack setup..."
  if [ -d "$GSTACK_HOME/gstack" ] && [ -f "$GSTACK_HOME/gstack/setup" ]; then
    (cd "$GSTACK_HOME/gstack" && ./setup)
  else
    echo "ERROR: gstack not found at $GSTACK_HOME/gstack"
    echo "Install: git clone --depth 1 https://github.com/garrytan/gstack.git $GSTACK_HOME/gstack"
    exit 1
  fi
fi

linked=0
skipped=0
for skill in "${SKILLS[@]}"; do
  if [ -d "$GSTACK_HOME/$skill" ]; then
    link_skill "$skill"
    linked=$((linked + 1))
  else
    echo "  skip: $skill (not installed)"
    skipped=$((skipped + 1))
  fi
done

echo ""
echo "Done: $linked linked, $skipped skipped."
echo ""
echo "gstack version: $(cat "$GSTACK_HOME/gstack/VERSION" 2>/dev/null || echo 'unknown')"
echo "browse binary: $GSTACK_HOME/gstack/browse/dist/browse"
