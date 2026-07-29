#!/bin/bash
# E2E Test Setup: Create test clone directory and seed test data
# Prefix: E2E_TEST_ for easy cleanup

set -e

CLONE_NAME="E2E_TEST_clone"
CLONE_DIR="$HOME/.octopus/agent/clones/$CLONE_NAME"
MAIN_DAILY_DIR="$HOME/.octopus/agent/memory/daily"
TODAY=$(date +%Y-%m-%d)
OLD_DATE="2026-06-01"

echo "=== E2E Test Setup ==="
echo "Clone name: $CLONE_NAME"
echo "Clone dir: $CLONE_DIR"
echo "Today: $TODAY"

# 1. Create clone directory structure
echo "[1/6] Creating clone directory structure..."
mkdir -p "$CLONE_DIR/memory/daily/archive"
mkdir -p "$CLONE_DIR/memory"

# 2. Write clone persona
echo "[2/6] Writing clone persona..."
cat > "$CLONE_DIR/persona.md" << 'EOF'
# E2E Test Clone

This is a test clone for E2E verification of clone memory alignment.
EOF

# 3. Write today's daily memory for clone
echo "[3/6] Writing clone daily memory (today: $TODAY)..."
cat > "$CLONE_DIR/memory/daily/$TODAY.md" << EOF
### 10:00:00
E2E_TEST_clone_memory_insight: This is a test daily memory entry from the E2E_TEST_clone clone.
EOF

# 4. Write an old daily memory file for archive testing
echo "[4/6] Writing old clone daily memory ($OLD_DATE)..."
cat > "$CLONE_DIR/memory/daily/$OLD_DATE.md" << EOF
### 09:00:00
E2E_TEST_old_memory: This is an old daily memory entry for archive testing.
EOF

# Set mtime to 60 days ago to ensure it's past retention
touch -d "60 days ago" "$CLONE_DIR/memory/daily/$OLD_DATE.md" 2>/dev/null || true

# 5. Write clone long-term memory with duplicates for refine testing
echo "[5/6] Writing clone long-term memory..."
cat > "$CLONE_DIR/memory/long-term.md" << 'EOF'
## 项目笔记

- E2E_TEST_lt_insight: 使用 TypeScript strict mode 可以减少运行时错误
- 使用 TypeScript strict mode 可以减少运行时错误
- 数据库选择 SQLite 适合本地优先架构
- E2E_TEST_lt_unique: 分身记忆对齐是重要的工程目标

## 经验教训

- 始终在提交前运行测试
- 始终在提交前运行测试
- E2E_TEST_lt_lesson: 代码审查有助于发现边界情况
EOF

# Set mtime to 10 days ago to trigger refine (threshold is 7 days)
touch -d "10 days ago" "$CLONE_DIR/memory/long-term.md" 2>/dev/null || true

# 6. Write main agent daily memory for isolation testing
echo "[6/6] Writing main agent daily memory..."
mkdir -p "$MAIN_DAILY_DIR"
cat > "$MAIN_DAILY_DIR/$TODAY.md" << EOF
### 11:00:00
E2E_TEST_main_memory: This is a test daily memory entry from the main agent.
EOF

echo ""
echo "=== Setup Complete ==="
echo "Clone daily dir: $CLONE_DIR/memory/daily/"
ls -la "$CLONE_DIR/memory/daily/"
echo ""
echo "Clone long-term: $CLONE_DIR/memory/long-term.md"
ls -la "$CLONE_DIR/memory/long-term.md"
echo ""
echo "Main daily dir: $MAIN_DAILY_DIR/"
ls -la "$MAIN_DAILY_DIR/"
