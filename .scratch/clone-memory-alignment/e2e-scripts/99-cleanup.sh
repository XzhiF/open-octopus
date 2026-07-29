#!/bin/bash
# E2E Test Cleanup: Remove all E2E_TEST_ prefixed test data

set -e

CLONE_NAME="E2E_TEST_clone"
CLONE_DIR="$HOME/.octopus/agent/clones/$CLONE_NAME"
MAIN_DAILY_DIR="$HOME/.octopus/agent/memory/daily"
TODAY=$(date +%Y-%m-%d)

echo "=== E2E Test Cleanup ==="

# 1. Remove test clone directory
echo "[1/3] Removing test clone directory..."
if [ -d "$CLONE_DIR" ]; then
  rm -rf "$CLONE_DIR"
  echo "  Removed: $CLONE_DIR"
else
  echo "  Already clean: $CLONE_DIR"
fi

# 2. Remove E2E_TEST_ content from main agent daily
echo "[2/3] Cleaning main agent daily file..."
MAIN_DAILY="$MAIN_DAILY_DIR/$TODAY.md"
if [ -f "$MAIN_DAILY" ]; then
  # Remove lines containing E2E_TEST_
  grep -v "E2E_TEST_" "$MAIN_DAILY" > "$MAIN_DAILY.tmp" 2>/dev/null || true
  mv "$MAIN_DAILY.tmp" "$MAIN_DAILY"
  # Remove file if empty
  if [ ! -s "$MAIN_DAILY" ]; then
    rm -f "$MAIN_DAILY"
    echo "  Removed empty daily file"
  else
    echo "  Cleaned E2E_TEST_ entries from daily file"
  fi
else
  echo "  No daily file to clean"
fi

# 3. Re-enable safe mode
echo "[3/3] Re-enabling safe mode..."
curl -s -X PUT "http://localhost:3001/api/agent/config" \
  -H "Authorization: Bearer e2e-test-token" \
  -H "X-Octopus-Org: xzf" \
  -H "Content-Type: application/json" \
  -d '{"safe_mode":{"enabled":true}}' > /dev/null 2>&1
echo "  Safe mode re-enabled"

echo ""
echo "=== Cleanup Complete ==="
